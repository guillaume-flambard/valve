import type { CognitiveAction, CognitiveActionKind } from "@valve/schema"

/**
 * The action space a policy may choose from.
 *
 * Prices here are nominal only. Every cost the bench actually charges comes
 * from the task's own CostModel, because a single global price is exactly what
 * let a scheduler learn a rule that was an artifact of the benchmark.
 */
export const CANDIDATES: CognitiveAction[] = (
  [
    "ACT",
    "READ",
    "SEARCH",
    "TEST",
    "VERIFY",
    "REASON_FAST",
    "REASON_DEEP",
    "DELEGATE",
    "ASK_HUMAN",
    "STOP",
  ] as CognitiveActionKind[]
).map((kind) => ({
  kind,
  estimatedCost: 0,
  estimatedLatencyMs: 0,
  reversible: kind !== "ACT" && kind !== "DELEGATE",
}))
