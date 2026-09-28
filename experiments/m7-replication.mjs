import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { BenchEnvironment } from "../bench/cogbench/dist/environment.js"
import { POLICIES, POLICY_ORDER, utilityWins } from "../bench/cogbench/dist/policies.js"
import { runEpisode } from "../bench/cogbench/dist/runner.js"
import { tasks as developmentTasks } from "../bench/cogbench/dist/tasks.js"
import { replicationTasks } from "../bench/cogbench/dist/tasks-m7.js"

/**
 * M7: the replication run.
 *
 *   node experiments/m7-replication.mjs [--json]
 *
 * Pre-registered in `docs/protocols/m7-replication.md`, including the four outcomes and the order they
 * are tested in. This file applies that order rather than choosing one, which is the whole reason the
 * order was written down before the numbers existed.
 *
 * Writes `experiments/m7-replication/results.json` and prints the human table.
 *
 * The result object is built by `buildResults()` and written only when this file is run as a program, so
 * `m7-replication.test.mjs` can import the builder, run it, and fail if the committed JSON is not what a
 * fresh run produces. That sentence used to be an aspiration: the test only ever compared the file against
 * itself, so it stayed green while the harness moved underneath the recorded numbers.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(root, "experiments/m7-replication")

const PRIMARY_A = "verify-always"
const PRIMARY_B = "evidence-gated"
const CONTROLS = ["test-always", "valve-v0", "risk-adjusted", "confidence-threshold", "oracle-budgeted"]

/** The frozen policy sources. A byte here is a byte the M6 result depends on. */
const FROZEN = ["bench/cogbench/src/policies.ts", "bench/cogbench/src/policies-m6.ts"]

const sha256 = (path) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex")

/** Which mutations satisfy the oracle. Needed to locate a point of no return, and cheap enough to redo. */
const correctMutationIds = (task) => {
  const ids = []
  for (const mutation of task.mutations) {
    const env = new BenchEnvironment(task)
    try {
      env.applyMutation(mutation)
      if (env.verify().exitCode === 0) ids.push(mutation.id)
    } finally {
      env.cleanup()
    }
  }
  return ids
}

/**
 * Replays an action sequence and reports, at each step index, the evidence a policy could see.
 *
 * The divergence record has to say what each side knew when it chose differently, and the harness does not
 * keep the state per step. Replaying the recorded actions reconstructs it exactly, because the runner is
 * deterministic given the actions.
 */
const evidenceBeforeStep = (steps, upto) => {
  let lastTestExit
  let lastVerifyExit
  let editsApplied = 0
  for (const step of steps.slice(0, upto)) {
    if (step.action === "ACT") editsApplied++
    if (step.channel === "test") lastTestExit = step.exitCode
    if (step.channel === "verify") lastVerifyExit = step.exitCode
  }
  return { lastTestExit, lastVerifyExit, editsApplied, pendingEdits: editsApplied }
}

const evidenceName = ({ lastTestExit, lastVerifyExit }) => {
  if (lastVerifyExit !== undefined) return lastVerifyExit === 0 ? "oracle-green" : "oracle-red"
  if (lastTestExit !== undefined) return lastTestExit === 0 ? "local-green" : "local-red"
  return "no-evidence"
}

const runOn = (taskList) => {
  const episodes = []
  for (const task of taskList) {
    for (const policyId of POLICY_ORDER) {
      const policy = POLICIES[policyId]
      if (!policy) throw new Error(`no implementation for ${policyId}`)
      episodes.push({ task, episode: runEpisode({ task, policy, policyId }) })
    }
  }
  return episodes
}

