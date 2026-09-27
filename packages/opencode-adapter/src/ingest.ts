import { readFileSync, existsSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { EventStore } from "@valve/telemetry"
import { createValveV0, type ValveV0 } from "@valve/runtime"
import type {
  ActionSummary,
  CognitiveAction,
  CognitiveActionKind,
  CognitiveState,
  Evidence,
  Grounding,
  ObservedEvent,
  OperationLabel,
  UtilityProfileName,
  VerificationStatus,
} from "@valve/schema"

const DEFAULT_SPOOL =
  process.env["VALVE_SPOOL_DIR"] ?? join(homedir(), ".local", "share", "opencode", "valve")

/**
 * Tool name to cognitive operation.
 *
 * The mapping is deliberately coarse. It answers "what kind of operation was
 * this", not "what did it do". Anything finer would be inference dressed up as
 * measurement, and the whole point of the shadow phase is that ground truth
 * comes from what happened, not from what we assume happened.
 */
const TOOL_OPERATION: Record<string, CognitiveActionKind> = {
  read: "READ",
  grep: "SEARCH",
  glob: "SEARCH",
  list: "SEARCH",
  webfetch: "SEARCH",
  websearch: "SEARCH",
  edit: "ACT",
  write: "ACT",
  patch: "ACT",
  task: "DELEGATE",
  todowrite: "ACT",
  todoread: "READ",
}

/**
 * Classifies a shell command by reading it, not by guessing.
 *
 * `bash` is the single most common tool and it spans every operation: it runs
 * tests, lints, greps, builds, and deletes. Labelling all of it ACT was
 * measured to be actively harmful: a correct `npm test` was recorded as a
 * generic mutation, so VALVE proposing TEST scored as a disagreement against
 * an agent that had done the right thing. That is label noise, and label noise
 * in the shadow phase becomes label noise in training.
 *
 * Classification runs over the *head* of each command segment (the program and
 * its immediate flags), never over arguments. Scanning the whole string
 * mislabels by accident: `rm -rf /tmp/build` contains "build" and was being
 * recorded as VERIFY, which files a destructive command under a safe heading.
 */
function classifyBash(command: string): CognitiveActionKind {
  // Split on the operators that chain independent commands, so a later
  // segment is judged on its own: `cd /x && npm test` is a test run.
  const segments = command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean)

  const verdicts = segments.map(classifySegment)
  // The most consequential operation in the chain wins. A command that both
  // verifies and mutates is reported as a mutation, because that is the
  // operation carrying the risk.
  const rank: Record<SegmentVerdict, number> = {
    NEUTRAL: -1,
    STOP: 0,
    ASK_HUMAN: 0,
    DELEGATE: 0,
    REASON_FAST: 0,
    REASON_DEEP: 0,
    SEARCH: 1,
    READ: 1,
    VERIFY: 2,
    TEST: 3,
    ACT: 4,
  }
  // Seeded with the first verdict, not with a constant. Seeding with ACT made
  // the comparison `rank[v] > rank[worst]` false on the first iteration for
  // every verdict below it, so the function collapsed to a constant.
  const seed = verdicts[0] ?? "ACT"
  const winner = verdicts.reduce((worst, v) => (rank[v] > rank[worst] ? v : worst), seed)
  // A chain of pure navigation carries no operation at all; calling it ACT
  // would file a context change as a mutation.
  return winner === "NEUTRAL" ? "READ" : winner
}

// Pre-compiled: these run once per tool call over every session in the spool,
// and building the literals per call was measurable allocation churn.
const GREP_PROGS = /^(grep|rg|ag|ack|fd|find|locate)$/
const READ_PROGS = /^(git|cat|less|more|head|tail|stat|wc|diff|jq|yq)$/
const GIT_MUTATIONS =
  /^(status|add|commit|push|checkout|switch|reset|clean|stash|merge|rebase)$/
