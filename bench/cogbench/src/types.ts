import type { CognitiveActionKind, Constraint } from "@valve/schema"

/**
 * A CogBench task is a real repository state, two real commands with different
 * prices, and a cost of getting it wrong.
 *
 * M3 and M4 had one command, priced the same everywhere. That made constant
 * verification close to free and let a scheduler learn a rule that was an
 * artifact of the benchmark rather than of value. The two-command shape below
 * is what makes the trade-off real: `testCommand` is a cheap partial check that
 * can go green on a wrong fix, `verifyCommand` is the expensive complete
 * oracle, and `defectEscape` is what shipping a bug costs.
 *
 * Correctness is still never declared by hand. A mutation is correct if and
 * only if `verifyCommand` exits 0 after it is applied.
 */

export type Family =
  /** Nothing to do. STOP can be optimal and costs nothing. */
  | "A-already-correct"
  /** One local, near-certain edit. ACT then STOP beats ACT then TEST. */
  | "B-trivial"
  /** Several plausible fixes. Testing between tries is necessary. */
  | "C-competing-hypotheses"
  /** The cheap test passes on a wrong fix. Only the full oracle catches it. */
  | "D-misleading-local-signal"
  /** Verification is correct but slow, so batching edits can win. */
  | "E-expensive-verifier"
  /** Verification is nearly free, so testing often is rational. */
  | "F-cheap-verifier"
  /** Reading or searching eliminates edits that would have been wrong. */
  | "G-information-before-action"
  /** An escaped defect is catastrophic, so verify despite the cost. */
  | "H-high-risk"
  /**
   * M3 fixtures, kept for the pinned ADR 0001 result. One command and no cheap
   * / complete split, so they cannot discriminate a verification policy.
   */
  | "legacy-m3"

export interface ActionCost {
  tokens: number
  latencyMs: number
}

/**
 * Per-task prices.
 *
 * Varying these across instances is the point of M5: the correct amount of
 * verification is a function of what verification costs and what an escaped
 * defect costs, and a single global price can only encode one answer.
 */
export interface CostModel {
  act: ActionCost
  read: ActionCost
  search: ActionCost
  /** Cheap, partial, and capable of passing on a wrong fix. */
  test: ActionCost
  /** Complete oracle. Correct, and priced accordingly. */
  verify: ActionCost
  /**
   * Utility charged for shipping a defect the policy's own evidence did not
   * catch. Without this the benchmark can price a test run but cannot price
   * skipping one, which is the whole question.
   */
  defectEscape: number
  /** Utility earned for a correct final state. */
  success: number
  /** Utility per wasted step, to break ties against looping. */
  step: number
}

export interface BenchMutation {
  id: string
  description: string
  /** Full replacement contents, path relative to task root. */
  changes: Record<string, string>
  /** Overrides CostModel.act for this edit when its cost is distinctive. */
  costTokens?: number
  /**
   * Note on why a mutation is wrong, when it is. Never used for scoring: the
   * exit code decides. Present so a human reading a failure knows what happened.
   */
  knownFlaw?: string
}

export interface BenchTask {
  id: string
  name: string
  family: Family
  description: string

  /** Initial repository contents, path relative to the task root. */
  files: Record<string, string>

  /**
   * Cheap partial check. May go green on an incorrect fix, which is what makes
   * the choice between TEST and VERIFY a real decision.
   */
  testCommand: string

  /** Complete oracle. Exit 0 means solved. The only definition of success. */
  verifyCommand: string

  mutations: BenchMutation[]

  /**
   * Constraints the policy may read. Used by the information-before-action
   * family, where the binding rule lives outside the file that fails.
   */
  constraints?: Constraint[]

  /** Files a READ can return. */
  readable: string[]

  /** Patterns a SEARCH can match, with what the match returns. */
  searchable: Array<{ pattern: string; matches: string[] }>

  costModel: CostModel

  budget: {
    maxSteps: number
    maxTokens: number
  }

  /**
   * Whether the state ships with no defect at all. Family A exists to make
   * STOP the correct first move, which is impossible to score correctly if the
   * harness assumes every task needs an edit.
   */
  startsSolved?: boolean
}

export type PolicyId =
  // Bounds and history
  | "verify-always"
  | "test-always"
  | "valve-v0"
  | "naive-edit-first"
  | "act-always"
  | "stop-immediately"
  // M6: evidence-acquisition policies
  | "confidence-threshold"
  | "evidence-gated"
  | "risk-adjusted"
  | "oracle-budgeted"

export interface StepRecord {
  step: number
  action: CognitiveActionKind
  detail: string
  costTokens: number
  latencyMs: number
  /** Exit code, for TEST and VERIFY. */
  exitCode?: number
  /**
   * Which evidence channel produced the exit code. A policy that trusts the
   * cheap test and stops has an unverified claim, and the harness must be able
   * to say so.
   */
  channel?: "test" | "verify"
}

export interface BenchEpisode {
  taskId: string
  family: Family
  policy: PolicyId
  success: boolean
  steps: StepRecord[]

  /** Frontier-equivalent reasoning calls: one per mutation applied. */
  frontierCalls: number
  testRuns: number
  verifyRuns: number
  stepCount: number

  /**
   * The policy's own evidence said passing, and the full oracle disagreed.
   * This is the quantity `defectEscape` prices, and the reason a cheap test is
   * not a substitute for the oracle.
   */
  escapedDefect: boolean

  totalCostTokens: number
  totalLatencyMs: number

  /** Net utility, dominated by success but trading against every cost. */
  utility: number

  mutationsApplied: string[]
  stepsAfterFirstCorrect: number
}
