import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { runEpisode } from "../bench/cogbench/dist/runner.js"
import { POLICIES, POLICY_ORDER } from "../bench/cogbench/dist/policies.js"
import { tasks } from "../bench/cogbench/dist/tasks.js"

/**
 * M6 guards.
 *
 * The failure mode this milestone has to avoid is writing a policy that reads
 * the benchmark's own taxonomy. A family label is an analyst's grouping, not
 * something an agent can observe at decision time, so a policy that branches on
 * it is a lookup table dressed as a strategy. It would score well here and mean
 * nothing on the replication corpus.
 *
 * It is checked by scanning the policy sources, because that is the only place
 * the cheat can be introduced.
 */

const POLICY_SOURCES = [
  "bench/cogbench/dist/policies-m6.js",
  "bench/cogbench/dist/policies.js",
]

test("no policy branches on the benchmark's own family taxonomy", () => {
  for (const path of POLICY_SOURCES) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    // Strip comments so prose about the families is not mistaken for a branch.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    assert.ok(
      !/\.family\b/.test(code),
      `${path} reads task.family. Families are an analyst's grouping; a policy that ` +
        `branches on them is a lookup table and its score would not transfer.`,
    )
  }
})

test("no policy reads which edit is the correct one", () => {
  for (const path of POLICY_SOURCES) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    // knownFlaw is the fixture author's annotation. Reading it would be reading
    // the answer key.
    assert.ok(
      !/knownFlaw/.test(code),
      `${path} reads knownFlaw, which is the answer key.`,
    )
  }
})

test("M6 policies never ship a defect the cheap channel missed", () => {
  // The one property that matters most: whatever else a policy costs, it must
  // not end an episode believing a cheap green result that the oracle refutes.
  const gated = ["evidence-gated", "risk-adjusted", "confidence-threshold", "oracle-budgeted"]
  for (const id of gated) {
    const policy = POLICIES[id]
    if (!policy) throw new Error(`missing policy ${id}`)
    const budget = {
      total: 5,
      used: 0,
      available() {
        return this.used < this.total
      },
      spend() {
        if (this.used >= this.total) return false
        this.used++
        return true
      },
    }
    for (const task of tasks) {
      const ep = runEpisode({
        task,
        policy,
        policyId: id,
        oracleBudget: id === "oracle-budgeted" ? budget : undefined,
      })
      assert.equal(
        ep.escapedDefect,
        false,
        `${id}/${task.id}: shipped a defect its own evidence had missed`,
      )
    }
  }
})

test("no M6 policy burns its whole step budget", () => {
  const gated = ["evidence-gated", "risk-adjusted", "confidence-threshold", "oracle-budgeted"]
  for (const id of gated) {
    const policy = POLICIES[id]
    if (!policy) throw new Error(`missing policy ${id}`)
    for (const task of tasks) {
      const ep = runEpisode({ task, policy, policyId: id })
      const repeated = ep.steps
        .filter((s) => s.action === "TEST" || s.action === "VERIFY")
        .map((s) => `${s.action}:${s.exitCode}`)
      let run = 1
      let maxRun = 1
      for (let i = 1; i < repeated.length; i++) {
        run = repeated[i] === repeated[i - 1] ? run + 1 : 1
        if (run > maxRun) maxRun = run
      }
      assert.ok(maxRun <= 2, `${id}/${task.id}: repeated the same check ${maxRun}x`)
    }
  }
})

test("the safety bound is unchanged by M6", () => {
  // verify-always is the reference M6 is measured against. If it moves, the
  // comparison it is making is not the one ADR 0003 recorded.
  const policy = POLICIES["verify-always"]
  if (!policy) throw new Error("missing verify-always")
  let solved = 0
  let cost = 0
  let escaped = 0
  for (const task of tasks) {
    const ep = runEpisode({ task, policy, policyId: "verify-always" })
    if (ep.success) solved++
    cost += ep.totalCostTokens
    if (ep.escapedDefect) escaped++
  }
  assert.equal(solved, 7, "verify-always solved count changed")
  assert.equal(cost, 27500, "verify-always cost changed")
  assert.equal(escaped, 0)
})

