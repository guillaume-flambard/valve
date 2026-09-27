#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { runEpisode, CANDIDATES } from "./runner.js"
import { POLICIES, POLICY_ORDER } from "./policies.js"
import { tasks } from "./tasks.js"
import type { BenchEpisode, ObservedSink } from "./runner.js"
import type { PolicyId } from "./types.js"

/**
 * CogBench runner.
 *
 * Usage:
 *   node dist/cli.js [--spool <path>] [--task <id>] [--json]
 *
 * Emits the same NDJSON spool the OpenCode shadow plugin emits, so a benchmark
 * run and a real session land in one dataset behind one set of queries. That
 * shared path is deliberate: two measurement pipelines would drift, and the
 * disagreement query is only meaningful over one corpus.
 */

const argv = process.argv.slice(2)
const arg = (flag: string) => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const spoolPath = arg("--spool")
const taskFilter = arg("--task")
const asJson = argv.includes("--json")

let sink: ObservedSink | undefined
if (spoolPath) {
  mkdirSync(dirname(spoolPath), { recursive: true })
  writeFileSync(spoolPath, "")
  sink = {
    write(record) {
      appendFileSync(spoolPath, JSON.stringify(record) + "\n", "utf8")
    },
  }
}

const selected = taskFilter ? tasks.filter((t) => t.id === taskFilter) : tasks
if (selected.length === 0) {
  console.error(`no task matches ${taskFilter}`)
  process.exit(1)
}

const episodes: BenchEpisode[] = []

for (const task of selected) {
  for (const policyId of POLICY_ORDER) {
    const policy = POLICIES[policyId]
    if (!policy) {
      throw new Error(`no implementation registered for policy ${policyId}`)
    }
    const episode = runEpisode({
      task,
      policy,
      policyId,
      spool: sink,
    })
    episodes.push(episode)
  }
}

if (asJson) {
  console.log(JSON.stringify({ episodes, candidates: CANDIDATES.length }, null, 2))
  process.exit(0)
}

interface Aggregate {
  tasks: number
  solved: number
  successRate: number
  frontierCalls: number
  testRuns: number
  costTokens: number
  latencyMs: number
  meanSteps: number
  stepsAfterFirstCorrect: number
}

const aggregate = (policyId: PolicyId): Aggregate => {
  const rows = episodes.filter((e) => e.policy === policyId)
  const solved = rows.filter((e) => e.success).length
  const sum = (pick: (e: BenchEpisode) => number) => rows.reduce((a, e) => a + pick(e), 0)
  return {
    tasks: rows.length,
    solved,
    successRate: rows.length === 0 ? 0 : solved / rows.length,
    frontierCalls: sum((e) => e.frontierCalls),
    testRuns: sum((e) => e.testRuns),
    costTokens: sum((e) => e.totalCostTokens),
    latencyMs: sum((e) => e.totalLatencyMs),
    meanSteps: rows.length === 0 ? 0 : sum((e) => e.steps.length) / rows.length,
    stepsAfterFirstCorrect: sum((e) => e.stepsAfterFirstCorrect),
  }
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`
const num = (n: number) => n.toLocaleString("en-US")

console.log(`CogBench  ${selected.length} task(s), oracle = exit code of the task's verifyCommand\n`)

const header = ["policy", "solved", "frontier", "tests", "cost", "ms", "steps", "wasted"]
console.log(
  header.map((h, i) => h.padEnd([14, 8, 9, 7, 9, 8, 7, 8][i]!)).join("")
)
console.log("-".repeat(70))

for (const policyId of POLICY_ORDER) {
  const a = aggregate(policyId)
  console.log(
    [
      policyId.padEnd(14),
      `${a.solved}/${a.tasks}`.padEnd(8),
      String(a.frontierCalls).padEnd(9),
      String(a.testRuns).padEnd(7),
      num(a.costTokens).padEnd(9),
      num(a.latencyMs).padEnd(8),
      a.meanSteps.toFixed(1).padEnd(7),
      String(a.stepsAfterFirstCorrect).padEnd(8),
    ].join("")
  )
}

const baseline = aggregate("naive-edit-first")
const valve = aggregate("valve-v0")

console.log("\nVALVE-V0 vs naive-edit-first (the behaviour shadow data actually shows):")
console.log(`  success      ${pct(baseline.successRate)} -> ${pct(valve.successRate)}`)
if (valve.frontierCalls !== baseline.frontierCalls) {
  const delta = (valve.frontierCalls - baseline.frontierCalls) / Math.max(1, baseline.frontierCalls)
  console.log(`  frontier     ${baseline.frontierCalls} -> ${valve.frontierCalls} (${delta > 0 ? "+" : ""}${pct(delta)})`)
}
if (valve.costTokens !== baseline.costTokens) {
  const delta = (valve.costTokens - baseline.costTokens) / Math.max(1, baseline.costTokens)
  console.log(`  cost         ${num(baseline.costTokens)} -> ${num(valve.costTokens)} (${delta > 0 ? "+" : ""}${pct(delta)})`)
}
if (valve.stepsAfterFirstCorrect !== baseline.stepsAfterFirstCorrect) {
  console.log(`  wasted steps ${baseline.stepsAfterFirstCorrect} -> ${valve.stepsAfterFirstCorrect}`)
}

if (spoolPath) {
  console.log(`\nspool written to ${spoolPath} (ingest with: npm run ingest -- --spool ${spoolPath})`)
}

console.log(
  "\nCaveat: policies are heuristic, mutations are scripted, and there are few\ntasks. This is a harness that can falsify a claim, not a result that confirms one."
)