const DESTRUCTIVE_PROGS = /^(rm|mv|cp|dd|truncate|chmod|chown)$/
const TEST_RUNNER_PROGS =
  /^(pytest|tox|vitest|jest|mocha|gradle|mvn|swift|xcodebuild|nextest)$/
const LINT_PROGS = /^(eslint|ruff|flake8|mypy|tsc|biome|prettier)$/
const TASK_PROGS = /^(npm|pnpm|yarn|bun|npx|deno|make|cargo|go|uv|poetry)$/

/**
 * A verdict of NEUTRAL means the segment changed the shell's context but did
 * not itself acquire or change anything: `cd`, `export`, `source`. Without
 * this, `cd /repo && npm test` classified the navigation as a mutation, and
 * because a mutation is the most consequential verdict it drowned out the
 * test run that actually mattered.
 */
type SegmentVerdict = CognitiveActionKind | "NEUTRAL"

const NAV_PROGS = /^(cd|pushd|popd|export|set|source|unset|alias|umask|ulimit)$/
const INFO_PROGS = /^(echo|printf|pwd|whoami|which|type|env|printenv|true|false)$/

function classifySegment(segment: string): SegmentVerdict {
  // First two words: the program and its subcommand or first flag. Arguments
  // after that are deliberately ignored.
  const words = segment.split(/\s+/)
  const program = (words[0] ?? "").toLowerCase()
  const sub = (words[1] ?? "").toLowerCase()
  const head = `${program} ${sub}`

  if (NAV_PROGS.test(program)) return "NEUTRAL"
  if (INFO_PROGS.test(program)) return "NEUTRAL"
  if (GREP_PROGS.test(program)) return "SEARCH"
  if (DESTRUCTIVE_PROGS.test(program)) return "ACT"
  if (READ_PROGS.test(program)) {
    // `git status` and `git commit` mutate; `git log/diff/show` do not.
    return program === "git" && GIT_MUTATIONS.test(sub) ? "ACT" : "READ"
  }
  if (TEST_RUNNER_PROGS.test(program)) return "TEST"
  if (LINT_PROGS.test(program)) return "VERIFY"
  if (/^(curl|wget)$/.test(program)) return "SEARCH"
  if (TASK_PROGS.test(program)) {
    // Task runners take the operation as a subcommand or, for `run`, as a
    // script name in the third position. Two words is not enough to see it:
    // `npm run build` was classified ACT because "build" sat at index 2.
    const runnerHead = words
      .slice(0, 3)
      .join(" ")
      .toLowerCase()
    if (/\btest\b|vitest|jest|pytest|mocha|xctest/.test(runnerHead)) return "TEST"
    if (/lint|tsc|typecheck|mypy|clippy|vet|check/.test(runnerHead)) return "VERIFY"
    if (/build|compile|make|cmake/.test(runnerHead)) return "VERIFY"
    return "ACT"
  }
  return "ACT"
}

/**
 * A classified operation plus how much the classification is worth.
 *
 * M4 removed the silent fallback. The previous code ended with
 * `TOOL_OPERATION[tool] ?? "ACT"`, which meant an unrecognised tool was filed
 * as a mutation: 41 test steps in the first CogBench run were ingested as ACT
 * because the bench emitted no shell command for the classifier to read. That
 * produced a dataset that looked healthy and taught the model that verifying
 * was the same as editing. An unrecognised tool is now `ungrounded` and
 * excluded from training, which is uncomfortable and correct.
 */
export interface ClassifiedOperation {
  action: OperationLabel;
  grounding: Grounding;
  /** Why the label is weak, for inspection. Never used to fill in a value. */
  reason?: string;
}

/** Tools whose name determines the operation with no interpretation involved. */
const DETERMINISTIC_TOOLS = new Set(["read", "grep", "glob", "list", "edit", "write", "patch", "todowrite", "todoread"])

