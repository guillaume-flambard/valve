import type {
  CognitiveAction,
  CognitiveActionKind,
  CognitiveState,
  Evidence,
  Uncertainty,
  ActionSummary,
  VerificationStatus,
} from "@valve/schema"
import { BenchEnvironment } from "./environment.js"
import {
  attributeVerdict,
  checkpointOf,
  deltaFingerprintOf,
  type Attempt,
  type Verification,
} from "@valve/schema"
import type { BenchTask, BenchMutation, StepRecord, PolicyId, BenchEpisode } from "./types.js"

// Re-exported so callers can treat `runner` as the single entry point for the
// bench surface, and so policy modules have one import to reach for.
export type { BenchTask, BenchMutation, StepRecord, PolicyId, BenchEpisode }

const CANDIDATE_COSTS: Record<CognitiveActionKind, { tokens: number; latencyMs: number }> = {
  ACT: { tokens: 1200, latencyMs: 1500 },
  READ: { tokens: 60, latencyMs: 120 },
  SEARCH: { tokens: 250, latencyMs: 900 },
  TEST: { tokens: 900, latencyMs: 1200 },
  VERIFY: { tokens: 700, latencyMs: 900 },
  REASON_FAST: { tokens: 800, latencyMs: 800 },
  REASON_DEEP: { tokens: 4000, latencyMs: 4000 },
  DELEGATE: { tokens: 2000, latencyMs: 2000 },
  ASK_HUMAN: { tokens: 0, latencyMs: 2000 },
  STOP: { tokens: 0, latencyMs: 0 },
}

export const CANDIDATES: CognitiveAction[] = (
  Object.keys(CANDIDATE_COSTS) as CognitiveActionKind[]
).map((kind) => ({
  kind,
  estimatedCost: CANDIDATE_COSTS[kind].tokens,
  estimatedLatencyMs: CANDIDATE_COSTS[kind].latencyMs,
  reversible: kind !== "ACT" && kind !== "DELEGATE",
}))

/**
 * Policies are the thing being compared. Each one is a function from state to
 * the next operation, and nothing else about the loop differs between them, so
 * any difference in the results is attributable to the decision policy rather
 * than to the harness.
 */
export type Policy = (state: CognitiveState, task: BenchTask, ctx: PolicyContext) => CognitiveActionKind

export interface PolicyContext {
  /** Mutations not yet applied, in fixture order. */
  remainingMutations: BenchMutation[]
  /** Files already read this episode. */
  readFiles: Set<string>
  step: number
}

export interface RunOptions {
  task: BenchTask
  policy: Policy
  policyId: PolicyId
  /** Records the same NDJSON the OpenCode shadow plugin emits. */
  spool?: ObservedSink
  maxSteps?: number
  /**
   * M4: receives the attempt history of the episode. The bench is the only
   * emitter that can produce real checkpoints and exit codes, so it is the
   * only source of grounded attempt identity.
   */
  onAttempts?: (attempts: Attempt[], verifications: Verification[]) => void
}

export interface ObservedSink {
  write(record: Record<string, unknown>): void
}

