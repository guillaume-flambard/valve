import type { CognitiveActionKind } from "@valve/schema";

/**
 * A CogBench task is a real, executable repository state plus a real oracle.
 *
 * The design constraint that matters: correctness is never declared by hand.
 * A mutation is "correct" if and only if `verifyCommand` exits 0 after it is
 * applied. That is the whole reason the bench can produce trustworthy labels
 * while the shadow phase, watching prose on stdout, cannot.
 *
 * Mutations are scripted rather than model-generated. At V0 there is no trained
 * policy to write code, and a fixture whose patches come from an LLM would be
 * non-deterministic and cost money on every run. What stays real is the part
 * that carries the claim: the filesystem, the test command, the exit code, the
 * cost of every step. Only the reasoning is stubbed.
 */
export interface BenchTask {
  id: string;
  name: string;
  description: string;
  category:
    | "fix-test"
    | "implement-feature"
    | "refactor"
    | "build-error"
    | "migrate"
    | "api-endpoint";

  /** Initial repository contents, path relative to the task root. */
  files: Record<string, string>;

  /**
   * The oracle. Exit code 0 means the task is solved. This is the ground truth
   * for `success`; nothing else is allowed to define it.
   */
  verifyCommand: string;

  /** Exit code and stdout of the test run, captured as evidence. */
  testCommand: string;

  /**
   * Scripted candidate edits. Each is a real file write with a real cost,
   * representing one unit of expensive reasoning applied to the problem.
   */
  mutations: BenchMutation[];

  /** Files a READ operation can return. */
  readable: string[];

  /** Patterns a SEARCH operation can match, with what the match returns. */
  searchable: Array<{ pattern: string; matches: string[] }>;

  budget: {
    maxSteps: number;
    maxTokens: number;
  };
}

export interface BenchMutation {
  id: string;
  description: string;
  /** Full replacement contents, path relative to task root. */
  changes: Record<string, string>;
  /**
   * Cost of the reasoning that produced this edit. Treated as frontier-equivalent
   * compute, which is the quantity VALVE claims to reduce.
   */
  costTokens: number;
  /**
   * Optional note on why a mutation is wrong. Never used for scoring: the exit
   * code decides. Present only so a human reading a failure knows what happened.
   */
  knownFlaw?: string;
}

export type PolicyId = "valve-v0" | "naive-edit-first" | "test-always" | "act-always";

export interface StepRecord {
  step: number;
  action: CognitiveActionKind;
  detail: string;
  costTokens: number;
  latencyMs: number;
  /** Populated for TEST/VERIFY, from the real exit code. */
  exitCode?: number;
  successAfterStep?: boolean;
}

export interface BenchEpisode {
  taskId: string;
  policy: PolicyId;
  success: boolean;
  steps: StepRecord[];
  /** Frontier-equivalent reasoning calls: one per mutation applied. */
  frontierCalls: number;
  testRuns: number;
  totalCostTokens: number;
  totalLatencyMs: number;
  /**
   * Edits that were applied and later had to be undone by applying another
   * edit, inferred from the final file state not matching any single mutation.
   * This is the cost VALVE exists to avoid: reasoning that was thrown away.
   */
  mutationsApplied: string[];
  /**
   * A defect reached the oracle only after more than one edit had been applied
   * on top of the fix, i.e. wasted verification cycles.
   */
  stepsAfterFirstCorrect: number;
}