function classify(tool: string, args: Record<string, unknown> | undefined): ClassifiedOperation {
  // Declared by the process that executed the step.
  const declared = args?.["cognitiveAction"]
  if (typeof declared === "string") {
    return { action: declared as CognitiveActionKind, grounding: "harness" }
  }

  if (DETERMINISTIC_TOOLS.has(tool)) {
    return { action: TOOL_OPERATION[tool] ?? "UNKNOWN", grounding: "deterministic" }
  }

  if (tool === "bash") {
    const command = args?.["command"]
    if (typeof command === "string") {
      return { action: classifyBash(command), grounding: "derived" }
    }
    return {
      action: "UNKNOWN",
      grounding: "ungrounded",
      reason: "bash with no observable command",
    }
  }

  if (tool === "task") {
    return { action: "DELEGATE", grounding: "deterministic" }
  }

  const known = TOOL_OPERATION[tool]
  if (known) {
    return { action: known, grounding: "deterministic" }
  }

  return {
    action: "UNKNOWN",
    grounding: "ungrounded",
    reason: `unrecognised tool ${tool}`,
  }
}

/**
 * Convenience for the places that only need a label. Note it can return
 * "UNKNOWN": callers that persist a training-critical label must check
 * grounding rather than assume a value.
 */
const mapTool = (tool: string, args?: Record<string, unknown>): OperationLabel =>
  classify(tool, args).action

/** UNKNOWN has no cost class. It is charged nothing rather than a default. */
const costOf = (label: OperationLabel): number =>
  label === "UNKNOWN" ? 0 : OPERATION_COST[label].tokens

/** Rough cost classes. Deliberately not dollars: we measure relative weight. */
const OPERATION_COST: Record<CognitiveActionKind, { tokens: number; latencyMs: number }> = {
  ACT: { tokens: 400, latencyMs: 2000 },
  READ: { tokens: 60, latencyMs: 500 },
  SEARCH: { tokens: 300, latencyMs: 3000 },
  TEST: { tokens: 1500, latencyMs: 12000 },
  VERIFY: { tokens: 1000, latencyMs: 6000 },
  REASON_FAST: { tokens: 1200, latencyMs: 3000 },
  REASON_DEEP: { tokens: 6000, latencyMs: 18000 },
  DELEGATE: { tokens: 3000, latencyMs: 8000 },
  ASK_HUMAN: { tokens: 0, latencyMs: 30000 },
  STOP: { tokens: 0, latencyMs: 0 },
}

const CANDIDATES: CognitiveAction[] = (
  Object.keys(OPERATION_COST) as CognitiveActionKind[]
).map((kind) => ({
  kind,
  estimatedCost: OPERATION_COST[kind].tokens,
  estimatedLatencyMs: OPERATION_COST[kind].latencyMs,
  // ACT and DELEGATE mutate; the rest are observations. ASK_HUMAN is
  // technically cheap and technically unrepeatable, which is why it carries
  // a high cost via the utility profile instead.
  reversible: kind !== "ACT" && kind !== "DELEGATE",
}))

/**
 * Derives verification state from tool output text.
 *
 * This is regex on prose, which is weak, and it is the weakest link in the
 * whole pipeline. It is kept because it is the only signal available without
 * a test-runner integration, and because a wrong "unknown" only weakens the
 * heuristic rather than inverting it. Replace it with real exit codes before
 * trusting any of it.
 */
function deriveVerification(events: ObservedEvent[]): VerificationStatus {
  const verification: VerificationStatus = {
    build: "unknown",
    tests: "unknown",
    qa: "unknown",
  }
  for (const e of events) {
    if (e.kind !== "tool_result") continue
    const out = e.output
    if (/\bFAIL\b|failed|AssertionError/i.test(out)) {
      verification.tests = "failed"
    } else if (/\bPASS\b|\d+ passed|all tests? pass/i.test(out)) {
      verification.tests = "passed"
    }
    if (/error TS\d+|compilation (failed|error)|build failed/i.test(out)) {
      verification.build = "failed"
    } else if (/compiled successfully|build passed|0 errors?/i.test(out)) {
      verification.build = "passed"
    }
  }
  return verification
}

