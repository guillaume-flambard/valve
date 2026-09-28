import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { replicationTasks } from "../bench/cogbench/dist/tasks-m7.js"
import { tasks as developmentTasks } from "../bench/cogbench/dist/tasks.js"

/**
 * M7 guards.
 *
 * The result is only worth what these four things are worth:
 *
 *   1. the policies were frozen, so the number describes a comparison and not a rewrite
 *   2. the corpus is 24 real, honest, independent tasks, and not the 8 development fixtures renamed
 *   3. the fixture sweep passes, so no number rests on a fixture that lies about itself
 *   4. the recorded result is what a fresh run produces, and its outcome letter is the one the
 *      pre-registered derivation gives rather than one chosen afterwards
 *
 * A harness bug found by the replication is not patched here. It is reported, and the decision to
 * re-measure belongs in an ADR with the numbers that move written down.
 */

const root = new URL("../", import.meta.url)

const read = (path) => readFileSync(new URL(path, root), "utf8")
const sha256 = (path) => createHash("sha256").update(read(path)).digest("hex")

/** The files the protocol froze, before the corpus existed. */
const FROZEN_FILES = [
  "bench/cogbench/src/policies.ts",
  "bench/cogbench/src/policies-m6.ts",
  "bench/cogbench/src/runner.ts",
  "bench/cogbench/src/tasks.ts",
]

test("the frozen files are the ones the protocol hashed, byte for byte", () => {
  const protocol = read("docs/protocols/m7-replication.md")
  for (const path of FROZEN_FILES) {
    const actual = sha256(path)
    assert.ok(
      protocol.includes(actual),
      `${path} hashes to ${actual}, which is not in the protocol. A freeze that is not recorded as a ` +
        `hash is a promise, and this result would then describe a comparison nobody can reproduce.`,
    )
  }
})

test("no policy can read the replication corpus, the family taxonomy, or the answer key", () => {
  for (const path of ["bench/cogbench/src/policies.ts", "bench/cogbench/src/policies-m6.ts"]) {
    const code = read(path)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    // Families are an analyst's grouping. A policy that branches on them is a lookup table, and its
    // score would not transfer to a corpus it was not written against.
    assert.ok(!/\.family\b/.test(code), `${path} reads task.family`)
    // knownFlaw is the fixture author's annotation: the answer key.
    assert.ok(!/knownFlaw/.test(code), `${path} reads knownFlaw`)
    // M7 adds one more door: the replication corpus itself, or its per-task metadata.
    assert.ok(!/replicationTasks|tasks-m7|startsSolved/.test(code), `${path} reads the corpus or its metadata`)
  }
})

test("the corpus is 24 tasks, three per family, and none of them is a development fixture", () => {
  assert.equal(replicationTasks.length, 24)
  const families = new Map()
  for (const task of replicationTasks) {
    families.set(task.family, (families.get(task.family) ?? 0) + 1)
  }
  assert.equal(families.size, 8, "eight families, as the M5 benchmark fixed")
  for (const [family, count] of families) {
    assert.equal(count, 3, `${family} has ${count} instances, and the protocol declares three`)
  }
  const devIds = new Set(developmentTasks.map((t) => t.id))
  const devNames = new Set(developmentTasks.map((t) => t.name))
  for (const task of replicationTasks) {
    assert.ok(!devIds.has(task.id), `${task.id} is a development fixture id`)
    assert.ok(!devNames.has(task.name), `${task.name} is a development fixture name`)
  }
  // The modules the two corpora live in must not have been merged, or the M6 pins are measuring the
  // replication corpus.
  assert.ok(
    !read("bench/cogbench/src/tasks.ts").includes("tasks-m7"),
    "tasks.ts must not import the replication corpus: the M6 result is pinned against 8 fixtures",
  )
})

test("every fixture is honest before any policy touches it", () => {
  // Run the sweep as a child process so the test and the pre-run sweep are the same program, and so a
  // fixture problem fails the build rather than being noticed in a log.
  try {
    execFileSync(process.execPath, ["experiments/verify-m7-fixtures.mjs"], {
      cwd: new URL(".", root).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`
    assert.fail(`the M7 fixture sweep failed, so no number from this corpus means anything:\n${out}`)
  }
})

test("the recorded result is a fresh run, and its outcome is the pre-registered one", () => {
  const recorded = JSON.parse(read("experiments/m7-replication/results.json"))
  assert.equal(recorded.protocol, "docs/protocols/m7-replication.md")

  // The four-way table, in the order the protocol fixes. A safety failure outranks a good result,
  // because that ordering is the one that does not let a cheap result buy a safety claim.
  const a = recorded.table.find((r) => r.policy === "verify-always")
  const b = recorded.table.find((r) => r.policy === "evidence-gated")
  assert.ok(a && b, "both primary policies are in the table")

  const expected =
    b.escaped > 0 && a.escaped === 0
      ? "Safety failure"
      : b.escaped === 0 && b.solved >= a.solved && b.cost < a.cost
        ? "Strong positive"
        : b.escaped === 0 && b.cost < a.cost && b.solved < a.solved
          ? "Efficiency tradeoff"
          : recorded.divergences.length === 0
            ? "Uninformative"
            : "No advantage"
  assert.equal(recorded.outcome.name, expected, "the outcome letter has to be the one the table gives")

  // The gate the safety claim rests on, stated on its own so it cannot be read off a column.
  if (recorded.outcome.name !== "Safety failure") {
    assert.equal(b.escaped, 0, "a result that is not a safety failure must have escaped nothing")
  }

  // The corpus the numbers came from is stated in the same file as the numbers.
  assert.equal(recorded.corpus.tasks, 24)
  assert.ok(
    recorded.authorConfound && recorded.authorConfound.includes("not a blind replication"),
    "the author confound travels with the numbers, not in a footnote nobody reads",
  )
})

test("the divergence records say what each policy knew when it chose differently", () => {
  const recorded = JSON.parse(read("experiments/m7-replication/results.json"))
  for (const record of recorded.divergences) {
    assert.ok(record.task, "a divergence names its task")
    assert.ok(
      record.reason === "different success" || record.reason.startsWith("cost gap"),
      `a divergence declares why it was recorded: ${record.reason}`,
    )
    assert.ok(record.stateBeforeDivergence, `${record.task}: the state before the divergence is recorded`)
    assert.ok(
      ["no-evidence", "local-red", "local-green", "oracle-red", "oracle-green"].includes(
        record.stateBeforeDivergence.evidence,
      ),
      `${record.task}: the evidence has to be one of the five the contract defines`,
    )
    assert.ok(
      record.actionVerifyAlways !== undefined && record.actionEvidenceGated !== undefined,
      `${record.task}: both actions are recorded`,
    )
    // The point of no return is a declared proxy, so a task with no such step says so.
    for (const policy of ["verify-always", "evidence-gated"]) {
      const point = record.firstUnrecoverableStep[policy]
      assert.ok(
        point === null || (Number.isInteger(point.step) && Array.isArray(point.stillAvailable)),
        `${record.task}/${policy}: a point of no return is either absent or carries the edits that were still available`,
      )
    }
  }
})