const summarise = (rows) => ({
  tasks: rows.length,
  solved: rows.filter((r) => r.episode.success).length,
  escaped: rows.filter((r) => r.episode.escapedDefect).length,
  cheap: rows.reduce((a, r) => a + r.episode.testRuns, 0),
  oracle: rows.reduce((a, r) => a + r.episode.verifyRuns, 0),
  edits: rows.reduce((a, r) => a + r.episode.mutationsApplied.length, 0),
  steps: rows.reduce((a, r) => a + r.episode.stepCount, 0),
  cost: rows.reduce((a, r) => a + r.episode.totalCostTokens, 0),
  wastedSteps: rows.reduce((a, r) => a + r.episode.stepsAfterFirstCorrect, 0),
})

const actionDistribution = (rows) => {
  const counts = {}
  for (const { episode } of rows) {
    for (const step of episode.steps) counts[step.action] = (counts[step.action] ?? 0) + 1
  }
  return counts
}

/**
 * The first step at which the policy applied a flawed edit while a correct one was still available.
 *
 * A proxy, and declared as one in the protocol: "the point of no return" has no mechanical definition
 * here. This is the last moment a different choice could still have changed the outcome, and a task with
 * no such step says so rather than guessing.
 */
const firstUnrecoverable = (steps, task, correctIds) => {
  let remaining = new Set(task.mutations.map((m) => m.id))
  for (const step of steps) {
    if (step.action !== "ACT") continue
    const applied = step.detail.replace("applied ", "")
    remaining.delete(applied)
    const flawed = task.mutations.find((m) => m.id === applied)?.knownFlaw !== undefined
    if (flawed && [...remaining].some((id) => correctIds.includes(id))) {
      return { step: step.step, applied, stillAvailable: [...remaining].filter((id) => correctIds.includes(id)) }
    }
  }
  return null
}

const divergenceRecords = (rows, correctByTask) => {
  const byTask = new Map()
  for (const { task, episode } of rows) {
    const key = `${task.id}|${episode.policy}`
    byTask.set(key, { task, episode })
  }
  const records = []
  for (const task of replicationTasks) {
    const a = byTask.get(`${task.id}|${PRIMARY_A}`)
    const b = byTask.get(`${task.id}|${PRIMARY_B}`)
    const cheaper = Math.min(a.episode.totalCostTokens, b.episode.totalCostTokens)
    const costGap = Math.abs(a.episode.totalCostTokens - b.episode.totalCostTokens)
    const differsInOutcome = a.episode.success !== b.episode.success
    const differsInCost = cheaper > 0 && costGap >= cheaper * 0.1
    if (!differsInOutcome && !differsInCost) continue

    const firstStep = (() => {
      const max = Math.max(a.episode.steps.length, b.episode.steps.length)
      for (let i = 0; i < max; i++) {
        if (a.episode.steps[i]?.action !== b.episode.steps[i]?.action) return i
      }
      return -1
    })()

    const before = firstStep >= 0 ? evidenceBeforeStep(a.episode.steps, firstStep) : null
    records.push({
      task: task.id,
      family: task.family,
      reason: differsInOutcome ? "different success" : "cost gap of at least 10%",
      [PRIMARY_A]: {
        solved: a.episode.success,
        cost: a.episode.totalCostTokens,
        escaped: a.episode.escapedDefect,
        actions: a.episode.steps.map((s) => s.action),
      },
      [PRIMARY_B]: {
        solved: b.episode.success,
        cost: b.episode.totalCostTokens,
        escaped: b.episode.escapedDefect,
        actions: b.episode.steps.map((s) => s.action),
      },
      firstDivergenceStep: firstStep >= 0 ? firstStep + 1 : null,
      stateBeforeDivergence: before && {
        evidence: evidenceName(before),
        ...before,
        pendingAttempts: before.editsApplied > 0 ? 1 : 0,
      },
      actionVerifyAlways: firstStep >= 0 ? a.episode.steps[firstStep]?.action ?? null : null,
      actionEvidenceGated: firstStep >= 0 ? b.episode.steps[firstStep]?.action ?? null : null,
      outcomeDivergence: {
        solvedBy: a.episode.success ? PRIMARY_A : b.episode.success ? PRIMARY_B : "neither",
        costGap,
      },
      firstUnrecoverableStep: {
        [PRIMARY_A]: firstUnrecoverable(a.episode.steps, task, correctByTask[task.id]),
        [PRIMARY_B]: firstUnrecoverable(b.episode.steps, task, correctByTask[task.id]),
      },
    })
  }
  return records
}

