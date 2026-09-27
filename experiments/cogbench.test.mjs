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
test("every fixture starts broken, and only its intended fix passes", () => {
  eachTask((task) => {
    const env = new BenchEnvironment(task)
    try {
      assert.equal(
        env.verify().exitCode,
        1,
        `${task.id}: the initial state must fail its own oracle, or the task is already solved`,
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

    assert.equal(
      passing,
      1,
      `${task.id}: expected exactly one passing edit, found ${passing}. ` +
        `A fixture with zero or several solutions cannot rank a policy.`,
    )
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

      assert.ok(
        episode.steps.length < task.budget.maxSteps,
        `${policyId}/${task.id}: ran to the step limit, which means it looped`,
      )

      // A no-op edit repeated in a row is a loop by another name.
      const consecutiveNoopEdits = episode.steps.filter(
        (s) => s.action === "ACT" && s.detail === "no edits left to apply",
      ).length
      assert.ok(
        consecutiveNoopEdits <= 1,
        `${policyId}/${task.id}: ${consecutiveNoopEdits} dead-branch edits`,
      )
    }
  })
})

/** Success is the oracle's verdict, never the policy's own say-so. */
test("a policy that stops without acting is never recorded as successful", () => {
  const alwaysStop = () => "STOP"
  eachTask((task) => {
    const episode = runEpisode({ task, policy: alwaysStop, policyId: "always-stop" })
    assert.equal(
      episode.success,
      false,
      `${task.id}: claiming to be done must not be enough`,
    )
    assert.equal(episode.steps.length, 1)
  })
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
