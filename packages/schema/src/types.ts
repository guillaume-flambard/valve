import type { Grounding, Provenance } from "./attempt.js";

export type CognitiveActionKind =
  | "ACT"
  | "READ"
  | "SEARCH"
  | "TEST"
  | "VERIFY"
  | "REASON_FAST"
  | "REASON_DEEP"
  | "DELEGATE"
  | "ASK_HUMAN"
  | "STOP";

/**
 * What a step was actually recorded as.
 *
 * `UNKNOWN` is a real recorded value, not a gap. It is deliberately not part of
 * the action space: a scheduler must never *choose* it, and nothing may fall
 * back to a plausible neighbour on its behalf. An unrecognised tool is stored
 * as UNKNOWN, counted, and excluded from training, because the alternative is
 * a corpus that looks complete and is quietly wrong.
 */
export type OperationLabel = CognitiveActionKind | "UNKNOWN";

export interface CognitiveAction {
  kind: CognitiveActionKind;
  estimatedCost: number;
  estimatedLatencyMs: number;
  reversible: boolean;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface Evidence {
  id: string;
  source: "file" | "tool" | "test" | "build" | "human" | "memory" | "search";
  content: string;
  relevance: number;
  timestamp: number;
}

export interface Uncertainty {
  id: string;
  description: string;
  severity: number;
  relatedActions: CognitiveActionKind[];
}

export interface Constraint {
  id: string;
  description: string;
  type: "hard" | "soft";
  source: "user" | "system" | "architecture" | "policy";
}

export type ActionSummary = {
  /**
   * What happened, which may be UNKNOWN. A chronology records reality, and
   * reality includes steps the observer could not classify.
   */
  action: OperationLabel;
  timestamp: number;
  outcome: "success" | "failure" | "partial" | "unknown";
  cost: number;
  latencyMs: number;
  progressDelta?: number;
  /**
   * M4: the identity of the attempt this step corresponds to, when one was
   * opened. A chronology entry without one cannot be linked to a verdict, and
   * that is precisely the link V0 lacked.
   */
  attemptId?: string;
};

export interface VerificationStatus {
  build?: "pending" | "passed" | "failed" | "unknown";
  tests?: "pending" | "passed" | "failed" | "unknown";
  qa?: "pending" | "passed" | "failed" | "unknown";
}

export interface Resources {
  contextTokens: number;
  remainingBudget?: number;
  elapsedMs: number;
}

export interface Authority {
  canWrite: boolean;
  canDelete: boolean;
  canAskHuman: boolean;
}

export interface CognitiveState {
  goal: string;
  progress: number;
  currentTask: string;
  evidence: Evidence[];
  uncertainties: Uncertainty[];
  constraints: Constraint[];
  /**
   * Chronology: what was done, in order.
   *
   * Kept, because it is cheap and occasionally the right question. It is not
   * sufficient on its own: a run of three edits reads identically whether each
   * was judged and rejected or whether they were stacked and judged once, and
   * those two states call for opposite next actions.
   */
  recentActions: ActionSummary[];
  verification: VerificationStatus;
  resources: Resources;
  authority: Authority;
  metadata?: Record<string, unknown>;

  // --- M4: the epistemology, alongside the chronology ---

