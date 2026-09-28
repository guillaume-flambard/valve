import { test } from "node:test"
import assert from "node:assert/strict"

import { runEpisode } from "../bench/cogbench/dist/runner.js"
import { tasks } from "../bench/cogbench/dist/tasks.js"
import { replicationTasks } from "../bench/cogbench/dist/tasks-m7.js"

/**
 * Knowledge-free probes.
 *
 * The order the harness hands out candidate edits is a hidden channel. With a
 * fixed order, "apply every edit then stop" wins when the correct one is last,
 * and "apply exactly one edit then verify" wins when it is first. Both were
 * observed on a replication corpus built specifically to be unbiased: the
 * second scored 21 of 24, beating every genuine policy on the board.
 *
 * A probe is a strategy with no knowledge of correctness. If one of these
 * scores well, the corpus is measuring a lottery rather than a policy, and no
 * policy number taken from it means anything.
 *
 * This is a standing guard, not a one-off. ADR 0005 spread the correct edit's
 * position 8/6/7 across the corpus precisely to close the first version of this
 * exploit; the mirror image is just as available and nothing in the fixture
 * checker would have caught it.
 */

const SEEDS = 8

const applyAllEdits = (_s, _t, ctx) => (ctx.remainingMutations.length ? "ACT" : "VERIFY")
const applyOneEdit = (_s, _t, ctx) => ((ctx.attempts?.length ?? 0) === 0 ? "ACT" : "VERIFY")
const applyTwoEdits = (s, _t, ctx) =>
  (ctx.attempts?.length ?? 0) < 2 ? "ACT" : "VERIFY"
const neverVerify = () => "STOP"

function successRate(policy, pool) {
  let solved = 0
  let n = 0
  for (let seed = 0; seed < SEEDS; seed++) {
    for (const task of pool) {
      if (runEpisode({ task, policy, policyId: "probe", seed }).success) solved++
      n++
    }
  }
  return solved / n
}

test("no knowledge-free strategy can win either corpus", () => {
  const probes = [
    ["apply every edit then verify", applyAllEdits],
    ["apply exactly one edit then verify", applyOneEdit],
    ["apply exactly two edits then verify", applyTwoEdits],
    ["never verify at all", neverVerify],
  ]
  const pools = [
    ["replication", replicationTasks],
    ["development", tasks],
  ]
  for (const [pname, policy] of probes) {
    for (const [lname, pool] of pools) {
      const rate = successRate(policy, pool)
      assert.ok(
        rate < 0.6,
        `${pname} solves ${(rate * 100).toFixed(0)}% of the ${lname} corpus. ` +
          `A strategy with no knowledge of correctness is exploiting candidate order, so no ` +
          `policy number from this corpus means anything until it is fixed.`,
      )
    }
  }
})

test("candidate order is not a winning strategy on its own", () => {
  // A sharper form of the same guard. The spread of correct-edit positions is
  // what makes each fixed "apply N edits" strategy weak; this asserts the spread
  // is real rather than assuming it, because assuming it is what let the
  // original leak through.
  const positionOfCorrect = (task) => {
    for (let i = 0; i < task.mutations.length; i++) {
      const ep = runEpisode({
        task,
        policy: (_s, _t, ctx) => (ctx.remainingMutations.length ? "ACT" : "VERIFY"),
        policyId: "probe",
      })
      // Applied all edits, so the surviving state is the last one. Instead,
      // probe each position directly.
      void ep
      for (let j = 0; j < task.mutations.length; j++) {
        const e2 = runEpisode({
          task,
          policy: (_s, _t, ctx) => {
            const seen = ctx.attempts?.length ?? 0
            return seen <= j ? "ACT" : "VERIFY"
          },
          policyId: "probe",
        })
        if (e2.success) return j
      }
      return -1
    }
    return -1
  }

  const counts = new Map()
  let solvable = 0
  for (const task of replicationTasks) {
    if (task.startsSolved) continue
    const pos = positionOfCorrect(task)
    if (pos < 0) continue
    solvable++
    counts.set(pos, (counts.get(pos) ?? 0) + 1)
  }
  assert.ok(solvable >= 20, `expected most replication tasks to be solvable, got ${solvable}`)
  const positions = [...counts.keys()].sort()
  assert.ok(
    positions.length >= 2,
    `the correct edit sits at only one position (${positions.join(",")}) across the corpus, ` +
      `so applying a fixed number of edits is a strategy`,
  )
})
