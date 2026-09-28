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

  // The historical claim survives: V0 remains dominated.
  assert.ok(v0.solved <= safety.solved, "V0 still solves no more than the safety bound")
  assert.ok(v0.cost >= safety.cost, "V0 still costs no less than the safety bound")

  // The M6 claim, which is weaker and must be stated accurately.
  assert.ok(
    gated.solved > v0.solved,
    `evidence-gated must beat V0 on success (${gated.solved} vs ${v0.solved})`,
  )
  assert.equal(gated.escaped, 0, "and ship no defects")
  assert.ok(
    gated.solved < safety.solved,
    `evidence-gated does NOT yet match the safety bound (${gated.solved} vs ${safety.solved}). ` +
      `If this assertion is removed, the headline claim must change with it.`,
  )
})