test("the M6 result, stated so it cannot be quietly improved", () => {
  /**
   * DEVIATION, recorded here rather than only in the ADR, per ADR 0004: "The deviation is recorded in the
   * test that pins the numbers rather than only here, so anyone reading the pin sees it."
   *
   * M7 found a second copy of the fact ADR 0004 already cleared once. An edit invalidated
   * `lastTestExit` and `lastVerifyExit` but not `state.verification.tests`, which is the copy the gated
   * policies read. ADR 0005 measured the contamination and took the decision to fix and re-measure.
   *
   * What moved on the 8 development tasks, all measured after the fix:
   *
   *   policy            before                    after
   *   verify-always     7 / 27,500 / 0 escaped   7 / 27,500 / 0 escaped     UNCHANGED
   *   evidence-gated    6 / 25,700 / 0 escaped   7 / 28,320 / 0 escaped
   *   risk-adjusted     3 / 26,760 / 0 escaped   7 / 31,780 / 0 escaped
   *   valve-v0          3 / 35,740 / 0 escaped   5 / 20,340 / 3 escaped
   *   test-always       4 / 10,180 / 3 escaped   4 / 10,180 / 3 escaped     UNCHANGED
   *
   * `verify-always` is unchanged because it never reads `state.verification` in its decision path, which is
   * why one column of this table is provably untouched and why this is not a blanket re-baseline.
   */
  const run = (id) => {
    const policy = POLICIES[id]
    if (!policy) throw new Error(`missing policy ${id}`)
    let solved = 0
    let cost = 0
    let escaped = 0
    for (const task of tasks) {
      const ep = runEpisode({ task, policy, policyId: id })
      if (ep.success) solved++
      cost += ep.totalCostTokens
      if (ep.escapedDefect) escaped++
    }
    return { solved, cost, escaped }
  }

  const safety = run("verify-always")
  const v0 = run("valve-v0")
  const gated = run("evidence-gated")

  // Dominance on success survives, measured, and is asserted rather than assumed.
  assert.ok(v0.solved <= safety.solved, "V0 still solves no more than the safety bound")
  assert.ok(v0.solved < safety.solved, "and is strictly worse on success")

  // The M6 claim, which is weaker and must be stated accurately.
  assert.ok(
    gated.solved > v0.solved,
    `evidence-gated must beat V0 on success (${gated.solved} vs ${v0.solved})`,
  )
  assert.equal(gated.escaped, 0, "and ship no defects")

  // The M6 reasoning, carried forward with measured numbers. ADR 0004 refused to call a match on success
  // bought at a higher cost a Pareto improvement, and that reasoning is unchanged; only the numbers are.
  // M6: 6/8 at 1,800 UNDER the safety bound. Now: 7/8 at 820 OVER it. Pinned because if evidence-gated ever
  // becomes cheaper again, that is the moment the M6 claim has to be re-examined rather than inherited.
  assert.ok(
    gated.cost > safety.cost,
    `evidence-gated meets the safety bound on success but costs more than it ` +
      `(${gated.cost} vs ${safety.cost}), which is not a Pareto improvement`,
  )

  // WITHDRAWN, 2026-09-28, and the two withdrawals are not the same kind of withdrawal.
  //
  // 1. `v0.cost >= safety.cost` is gone because it is false. V0 is now 20,340 against 27,500: it became
  //    cheaper, because it no longer stops on a stale red and therefore no longer pays for the edits it
  //    used to make after the red. It is not replaced by the opposite assertion, because "cheaper" on its
  //    own is the flattering half of a claim whose unflattering half is 3 escaped defects, and this file
  //    has no standing to assert that trade on its own. It is ADR 0005's open decision.
  //
  // 2. `gated.solved < safety.solved` is gone because it is false, and the assertion said itself what
  //    happens when it is: "If this assertion is removed, the headline claim must change with it." It has.
  //    evidence-gated is 7/8 against the safety bound's 7/8. The M6 headline that it "does not meet the
  //    bar" is withdrawn in ADR 0004, and what replaces it is that it reaches the bar at 28,320 against
  //    27,500, which is 820 MORE rather than the 1,800 less ADR 0004 recorded. Meeting the bar on success
  //    while costing more is a different claim from the one M6 made, and ADR 0004 says so rather than this
  //    test quietly inheriting a stronger one.
})