function deriveUncertainties(
  events: ObservedEvent[],
  verification: VerificationStatus
) {
  const uncertainties = []
  if (verification.tests === "failed") {
    uncertainties.push({
      id: "unc-tests-failed",
      description: "Tests are failing",
      severity: 0.9,
      relatedActions: ["ACT", "READ", "TEST"] as CognitiveActionKind[],
    })
  }
  if (verification.tests === "unknown") {
    uncertainties.push({
      id: "unc-tests-unknown",
      description: "Test status unknown",
      severity: 0.7,
      relatedActions: ["TEST", "VERIFY"] as CognitiveActionKind[],
    })
  }
  if (events.some((e) => e.kind === "session_error")) {
    uncertainties.push({
      id: "unc-session-error",
      description: "Session reported an error",
      severity: 0.8,
      relatedActions: ["READ", "REASON_FAST"] as CognitiveActionKind[],
    })
  }
  return uncertainties
}

function deriveProgress(events: ObservedEvent[], verification: VerificationStatus) {
  const tools = events.filter((e) => e.kind === "tool_result").length
  let progress = Math.min(0.4, 0.1 + tools * 0.04)
  if (verification.build === "passed") progress += 0.2
  if (verification.tests === "passed") progress += 0.3
  return Math.min(1, progress)
}

function deriveRecentActions(events: ObservedEvent[]): ActionSummary[] {
  return events
    .filter((e): e is Extract<ObservedEvent, { kind: "tool_result" }> => e.kind === "tool_result")
    .slice(-20)
    .map((e) => ({
      action: mapTool(e.tool, e.args),
      timestamp: e.ts,
      outcome: e.errored ? ("failure" as const) : ("success" as const),
      cost: costOf(mapTool(e.tool, e.args)),
      latencyMs: e.latencyMs,
    }))
}

/**
 * Builds evidence from what tools actually returned.
 *
 * This was measured to be a real defect when left empty: `evidence.length`
 * drives the information-seeking priors in the utility model, so a state that
 * claims zero evidence after the agent has read a file biases the policy
 * permanently toward searching. A state that lies about what it knows produces
 * a dataset that teaches the wrong thing.
 */
function deriveEvidence(events: ObservedEvent[]): Evidence[] {
  return events
    .filter((e): e is Extract<ObservedEvent, { kind: "tool_result" }> => e.kind === "tool_result")
    .slice(-30)
    .map((e, i) => ({
      id: `ev-${e.callID}-${i}`,
      source: sourceForOperation(labelForEvidence(e.tool, e.args)),
      // Title is the cheapest reliable description of what came back; the full
      // output stays in the spool and in OpenCode's own storage.
      content: `${e.title}\n${e.output}`.slice(0, 2000),
      // Failed tools are evidence too, and arguably the most valuable kind,
      // so they are marked relevant rather than discarded.
      relevance: e.errored ? 0.7 : 0.8,
      timestamp: e.ts,
    }))
}

function labelForEvidence(tool: string, args: Record<string, unknown> | undefined): CognitiveActionKind {
  const label = mapTool(tool, args)
  return label === "UNKNOWN" ? "ACT" : label
}

function sourceForOperation(op: CognitiveActionKind): Evidence["source"] {
  switch (op) {
    case "READ":
      return "file"
    case "TEST":
      return "test"
    case "VERIFY":
      return "build"
    case "SEARCH":
      return "search"
    case "ACT":
      return "tool"
    default:
      return "tool"
  }
}

function deriveResources(events: ObservedEvent[]) {
  const start = events[0]?.ts ?? Date.now()
  const llmCalls = events.filter((e) => e.kind === "llm_call").length
  return {
    contextTokens: llmCalls * 1000,
    elapsedMs: Date.now() - start,
  }
}

export interface IngestOptions {
  spoolPath?: string
  dbPath?: string
  utilityProfile?: UtilityProfileName
  /** Keep the spool file after ingest instead of rotating it. */
  keepSpool?: boolean
  valve?: ValveV0
}

