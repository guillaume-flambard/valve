/**
 * Probe: does a stale `verification` survive an edit, and does it change a decision?
 *
 * The M7 traces show a policy stopping on a state it never examined, which the M6 rule "terminal states
 * cannot be reached with no evidence" was written to prevent. This watches the one field the runner does
 * not clear on an edit.
 */
import { BenchEnvironment } from "../bench/cogbench/dist/environment.js"
import { POLICIES } from "../bench/cogbench/dist/policies.js"
import { replicationTasks } from "../bench/cogbench/dist/tasks-m7.js"
import { runEpisode } from "../bench/cogbench/dist/runner.js"

const [taskId, policyId] = process.argv.slice(2)
const task = replicationTasks.find((t) => t.id === taskId)
if (!task) throw new Error(`no task ${taskId}`)

const policy = POLICIES[policyId]
const observed = []
const spy = (state, t, ctx) => {
  const action = policy(state, t, ctx)
  observed.push({
    step: ctx.step,
    action,
    stateTests: state.verification.tests,
    lastTestExit: ctx.lastTestExit ?? null,
    lastVerifyExit: ctx.lastVerifyExit ?? null,
    editsLeft: ctx.remainingMutations.length,
    unverifiedDelta: state.metadata?.unverifiedDelta,
  })
  return action
}
const episode = runEpisode({ task, policy: spy, policyId })

for (const row of observed) {
  console.log(
    `step ${row.step}: ${row.action.padEnd(6)} state.verification.tests=${String(row.stateTests).padEnd(7)}` +
      ` lastTest=${String(row.lastTestExit).padEnd(5)} lastVerify=${String(row.lastVerifyExit).padEnd(5)}` +
      ` editsLeft=${row.editsLeft} unverifiedDelta=${row.unverifiedDelta}`,
  )
}
console.log(`\nmutations applied: ${episode.mutationsApplied.join(", ") || "none"}`)
console.log(`solved: ${episode.success}  escaped: ${episode.escapedDefect}`)