export function runEpisode(options: RunOptions): BenchEpisode {
  const { task, policy, policyId } = options
  const env = new BenchEnvironment(task)
  const episodeId = `cogbench-${task.id}-${policyId}`
  const startedAt = Date.now()

  const steps: StepRecord[] = []
  const mutationsApplied: string[] = []
  const readFiles = new Set<string>()
  const searchedPatterns = new Set<string>()
  const evidence: Evidence[] = []
  const recentActions: ActionSummary[] = []
  const uncertainties: Uncertainty[] = []

  let verification: VerificationStatus = { build: "unknown", tests: "unknown", qa: "unknown" }
  let testRuns = 0
  let totalCostTokens = 0
  let totalLatencyMs = 0
  let frontierCalls = 0
  let remaining = [...task.mutations]
  let firstCorrectStep: number | null = null
  let step = 0
  const maxSteps = options.maxSteps ?? task.budget.maxSteps

  // M4: the epistemology. Attempts carry identity and survive verification;
  // verifications name what they speak to.
  let attempts: Attempt[] = []
  const verifications: Verification[] = []
  // A box, because the verified checkpoint advances mid-episode when the
  // oracle goes green and the loop body needs to write it.
  const verifiedCheckpointRef = { value: checkpointOf(task.files) }
  let currentCheckpoint = verifiedCheckpointRef.value
  const attemptedFiles: Record<string, string> = { ...task.files }

  const emit = (kind: string, extra: Record<string, unknown>) =>
    options.spool?.write({ v: 1, kind, sessionID: episodeId, ts: Date.now(), ...extra })

  emit("episode_open", { goal: task.description, agent: policyId })

  while (step < maxSteps) {
    step++

    const state = buildState({
      task,
      goal: task.description,
      step,
      evidence,
      uncertainties,
      recentActions,
      verification,
      remainingMutations: remaining,
      elapsedMs: Date.now() - startedAt,
      verifiedCheckpoint: verifiedCheckpointRef.value,
      currentCheckpoint,
      attempts,
    })

    const ctx: PolicyContext = { remainingMutations: remaining, readFiles, step }
    const action = policy(state, task, ctx)

    const cost = CANDIDATE_COSTS[action]
    const started = Date.now()
    let detail = ""
    let exitCode: number | undefined
    let mutated = false
    let noProgress = false

    switch (action) {
      case "ACT": {
        const mutation = remaining.shift()
        if (!mutation) {
          detail = "no edits left to apply"
          // An edit with nothing to apply cannot make progress. Ending the
          // episode here is what stops a policy from spinning forever on a
          // dead branch, which is the exact failure this project exists to
          // prevent and the one the naive policy fell into.
          noProgress = true
          break
        }
        // The state this attempt is made from, captured before the write.
        const baseCheckpoint = currentCheckpoint
        env.applyMutation(mutation)
        const after: Record<string, string> = { ...attemptedFiles }
        for (const [path, contents] of Object.entries(mutation.changes)) {
          after[path] = contents
        }
        currentCheckpoint = checkpointOf(after)
        mutationsApplied.push(mutation.id)
        remaining = remaining.filter((m) => m.id !== mutation.id)
        frontierCalls++
        totalCostTokens += mutation.costTokens
        mutated = true
        detail = `applied ${mutation.id}`

        const attempt: Attempt = {
          id: `${episodeId}-a${attempts.length + 1}`,
          step,
          episodeId,
          cognitiveAction: {
            kind: "ACT",
            estimatedCost: mutation.costTokens,
            estimatedLatencyMs: 0,
            reversible: true,
          },
          baseCheckpoint,
          deltaFingerprint: deltaFingerprintOf(attemptedFiles, after),
          resultingCheckpoint: currentCheckpoint,
          hypothesis: mutation.description,
          verdict: "pending",
          attribution: "individual",
          evidence: [],
          verifiedBy: [],
          reverted: false,
          costTokens: mutation.costTokens,
          // The harness executed the edit, so both the operation and the
          // resulting state are facts rather than classifications.
          grounding: "harness",
          provenance: "harness",
        }
        attempts = [...attempts, attempt]
        for (const a of attempts) {
          if (a.verdict === "pending" && a.id !== attempt.id) {
            a.verifiedBy = [...a.verifiedBy, attempt.id]
          }
        }
        recentActions.push({
          action: "ACT",
          timestamp: Date.now(),
          outcome: "success",
          cost: mutation.costTokens,
          latencyMs: 0,
          progressDelta: 0,
          attemptId: attempt.id,
        })
        break
      }
      case "TEST":
      case "VERIFY": {
        const result = env.test()
        testRuns++
        exitCode = result.exitCode
        verification = {
          ...verification,
          tests: result.exitCode === 0 ? "passed" : result.timedOut ? "unknown" : "failed",
          build: action === "VERIFY" ? (result.exitCode === 0 ? "passed" : "failed") : verification.build,
        }
        detail = result.exitCode === 0 ? "tests passed" : `tests failed (exit ${result.exitCode})`

        // A verification names the attempts it can speak to. Stacked edits are
        // all named, and attribution below records that none of them can be
        // singled out rather than inventing three confident verdicts.
        const pendingIds = attempts.filter((a) => a.verdict === "pending").map((a) => a.id)
        const record: Verification = {
          id: `${episodeId}-v${verifications.length + 1}`,
          step,
          episodeId,
          targets: pendingIds,
          command: task.testCommand,
          exitCode: result.exitCode,
          checkpoint: currentCheckpoint,
          provenance: "harness",
          grounded: !result.timedOut,
          timedOut: result.timedOut,
        }
        verifications.push(record)
        attempts = attributeVerdict(attempts, record, result.exitCode === 0)
        if (result.exitCode === 0 && !result.timedOut) {
          // Green oracle, so the current state becomes the known-good
          // checkpoint. This is what clears the unverified delta.
          verifiedCheckpointRef.value = currentCheckpoint
        }
        break
      }
      case "READ": {
        const path = task.readable.find((p) => !readFiles.has(p))
        if (path) {
          readFiles.add(path)
          const contents = env.read(path) ?? ""
          evidence.push({
            id: `ev-${path}`,
            source: "file",
            content: contents.slice(0, 2000),
            relevance: 0.8,
            timestamp: Date.now(),
          })
          detail = `read ${path}`
        } else {
          detail = "nothing left to read"
        }
        break
      }
      case "SEARCH": {
        // Tracked in a local set rather than by inspecting ActionSummary, which
        // carries no free-form detail field.
        const spec = task.searchable.find((s) => !searchedPatterns.has(s.pattern))
        if (spec) {
          searchedPatterns.add(spec.pattern)
          evidence.push({
            id: `ev-search-${spec.pattern}`,
            source: "search",
            content: spec.matches.join("\n"),
            relevance: 0.7,
            timestamp: Date.now(),
          })
          detail = `search ${spec.pattern}`
        } else {
          detail = "nothing left to search"
        }
        break
      }
      case "STOP":
        detail = "policy stopped"
        break
      default:
        detail = `${action} is not executable in this environment`
        break
    }

    const latencyMs = Date.now() - started
    totalLatencyMs += latencyMs
    if (action !== "ACT") totalCostTokens += cost.tokens

    // Uncertainty is recomputed from the real verification status rather than
    // accumulated, so a stale uncertainty cannot outlive the evidence.
    uncertainties.length = 0
    if (verification.tests === "failed") {
      uncertainties.push({
        id: "u-tests",
        description: "tests failing",
        severity: 0.9,
        relatedActions: ["ACT", "READ", "TEST"],
      })
    } else if (verification.tests === "unknown") {
      uncertainties.push({
        id: "u-unverified",
        description: "changes not yet verified",
        severity: 0.7,
        relatedActions: ["TEST", "VERIFY"],
      })
    }

    recentActions.push({
      action,
      timestamp: Date.now(),
      outcome: action === "TEST" || action === "VERIFY" ? (exitCode === 0 ? "success" : "failure") : "success",
      cost: action === "ACT" ? (task.mutations.find((m) => m.id === mutationsApplied.at(-1))?.costTokens ?? cost.tokens) : cost.tokens,
      latencyMs,
      progressDelta: 0,
    })

    steps.push({ step, action, detail, costTokens: cost.tokens, latencyMs, exitCode })

    emit("tool_result", {
      callID: `${episodeId}-${step}`,
      tool: toolNameFor(action),
      title: detail,
      // The harness executed this step, so it reports the operation outright
      // rather than leaving ingest to infer it from a tool name.
      args: { cognitiveAction: action },
      output: detail,
      outputTruncated: false,
      latencyMs,
      errored: exitCode !== undefined && exitCode !== 0,
    })
    if (action === "ACT" || action === "REASON_DEEP" || action === "REASON_FAST") {
      emit("llm_call", {
        agent: policyId,
        model: { providerID: "bench", modelID: action === "ACT" ? "frontier" : "small" },
      })
    }

    // Success is judged by the oracle, never by the policy believing it is done.
    if (mutated && firstCorrectStep === null && env.verify().exitCode === 0) {
      firstCorrectStep = step
    }

    if (action === "STOP") break
    if (noProgress) break
    if (action === "ACT" && remaining.length === 0) {
      // No further edits are available. Give the policy one verification step
      // before the episode is closed out, so it is never penalised for having
      // no way to learn the outcome.
      if (verification.tests !== "passed") {
        continue
      }
      break
    }
  }

  // Every policy is scored by the same final oracle check, so a policy cannot
  // win by never verifying.
  const finalResult = env.verify()
  const success = finalResult.exitCode === 0
  if (success && firstCorrectStep === null) {
    firstCorrectStep = steps.length
  }

  // A rollback must not erase a rejection. The bench resets state constantly
  // because every edit is judged alone, so this is the case that matters.
  for (const a of attempts) {
    if (a.resultingCheckpoint !== currentCheckpoint && a.verdict !== "pending") {
      a.reverted = true
    }
  }

  options.onAttempts?.(attempts, verifications)
  emit("episode_close", { reason: "idle" })
  env.cleanup()

  return {
    taskId: task.id,
    policy: policyId,
    success,
    steps,
    frontierCalls,
    testRuns,
    totalCostTokens,
    totalLatencyMs,
    mutationsApplied,
    stepsAfterFirstCorrect: firstCorrectStep === null ? steps.length : steps.length - firstCorrectStep,
  }
}

