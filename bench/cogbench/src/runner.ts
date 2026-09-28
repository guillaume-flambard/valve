import { BenchEnvironment } from "./environment.js"
import type { ActionSummary, CognitiveActionKind, CognitiveState, Constraint } from "@valve/schema"
import {
  attributeVerdict,
  checkpointOf,
  deltaFingerprintOf,
  type Attempt,
  type Verification,
} from "@valve/schema"
import type {
  ActionCost,
  BenchEpisode,
  BenchMutation,
  BenchTask,
  PolicyId,
  StepRecord,
} from "./types.js"

// Re-exported so the CLI and policies have one import for the bench surface.
export type { BenchEpisode, BenchTask, PolicyId, StepRecord, BenchMutation }
export { CANDIDATES } from "./candidates.js"

export interface ObservedSink {
  write(record: Record<string, unknown>): void
}

/**
 * Cross-episode resource, shared by every task in a benchmark run.
 *
 * It exists for one question that a per-episode policy cannot answer: not
 * "does this task deserve the oracle" but "with three oracle calls for eight
 * tasks, where should they be spent". A budget object that is per-episode would
 * silently reduce that back to the easy question.
 */
export interface OracleBudget {
  total: number
  used: number
  /** Spend is refused once exhausted; the caller must fall back. */
  available(): boolean
  spend(): boolean
}

export interface PolicyContext {
  remainingMutations: BenchMutation[]
  readFiles: Set<string>
  searchedPatterns: Set<string>
  step: number
  /** Exit code of the most recent TEST, if any. */
  lastTestExit?: number
  /** Exit code of the most recent VERIFY, if any. */
  lastVerifyExit?: number
  /**
   * Attempts tried and judged, oldest first. Present so a policy can ask what
   * has already been falsified rather than inferring it from a step count.
   */
  attempts?: Attempt[]
  /** Shared across the run, when the caller supplied one. */
  oracleBudget?: OracleBudget
  /** Total oracle calls made in this episode. */
  oracleCalls: number
}

export type Policy = (
  state: CognitiveStateLike,
  task: BenchTask,
  ctx: PolicyContext
) => CognitiveActionKind

/**
 * Policies receive a real CognitiveState.
 *
 * An earlier version passed a structural subset cast through `never`, which
 * typechecked and then crashed at the first heuristic that read
 * `uncertainties`. The cast hid a genuine contract violation: VALVE needs the
 * whole state, and a benchmark that quietly supplies less would be measuring a
 * policy that cannot exist in production.
 */
export type CognitiveStateLike = CognitiveState

export interface RunOptions {
  task: BenchTask
  policy: Policy
  policyId: PolicyId
  spool?: ObservedSink
  maxSteps?: number
  onAttempts?: (attempts: Attempt[], verifications: Verification[]) => void
  /** Shared across tasks, for policies that allocate a verification budget. */
  oracleBudget?: OracleBudget
}

