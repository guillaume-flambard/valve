import { test } from "node:test"
import assert from "node:assert/strict"

import { BenchEnvironment } from "../bench/cogbench/dist/environment.js"
import { runEpisode, CANDIDATES } from "../bench/cogbench/dist/runner.js"
import { POLICIES, POLICY_ORDER } from "../bench/cogbench/dist/policies.js"
import { tasks } from "../bench/cogbench/dist/tasks.js"

const eachTask = (fn) => {
  for (const task of tasks) fn(task)
}

/**
 * A fixture whose documentation disagrees with its behaviour is worse than no
 * fixture, because every downstream number inherits the lie. These tests pin
 * the oracle verdict of every variant against the task's own exit code.
 */
test("every fixture matches its declared shape, and exactly one edit is right", () => {
  eachTask((task) => {
    const env = new BenchEnvironment(task)
    try {
      // A task that needs no change must pass untouched. A task that needs a
      // change must fail until one is applied. Assuming the second for all
      // tasks is what made family A impossible to score.
      const expectedInitial = task.startsSolved ? 0 : 1
      assert.equal(
        env.verify().exitCode,
        expectedInitial,
        task.startsSolved
          ? `${task.id}: declared already correct, but the oracle rejects it`
          : `${task.id}: the initial state already passes, so the task is solved before any edit`,
      )
    } finally {
      env.cleanup()
    }

    let passing = 0
    for (const mutation of task.mutations) {
      const mEnv = new BenchEnvironment(task)
      try {
        mEnv.applyMutation(mutation)
        const code = mEnv.verify().exitCode
        if (code === 0) passing++
        // A mutation that claims a known flaw must actually be rejected.
        if (mutation.knownFlaw) {
          assert.notEqual(
            code,
            0,
            `${task.id}/${mutation.id}: documented a flaw but the oracle accepts it`,
          )
        }
      } finally {
        mEnv.cleanup()
      }
    }

    if (task.startsSolved) {
      // Nothing may fix it, because there is nothing to fix. If an edit
      // helped, family A could not tell a policy that recognises "already
      // correct" from one that acts on reflex.
      assert.equal(
        passing,
        0,
        `${task.id}: already correct, but ${passing} edit(s) still pass`,
      )
    } else {
      assert.equal(
        passing,
        1,
        `${task.id}: expected exactly one passing edit, found ${passing}. ` +
          `A fixture with zero or several solutions cannot rank a policy.`,
      )
    }
  })
})

/** The regression that made every policy behave identically. */
test("a mutation is judged alone, not stacked on the previous one", () => {
  eachTask((task) => {
    const [first, second] = task.mutations
    if (!first || !second) return

    // first then second, versus second on its own, must be identical.
    const stacked = new BenchEnvironment(task)
    const alone = new BenchEnvironment(task)
    try {
      stacked.applyMutation(first)
      stacked.applyMutation(second)
      alone.applyMutation(second)
      assert.equal(
        stacked.snapshot(),
        alone.snapshot(),
        `${task.id}: edits must reset to the pristine state, otherwise the last edit always wins`,
      )
    } finally {
      stacked.cleanup()
      alone.cleanup()
    }
  })
})

/** A benchmark that cannot fail a policy measures nothing. */
test("the bench rejects a policy that never verifies", () => {
  for (const task of tasks) {
    const episode = runEpisode({ task, policy: POLICIES["act-always"], policyId: "act-always" })
    assert.equal(episode.testRuns, 0, `${task.id}: act-always ran no test`)
    // act-always applies every edit in order, so it lands on the last one.
    // With exactly one passing edit somewhere in the list, it is right only
    // by luck, and the fixture ordering must not hide that.
    const last = task.mutations.at(-1)
    assert.ok(last, "task has mutations")
    assert.equal(
      episode.success,
      last.knownFlaw === undefined,
      `${task.id}: act-always should not be able to solve the task by ordering alone`,
    )
  }
})

/**
 * The failure the bench was built to catch: VALVE proposing a dead action and
 * the harness spinning on it until the step limit.
 */
test("no policy spins on a dead branch", () => {
  eachTask((task) => {
    for (const policyId of POLICY_ORDER) {
      const policy = POLICIES[policyId]
      if (!policy) throw new Error(`missing policy ${policyId}`)
      const episode = runEpisode({ task, policy, policyId })

      // Reaching the step limit is not spinning: a policy can use every step
      // it is given and still terminate on a real decision. Spinning is
      // repeating the same operation and learning nothing from it, so that is
      // what is asserted.
      const repeatedVerdict = episode.steps
        .filter((s) => s.action === "TEST" || s.action === "VERIFY")
        .map((s) => `${s.action}:${s.exitCode}`)
      let maxIdenticalRun = 1
      let run = 1
      for (let i = 1; i < repeatedVerdict.length; i++) {
        run = repeatedVerdict[i] === repeatedVerdict[i - 1] ? run + 1 : 1
        if (run > maxIdenticalRun) maxIdenticalRun = run
      }
      assert.ok(
        maxIdenticalRun <= 2,
        `${policyId}/${task.id}: repeated the same check ${maxIdenticalRun}x, which is spinning`,
      )

      // A no-op edit repeated in a row is a loop by another name.
      const deadEdits = episode.steps.filter(
        (s) => s.action === "ACT" && s.detail === "no edits left to apply",
      ).length
      assert.ok(
        deadEdits <= 1,
        `${policyId}/${task.id}: ${deadEdits} dead-branch edits`,
      )
    }
  })
})

/** Success is the oracle's verdict, never the policy's own say-so. */
test("a policy that stops without acting is never recorded as successful", () => {
  const alwaysStop = () => "STOP"
  // Family A is declared already solved, so stopping IS correct there. This
  // invariant is about tasks that still need work.
  for (const task of tasks.filter((t) => !t.startsSolved)) {
    const episode = runEpisode({ task, policy: alwaysStop, policyId: "always-stop" })
    assert.equal(
      episode.success,
      false,
      `${task.id}: claiming to be done must not be enough`,
    )
    assert.equal(episode.steps.length, 1)
  }
})

test("a run emits the same NDJSON record kinds as the OpenCode shadow plugin", () => {
  const records = []
  const task = tasks[0]
  runEpisode({
    task,
    policy: POLICIES["valve-v0"],
    policyId: "valve-v0",
    spool: { write: (r) => records.push(r) },
  })

  const kinds = new Set(records.map((r) => r["kind"]))
  assert.ok(kinds.has("episode_open"), "records the goal")
  assert.ok(kinds.has("tool_result"), "records each operation")
  assert.ok(kinds.has("episode_close"), "records the boundary")

  for (const record of records) {
    assert.equal(record["v"], 1, "records carry the schema version")
    assert.equal(typeof record["sessionID"], "string")
    assert.equal(typeof record["ts"], "number")
  }

  // The bench must be ingestible by the same reader as real sessions.
  const sessionIds = new Set(records.map((r) => r["sessionID"]))
  assert.equal(sessionIds.size, 1, "one episode per run")
})

test("candidates cover every operation a policy may propose", () => {
  const kinds = new Set(CANDIDATES.map((c) => c.kind))
  for (const required of ["ACT", "READ", "SEARCH", "TEST", "VERIFY", "STOP"]) {
    assert.ok(kinds.has(required), `missing candidate ${required}`)
  }
  for (const candidate of CANDIDATES) {
    assert.ok(candidate.estimatedCost >= 0)
    assert.ok(candidate.estimatedLatencyMs >= 0)
  }
})
