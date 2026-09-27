import { createValveV0 } from "@valve/runtime"
import type { CognitiveActionKind, CognitiveState } from "@valve/schema"
import { CANDIDATES } from "./runner.js"
import type { BenchTask, PolicyId, Policy, PolicyContext } from "./runner.js"

/**
 * VALVE-V0 as a bench policy.
 *
 * Uses the same `decideSync` path the shadow observer uses, so the bench
 * measures the policy that is actually observing you right now. It is
 * heuristics only: no network, no teacher model. What the bench measures is
 * therefore the V0 heuristic set, not a trained controller, and the number
 * should be read as a floor rather than as VALVE's ceiling.
 *
 * The guard below is not a thumb on the scale. VALVE sees candidate operations
 * and their costs; it does not know which are still executable. Proposing an
 * edit when no edit is left is proposing a dead action, and the bench caught
 * the raw policy spinning on that dead branch until it hit the step limit. The
 * guard maps a dead proposal onto a live one, which is a property of the
 * harness, not a claim about the policy.
 */
export const valveV0Policy: Policy = (state, _task, ctx) => {
  const valve = createValveV0()
  const decision = valve.decideSync({
    state,
    candidates: CANDIDATES,
    utilityProfile: "coding-correctness",
  })

  // Already verified: nothing further can improve on a passing oracle.
  if (state.verification.tests === "passed") return "STOP"

  if (decision.action === "ACT" && ctx.remainingMutations.length === 0) {
    // Dead branch: no edit is left to make. Verify the final state once so the
    // outcome is known, then stop. Mapping this straight onto TEST instead
    // produced an endless loop of re-running a test that had just failed,
    // because "tests are failing" is itself what proposes the dead edit.
    const last = state.recentActions.at(-1)?.action
    return last === "TEST" || last === "VERIFY" ? "STOP" : "TEST"
  }

  return decision.action
}

/**
 * Baseline A: the behaviour shadow data actually shows most often. Edit until
 * the edits run out, then verify once at the end.
 *
 * This is the honest control. It is not a strawman: it is what an agent does
 * when it treats reasoning as the default and verification as a formality.
 */
export const naiveEditFirstPolicy: Policy = (state, _task, ctx) => {
  if (ctx.remainingMutations.length > 0) return "ACT"
  // Every edit is spent. Verify once and finish.
  //
  // It does not react to a failing oracle, which is exactly the behaviour
  // being measured. An earlier version returned TEST while the tests were red,
  // which sent it into an unbounded loop re-running a test it had just seen
  // fail. That is not a more interesting baseline, it is a broken one: it
  // ends the episode with no information the runner did not already have.
  void state
  return "STOP"
}

/**
 * Baseline B: maximal verification. Tests after every single step.
 *
 * Included because it is the reflexive response to "should we verify more?".
 * It should be safe and it should be expensive, and the bench exists to put a
 * number on both halves of that sentence rather than asserting them.
 */
export const testAlwaysPolicy: Policy = (state, _task, ctx) => {
  // A passing oracle is terminal. Without this the policy kept editing after
  // it had already succeeded and destroyed its own fix, which made it look
  // worse than doing nothing.
  if (state.verification.tests === "passed") return "STOP"
  if (ctx.remainingMutations.length === 0) return "STOP"
  // Verify, then immediately make progress, so the episode can still finish.
  return state.recentActions.at(-1)?.action === "TEST" ? "ACT" : "TEST"
}

/**
 * Baseline C: never verify. A frontier model that simply keeps editing.
 *
 * This is the condition VALVE's StopHead and Value-of-Information head exist
 * to detect, and it is the only baseline that can be expected to fail.
 */
export const actAlwaysPolicy: Policy = (_state, _task, ctx) =>
  ctx.remainingMutations.length > 0 ? "ACT" : "STOP"

export const POLICIES: Record<PolicyId, Policy> = {
  "valve-v0": valveV0Policy,
  "naive-edit-first": naiveEditFirstPolicy,
  "test-always": testAlwaysPolicy,
  "act-always": actAlwaysPolicy,
}

export const POLICY_ORDER: PolicyId[] = [
  "naive-edit-first",
  "valve-v0",
  "test-always",
  "act-always",
]