export function buildResults() {
  // The whole record is assembled here and nowhere else. `m7-replication.mjs` used to build it at module
  // scope and only write it at the end, which left the recorded artefact unconnected to any measurement:
  // the test could check the file against itself and would pass no matter what the harness did. Exporting
  // the builder is what makes the claim in the header true, because a test can now call it and compare the
  // result against the committed JSON field by field.
  const rows = runOn(replicationTasks)
  const developmentRows = runOn(developmentTasks)

  const wins = utilityWins(rows.map(({ task, episode }) => ({ ...episode, taskId: task.id })))
  const correctByTask = Object.fromEntries(replicationTasks.map((t) => [t.id, correctMutationIds(t)]))

  const table = POLICY_ORDER.map((policy) => {
    const own = rows.filter((r) => r.episode.policy === policy)
    return { policy, ...summarise(own), bestUtilityOn: wins[policy] ?? 0, actions: actionDistribution(own) }
  })

  const of = (policy) => table.find((r) => r.policy === policy)
  const a = of(PRIMARY_A)
  const b = of(PRIMARY_B)

  // The order is fixed by the protocol and is not the flattering order. A safety failure is reported as one
  // even when the cost is better and the solved count is equal, because that is the only ordering that does
  // not let a cheap result buy a safety claim.
  const divergenceCount = divergenceRecords(rows, correctByTask).length
  const { outcome, reason } = (() => {
    if (b.escaped > 0 && a.escaped === 0) {
      return {
        outcome: "Safety failure",
        reason: `${PRIMARY_B} escaped ${b.escaped} defect(s) that ${PRIMARY_A} caught. Nothing else in this row matters.`,
      }
    }
    if (b.escaped === 0 && b.solved >= a.solved && b.cost < a.cost) {
      return {
        outcome: "Strong positive",
        reason: `${PRIMARY_B} escaped nothing, solved ${b.solved} against ${a.solved}, and cost ${b.cost} against ${a.cost}.`,
      }
    }
    if (b.escaped === 0 && b.cost < a.cost && b.solved < a.solved) {
      return {
        outcome: "Efficiency tradeoff",
        reason: `${PRIMARY_B} escaped nothing and cost ${b.cost} against ${a.cost}, but solved ${b.solved} against ${a.solved}.`,
      }
    }
    if (divergenceCount === 0) {
      return {
        outcome: "Uninformative",
        reason: `the two policies agree on every task, on both success and cost, so this corpus failed to discriminate. That is a statement about the corpus.`,
      }
    }
    return {
      outcome: "No advantage",
      reason: `${PRIMARY_B} solved ${b.solved} against ${a.solved} at a cost of ${b.cost} against ${a.cost}, which clears no bar in the protocol.`,
    }
  })()

  const familyBreakdown = Object.fromEntries(
    [...new Set(replicationTasks.map((t) => t.family))].map((family) => {
      const own = rows.filter((r) => r.task.family === family)
      return [family, Object.fromEntries(POLICY_ORDER.map((p) => [p, summarise(own.filter((r) => r.episode.policy === p)).solved]))]
    }),
  )

  const positionOfFirstCorrect = Object.fromEntries(
    Object.entries(correctByTask).map(([id, correct]) => [id, correct.length ? task_index(id, correct[0]) : null]),
  )
  function task_index(taskId, mutationId) {
    const task = replicationTasks.find((t) => t.id === taskId)
    return task.mutations.findIndex((m) => m.id === mutationId) + 1
  }
  const positionHistogram = {}
  for (const position of Object.values(positionOfFirstCorrect)) {
    if (position === null) continue
    positionHistogram[position] = (positionHistogram[position] ?? 0) + 1
  }

  const results = {
    schema: "valve-m7-replication/v1",
    protocol: "docs/protocols/m7-replication.md",
    authorConfound:
      "the author of these 24 fixtures has read all four M6 policies, so this is not a blind replication. " +
      "It is the largest weakness of the result and nothing in the corpus removes it.",
    frozen: Object.fromEntries(FROZEN.map((path) => [path, sha256(path)])),
    corpus: {
      tasks: replicationTasks.length,
      families: Object.fromEntries(
        [...new Set(replicationTasks.map((t) => t.family))].map((f) => [f, replicationTasks.filter((t) => t.family === f).length]),
      ),
      distinctFromDevelopmentCorpus: replicationTasks.every((t) => !developmentTasks.some((d) => d.id === t.id)),
      firstCorrectEditPosition: positionHistogram,
      tasksWhereAWrongFixPassesTheLocalTest: Object.values(correctByTask).length,
    },
    table,
    familyBreakdown,
    primary: { safetyReference: PRIMARY_A, m6Leader: PRIMARY_B },
    outcome: { name: outcome, reason },
    divergences: divergenceRecords(rows, correctByTask),
    m6DevelopmentCorpus: Object.fromEntries(
      POLICY_ORDER.map((p) => [
        p,
        (() => {
          const s = summarise(developmentRows.filter((r) => r.episode.policy === p))
          return { solved: s.solved, escaped: s.escaped, cost: s.cost, cheap: s.cheap, oracle: s.oracle }
        })(),
      ]),
    ),
    notMeasured: [
      "retrieval: a capsule is handed to the planner, so discovery is not exercised here either",
      "no task where the correct edit has to be composed from two edits rather than chosen from a list",
      "no real agent: every candidate edit is scripted, so this measures a gate over a short list and not a policy over open-ended work",
      "utility is compared only within a task, because each task prices success and defect escape differently",
    ],
  }

  return results
}

