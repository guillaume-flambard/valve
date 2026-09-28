import { BenchEnvironment } from "../bench/cogbench/dist/environment.js"
import { tasks, legacyTasks } from "../bench/cogbench/dist/tasks.js"

/**
 * Verifies every fixture against its own oracle.
 *
 * The invariant this protects: a fixture whose documentation disagrees with its
 * behaviour is worse than no fixture, because every number downstream inherits
 * the lie. Three things must hold for each task:
 *
 *   1. unless it starts solved, the initial state fails the oracle
 *   2. a task that starts solved passes the oracle untouched
 *   3. exactly one mutation passes, and every mutation that documents a flaw is
 *      actually rejected
 */

let failures = 0
const fail = (msg) => {
  failures++
  console.log(`  FAIL ${msg}`)
}

const all = [...tasks, ...legacyTasks]

console.log(`checking ${all.length} fixtures\n`)

for (const task of all) {
  const label = `${task.family} ${task.id}`
  let passing = 0
  const passingIds = []

  const env = new BenchEnvironment(task)
  try {
    const initial = env.verify().exitCode
    if (task.startsSolved) {
      if (initial !== 0) fail(`${label}: declared startsSolved but the oracle rejects the initial state`)
    } else if (initial === 0) {
      fail(`${label}: initial state already passes the oracle, so the task is solved before any edit`)
    }
  } finally {
    env.cleanup()
  }

  for (const mutation of task.mutations) {
    const mEnv = new BenchEnvironment(task)
    try {
      mEnv.applyMutation(mutation)
      const code = mEnv.verify().exitCode
      if (code === 0) {
        passing++
        passingIds.push(mutation.id)
      }
      if (mutation.knownFlaw && code === 0) {
        fail(`${label}/${mutation.id}: documents a flaw but the oracle accepts it`)
      }
      if (!mutation.knownFlaw && code !== 0) {
        fail(`${label}/${mutation.id}: undocumented failure, exit ${code}`)
      }
    } finally {
      mEnv.cleanup()
    }
  }

  if (task.startsSolved) {
    // A task that needs no change must have no correct edit available. If one
    // existed, editing would be harmless and the family could not distinguish
    // a policy that recognises "already correct" from one that acts on reflex.
    if (passing !== 0) {
      fail(`${label}: startsSolved but ${passing} edit(s) still pass the oracle`)
    }
  } else if (passing !== 1) {
    fail(`${label}: expected exactly one passing edit, found ${passing} [${passingIds.join(", ")}]`)
  }

  // A task that starts solved must still be breakable, otherwise it scores the
  // same whether or not a policy edits.
  if (task.startsSolved && task.mutations.length === 0) {
    fail(`${label}: startsSolved with no mutations, so acting is unpunished`)
  }
}

// --- ordering luck -------------------------------------------------------------
// A benchmark in which the correct edit is always last is won by "apply every
// edit, then stop", which is not a strategy. The correct edit's position is
// mixed on purpose, and this asserts the mixing is real.

const families = tasks.filter((t) => !t.startsSolved)
const lastWins = []
for (const task of families) {
  const env = new BenchEnvironment(task)
  let correctIndex = -1
  try {
    task.mutations.forEach((m, i) => {
      const e = new BenchEnvironment(task)
      e.applyMutation(m)
      if (e.verify().exitCode === 0) correctIndex = i
      e.cleanup()
    })
  } finally {
    env.cleanup()
  }
  if (correctIndex === task.mutations.length - 1) lastWins.push(task.id)
}

if (lastWins.length > Math.ceil(families.length / 2)) {
  fail(
    `ordering luck: the correct edit is last in ${lastWins.length}/${families.length} ` +
      `tasks [${lastWins.join(", ")}], so "apply everything then stop" is a winning strategy`
  )
} else {
  console.log(
    `  ordering: correct edit is last in ${lastWins.length}/${families.length} tasks ` +
      `(positions mixed, so no single ordering wins)`
  )
}

if (failures === 0) {
  console.log(`all ${all.length} fixtures honest: one correct edit each, flaws rejected`)
  process.exit(0)
}
console.log(`\n${failures} fixture problems`)
process.exit(1)
