import type { BenchTask, Policy, PolicyContext } from "./runner.js"

/**
 * M6: evidence-acquisition policies.
 *
 * The question is no longer "how often should a policy check" but:
 *
 *     how much evidence is enough to avoid buying the full oracle?
 *
 * The loss is explicit. A check costs `costModel.verify`; shipping a defect
 * costs `costModel.defectEscape`; another edit costs `costModel.act` plus
 * frontier reasoning. The policies differ only in how they decide whether the
 * evidence already in hand is sufficient.
 *
 * A hard rule applies to all of them: **no policy may branch on `task.family`.**
 * The families exist to analyse results. A policy that reads its own
 * benchmark's taxonomy is a lookup table, and it would produce a number that
 * means nothing on the replication corpus. A test enforces this by scanning
 * these sources.
 */

/**
 * What the evidence in hand actually says.
 *
 * The distinction that matters, and the one an earlier draft of this file got
 * wrong three times: a *red* result is strong evidence. When the oracle or the
 * local test has already refuted the current state, re-running it buys nothing
 * and the only productive move is a different edit. Only a *green* cheap result
 * is genuinely ambiguous, because the cheap channel is the one that can be
 * fooled.
 */
type Evidence =
  | "no-evidence"
  /** A cheap test refuted the current edit. */
  | "local-red"
  /** A cheap test passed. Weak: this is the channel that can be fooled. */
  | "local-green"
  /** The oracle refuted the state. */
  | "oracle-red"
  /** The oracle passed. */
  | "oracle-green"

function evidenceOf(ctx: PolicyContext, testsStatus: string | undefined): Evidence {
  if (ctx.lastVerifyExit !== undefined) {
    return ctx.lastVerifyExit === 0 ? "oracle-green" : "oracle-red"
  }
  if (ctx.lastTestExit !== undefined) {
    return ctx.lastTestExit === 0 ? "local-green" : "local-red"
  }
  if (testsStatus === "passed") return "local-green"
  if (testsStatus === "failed") return "local-red"
  return "no-evidence"
}

/** Terminal states shared by every policy, so none of them can spin. */
function terminal(evidence: Evidence, editsLeft: number): "STOP" | "VERIFY" | null {
  if (evidence === "oracle-green") return "STOP"
  if (editsLeft > 0) return null
  // Nothing left to try. A refuted state is finished, not worth re-checking.
  if (evidence === "oracle-red" || evidence === "local-red") return "STOP"
  // No edits left and nothing has been said about the resulting state. Calling
  // this done is how a policy ships whatever the last edit happened to be, so
  // the state has to be examined before the episode can close. An earlier draft
  // returned STOP here and `evidence-gated` finished on family A having applied
  // a regression and never looked at it.
  return "VERIFY"
}

/**
 * An edit that nobody has looked at yet.
 *
 * The cheap channel exists to answer exactly one question, which is whether
 * the edit just made is already refuted. A policy that skips it has no
 * evidence to gate on, and degenerates into apply-everything-then-stop: the
 * first draft of this file did exactly that, running sixteen edits and not one
 * check, and scored identically to `act-always`.
 */
const hasUncheckedEdit = (ctx: PolicyContext) =>
  (ctx.attempts ?? []).some((a) => a.verdict === "pending")

/**
 * What to do with no evidence in hand.
 *
 * Order matters: look at the code first, then make an edit, then obtain cheap
 * evidence about that edit, and only then decide whether the oracle is needed.
 */
function unevidenced(ctx: PolicyContext): "READ" | "ACT" | "TEST" {
  if (hasUncheckedEdit(ctx)) return "TEST"
  if (ctx.step === 1) return "READ"
  return "ACT"
}

/**
 * M6-A `confidence-threshold`.
 *
 * The crudest signal: how many judged attempts have been refuted, and does that
 * fraction fall below a fixed tau. It knows the *rate* of failure but nothing
 * about which channel produced the evidence, so it cannot tell a cheap red from
 * an oracle red.
 */