  /**
   * Fingerprint of the last state known to be good. Compared against
   * `currentCheckpoint` this answers "is there an unverified change?", which is
   * the question V0 could not ask.
   */
  verifiedCheckpoint?: string;
  /** Fingerprint of the state as it is now, verified or not. */
  currentCheckpoint?: string;
  /** Attempts made and not yet judged. `pending` verdicts live here. */
  pendingAttempts?: import("./attempt.js").Attempt[];
  /** Attempts the oracle rejected, kept even after a rollback. */
  falsifiedAttempts?: import("./attempt.js").Attempt[];
}

export type UtilityProfileName =
  | "coding-balanced"
  | "coding-correctness"
  | "coding-speed"
  | "interactive-ui"
  | "production-migration"
  | "research"
  | "custom";

export interface UtilityProfile {
  name: UtilityProfileName;
  weights: {
    taskSuccess: number;
    progress: number;
    informationGain: number;
    tokenCost: number;
    latencyCost: number;
    humanInterruptionCost: number;
    regressionCost: number;
    unnecessaryStepCost: number;
  };
}

export const DEFAULT_UTILITY_PROFILES: Record<UtilityProfileName, UtilityProfile> = {
  "coding-balanced": {
    name: "coding-balanced",
    weights: {
      taskSuccess: 10,
      progress: 3,
      informationGain: 2,
      tokenCost: 0.00001,
      latencyCost: 0.001,
      humanInterruptionCost: 4,
      regressionCost: 8,
      unnecessaryStepCost: 0.5,
    },
  },
  "coding-correctness": {
    name: "coding-correctness",
    weights: {
      taskSuccess: 15,
      progress: 2,
      informationGain: 3,
      tokenCost: 0.000005,
      latencyCost: 0.0005,
      humanInterruptionCost: 6,
      regressionCost: 15,
      unnecessaryStepCost: 0.3,
    },
  },
  "coding-speed": {
    name: "coding-speed",
    weights: {
      taskSuccess: 8,
      progress: 4,
      informationGain: 1,
      tokenCost: 0.00002,
      latencyCost: 0.002,
      humanInterruptionCost: 3,
      regressionCost: 5,
      unnecessaryStepCost: 0.8,
    },
  },
  "interactive-ui": {
    name: "interactive-ui",
    weights: {
      taskSuccess: 8,
      progress: 3,
      informationGain: 1,
      tokenCost: 0.00001,
      latencyCost: 0.005,
      humanInterruptionCost: 2,
      regressionCost: 6,
      unnecessaryStepCost: 0.5,
    },
  },
  "production-migration": {
    name: "production-migration",
    weights: {
      taskSuccess: 12,
      progress: 1,
      informationGain: 4,
      tokenCost: 0.000001,
      latencyCost: 0.0001,
      humanInterruptionCost: 10,
      regressionCost: 25,
      unnecessaryStepCost: 0.1,
    },
  },
  "research": {
    name: "research",
    weights: {
      taskSuccess: 10,
      progress: 2,
      informationGain: 5,
      tokenCost: 0.00001,
      latencyCost: 0.001,
      humanInterruptionCost: 3,
      regressionCost: 5,
      unnecessaryStepCost: 0.5,
    },
  },
  "custom": {
    name: "custom",
    weights: {
      taskSuccess: 10,
      progress: 3,
      informationGain: 2,
      tokenCost: 0.00001,
      latencyCost: 0.001,
      humanInterruptionCost: 4,
      regressionCost: 8,
      unnecessaryStepCost: 0.5,
    },
  },
};

export interface DecisionInput {
  state: CognitiveState;
  candidates: CognitiveAction[];
  utilityProfile: UtilityProfileName;
}

export interface DecisionOutput {
  action: CognitiveActionKind;
  probability: number;
  expectedUtility: number;
  risk: number;
  informationGain: number;
  alternatives: Array<{
    action: CognitiveActionKind;
    expectedUtility: number;
    probability: number;
  }>;
  reasoning?: string;
  source: "heuristic" | "jev" | "teacher" | "model";
}

export interface ShadowPrediction {
  /** What VALVE would have done at this exact state. */
  action: CognitiveActionKind;
  probability: number;
  expectedUtility: number;
  risk: number;
  informationGain: number;
  /**
   * True when VALVE and the real agent picked the same operation.
   *
   * Absent when the ground-truth operation could not be grounded. Scoring an
   * ungrounded label as a disagreement would penalise the policy for a gap in
   * the observer rather than for a wrong decision, and the resulting
   * agreement rate would be quietly wrong.
   */
  agrees?: boolean;
}

export interface TrajectoryEvent {
  episodeId: string;
  step: number;
  timestamp: number;
  state: CognitiveState;
  candidates: CognitiveAction[];
  chosen: OperationLabel;
  source: "heuristic" | "jev" | "teacher" | "model" | "human";
  cost: {
    tokens: number;
    usd: number;
    latencyMs: number;
  };
  outcome: {
    progressDelta: number;
    uncertaintyDelta: number;
    failureDetected: boolean;
    taskSuccess: boolean | null;
    regressions: string[];
  };
  utilityProfile: UtilityProfileName;
  /**
   * Present in shadow mode only: what VALVE predicted while the real agent
   * stayed in control. The disagreement between `chosen` and `shadow.action`
   * is the primary training signal, so it is stored on the same row as the
   * ground truth rather than in a parallel table that can drift.
   */
  shadow?: ShadowPrediction;
  /**
   * M4: how the operation label was established, and how the outcome was
   * observed. A record whose label is not adequately grounded is retained for
   * inspection but must be excluded from training, because a quietly invented
   * action label is indistinguishable from a learned one once it is in the set.
   */
  grounding?: Grounding;
  provenance?: Provenance;
}

export interface Episode {
  id: string;
  taskId: string;
  startTime: number;
  endTime?: number;
  initialState: CognitiveState;
  finalState?: CognitiveState;
  events: TrajectoryEvent[];
  success: boolean;
  totalCost: {
    tokens: number;
    usd: number;
    latencyMs: number;
  };
  humanInterventions: number;
  utilityProfile: UtilityProfileName;
}

export interface CounterfactualRun {
  baseEventId: string;
  alternativeAction: CognitiveActionKind;
  simulatedOutcome: {
    progressDelta: number;
    uncertaintyDelta: number;
    failureDetected: boolean;
    taskSuccess: boolean | null;
    cost: { tokens: number; usd: number; latencyMs: number };
    futureSteps: number;
  };
}

export interface CogBenchTask {
  id: string;
  name: string;
  description: string;
  category: "fix-test" | "implement-feature" | "refactor" | "build-error" | "migrate" | "api-endpoint" | "visual-regression" | "dependency" | "performance";
  initialState: CognitiveState;
  allowedActions: CognitiveActionKind[];
  successCriteria: {
    testsPass: boolean;
    buildPass: boolean;
    behaviorMatch?: boolean;
    noRegressions: boolean;
  };
  budget: {
    maxTokens: number;
    maxSeconds: number;
    maxSteps?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface CogBenchResult {
  taskId: string;
  agentType: "baseline" | "valve" | "heuristic" | "jev" | "router";
  success: boolean;
  cost: { tokens: number; usd: number; latencyMs: number };
  steps: number;
  humanInterventions: number;
  escapedDefects: number;
  frontierCalls: number;
  trajectory: TrajectoryEvent[];
}