export interface IngestResult {
  spoolPath: string
  linesRead: number
  linesSkipped: number
  episodes: number
  decisionPoints: number
  llmCalls: number
  humanInterruptions: number
  errors: number
  agreementRate: number
  disagreements: number
  /** Decision points whose operation label could not be grounded. Never trained on. */
  ungroundedLabels: number
  /** Rows retained for inspection but excluded from training. */
  rejectedForTraining: number
}

/**
 * Reads the NDJSON spool, reconstructs the state preceding each completed tool
 * call, asks VALVE what it would have done there, and stores both.
 *
 * The state is reconstructed from events strictly *before* the tool call, so
 * VALVE is never shown the answer it is being judged against.
 */
export function ingestSpool(options: IngestOptions = {}): IngestResult {
  const spoolPath = options.spoolPath ?? `${DEFAULT_SPOOL}/observed.ndjson`
  const dbPath = options.dbPath ?? "./data/valve.db"
  const utilityProfile = options.utilityProfile ?? "coding-balanced"
  const valve = options.valve ?? createValveV0()

  const result: IngestResult = {
    spoolPath,
    linesRead: 0,
    linesSkipped: 0,
    episodes: 0,
    decisionPoints: 0,
    llmCalls: 0,
    humanInterruptions: 0,
    errors: 0,
    agreementRate: 0,
    disagreements: 0,
    ungroundedLabels: 0,
    rejectedForTraining: 0,
  }

  if (!existsSync(spoolPath)) return result

  const raw = readFileSync(spoolPath, "utf8")
  const events: ObservedEvent[] = []

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as ObservedEvent
      if (parsed.v !== 1 || typeof parsed.kind !== "string") {
        result.linesSkipped += 1
        continue
      }
      events.push(parsed)
    } catch {
      // A torn final line is expected if the process died mid-append.
      result.linesSkipped += 1
    }
  }
  result.linesRead = events.length

  // Group by session, preserving order.
  const bySession = new Map<string, ObservedEvent[]>()
  for (const e of events) {
    const list = bySession.get(e.sessionID)
    if (list) list.push(e)
    else bySession.set(e.sessionID, [e])
  }

  // The store owns a native SQLite handle. It is closed in a finally block
  // because leaking one lets the garbage collector finalise the native
  // database at an arbitrary point in the process, which crashes node rather
  // than raising a catchable error. Statistics are read before the close,
  // since the handle is invalid afterwards.
  const store = new EventStore({ dbPath })
  let stats: ReturnType<EventStore["getShadowStats"]>
  try {
    ingestSessions(store, bySession, result, utilityProfile, valve)
    stats = store.getShadowStats()
  } finally {
    store.close()
  }

  result.agreementRate = stats.agreementRate
  result.disagreements = stats.disagreements

  if (!options.keepSpool) {
    // Rotate rather than delete, so an ingest bug is always recoverable.
    try {
      renameSync(spoolPath, `${spoolPath}.ingested`)
    } catch {
      // Non-fatal: the data is already in SQLite.
    }
  }

  return result
}

