import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type {
  TrajectoryEvent,
  Episode,
  CounterfactualRun,
  CogBenchTask,
  CogBenchResult,
  Attempt,
  Verification,
} from "@valve/schema";

export interface TelemetryConfig {
  dbPath: string;
  enableWAL?: boolean;
}

/**
 * Trajectory event store.
 *
 * Built on node:sqlite rather than better-sqlite3. The native addon was
 * removed on evidence, not preference: its Database finalizer runs during
 * garbage collection, and under Node 24 that finalizer aborts the process
 * with a V8 assertion instead of raising a catchable error. It reproduced
 * reliably once an ingest had written roughly a dozen decision points, and it
 * destroyed the test report on the way out, which is the worst possible
 * failure mode for a measurement tool. node:sqlite is built in, has no
 * finalizer, and keeps the same synchronous API.
 */
export class EventStore {
  private db: DatabaseSync;

  constructor(config: TelemetryConfig) {
    mkdirSync(dirname(config.dbPath), { recursive: true });

    this.db = new DatabaseSync(config.dbPath);

    if (config.enableWAL !== false) {
      this.db.exec("PRAGMA journal_mode = WAL");
    }

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        initial_state TEXT NOT NULL,
        final_state TEXT,
        success INTEGER,
        total_tokens INTEGER DEFAULT 0,
        total_usd REAL DEFAULT 0,
        total_latency_ms INTEGER DEFAULT 0,
        human_interventions INTEGER DEFAULT 0,
        utility_profile TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        state TEXT NOT NULL,
        candidates TEXT NOT NULL,
        chosen TEXT NOT NULL,
        source TEXT NOT NULL,
        cost_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        cost_latency_ms INTEGER NOT NULL,
        outcome_progress_delta REAL NOT NULL,
        outcome_uncertainty_delta REAL NOT NULL,
        outcome_failure_detected INTEGER NOT NULL,
        outcome_task_success INTEGER,
        outcome_regressions TEXT,
        utility_profile TEXT NOT NULL,
        shadow TEXT,
        grounding TEXT,
        provenance TEXT,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_episode ON events(episode_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_chosen ON events(chosen);

      CREATE TABLE IF NOT EXISTS counterfactuals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        base_event_id INTEGER NOT NULL,
        alternative_action TEXT NOT NULL,
        simulated_progress_delta REAL NOT NULL,
        simulated_uncertainty_delta REAL NOT NULL,
        simulated_failure_detected INTEGER NOT NULL,
        simulated_task_success INTEGER,
        simulated_cost_tokens INTEGER NOT NULL,
        simulated_cost_usd REAL NOT NULL,
        simulated_cost_latency_ms INTEGER NOT NULL,
        simulated_future_steps INTEGER NOT NULL,
        FOREIGN KEY (base_event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS cogbench_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        initial_state TEXT NOT NULL,
        allowed_actions TEXT NOT NULL,
        success_criteria TEXT NOT NULL,
        budget_tokens INTEGER NOT NULL,
        budget_seconds INTEGER NOT NULL,
        budget_steps INTEGER,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS cogbench_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        success INTEGER NOT NULL,
        cost_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        cost_latency_ms INTEGER NOT NULL,
        steps INTEGER NOT NULL,
        human_interventions INTEGER NOT NULL,
        escaped_defects INTEGER NOT NULL,
        frontier_calls INTEGER NOT NULL,
        trajectory TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (task_id) REFERENCES cogbench_tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_cogbench_results_task ON cogbench_results(task_id);
      CREATE INDEX IF NOT EXISTS idx_cogbench_results_agent ON cogbench_results(agent_type);

      -- M4: the epistemology. Separate from events because an attempt has a
      -- lifetime that spans steps: it is opened by an edit, judged by a later
      -- verification, and survives a rollback.
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        cognitive_action TEXT NOT NULL,
        base_checkpoint TEXT NOT NULL,
        delta_fingerprint TEXT NOT NULL,
        resulting_checkpoint TEXT,
        hypothesis TEXT,
        verdict TEXT NOT NULL,
        attribution TEXT NOT NULL,
        evidence TEXT NOT NULL,
        verified_by TEXT NOT NULL,
        reverted INTEGER NOT NULL DEFAULT 0,
        cost_tokens INTEGER NOT NULL DEFAULT 0,
        grounding TEXT NOT NULL,
        provenance TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        targets TEXT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        checkpoint TEXT NOT NULL,
        provenance TEXT NOT NULL,
        grounded INTEGER NOT NULL,
        timed_out INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_episode ON attempts(episode_id, step);
      CREATE INDEX IF NOT EXISTS idx_attempts_verdict ON attempts(verdict);
      CREATE INDEX IF NOT EXISTS idx_attempts_repeat ON attempts(base_checkpoint, delta_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_verifications_episode ON verifications(episode_id, step);
    `);

    this.migrate();
  }

  /**
   * Additive-only migrations for databases created by an earlier schema.
   * ALTER TABLE ADD COLUMN is a no-op-safe operation in SQLite when guarded by
   * a column probe, so this is safe to run on every open.
   */
  private migrate(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(events)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    // Additive only. A record ingested before M4 has no grounding, and
    // backfilling one would be inventing provenance, so the column stays null
    // and those records read as ungrounded when it does.
    if (!names.has("shadow")) {
      this.db.exec("ALTER TABLE events ADD COLUMN shadow TEXT");
    }
    if (!names.has("grounding")) {
      this.db.exec("ALTER TABLE events ADD COLUMN grounding TEXT");
    }
    if (!names.has("provenance")) {
      this.db.exec("ALTER TABLE events ADD COLUMN provenance TEXT");
    }
  }

  /**
   * Declares an episode without asserting anything about its outcome.
   *
   * Idempotent, and deliberately not a shortcut around the foreign key on
   * attempts: an attempt that belongs to no episode is meaningless, and
   * dropping the constraint to accommodate a direct writer would trade a real
   * integrity guarantee for a convenience.
   */
  ensureEpisode(input: {
    id: string
    taskId: string
    startTime: number
    initialState: unknown
    utilityProfile: string
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO episodes (id, task_id, start_time, initial_state, utility_profile)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.taskId,
        input.startTime,
        JSON.stringify(input.initialState ?? {}),
        input.utilityProfile
      );
  }

  // --- M4: attempts and verifications ---

  recordAttempt(attempt: Attempt): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attempts (
          id, episode_id, step, cognitive_action, base_checkpoint, delta_fingerprint,
          resulting_checkpoint, hypothesis, verdict, attribution, evidence,
          verified_by, reverted, cost_tokens, grounding, provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attempt.id,
        attempt.episodeId,
        attempt.step,
        attempt.cognitiveAction.kind,
        attempt.baseCheckpoint,
        attempt.deltaFingerprint,
        attempt.resultingCheckpoint ?? null,
        attempt.hypothesis ?? null,
        attempt.verdict,
        attempt.attribution,
        JSON.stringify(attempt.evidence),
        JSON.stringify(attempt.verifiedBy),
        attempt.reverted ? 1 : 0,
        attempt.costTokens,
        attempt.grounding,
        attempt.provenance
      );
  }

  recordVerification(verification: Verification): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO verifications (
          id, episode_id, step, targets, command, exit_code, checkpoint,
          provenance, grounded, timed_out
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        verification.id,
        verification.episodeId,
        verification.step,
        JSON.stringify(verification.targets),
        verification.command,
        verification.exitCode,
        verification.checkpoint,
        verification.provenance,
        verification.grounded ? 1 : 0,
        verification.timedOut ? 1 : 0
      );
  }

  private rowToAttempt(row: any): Attempt {
    return {
      id: row.id,
      step: row.step,
      episodeId: row.episode_id,
      cognitiveAction: {
        kind: row.cognitive_action,
        estimatedCost: 0,
        estimatedLatencyMs: 0,
        reversible: true,
      },
      baseCheckpoint: row.base_checkpoint,
      deltaFingerprint: row.delta_fingerprint,
      resultingCheckpoint: row.resulting_checkpoint ?? undefined,
      hypothesis: row.hypothesis ?? undefined,
      verdict: row.verdict,
      attribution: row.attribution,
      evidence: JSON.parse(row.evidence),
      verifiedBy: JSON.parse(row.verified_by),
      reverted: Boolean(row.reverted),
      costTokens: row.cost_tokens,
      grounding: row.grounding,
      provenance: row.provenance,
    }
  }

  /**
   * The decisive M4 query: the attempt history of one episode, in order.
   *
   * This is what the representation exists to make answerable. Reading it
   * should show what was tried, what each attempt was supposed to establish,
   * what came back, and where causal attribution was destroyed by stacking.
   */
  getAttempts(episodeId: string): Attempt[] {
    const rows = this.db
      .prepare("SELECT * FROM attempts WHERE episode_id = ? ORDER BY step, id")
      .all(episodeId) as any[]
    return rows.map((row) => this.rowToAttempt(row))
  }

  getVerifications(episodeId: string): Verification[] {
    const rows = this.db
      .prepare("SELECT * FROM verifications WHERE episode_id = ? ORDER BY step")
      .all(episodeId) as any[]
    return rows.map((row) => ({
      id: row.id,
      step: row.step,
      episodeId: row.episode_id,
      targets: JSON.parse(row.targets),
      command: row.command,
      exitCode: row.exit_code,
      checkpoint: row.checkpoint,
      provenance: row.provenance,
      grounded: Boolean(row.grounded),
      timedOut: Boolean(row.timed_out),
    }))
  }

  /**
   * Attempts that repeat an intervention already falsified from the same base.
   *
   * Detectability only. Forbidding the repeat is a policy decision, and M4
   * deliberately changes no policy.
   */
  getRepeatedFalsified(): Array<{ attempt: Attempt; falsified: Attempt }> {
    const rows = this.db
      .prepare(
        `SELECT a.*, f.id AS f_id FROM attempts a
         JOIN attempts f
           ON f.base_checkpoint = a.base_checkpoint
          AND f.delta_fingerprint = a.delta_fingerprint
          AND f.verdict = 'falsified'
          AND f.episode_id = a.episode_id
         WHERE a.verdict = 'pending'
         ORDER BY a.episode_id, a.step`
      )
      .all() as any[]
    return rows.map((row) => ({
      attempt: this.rowToAttempt(row),
      falsified: {
        ...this.rowToAttempt(row),
        id: row.f_id,
        verdict: "falsified" as const,
      },
    }))
  }

  /**
   * Falsification that outlived a rollback. If resetting the workspace could
   * erase a rejection, the dataset would quietly forget its own failures.
   */
  getFalsifiedAfterRevert(): Attempt[] {
    const rows = this.db
      .prepare("SELECT * FROM attempts WHERE verdict = 'falsified' AND reverted = 1")
      .all() as any[]
    return rows.map((row) => this.rowToAttempt(row))
  }

  /** How much of the corpus is safe to train an action predictor on. */
  getGroundingStats(): Record<string, { total: number; trainable: number }> {
    const rows = this.db
      .prepare("SELECT grounding FROM events WHERE chosen IS NOT NULL")
      .all() as Array<{ grounding: string | null }>
    const out: Record<string, { total: number; trainable: number }> = {}
    for (const row of rows) {
      const key = row.grounding ?? "ungrounded"
      const bucket = (out[key] ??= { total: 0, trainable: 0 })
      bucket.total += 1
      if (row.grounding === "harness" || row.grounding === "deterministic") {
        bucket.trainable += 1
      }
    }
    return out
  }

  startEpisode(episode: Episode): void {
    const stmt = this.db.prepare(`
      INSERT INTO episodes (id, task_id, start_time, initial_state, utility_profile)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      episode.id,
      episode.taskId,
      episode.startTime,
      JSON.stringify(episode.initialState),
      episode.utilityProfile
    );
  }

  endEpisode(
    episodeId: string,
    success: boolean,
    finalState: any,
    totalCost: { tokens: number; usd: number; latencyMs: number },
    humanInterventions: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE episodes
      SET end_time = ?, final_state = ?, success = ?, total_tokens = ?, total_usd = ?, total_latency_ms = ?, human_interventions = ?
      WHERE id = ?
    `);
    stmt.run(
      Date.now(),
      JSON.stringify(finalState),
      success ? 1 : 0,
      totalCost.tokens,
      totalCost.usd,
      totalCost.latencyMs,
      humanInterventions,
      episodeId
    );
  }

  logEvent(event: TrajectoryEvent): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (
        episode_id, step, timestamp, state, candidates, chosen, source,
        cost_tokens, cost_usd, cost_latency_ms,
        outcome_progress_delta, outcome_uncertainty_delta,
        outcome_failure_detected, outcome_task_success, outcome_regressions,
        utility_profile, shadow, grounding, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      event.episodeId,
      event.step,
      event.timestamp,
      JSON.stringify(event.state),
      JSON.stringify(event.candidates),
      event.chosen,
      event.source,
      event.cost.tokens,
      event.cost.usd,
      event.cost.latencyMs,
      event.outcome.progressDelta,
      event.outcome.uncertaintyDelta,
      event.outcome.failureDetected ? 1 : 0,
      event.outcome.taskSuccess === null ? null : (event.outcome.taskSuccess ? 1 : 0),
      JSON.stringify(event.outcome.regressions),
      event.utilityProfile,
      event.shadow ? JSON.stringify(event.shadow) : null,
      event.grounding ?? null,
      event.provenance ?? null
    );

    return Number(result.lastInsertRowid);
  }

  logCounterfactual(counterfactual: CounterfactualRun & { baseEventId: number }): void {
    const stmt = this.db.prepare(`
      INSERT INTO counterfactuals (
        base_event_id, alternative_action,
        simulated_progress_delta, simulated_uncertainty_delta,
        simulated_failure_detected, simulated_task_success,
        simulated_cost_tokens, simulated_cost_usd, simulated_cost_latency_ms,
        simulated_future_steps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      counterfactual.baseEventId,
      counterfactual.alternativeAction,
      counterfactual.simulatedOutcome.progressDelta,
      counterfactual.simulatedOutcome.uncertaintyDelta,
      counterfactual.simulatedOutcome.failureDetected ? 1 : 0,
      counterfactual.simulatedOutcome.taskSuccess === null ? null : (counterfactual.simulatedOutcome.taskSuccess ? 1 : 0),
      counterfactual.simulatedOutcome.cost.tokens,
      counterfactual.simulatedOutcome.cost.usd,
      counterfactual.simulatedOutcome.cost.latencyMs,
      counterfactual.simulatedOutcome.futureSteps
    );
  }

  getEpisode(episodeId: string): Episode | null {
    const stmt = this.db.prepare("SELECT * FROM episodes WHERE id = ?");
    const row = stmt.get(episodeId) as any;
    if (!row) return null;

    const events = this.getEventsForEpisode(episodeId);
    return {
      id: row.id,
      taskId: row.task_id,
      startTime: row.start_time,
      endTime: row.end_time ?? undefined,
      initialState: JSON.parse(row.initial_state),
      finalState: row.final_state ? JSON.parse(row.final_state) : undefined,
      events,
      success: Boolean(row.success),
      totalCost: {
        tokens: row.total_tokens,
        usd: row.total_usd,
        latencyMs: row.total_latency_ms,
      },
      humanInterventions: row.human_interventions,
      utilityProfile: row.utility_profile,
    };
  }

  /** Single mapping from a DB row to a TrajectoryEvent. */
  private rowToEvent(row: any): TrajectoryEvent {
    return {
      episodeId: row.episode_id,
      step: row.step,
      timestamp: row.timestamp,
      state: JSON.parse(row.state),
      candidates: JSON.parse(row.candidates),
      chosen: row.chosen,
      source: row.source,
      cost: {
        tokens: row.cost_tokens,
        usd: row.cost_usd,
        latencyMs: row.cost_latency_ms,
      },
      outcome: {
        progressDelta: row.outcome_progress_delta,
        uncertaintyDelta: row.outcome_uncertainty_delta,
        failureDetected: Boolean(row.outcome_failure_detected),
        taskSuccess: row.outcome_task_success === null ? null : Boolean(row.outcome_task_success),
        regressions: JSON.parse(row.outcome_regressions || "[]"),
      },
      utilityProfile: row.utility_profile,
      shadow: row.shadow ? JSON.parse(row.shadow) : undefined,
      // Absent for records written before M4. Null is deliberately not
      // backfilled into a grounding value, because inventing provenance is the
      // exact failure M4 exists to prevent; a consumer treats undefined as
      // ungrounded.
      grounding: (row.grounding ?? undefined) as TrajectoryEvent["grounding"],
      provenance: (row.provenance ?? undefined) as TrajectoryEvent["provenance"],
    }
  }

  getEventsForEpisode(episodeId: string): TrajectoryEvent[] {
    const stmt = this.db.prepare("SELECT * FROM events WHERE episode_id = ? ORDER BY step");
    return (stmt.all(episodeId) as any[]).map((row) => this.rowToEvent(row));
  }

  getAllEpisodes(limit = 100, offset = 0): Episode[] {
    const stmt = this.db.prepare("SELECT id FROM episodes ORDER BY start_time DESC LIMIT ? OFFSET ?");
    const rows = stmt.all(limit, offset) as any[];
    return rows.map((row) => this.getEpisode(row.id)!).filter(Boolean);
  }

  getEventsByAction(action: string, limit = 1000): TrajectoryEvent[] {
    const stmt = this.db.prepare("SELECT * FROM events WHERE chosen = ? ORDER BY timestamp DESC LIMIT ?");
    return (stmt.all(action, limit) as any[]).map((row) => this.rowToEvent(row));
  }

  /**
   * Decision points where VALVE and the real agent disagreed. This is the
   * query the whole project exists to serve: it is where the training signal
   * is, and it is only computable because shadow sits on the same row as
   * ground truth.
   */
  getDisagreements(limit = 1000): TrajectoryEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE shadow IS NOT NULL
        AND json_extract(shadow, '$.agrees') = 0
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return (stmt.all(limit) as any[]).map((row) => this.rowToEvent(row));
  }

  /** Aggregate shadow agreement rate, the headline V0 metric. */
  getShadowStats(): {
    total: number
    scored: number
    agrees: number
    disagreements: number
    unscored: number
    agreementRate: number
    byActualAction: Record<string, { total: number; agrees: number }>
  } {
    const rows = this.db
      .prepare("SELECT chosen, shadow FROM events WHERE shadow IS NOT NULL")
      .all() as Array<{ chosen: string; shadow: string | null }>

    const byActualAction: Record<string, { total: number; agrees: number }> = {}
    let agrees = 0
    let scored = 0

    for (const row of rows) {
      const shadow = row.shadow
        ? (JSON.parse(row.shadow) as { agrees?: boolean })
        : null
      if (typeof shadow?.agrees !== "boolean") continue
      scored++
      const bucket = (byActualAction[row.chosen] ??= { total: 0, agrees: 0 })
      bucket.total += 1
      if (shadow.agrees) {
        agrees += 1
        bucket.agrees += 1
      }
    }

    const total = rows.length
    return {
      total,
      scored,
      agrees,
      disagreements: scored - agrees,
      unscored: total - scored,
      // Scored over what could be scored. The unscored count is reported
      // alongside so the rate can never be quoted without its denominator.
      agreementRate: scored === 0 ? 0 : agrees / scored,
      byActualAction,
    }
  }

  saveCogBenchTask(task: CogBenchTask): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cogbench_tasks (id, name, description, category, initial_state, allowed_actions, success_criteria, budget_tokens, budget_seconds, budget_steps, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id,
      task.name,
      task.description,
      task.category,
      JSON.stringify(task.initialState),
      JSON.stringify(task.allowedActions),
      JSON.stringify(task.successCriteria),
      task.budget.maxTokens,
      task.budget.maxSeconds,
      task.budget.maxSteps ?? null,
      JSON.stringify(task.metadata ?? {})
    );
  }

