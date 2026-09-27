import { runEpisode } from "../bench/cogbench/dist/runner.js"
import { POLICIES } from "../bench/cogbench/dist/policies.js"
import { tasks } from "../bench/cogbench/dist/tasks.js"
import { EventStore } from "../packages/telemetry/dist/index.js"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Prints the attempt history of an episode the way the decisive M4 query
 * should read: what was tried, what it claimed, what came back, and where
 * causal attribution was destroyed.
 */

const dir = mkdtempSync(join(tmpdir(), "valve-m4-"))
const db = join(dir, "m4.db")
const store = new EventStore({ dbPath: db })

const taskId = process.argv[2] ?? tasks[0].id
const policyId = process.argv[3] ?? "valve-v0"
const task = tasks.find((t) => t.id === taskId) ?? tasks[0]
const policy = POLICIES[policyId]
if (!policy) throw new Error(`unknown policy ${policyId}`)

const episodeId = `cogbench-${task.id}-${policyId}`
store.ensureEpisode({
  id: episodeId,
  taskId: task.id,
  startTime: Date.now(),
  initialState: { goal: task.description, files: Object.keys(task.files) },
  utilityProfile: "coding-correctness",
})
runEpisode({
  task,
  policy,
  policyId,
  onAttempts: (attempts, verifications) => {
    for (const a of attempts) store.recordAttempt(a)
    for (const v of verifications) store.recordVerification(v)
  },
})

const attempts = store.getAttempts(episodeId)
const verifications = store.getVerifications(episodeId)

console.log(`episode ${episodeId}`)
console.log(`task    ${task.name}\n`)

for (const a of attempts) {
  console.log(`attempt ${a.id.split("-a").pop()}  step ${a.step}`)
  console.log(`  hypothesis   ${a.hypothesis ?? "(none declared)"}`)
  console.log(`  base         ${a.baseCheckpoint.slice(0, 12)}`)
  console.log(`  delta        ${a.deltaFingerprint.slice(0, 12)}`)
  console.log(`  verdict      ${a.verdict}  (${a.attribution})`)
  if (a.reverted) console.log(`  reverted     yes`)
  for (const e of a.evidence) {
    console.log(`  evidence     ${e.kind} exit=${e.exitCode} grounded=${e.grounded}`)
  }
  console.log()
}

console.log("verifications")
for (const v of verifications) {
  const names = v.targets.map((t) => t.split("-a").pop()).join(", ") || "(none)"
  console.log(
    `  step ${v.step}  exit ${v.exitCode}  ${v.provenance}  targets: ${names}  ` +
      `[${v.command}]`
  )
}

const compound = attempts.filter((a) => a.attribution === "compound")
const falsified = attempts.filter((a) => a.verdict === "falsified")
console.log(
  `\nsummary: ${attempts.length} attempts, ${falsified.length} falsified, ` +
    `${compound.length} unattributable (causal attribution destroyed by stacking)`
)

store.close()
rmSync(dir, { recursive: true, force: true })