function ingestSessions(
  store: EventStore,
  bySession: Map<string, ObservedEvent[]>,
  result: IngestResult,
  utilityProfile: UtilityProfileName,
  valve: ValveV0
): void {
  for (const [sessionID, sessionEvents] of bySession) {
    const open = sessionEvents.find((e) => e.kind === "episode_open")
    const goal = open && open.kind === "episode_open" ? open.goal : "unknown goal"

    const llmCalls = sessionEvents.filter((e) => e.kind === "llm_call").length
    const humanAsks = sessionEvents.filter((e) => e.kind === "human_interruption").length
    const sessionErrors = sessionEvents.filter((e) => e.kind === "session_error").length

    result.llmCalls += llmCalls
    result.humanInterruptions += humanAsks
    result.errors += sessionErrors

    const verification = deriveVerification(sessionEvents)

    store.startEpisode({
      id: sessionID,
      taskId: "opencode-shadow",
      startTime: sessionEvents[0]?.ts ?? Date.now(),
      initialState: buildState(goal, sessionEvents, verification, utilityProfile),
      events: [],
      success: false,
      totalCost: { tokens: llmCalls * 1000, usd: 0, latencyMs: 0 },
      humanInterventions: humanAsks,
      utilityProfile,
    })
    result.episodes += 1

    // Each completed tool call is one decision point. State is built from the
    // prefix strictly before it.
    const toolResults = sessionEvents.filter(
      (e): e is Extract<ObservedEvent, { kind: "tool_result" }> => e.kind === "tool_result"
    )

    for (let i = 0; i < toolResults.length; i++) {
      const call = toolResults[i]!
      const prefix = sessionEvents.slice(0, sessionEvents.indexOf(call))
      const state = buildState(goal, prefix, deriveVerification(prefix), utilityProfile)
      const classified = classify(call.tool, call.args)
      const actual: OperationLabel = classified.action

      const decision = valve.decideSync({
        state,
        candidates: CANDIDATES,
        utilityProfile,
      })

      store.logEvent({
        episodeId: sessionID,
        step: i + 1,
        timestamp: call.ts,
        state,
        candidates: CANDIDATES,
        // "UNKNOWN" is persisted verbatim. It is a real value in the corpus, not
        // a gap to be papered over with the nearest plausible label.
        chosen: actual,
        source: "human",
        cost: {
          tokens: actual === "UNKNOWN" ? 0 : OPERATION_COST[actual].tokens,
          usd: 0,
          latencyMs: call.latencyMs,
        },
        outcome: {
          // Shadow mode cannot observe progress or task success without a
          // verifier. Recorded as null rather than guessed: a fabricated
          // progress delta would silently become a training label.
          progressDelta: 0,
          uncertaintyDelta: 0,
          failureDetected: call.errored,
          taskSuccess: null,
          regressions: [],
        },
        utilityProfile,
        grounding: classified.grounding,
        provenance: call.provenance ?? (classified.grounding === "harness" ? "harness" : "environment"),
        shadow: decision
          ? {
              action: decision.action,
              probability: decision.probability,
              expectedUtility: decision.expectedUtility,
              risk: decision.risk,
              informationGain: decision.informationGain,
                // An UNKNOWN ground truth can never be agreed or disagreed
                // with, so it is recorded as neither rather than counted as a
                // miss, which would silently penalise VALVE for the label gap.
              agrees: actual === "UNKNOWN" ? undefined : decision.action === actual,
            }
          : undefined,
      })
      if (classified.grounding === "ungrounded") {
        // Retained, visible, and excluded. The invariant is that a
        // training-critical label is never invented: the alternative is a
        // corpus that looks complete and is quietly wrong.
        result.ungroundedLabels += 1
        result.rejectedForTraining += 1
      }
      result.decisionPoints += 1
    }

    const totalLatency = toolResults.reduce((sum, e) => sum + e.latencyMs, 0)
    store.endEpisode(
      sessionID,
      false,
      buildState(goal, sessionEvents, verification, utilityProfile),
      { tokens: llmCalls * 1000, usd: 0, latencyMs: totalLatency },
      humanAsks
    )
  }
}

function buildState(
  goal: string,
  events: ObservedEvent[],
  verification: VerificationStatus,
  utilityProfile: UtilityProfileName
): CognitiveState {
  const humanAsks = events.filter((e) => e.kind === "human_interruption").length
  const llmCalls = events.filter((e) => e.kind === "llm_call").length

  return {
    goal,
    progress: deriveProgress(events, verification),
    currentTask: goal.slice(0, 200),
    evidence: deriveEvidence(events),
    uncertainties: deriveUncertainties(events, verification),
    constraints: [],
    recentActions: deriveRecentActions(events),
    verification,
    resources: deriveResources(events),
    authority: { canWrite: true, canDelete: false, canAskHuman: true },
    metadata: { utilityProfile, llmCalls, humanAsks },
  }
}
