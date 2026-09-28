import { BenchEnvironment } from "../bench/cogbench/dist/environment.js"
import { replicationTasks } from "../bench/cogbench/dist/tasks-m7.js"

/**
 * M7 fixture sweep, run before any policy touches the replication corpus.
 *
 * `verify-fixtures.mjs` refuses a fixture with two correct edits, which is the right rule for the
 * development corpus because one correct edit makes "try the obvious fix" a strategy. M7's B3 declares
 * two, so the rule is relaxed here for exactly that reason and tightened in the other direction: every
 * mutation's `knownFlaw` annotation must agree with what the oracle actually does, in both directions. A
 * mutation documented as flawed that passes is a fixture that lies about itself, and a mutation documented
 * as clean that fails is one whose cost and position would be measured on an accident.
 *
 * It also reports the two distributions the corpus is only honest if it has: where the correct edit sits,
 * and how often the cheap channel cannot tell a wrong fix from a right one.
 */

let failures = 0
const fail = (msg) => {
  failures++
  console.log(`  FAIL ${msg}`)
}

const oracleExit = (task, mutation) => {
  const env = new BenchEnvironment(task)
  try {
    if (mutation) env.applyMutation(mutation)
    return env.verify().exitCode
  } finally {
    env.cleanup()
  }
}

const localExit = (task, mutation) => {
  const env = new BenchEnvironment(task)
  try {
    if (mutation) env.applyMutation(mutation)
    return env.test().exitCode
  } finally {
    env.cleanup()
  }
}

console.log(`checking ${replicationTasks.length} M7 fixtures\n`)

const positions = { 1: 0, 2: 0, 3: 0, 4: 0 }
const priceRows = []
let misleadingSignalTasks = 0
let twoCorrectEditTasks = 0

for (const task of replicationTasks) {
  const label = `${task.family} ${task.id}`

  const initial = oracleExit(task, undefined)
  if (task.startsSolved) {
    if (initial !== 0) fail(`${label}: declares startsSolved but the oracle rejects the initial state`)
  } else if (initial === 0) {
    fail(`${label}: the initial state already passes the oracle, so the task is solved before any edit`)
  }

  const passing = []
  const flawedPassing = []
  const cleanFailing = []
  let firstCorrect = -1
  let wrongFixHiddenFromLocalTest = 0

  for (const [index, mutation] of task.mutations.entries()) {
    const code = oracleExit(task, mutation)
    if (code === 0) {
      passing.push(mutation.id)
      if (firstCorrect === -1) firstCorrect = index + 1
    }
    if (mutation.knownFlaw && code === 0) {
      flawedPassing.push(mutation.id)
    }
    if (!mutation.knownFlaw && code !== 0) {
      cleanFailing.push(`${mutation.id} (exit ${code})`)
    }
    // A wrong fix the cheap channel accepts is the property the D family exists to
    // create, and its absence from a D fixture would make the family measure nothing.
    if (mutation.knownFlaw && code !== 0 && localExit(task, mutation) === 0) {
      wrongFixHiddenFromLocalTest++
    }
  }

  for (const id of flawedPassing) {
    fail(`${label}/${id}: documents a flaw but the oracle accepts it`)
  }
  for (const id of cleanFailing) {
    fail(`${label}/${id}: documents no flaw but the oracle rejects it, so its cost and position would be measured on an accident`)
  }

  if (task.startsSolved) {
    if (passing.length !== 0) {
      fail(`${label}: startsSolved but ${passing.length} edit(s) still pass the oracle [${passing.join(", ")}]`)
    }
    if (task.mutations.length === 0) {
      fail(`${label}: startsSolved with no mutations, so acting is unpunished`)
    }
  } else {
    if (passing.length === 0) {
      fail(`${label}: no mutation satisfies the oracle, so the task is unsolvable`)
    }
    if (firstCorrect > 0) positions[firstCorrect] = (positions[firstCorrect] ?? 0) + 1
    if (passing.length > 1) {
      twoCorrectEditTasks++
      if (task.id !== "B-m7-3-two-correct-edits") {
        fail(`${label}: declares ${passing.length} correct edits [${passing.join(", ")}], and only B-m7-3 was meant to`)
      }
    }
  }

  if (wrongFixHiddenFromLocalTest > 0) misleadingSignalTasks++
  priceRows.push({
    id: task.id,
    verifyOverTest: task.costModel.verify.tokens / task.costModel.test.tokens,
    verifyOverAct: task.costModel.verify.tokens / task.costModel.act.tokens,
    escapeOverVerify: task.costModel.defectEscape / task.costModel.verify.tokens,
    wrongFixHiddenFromLocalTest,
  })
}

// The corpus has to be spread on the only axis that decides a benchmark whose edits are scripted: where
// the right answer sits. A corpus where it is usually first rewards reflex, and one where it is usually
// last rewards applying everything.
const positioned = Object.values(positions).reduce((a, b) => a + b, 0)
if (positioned !== replicationTasks.length - 3) {
  fail(`only ${positioned} of ${replicationTasks.length - 3} solvable tasks have a correct edit to position`)
}
if (Math.max(...Object.values(positions)) - Math.min(...Object.values(positions).filter(Boolean)) > 6) {
  fail(`the correct edit is badly clustered: ${JSON.stringify(positions)}, which makes one reflex a strategy`)
}

console.log("position of the first correct edit:", positions)
console.log(`tasks where a wrong fix passes the cheap test: ${misleadingSignalTasks}/${replicationTasks.length}`)
console.log(`tasks declaring more than one correct edit: ${twoCorrectEditTasks}\n`)

console.log("id                                verify/test  verify/act  escape/verify  wrong fix hidden from local")
for (const row of priceRows) {
  console.log(
    `${row.id.padEnd(33)} ${row.verifyOverTest.toFixed(1).padStart(10)} ${row.verifyOverAct
      .toFixed(1)
      .padStart(11)} ${row.escapeOverVerify.toFixed(1).padStart(14)} ${String(row.wrongFixHiddenFromLocalTest).padStart(25)}`,
  )
}

// The price spread is the point of the three instances per family, so a range that collapsed to one
// number would mean the corpus stopped being a question.
const ratios = priceRows.map((r) => r.verifyOverAct)
if (Math.max(...ratios) / Math.min(...ratios) < 20) {
  fail(`the oracle price only spans ${(Math.max(...ratios) / Math.min(...ratios)).toFixed(1)}x across 24 tasks, which is not a spread`)
}

if (failures === 0) {
  console.log(`\nall ${replicationTasks.length} M7 fixtures honest`)
  process.exit(0)
}
console.log(`\n${failures} fixture problems`)
process.exit(1)