function costFor(task: BenchTask, action: CognitiveActionKind): ActionCost {
  switch (action) {
    case "ACT":
      return task.costModel.act
    case "READ":
      return task.costModel.read
    case "SEARCH":
      return task.costModel.search
    case "TEST":
      return task.costModel.test
    case "VERIFY":
      return task.costModel.verify
    default:
      return { tokens: 0, latencyMs: 0 }
  }
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
  const evidence: Array<{ id: string; source: string; content: string; relevance: number; timestamp: number }> = []
  const recentActions: CognitiveStateLike["recentActions"] = []

  let verification: CognitiveStateLike["verification"] = { build: "unknown", tests: "unknown", qa: "unknown" }
  let testRuns = 0
  let verifyRuns = 0
  let frontierCalls = 0
  let totalCostTokens = 0
  let totalLatencyMs = 0
  let remaining = [...task.mutations]
  let firstCorrectStep: number | null = null
  let step = 0
  const maxSteps = options.maxSteps ?? task.budget.maxSteps

  // The two channels are tracked separately, because a green cheap test and a
  // green oracle are different claims and only one of them is the oracle.
  let lastTestExit: number | undefined
  let lastVerifyExit: number | undefined
  /** The policy's own belief that it was done, and on what evidence. */
  let believedPassing = false
  let believedOnCheapEvidence = false

  let attempts: Attempt[] = []
  const verifications: Verification[] = []
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
      step,
      evidence,
      recentActions,
      verification,
      elapsedMs: Date.now() - startedAt,
      verifiedCheckpoint: verifiedCheckpointRef.value,
      currentCheckpoint,
      attempts,
    })

    const ctx: PolicyContext = {
      remainingMutations: remaining,
      readFiles,
      searchedPatterns,
      step,
      lastTestExit,
      lastVerifyExit,
      attempts,
      oracleBudget: options.oracleBudget,
      oracleCalls: verifyRuns,
    }
    const action = policy(state, task, ctx)

    const cost = costFor(task, action)
    const started = Date.now()
    let detail = ""
    let exitCode: number | undefined
    let channel: "test" | "verify" | undefined
    let mutated = false
    let noProgress = false

    switch (action) {
      case "ACT": {
        const mutation = remaining.shift()
        if (!mutation) {
          detail = "no edits left to apply"
          noProgress = true
          break
        }
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
        const editCost = mutation.costTokens ?? cost.tokens
        totalCostTokens += editCost
        mutated = true
        detail = `applied ${mutation.id}`

        const attempt: Attempt = {
          id: `${episodeId}-a${attempts.length + 1}`,
          step,
          episodeId,
          cognitiveAction: {
            kind: "ACT",
            estimatedCost: editCost,
            estimatedLatencyMs: cost.latencyMs,
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
          costTokens: editCost,
          grounding: "harness",
          provenance: "harness",
        }
        attempts = [...attempts, attempt]
        // Recorded so a policy can see that the world moved. Without this the
        // only edit-aware signal is the attempt table, and policies fall back
        // to guessing from ordering.
        recentActions.push({
          action: "ACT",
          timestamp: Date.now(),
          outcome: "success",
          cost: editCost,
          latencyMs: cost.latencyMs,
          attemptId: attempt.id,
        })
        // Any edit invalidates the earlier evidence, both green and red.
        //
        // Clearing the red case matters as much as the green one: a refutation
        // describes the state it was observed on, and after an edit that state
        // no longer exists. Keeping it let a policy carry "already refuted"
        // across an edit and overwrite its own best attempt with the next one.
        //
        // The same argument applies to `verification`, which is the field the
        // gated policies actually read rather than the locals beside it. M7
        // found three of 24 episodes ending on a state nothing had examined
        // because this one field outlived the edit that destroyed its subject.
        believedPassing = false
        believedOnCheapEvidence = false
        lastTestExit = undefined
        lastVerifyExit = undefined
        verification = { ...verification, tests: "unknown" }
        break
      }
      case "TEST": {
        const result = env.test()
        testRuns++
        exitCode = result.exitCode
        channel = "test"
        lastTestExit = result.exitCode
        verification = { ...verification, tests: result.exitCode === 0 ? "passed" : "failed" }
        detail = result.exitCode === 0 ? "local test passed" : `local test failed (exit ${result.exitCode})`
        believedPassing = result.exitCode === 0
        believedOnCheapEvidence = result.exitCode === 0
        break
      }
      case "VERIFY": {
        // A budget is a hard constraint, not a preference. Spending past it is
        // refused so the policy must fall back to cheaper evidence, which is
        // the behaviour the budgeted policy is being measured on.
        if (options.oracleBudget && !options.oracleBudget.spend()) {
          detail = "oracle budget exhausted"
          noProgress = true
          break
        }
        const result = env.verify()
        verifyRuns++
        exitCode = result.exitCode
        channel = "verify"
        lastVerifyExit = result.exitCode
        verification = { ...verification, tests: result.exitCode === 0 ? "passed" : "failed" }
        detail = result.exitCode === 0 ? "oracle passed" : `oracle failed (exit ${result.exitCode})`
        // The oracle is the only channel that may clear the belief.
        believedPassing = result.exitCode === 0
        believedOnCheapEvidence = false
        break
      }
      case "READ": {
        const path = task.readable.find((p) => !readFiles.has(p))
        if (path) {
          readFiles.add(path)
          const contents = env.read(path) ?? ""
          evidence.push({ id: `ev-${path}`, source: "file", content: contents.slice(0, 2000), relevance: 0.8, timestamp: Date.now() })
          detail = `read ${path}`
        } else {
          detail = "nothing left to read"
        }
        break
      }
      case "SEARCH": {
        const spec = task.searchable.find((s) => !searchedPatterns.has(s.pattern))
        if (spec) {
          searchedPatterns.add(spec.pattern)
          evidence.push({ id: `ev-search-${spec.pattern}`, source: "search", content: spec.matches.join("\n"), relevance: 0.7, timestamp: Date.now() })
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

    if (channel) {
      const pendingIds = attempts.filter((a) => a.verdict === "pending").map((a) => a.id)
      const record: Verification = {
        id: `${episodeId}-v${verifications.length + 1}`,
        step,
        episodeId,
        targets: pendingIds,
        command: channel === "test" ? task.testCommand : task.verifyCommand,
        exitCode: exitCode ?? 1,
        checkpoint: currentCheckpoint,
        // A cheap local test is grounded but partial. That distinction matters:
        // it may legitimately clear an attempt that the oracle would reject.
        provenance: "harness",
        grounded: exitCode !== undefined,
        timedOut: false,
      }
      verifications.push(record)
      attempts = attributeVerdict(attempts, record, exitCode === 0)
      // "Verified" here means *somebody looked at this state*, not "somebody
      // confirmed it is good". Whether the state is any good is the attempt
      // verdict's job, recorded above.
      //
      // Advancing only on a pass, or only on the oracle, left unverifiedDelta
      // permanently true after any red result, so a policy that checks before
      // its next edit could never reach its next edit.
      verifiedCheckpointRef.value = currentCheckpoint
    }

    if (action !== "ACT" && action !== "STOP") {
      recentActions.push({
        action,
        timestamp: Date.now(),
        outcome: exitCode === 0 ? "success" : exitCode === undefined ? "success" : "failure",
        cost: cost.tokens,
        latencyMs,
      })
    }

    steps.push({ step, action, detail, costTokens: cost.tokens, latencyMs, exitCode, channel })

    emit("tool_result", {
      callID: `${episodeId}-${step}`,
      tool: toolNameFor(action),
      title: detail,
      args: { cognitiveAction: action },
      grounding: "harness",
      provenance: "harness",
      exitCode,
      output: detail,
      outputTruncated: false,
      latencyMs,
      errored: exitCode !== undefined && exitCode !== 0,
    })
    if (action === "ACT") {
      emit("llm_call", { agent: policyId, model: { providerID: "bench", modelID: "frontier" } })
    }

    if (mutated && firstCorrectStep === null && env.verify().exitCode === 0) {
      firstCorrectStep = step
    }

    if (action === "STOP") break
    if (noProgress) break
    if (totalCostTokens > task.budget.maxTokens) break
  }

  // Every policy is graded by the same complete oracle, so none can win by
  // never verifying.
  const finalResult = env.verify()
  const success = finalResult.exitCode === 0

  // A defect escaped exactly when the policy's own evidence said passing and
  // the complete oracle disagreed. The policy stopped on a claim it had not
  // actually established.
  const escapedDefect = !success && believedPassing && believedOnCheapEvidence

  if (success && firstCorrectStep === null) firstCorrectStep = steps.length

  for (const a of attempts) {
    if (a.resultingCheckpoint !== currentCheckpoint && a.verdict !== "pending") {
      a.reverted = true
    }
  }

  options.onAttempts?.(attempts, verifications)
  emit("episode_close", { reason: "idle" })
  env.cleanup()

  const utility =
    (success ? task.costModel.success : 0) -
    totalCostTokens -
    (escapedDefect ? task.costModel.defectEscape : 0) -
    steps.length * task.costModel.step

  return {
    taskId: task.id,
    family: task.family,
    policy: policyId,
    success,
    steps,
    frontierCalls,
    testRuns,
    verifyRuns,
    stepCount: steps.length,
    escapedDefect,
    totalCostTokens,
    totalLatencyMs,
    utility: Math.round(utility),
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
  step: number
  evidence: unknown[]
  recentActions: CognitiveStateLike["recentActions"]
  verification: CognitiveStateLike["verification"]
  elapsedMs: number
  constraints?: Constraint[]
  verifiedCheckpoint: string
  currentCheckpoint: string
  attempts: Attempt[]
}): CognitiveStateLike {
  return {
    goal: input.task.description,
    progress: input.verification.tests === "passed" ? 0.9 : 0.2,
    currentTask: `working on ${input.task.name}`,
    evidence: input.evidence as CognitiveState["evidence"],
    // Recomputed from the live verification status rather than accumulated, so
    // a stale uncertainty cannot outlive the evidence that produced it.
    uncertainties: input.verification.tests === "passed"
      ? []
      : [
          {
            id: "u-unverified",
            description:
              input.verification.tests === "failed"
                ? "checks are failing"
                : "changes not yet verified",
            severity: input.verification.tests === "failed" ? 0.9 : 0.7,
            relatedActions: ["ACT", "READ", "TEST", "VERIFY"],
          },
        ],
    constraints: input.task.constraints ?? [],
    recentActions: input.recentActions,
    verification: input.verification,
    verifiedCheckpoint: input.verifiedCheckpoint,
    currentCheckpoint: input.currentCheckpoint,
    pendingAttempts: input.attempts.filter((a) => a.verdict === "pending"),
    falsifiedAttempts: input.attempts.filter((a) => a.verdict === "falsified"),
    resources: {
      contextTokens: 0,
      remainingBudget: input.task.budget.maxTokens,
      elapsedMs: input.elapsedMs,
    },
    authority: { canWrite: true, canDelete: false, canAskHuman: false },
    metadata: {
      step: input.step,
      mutationsLeft: 0,
      unverifiedDelta: input.verifiedCheckpoint !== input.currentCheckpoint,
    },
  }
}