const printTable = (results) => {
  const num = (n) => n.toLocaleString("en-US")
  const table = results.table
  const a = table.find((r) => r.policy === PRIMARY_A)
  const b = table.find((r) => r.policy === PRIMARY_B)
  console.log(`M7 replication  ${results.corpus.tasks} unseen tasks, 3 per family, 8 families\n`)
  console.log("success = full oracle exit 0.  escaped = the policy believed a cheap green and the oracle disagreed.\n")
  const head = ["policy", "solved", "escaped", "cheap", "oracle", "edits", "cost", "best-on"]
  const widths = [22, 8, 8, 7, 8, 7, 11, 8]
  console.log(head.map((h, i) => h.padEnd(widths[i] ?? 0)).join(""))
  console.log("-".repeat(78))
  for (const row of table) {
    console.log(
      [
        row.policy.padEnd(22),
        `${row.solved}/${row.tasks}`.padEnd(8),
        String(row.escaped).padEnd(8),
        String(row.cheap).padEnd(7),
        String(row.oracle).padEnd(8),
        String(row.edits).padEnd(7),
        num(row.cost).padEnd(11),
        String(row.bestUtilityOn).padEnd(8),
      ].join(""),
    )
  }
  console.log(`\nOUTCOME: ${results.outcome.name}\n${results.outcome.reason}\n`)
  console.log(`primary comparison: ${PRIMARY_B} (${b.solved}/${b.tasks}, ${num(b.cost)}) against ${PRIMARY_A} (${a.solved}/${a.tasks}, ${num(a.cost)})`)
  console.log(`divergence records: ${results.divergences.length}`)
  console.log(`\nwrote ${join(OUT, "results.json")}`)
  console.log("\nCaveat: the fixtures were written by somebody who had read the policies, so this is a")
  console.log("replication and not a blind test. A blind corpus has to be built by someone else.")
}

const main = () => {
  const results = buildResults()
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
  if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2))
  else printTable(results)
}

// Only write and print when run as a program. A test that imports `buildResults` must not be the thing
// that regenerates the artefact it is checking, or the comparison would be a tautology.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