  getCogBenchTask(id: string): CogBenchTask | null {
    const stmt = this.db.prepare("SELECT * FROM cogbench_tasks WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      initialState: JSON.parse(row.initial_state),
      allowedActions: JSON.parse(row.allowed_actions),
      successCriteria: JSON.parse(row.success_criteria),
      budget: {
        maxTokens: row.budget_tokens,
        maxSeconds: row.budget_seconds,
        maxSteps: row.budget_steps ?? undefined,
      },
      metadata: JSON.parse(row.metadata || "{}"),
    };
  }

  getAllCogBenchTasks(): CogBenchTask[] {
    const stmt = this.db.prepare("SELECT id FROM cogbench_tasks");
    const rows = stmt.all() as any[];
    return rows.map((row) => this.getCogBenchTask(row.id)!).filter(Boolean);
  }

  saveCogBenchResult(result: CogBenchResult): void {
    const stmt = this.db.prepare(`
      INSERT INTO cogbench_results (task_id, agent_type, success, cost_tokens, cost_usd, cost_latency_ms, steps, human_interventions, escaped_defects, frontier_calls, trajectory)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      result.taskId,
      result.agentType,
      result.success ? 1 : 0,
      result.cost.tokens,
      result.cost.usd,
      result.cost.latencyMs,
      result.steps,
      result.humanInterventions,
      result.escapedDefects,
      result.frontierCalls,
      JSON.stringify(result.trajectory)
    );
  }

  getCogBenchResults(taskId?: string, agentType?: string): CogBenchResult[] {
    let query = "SELECT * FROM cogbench_results";
    const params: any[] = [];

    if (taskId && agentType) {
      query += " WHERE task_id = ? AND agent_type = ?";
      params.push(taskId, agentType);
    } else if (taskId) {
      query += " WHERE task_id = ?";
      params.push(taskId);
    } else if (agentType) {
      query += " WHERE agent_type = ?";
      params.push(agentType);
    }

    query += " ORDER BY created_at DESC";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map((row) => ({
      taskId: row.task_id,
      agentType: row.agent_type,
      success: Boolean(row.success),
      cost: {
        tokens: row.cost_tokens,
        usd: row.cost_usd,
        latencyMs: row.cost_latency_ms,
      },
      steps: row.steps,
      humanInterventions: row.human_interventions,
      escapedDefects: row.escaped_defects,
      frontierCalls: row.frontier_calls,
      trajectory: JSON.parse(row.trajectory),
    }));
  }

  exportToParquet(outputPath: string): void {
    // Placeholder for Parquet export - would use apache-arrow or similar
    console.log(`Parquet export to ${outputPath} not yet implemented`);
  }

  close(): void {
    this.db.close();
  }
}

export function createEventStore(dbPath = "./data/valve.db"): EventStore {
  return new EventStore({ dbPath });
}