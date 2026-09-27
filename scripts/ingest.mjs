#!/usr/bin/env node
import { ingestSpool } from "../packages/opencode-adapter/dist/index.js"

/**
 * Ingests the OpenCode shadow spool into the VALVE event store.
 *
 * Usage:
 *   node scripts/ingest.mjs [--spool <path>] [--db <path>] [--keep] [--profile <name>]
 *
 * The spool is rotated to <path>.ingested after a successful run, never
 * deleted, so a bug here is always recoverable.
 */

const argv = process.argv.slice(2)
const arg = (flag) => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const result = ingestSpool({
  spoolPath: arg("--spool"),
  dbPath: arg("--db"),
  utilityProfile: arg("--profile"),
  keepSpool: argv.includes("--keep"),
})

if (result.linesRead === 0) {
  console.log("No spool to ingest. Use OpenCode with the valve-shadow plugin loaded.")
  process.exit(0)
}

const pct = (n) => `${(n * 100).toFixed(1)}%`

console.log(`spool            ${result.spoolPath}`)
console.log(`lines read       ${result.linesRead} (${result.linesSkipped} skipped)`)
console.log(`episodes         ${result.episodes}`)
console.log(`decision points  ${result.decisionPoints}`)
console.log(`llm calls        ${result.llmCalls}`)
console.log(`human interrupts ${result.humanInterruptions}`)
console.log(`session errors   ${result.errors}`)
console.log(`shadow agreement ${pct(result.agreementRate)} (${result.disagreements} disagreements)`)