export const confidenceThresholdPolicy = (tau = 0.5): Policy => (_state, _task, ctx) => {
  const judged = (ctx.attempts ?? []).filter((a) => a.verdict !== "pending")
  const rejected = judged.filter((a) => a.verdict === "falsified" || a.verdict === "unattributable")
  const confidence = judged.length === 0 ? 1 : (judged.length - rejected.length) / judged.length

  const evidence = evidenceOf(ctx, _state.verification.tests)
  const end = terminal(evidence, ctx.remainingMutations.length)
  if (end) return end

  if (evidence === "local-red" || evidence === "oracle-red") {
    return ctx.remainingMutations.length > 0 ? "ACT" : "STOP"
  }
  if (confidence < tau) return "VERIFY"
  return unevidenced(ctx)
}

/**
 * M6-B `evidence-gated`.
 *
 * Gates on the *nature* of the evidence rather than its quantity. Red is acted
 * on, because it is already conclusive. Green-cheap is the only ambiguous state
 * and is therefore the only one worth paying to resolve.
 */
export const evidenceGatedPolicy: Policy = (state, _task, ctx) => {
  const evidence = evidenceOf(ctx, state.verification.tests)
  const end = terminal(evidence, ctx.remainingMutations.length)
  if (end) return end

  switch (evidence) {
    case "local-green":
      return "VERIFY"
    case "local-red":
    case "oracle-red":
      return ctx.remainingMutations.length > 0 ? "ACT" : "STOP"
    default:
      return unevidenced(ctx)
  }
}

/**
 * M6-C `risk-adjusted`.
 *
 * The threshold is a price, not a constant. Buy the oracle when the expected
 * cost of shipping a wrong answer exceeds what the check costs:
 *
 *     P(escape) * defectEscape  >  costModel.verify
 *
 * This is the policy the thesis actually predicts, so it is the one that
 * matters. `P(escape)` comes from the evidence: high while a cheap test is
 * green and the oracle has not spoken, because the cheap channel is the one
 * that can be fooled; low once anything has spoken.
 */
export const riskAdjustedPolicy: Policy = (state, task, ctx) => {
  const evidence = evidenceOf(ctx, state.verification.tests)
  const end = terminal(evidence, ctx.remainingMutations.length)
  if (end) return end

  if (evidence === "local-red" || evidence === "oracle-red") {
    return ctx.remainingMutations.length > 0 ? "ACT" : "STOP"
  }

  // P(the cheap evidence is already sufficient).
  const pSufficient = evidence === "local-green" ? 0.4 : 0.15
  const expectedDefectCost = (1 - pSufficient) * task.costModel.defectEscape
  const checkCost = task.costModel.verify.tokens
  const editCost = task.costModel.act.tokens

  if (expectedDefectCost > checkCost) return "VERIFY"
  // The oracle is not worth its price. A cheap check is still worth having if
  // it costs less than the edits it would save us from making.
  if (expectedDefectCost <= editCost) return "TEST"

  return unevidenced(ctx)
}

/**
 * M6-D `oracle-budgeted`.
 *
 * The scheduling question rather than the gating question: with a fixed number
 * of oracle calls across the whole benchmark, where do they go?
 *
 * Spend is reserved for states where a check is genuinely due, and the reserve
 * is protected until the end of an episode, because mid-episode checks are the
 * ones that can be replaced by a cheap one. When the budget is gone the policy
 * degrades to the cheap channel rather than pretending otherwise, which is what
 * makes the spent-versus-unspent comparison honest.
 */
export const oracleBudgetedPolicy: Policy = (state, task, ctx) => {
  const evidence = evidenceOf(ctx, state.verification.tests)
  const end = terminal(evidence, ctx.remainingMutations.length)
  if (end) return end

  if (evidence === "local-red" || evidence === "oracle-red") {
    return ctx.remainingMutations.length > 0 ? "ACT" : "STOP"
  }

  const budget = ctx.oracleBudget
  const dueNow = evidence === "local-green"
  // Safety per token spent. A catastrophic defect behind a cheap oracle is the
  // best buy on the board; a mild defect behind an expensive one is not.
  const worth = task.costModel.defectEscape / Math.max(1, task.costModel.verify.tokens)

  if (dueNow && budget && budget.available() && worth >= 1) return "VERIFY"

  return unevidenced(ctx)
}

export type { BenchTask }
