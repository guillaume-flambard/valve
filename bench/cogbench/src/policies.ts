import { createValveV0 } from "@valve/runtime"
import { CANDIDATES } from "./candidates.js"
import type { BenchTask, Policy, PolicyContext } from "./runner.js"
import type { PolicyId } from "./types.js"

/**
 * The policies CogBench compares.
 *
 * M5 added two channels, so "always verify" is no longer a single idea. A
 * cheap partial test and a complete oracle are different actions with different
 * prices, and the interesting question is not how often to check but which
 * channel to check on. These baselines bracket that.
 */

/** VALVE-V0, unchanged. M5 changed the benchmark, not the policy. */
export const valveV0Policy: Policy = (state, _task, ctx) => {
  const valve = createValveV0()
  const decision = valve.decideSync({
    state,
    candidates: CANDIDATES,
    utilityProfile: "coding-correctness",
  })
  // The heuristic layer is untouched. Two guards are added, and both ask
  // questions M4 made answerable: has the oracle already passed, and has the
  // world moved since anyone last looked?
  //
  // The first guard is not optional. Without it a task that still has edits
  // available re-runs an already-green oracle until it hits the step limit,
  // because nothing in the heuristics distinguishes "the oracle passed" from
  // "I have not checked yet".
  if (ctx.lastVerifyExit === 0) return "STOP"
  if (ctx.remainingMutations.length === 0) {
    // Nothing left to try. A red oracle is a dead end, and re-running it is
    // how a policy burns its step budget learning nothing.
    if (ctx.lastVerifyExit === 1) return "STOP"
    return state.metadata?.["unverifiedDelta"] ? "VERIFY" : "STOP"
  }
  return decision.action
}

/**
 * The M3 control: edit until the edits run out, then stop. Kept so the ADR 0001
 * result stays reproducible, and because in a world with an expensive oracle it
 * is a genuinely tempting strategy.
 */
export const naiveEditFirstPolicy: Policy = (_state, _task, ctx) => {
  if (ctx.remainingMutations.length > 0) return "ACT"
  return "STOP"
}

/**
 * Constant cheap checking. The reflexive answer to "should we verify more?".
 * Safe when the local test is trustworthy, and quietly unsafe on family D,
 * where it passes on a wrong fix.
 */
export const testAlwaysPolicy: Policy = (state, _task, ctx) => {
  if (ctx.lastVerifyExit === 0) return "STOP"
  // Trusts the cheap channel: a green local test ends the episode. This is the
  // reflex the misleading-signal family exists to punish, and it is the reason
  // that family has any discriminative power at all. A version that kept
  // editing after a green local test would simply exhaust the edit list and
  // never ship a defect, which would make the family measure nothing.
  if (ctx.lastTestExit === 0) return "STOP"
  if (ctx.remainingMutations.length === 0) {
    // The cheap channel said passing, so it stops. On the misleading-signal
    // family that is precisely how a defect escapes. A red oracle with no
    // edits left is a dead branch, not a reason to re-run it.
    if (state.verification.tests === "passed") return "STOP"
    return ctx.lastVerifyExit === 1 ? "STOP" : "VERIFY"
  }
  if (state.metadata?.["unverifiedDelta"]) return "TEST"
  if (ctx.step === 1) return "READ"
  return "ACT"
}

/**
 * Constant complete checking. The safety reference: it cannot ship a defect,
 * because the oracle is the thing it runs.
 */
export const verifyAlwaysPolicy: Policy = (state, _task, ctx) => {
  if (ctx.lastVerifyExit === 0) return "STOP"
  if (ctx.remainingMutations.length === 0) {
    // Nothing left to try. A red oracle is a dead end, and re-running it is
    // how a policy burns its step budget learning nothing.
    if (ctx.lastVerifyExit === 1) return "STOP"
    return state.metadata?.["unverifiedDelta"] ? "VERIFY" : "STOP"
  }
  // Ask the question directly instead of inferring it from the last action.
  // An edit that has not been checked is checked before the next edit is made,
  // which is what stops a run of edits from landing on whichever was last.
  if (state.metadata?.["unverifiedDelta"]) return "VERIFY"
  if (ctx.step === 1) return "READ"
  return "ACT"
}

/** Never checks anything. Solves by ordering luck alone. */
export const actAlwaysPolicy: Policy = (_state, _task, ctx) =>
  ctx.remainingMutations.length > 0 ? "ACT" : "STOP"

/**
 * Never edits. The floor: it must lose every task that needs a change, and it
 * is the only policy that should be allowed to win on family A, where doing
 * nothing is the correct move.
 */
export const stopImmediatelyPolicy: Policy = () => "STOP"

export const POLICIES: Record<PolicyId, Policy> = {
  "valve-v0": valveV0Policy,
  "naive-edit-first": naiveEditFirstPolicy,
  "test-always": testAlwaysPolicy,
  "verify-always": verifyAlwaysPolicy,
  "act-always": actAlwaysPolicy,
  "stop-immediately": stopImmediatelyPolicy,
}

/**
 * Order matters for reading the table: the safety references first, then the
 * cheap strategies, then the scheduler being evaluated.
 */
export const POLICY_ORDER: PolicyId[] = [
  "verify-always",
  "test-always",
  "valve-v0",
  "naive-edit-first",
  "act-always",
  "stop-immediately",
]

export interface EpisodeLike {
  taskId: string
  policy: string
  success: boolean
  utility: number
  totalCostTokens: number
  escapedDefect: boolean
}

/**
 * Cost and safety of a policy across a set of tasks.
 *
 * `totalUtility` is deliberately absent. Success is priced per task, from 6,000
 * on a routine fix to 70,000 where an escaped defect is catastrophic, so
 * summing utility across tasks adds numbers that are not on the same scale and
 * produces a ranking that means nothing. Utility is only comparable within a
 * single task, and `utilityWins` below is the aggregate that respects that.
 */
export function summarise(episodes: EpisodeLike[]) {
  const solved = episodes.filter((e) => e.success).length
  return {
    tasks: episodes.length,
    solved,
    successRate: episodes.length === 0 ? 0 : solved / episodes.length,
    escapedDefects: episodes.filter((e) => e.escapedDefect).length,
    totalCostTokens: episodes.reduce((a, e) => a + e.totalCostTokens, 0),
  }
}

/**
 * How many tasks each policy has the highest utility on.
 *
 * This is the only cross-task comparison the cost model supports, because each
 * task carries its own prices. A policy that wins here has found the cheapest
 * safe strategy *for that task's* trade-off, which is the property of interest.
 */
export function utilityWins(episodes: EpisodeLike[]): Record<string, number> {
  const byTask = new Map<string, EpisodeLike[]>()
  for (const e of episodes) {
    const list = byTask.get(e.taskId)
    if (list) list.push(e)
    else byTask.set(e.taskId, [e])
  }
  const wins: Record<string, number> = {}
  for (const [, rows] of byTask) {
    let best: EpisodeLike | undefined
    for (const row of rows) if (!best || row.utility > best.utility) best = row
    if (best) wins[best.policy] = (wins[best.policy] ?? 0) + 1
  }
  return wins
}

export type { BenchTask }