function toolNameFor(action: CognitiveActionKind): string {
  switch (action) {
    case "ACT":
      return "edit"
    case "READ":
      return "read"
    case "SEARCH":
      return "grep"
    case "TEST":
    case "VERIFY":
      return "bash"
    case "STOP":
      return "noop"
    default:
      return "other"
  }
}

function buildState(input: {
  task: BenchTask
  goal: string
  step: number
  evidence: Evidence[]
  uncertainties: Uncertainty[]
  recentActions: ActionSummary[]
  verification: VerificationStatus
  remainingMutations: BenchMutation[]
  elapsedMs: number
  verifiedCheckpoint: string
  currentCheckpoint: string
  attempts: Attempt[]
}): CognitiveState {
  return {
    goal: input.goal,
    progress: input.verification.tests === "passed" ? 0.9 : 0.2,
    currentTask: `working on ${input.task.name}`,
    evidence: input.evidence,
    uncertainties: input.uncertainties,
    constraints: [],
    recentActions: input.recentActions,
    verification: input.verification,
    resources: {
      contextTokens: input.evidence.reduce((sum, e) => sum + e.content.length / 4, 0),
      remainingBudget: input.task.budget.maxTokens,
      elapsedMs: input.elapsedMs,
    },
    authority: { canWrite: true, canDelete: false, canAskHuman: false },
    // M4: the epistemology, available to the policy alongside the chronology.
    verifiedCheckpoint: input.verifiedCheckpoint,
    currentCheckpoint: input.currentCheckpoint,
    pendingAttempts: input.attempts.filter((a) => a.verdict === "pending"),
    falsifiedAttempts: input.attempts.filter((a) => a.verdict === "falsified"),
    metadata: {
      step: input.step,
      mutationsLeft: input.remainingMutations.length,
      // True when the world has moved and nobody has looked since. This is the
      // question V0 could not ask, exposed without any policy being able to
      // act on it yet.
      unverifiedDelta: input.verifiedCheckpoint !== input.currentCheckpoint,
    },
  }
}
