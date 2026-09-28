#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { runEpisode, type ObservedSink } from "./runner.js"
import { POLICIES, POLICY_ORDER, summarise, utilityWins } from "./policies.js"
import { tasks, legacyTasks, tasksByFamily } from "./tasks.js"
import type { BenchEpisode, PolicyId } from "./types.js"

/**
 * CogBench runner.
 *
 *   node dist/cli.js [--spool <path>] [--family <id>] [--legacy] [--json]
 *
 * Reports escaped defects and net utility alongside success and cost, because
 * the question is not how often a policy checked but whether the checking was
 * worth what it cost and what it missed.
 */

const argv = process.argv.slice(2)
const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const spoolPath = arg("--spool")
const familyFilter = arg("--family")
const includeLegacy = argv.includes("--legacy")
const asJson = argv.includes("--json")

let sink
if (spoolPath) {
  mkdirSync(dirname(spoolPath), { recursive: true })
  writeFileSync(spoolPath, "")
  sink = {
    write(record: Record<string, unknown>) {
      appendFileSync(spoolPath, JSON.stringify(record) + "\n", "utf8")
    },
  }
}

const pool = includeLegacy ? [...tasks, ...legacyTasks] : [...tasks]
const selected = familyFilter ? pool.filter((t) => t.family === familyFilter) : pool
if (selected.length === 0) {
  console.error(`no task matches family ${familyFilter}`)
  process.exit(1)
}

const episodes: BenchEpisode[] = []
for (const task of selected) {
  for (const policyId of POLICY_ORDER) {
    const policy = POLICIES[policyId]
    if (!policy) throw new Error(`no implementation for ${policyId}`)
    episodes.push(runEpisode({ task, policy, policyId, spool: sink }))
  }
}

if (asJson) {
  console.log(JSON.stringify({ episodes }, null, 2))
  process.exit(0)
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`
const num = (n: number) => Math.round(n).toLocaleString("en-US")

console.log(`CogBench  ${selected.length} task(s)  ${includeLegacy ? "(incl. legacy M3)" : ""}`)
console.log("success = full oracle exit 0.  escaped = local test green, oracle red.\n")

const wins = utilityWins(episodes)

const header = ["policy", "solved", "escaped", "tests", "oracle", "cost", "best-on"]
const widths = [16, 8, 8, 7, 7, 10, 9]
console.log(header.map((h, i) => h.padEnd(widths[i] ?? 0)).join(""))
console.log("-".repeat(65))

for (const policyId of POLICY_ORDER) {
  const rows = episodes.filter((e) => e.policy === policyId)
  const s = summarise(rows)
  console.log(
    [
      policyId.padEnd(16),
      `${s.solved}/${s.tasks}`.padEnd(8),
      String(s.escapedDefects).padEnd(8),
      String(rows.reduce((a, e) => a + e.testRuns, 0)).padEnd(7),
      String(rows.reduce((a, e) => a + e.verifyRuns, 0)).padEnd(7),
      num(s.totalCostTokens).padEnd(10),
      String(wins[policyId] ?? 0).padEnd(9),
    ].join("")
  )
}

console.log("\nper family")
const byFamily = tasksByFamily()
const columns = POLICY_ORDER
const fw = 24
console.log(`${"family".padEnd(fw)}${columns.map((c) => c.slice(0, 8).padEnd(9)).join("")}`)
for (const [family, familyTasks] of byFamily) {
  if (!selected.some((t) => t.family === family)) continue
  const cells = columns.map((policyId: PolicyId) => {
    const rows = episodes.filter((e) => e.family === family && e.policy === policyId)
    const solved = rows.filter((e) => e.success).length
    const esc = rows.filter((e) => e.escapedDefect).length
    return `${solved}/${rows.length}${esc > 0 ? ` !${esc}` : ""}`.padEnd(9)
  })
  console.log(`${family.padEnd(fw)}${cells.join("")}`)
}

for (const id of ["verify-always", "test-always", "valve-v0"] as const) {
  const r = summarise(episodes.filter((e) => e.policy === id))
  console.log(
    `  ${id.padEnd(16)} ${r.solved}/${r.tasks} solved, ${r.escapedDefects} escaped, ` +
      `cost ${num(r.totalCostTokens)}, best utility on ${wins[id] ?? 0} task(s)`
  )
}
console.log(
  "\nTarget: verify-always's solved count and zero escaped, at lower cost.\n" +
    "Per-task utility is not summed across tasks: each task prices success and\n" +
    "defect escape differently, so only within-task comparison is meaningful."
)

if (spoolPath) console.log(`\nspool written to ${spoolPath}`)

console.log(
  "\nCaveat: mutations are scripted, policies are heuristic, and the task count is\n" +
    "small. This harness can falsify a claim; it cannot establish one."
)
