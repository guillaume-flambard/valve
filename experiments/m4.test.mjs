import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runEpisode } from "../bench/cogbench/dist/runner.js"
import { POLICIES } from "../bench/cogbench/dist/policies.js"
import { tasks, legacyTasks } from "../bench/cogbench/dist/tasks.js"
import { ingestSpool } from "../packages/opencode-adapter/dist/index.js"
import { EventStore } from "../packages/telemetry/dist/index.js"
import {
  attributeVerdict,
  checkpointOf,
  deltaFingerprintOf,
  findRepeats,
  hasUnverifiedDelta,
} from "../packages/schema/dist/index.js"

const withTempDb = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "valve-m4-"))
  try {
    return fn(join(dir, "m4.db"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const runCollecting = (task, policyId) => {
  const collected = { attempts: [], verifications: [] }
  const policy = POLICIES[policyId]
  if (!policy) throw new Error(`unknown policy ${policyId}`)
  runEpisode({
    task,
    policy,
    policyId,
    onAttempts: (attempts, verifications) => {
      collected.attempts = attempts
      collected.verifications = verifications
    },
  })
  return collected
}

/**
 * M5 added family A, whose tasks are already solved and therefore produce no
 * attempts. The attempt-level invariants need a task that actually requires
 * work, so these pick one explicitly rather than trusting index 0.
 */
const taskNeedingWork = () => tasks.find((t) => !t.startsSolved && t.mutations.length > 0)
const task0 = taskNeedingWork
const task1 = () => tasks.find((t) => t.family === "D-misleading-local-signal") ?? taskNeedingWork()

// --- 1. every mutating attempt has identity ---

test("criterion 1: every mutating attempt carries identity", () => {
  for (const task of tasks) {
    for (const policyId of ["valve-v0", "test-always", "naive-edit-first"]) {
      const { attempts } = runCollecting(task, policyId)
      for (const a of attempts) {
        assert.ok(a.id && a.id.length > 0, `${policyId}: attempt has no id`)
        assert.match(a.baseCheckpoint, /^[0-9a-f]{32}$/, "base checkpoint is a fingerprint")
        assert.match(a.deltaFingerprint, /^[0-9a-f]{32}$/, "delta fingerprint is a fingerprint")
        assert.notEqual(a.baseCheckpoint, "", "base checkpoint recorded")
      }
    }
  }
})

test("checkpoints are content-addressed, so identical state yields identical identity", () => {
  const a = { "x.js": "one", "y.js": "two" }
  const b = { "y.js": "two", "x.js": "one" }
  assert.equal(checkpointOf(a), checkpointOf(b), "key order must not change identity")

  const changed = { ...a, "x.js": "one-modified" }
  assert.notEqual(checkpointOf(a), checkpointOf(changed))

  // The delta ignores untouched files, so re-stating them is not a new move.
  assert.equal(
    deltaFingerprintOf(a, { ...a, "x.js": "three" }),
    deltaFingerprintOf(a, { "x.js": "three", "y.js": "two" }),
  )
})

// --- 2. every verification references what it verifies ---

test("criterion 2: a verification names the attempts it speaks to", () => {
  const { attempts, verifications } = runCollecting(task0(), "valve-v0")
  const ids = new Set(attempts.map((a) => a.id))

  for (const v of verifications) {
    assert.ok(Array.isArray(v.targets), "targets is a list")
    for (const t of v.targets) {
      assert.ok(ids.has(t), `verification targets unknown attempt ${t}`)
    }
  }

  // A verification that judges stacked edits must name every one of them.
  const judging = verifications.find((v) => v.targets.length > 0)
  assert.ok(judging, "at least one verification judged an attempt")
})

// --- 3. falsification survives rollback ---

test("criterion 3: falsification survives a rollback", () => {
  // A task with competing fixes, so verification between attempts actually
  // rejects one. A task whose first edit is correct never produces a rejection.
  const contested =
    tasks.find((t) => t.family === "C-competing-hypotheses") ?? taskNeedingWork()
  const { attempts } = runCollecting(contested, "verify-always")
  const falsified = attempts.filter((a) => a.verdict === "falsified")
  assert.ok(falsified.length > 0, "the fixture produces a real rejection")
  assert.ok(
    falsified.some((a) => a.reverted),
    "the bench resets state between edits, so a falsified attempt must be marked reverted",
  )
  // Reverted is a property of the record, not a deletion of it.
  assert.ok(falsified.every((a) => a.evidence.length > 0), "a reverted rejection keeps its evidence")
})

// --- 4. repeating a falsified intervention is detectable ---

test("criterion 4: repeating a falsified intervention is detectable", () => {
  const base = checkpointOf({ "a.js": "original" })
  const delta = deltaFingerprintOf({ "a.js": "original" }, { "a.js": "patched" })

  const falsified = {
    id: "a1",
    baseCheckpoint: base,
    deltaFingerprint: delta,
    verdict: "falsified",
  }
  const repeat = {
    id: "a2",
    baseCheckpoint: base,
    deltaFingerprint: delta,
    verdict: "pending",
  }
  const different = {
    id: "a3",
    baseCheckpoint: base,
    deltaFingerprint: "deadbeef".repeat(4).slice(0, 32),
    verdict: "pending",
  }

  const repeats = findRepeats([falsified, repeat, different])
  assert.equal(repeats.length, 1, "exactly the true repeat is detected")
  assert.equal(repeats[0].attempted.id, "a2")

  // The same base but a different intervention is a different move.
  assert.equal(findRepeats([falsified, different]).length, 0)
})

test("criterion 4: the stored corpus exposes repeats through SQL", () => {
  withTempDb((dbPath) => {
    const store = new EventStore({ dbPath: dbPath })
    store.ensureEpisode({
      id: "e1",
      taskId: "t",
      startTime: 1,
      initialState: {},
      utilityProfile: "coding-balanced",
    })
    const base = checkpointOf({ "a.js": "original" })
    const delta = deltaFingerprintOf({ "a.js": "original" }, { "a.js": "patched" })
    const mk = (id, verdict) => ({
      id,
      step: 1,
      episodeId: "e1",
      cognitiveAction: { kind: "ACT", estimatedCost: 0, estimatedLatencyMs: 0, reversible: true },
      baseCheckpoint: base,
      deltaFingerprint: delta,
      verdict,
      attribution: "individual",
      evidence: [],
      verifiedBy: [],
      reverted: false,
      costTokens: 0,
      grounding: "harness",
      provenance: "harness",
    })
    store.recordAttempt(mk("a1", "falsified"))
    store.recordAttempt(mk("a2", "pending"))

    const repeats = store.getRepeatedFalsified()
    assert.equal(repeats.length, 1)
    assert.equal(repeats[0].attempt.id, "a2")
    assert.equal(repeats[0].falsified.id, "a1", "the matched rejection is returned, not a stub")
    store.close()
  })
})

// --- 5. pending modifications are visible ---

test("criterion 5: an unverified delta is visible in the state", () => {
  assert.equal(hasUnverifiedDelta({ verifiedCheckpoint: "a", currentCheckpoint: "a" }), false)
  assert.equal(hasUnverifiedDelta({ verifiedCheckpoint: "a", currentCheckpoint: "b" }), true)

  // The bench must actually reach a state where the world moved unchecked.
  //
  // WITNESS CHANGED 2026-09-28, and the reason is worth keeping. This used to use `valve-v0`, which
  // stopped being a witness the moment the stale latch was cleared from `state.verification.tests`: V0
  // used to leave an unjudged attempt only because it was stopping on a refutation recorded against a
  // state an edit had already destroyed. On the corrected harness its single attempt on this task comes
  // back `supported`, because it now runs the cheap test after the edit. That is the fix working.
  //
  // `naive-edit-first` witnesses the same property for the reason the property exists: it edits until the
  // edits run out and never checks, so it necessarily leaves the world moved and unchecked. Measured, not
  // assumed: it is one of 16 policy/task pairs on this corpus that still produce a pending or
  // unattributable attempt, and all 16 are policies that never verify.
  let sawUnverified = false
  const task = task0()
  const witness = "naive-edit-first"
  runEpisode({
    task,
    policy: POLICIES[witness],
    policyId: witness,
    onAttempts: () => {},
  })
  // Re-derive from the stored corpus instead of trusting the policy.
  const collected = runCollecting(task, witness)
  assert.ok(collected.attempts.length > 0, "attempts were produced")
  assert.ok(
    collected.attempts.some((a) => a.verdict === "pending") ||
      collected.attempts.some((a) => a.verdict === "unattributable"),
    "at least one attempt was left unjudged or unattributable, which is the visible unverified delta",
  )
  assert.equal(sawUnverified, false, "no unused flag")
})

// --- 6. no ungrounded training label ---

test("criterion 6: an unrecognised tool is UNKNOWN, never silently ACT", () => {
  const dir = mkdtempSync(join(tmpdir(), "valve-ground-"))
  try {
    const spool = join(dir, "s.ndjson")
    const t0 = 1700000000000
    const records = [
      { v: 1, kind: "episode_open", sessionID: "s", ts: t0, goal: "g" },
      { v: 1, kind: "tool_result", sessionID: "s", ts: t0 + 1, callID: "c1", tool: "read", title: "r", args: { filePath: "a" }, output: "x", outputTruncated: false, latencyMs: 1, errored: false },
      { v: 1, kind: "tool_result", sessionID: "s", ts: t0 + 2, callID: "c2", tool: "some_future_tool", title: "?", args: {}, output: "y", outputTruncated: false, latencyMs: 1, errored: false },
    ]
    writeFileSync(spool, records.map((r) => JSON.stringify(r)).join("\n") + "\n")

    const dbPath = join(dir, "g.db")
    const result = ingestSpool({ spoolPath: spool, dbPath })
    assert.equal(result.ungroundedLabels, 1, "the unknown tool is counted, not hidden")
    assert.equal(result.rejectedForTraining, 1, "and excluded from training")

    const store = new EventStore({ dbPath })
    const events = store.getEventsForEpisode("s")
    const labels = events.map((e) => e.chosen)
    assert.ok(labels.includes("UNKNOWN"), "recorded as UNKNOWN, not coerced to a neighbour")
    assert.equal(
      labels.filter((l) => l === "ACT").length,
      0,
      "and crucially not filed as a mutation, which is the M3 bug"
    )

    const stats = store.getGroundingStats()
    assert.ok(stats.ungrounded, "ungrounded records are visible in the corpus stats")
    assert.equal(stats.ungrounded.trainable, 0, "ungrounded records are never trainable")
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("criterion 6: an ungrounded label is not scored as a disagreement", () => {
  // Otherwise the shadow agreement rate silently punishes the policy for a
  // gap in the observer rather than for a wrong decision.
  withTempDb((dbPath) => {
    const store = new EventStore({ dbPath })
    store.startEpisode({
      id: "e2",
      taskId: "t",
      startTime: 1,
      initialState: {},
      events: [],
      success: false,
      totalCost: { tokens: 0, usd: 0, latencyMs: 0 },
      humanInterventions: 0,
      utilityProfile: "coding-balanced",
    })
    const state = { goal: "g", progress: 0, currentTask: "t", evidence: [], uncertainties: [], constraints: [], recentActions: [], verification: {}, resources: { contextTokens: 0, elapsedMs: 0 }, authority: { canWrite: true, canDelete: false, canAskHuman: true } }
    store.logEvent({
      episodeId: "e2",
      step: 1,
      timestamp: 1,
      state,
      candidates: [],
      chosen: "UNKNOWN",
      source: "human",
      cost: { tokens: 0, usd: 0, latencyMs: 0 },
      outcome: { progressDelta: 0, uncertaintyDelta: 0, failureDetected: false, taskSuccess: null, regressions: [] },
      utilityProfile: "coding-balanced",
      grounding: "ungrounded",
      shadow: { action: "READ", probability: 0.5, expectedUtility: 0, risk: 0, informationGain: 0 },
    })
    const stats = store.getShadowStats()
    assert.equal(stats.total, 1)
    assert.equal(stats.scored, 0, "an UNKNOWN label cannot be agreed or disagreed with")
    assert.equal(stats.unscored, 1, "and is reported as unscored rather than dropped")
    assert.equal(stats.disagreements, 0, "so it is not counted against the policy")
    store.close()
  })
})

// --- 7. bench and shadow use identical event semantics ---

test("criterion 7: bench and shadow records share one record shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "valve-sem-"))
  try {
    const benchSpool = join(dir, "bench.ndjson")
    const shadowSpool = join(dir, "shadow.ndjson")
    const t0 = 1700000000000

    // A bench record: the harness declares the operation it executed.
    writeFileSync(
      benchSpool,
      [
        { v: 1, kind: "episode_open", sessionID: "bench", ts: t0, goal: "g" },
        { v: 1, kind: "tool_result", sessionID: "bench", ts: t0 + 1, callID: "b1", tool: "bash", title: "npm test", args: { cognitiveAction: "TEST" }, grounding: "harness", provenance: "harness", exitCode: 0, timedOut: false, output: "ok", outputTruncated: false, latencyMs: 5, errored: false },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n"
    )
    // A shadow record: no declared operation, the reader must classify it.
    writeFileSync(
      shadowSpool,
      [
        { v: 1, kind: "episode_open", sessionID: "shadow", ts: t0, goal: "g" },
        { v: 1, kind: "tool_result", sessionID: "shadow", ts: t0 + 1, callID: "s1", tool: "read", title: "read a.ts", args: { filePath: "a.ts" }, provenance: "environment", output: "x", outputTruncated: false, latencyMs: 5, errored: false },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n"
    )

    const benchDb = join(dir, "bench.db")
    const shadowDb = join(dir, "shadow.db")
    ingestSpool({ spoolPath: benchSpool, dbPath: benchDb })
    ingestSpool({ spoolPath: shadowSpool, dbPath: shadowDb })

    const bStore = new EventStore({ dbPath: benchDb })
    const sStore = new EventStore({ dbPath: shadowDb })
    const benchEvent = bStore.getEventsForEpisode("bench")[0]
    const shadowEvent = sStore.getEventsForEpisode("shadow")[0]

    // Same event kind, same ingest path, same downstream shape.
    assert.equal(benchEvent.chosen, "TEST", "the harness declaration is honoured")
    assert.equal(benchEvent.grounding, "harness")
    assert.equal(shadowEvent.chosen, "READ", "the plugin record is classified, not declared")
    assert.equal(shadowEvent.grounding, "deterministic")

    for (const e of [benchEvent, shadowEvent]) {
      assert.equal(typeof e.chosen, "string")
      assert.equal(typeof e.step, "number")
      assert.ok(e.state, "both carry a reconstructed state")
      assert.ok(Array.isArray(e.candidates), "both carry the same candidate set")
    }
    bStore.close()
    sStore.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- honest attribution, the point of the whole milestone ---

test("stacked edits are unattributable, never three confident rejections", () => {
  const base = checkpointOf({ "f.js": "v0" })
  const mkAttempt = (id, delta) => ({
    id,
    step: 1,
    episodeId: "e",
    cognitiveAction: { kind: "ACT", estimatedCost: 0, estimatedLatencyMs: 0, reversible: true },
    baseCheckpoint: base,
    deltaFingerprint: delta,
    verdict: "pending",
    attribution: "individual",
    evidence: [],
    verifiedBy: [],
    reverted: false,
    costTokens: 0,
    grounding: "harness",
    provenance: "harness",
  })

  const attempts = [
    mkAttempt("a1", "1".repeat(32)),
    mkAttempt("a2", "2".repeat(32)),
    mkAttempt("a3", "3".repeat(32)),
  ]
  const verification = {
    id: "v1",
    step: 2,
    episodeId: "e",
    targets: ["a1", "a2", "a3"],
    command: "npm test",
    exitCode: 1,
    checkpoint: base,
    provenance: "harness",
    grounded: true,
    timedOut: false,
  }

  const after = attributeVerdict(attempts, verification, false)
  assert.equal(after.filter((a) => a.verdict === "falsified").length, 0, "none is singled out")
  assert.equal(after.filter((a) => a.verdict === "unattributable").length, 3)
  assert.ok(after.every((a) => a.attribution === "compound"))

  // The same code with a single pending attempt does attribute.
  const single = attributeVerdict([mkAttempt("only", "9".repeat(32))], { ...verification, targets: ["only"] }, false)
  assert.equal(single[0].verdict, "falsified")
  assert.equal(single[0].attribution, "individual")
})

/**
 * The contrast M4 exists to expose: stacking edits and checking once destroys
 * causal attribution, checking between attempts preserves it.
 *
 * A probe policy is used rather than a baseline, because no shipped policy
 * stacks *and* then verifies: `act-always` stacks but never checks, so it
 * produces no verdicts at all, and the verifying policies check between edits.
 * The behaviour under test is real, it is just not something a sensible policy
 * does on purpose.
 */
const stackThenVerify = (state, _task, ctx) => {
  if (ctx.remainingMutations.length > 0) return "ACT"
  return state.verification.tests === "passed" ? "STOP" : "VERIFY"
}

test("the contrast the milestone exists to expose is real", () => {
  const contested =
    tasks.find((t) => t.family === "C-competing-hypotheses") ?? taskNeedingWork()

  let stacked = { attempts: [] }
  runEpisode({
    task: contested,
    policy: stackThenVerify,
    policyId: "probe-stack-then-verify",
    onAttempts: (attempts) => {
      stacked = { attempts }
    },
  })
  const interleaved = runCollecting(contested, "verify-always")

  const stackedUnattributable = stacked.attempts.filter(
    (a) => a.verdict === "unattributable"
  ).length
  const interleavedUnattributable = interleaved.attempts.filter(
    (a) => a.verdict === "unattributable"
  ).length

  assert.ok(
    stacked.attempts.length > 1,
    "the probe must stack more than one edit for the contrast to mean anything",
  )
  assert.ok(
    stackedUnattributable > 0,
    "stacking edits must show up as destroyed attribution, not as silent absence of verdicts"
  )
  assert.equal(
    stacked.attempts.filter((a) => a.verdict === "falsified").length,
    0,
    "and must not invent a rejection it could not make",
  )
  assert.equal(
    interleavedUnattributable,
    0,
    "verifying after each edit must preserve individual attribution"
  )
  assert.ok(
    interleaved.attempts.some((a) => a.verdict === "falsified"),
    "and must actually record which edit was rejected",
  )
})

// --- 8. no V0 heuristic changes ---

/**
 * The freeze pin.
 *
 * M5 changed the benchmark, so the ADR 0001 numbers no longer reproduce: that
 * harness had one command priced globally, and the current one has two
 * channels priced per task. The *conclusion* survived and hardened, but the
 * figures did not, and saying so is more useful than quietly re-baselining.
 *
 * What this test protects is the thing M5 promised: no policy moved. If any of
 * these numbers drift, a policy changed, and the milestone boundary was
 * crossed silently.
 *
 * DEVIATION, recorded rather than hidden. There have now been TWO runner changes under this freeze, and
 * both are recorded here because a reader of the pin has to see that the harness moved.
 *
 * First, M6: a refutation was carried across an edit, so a policy could treat an already refuted state as
 * still refuted and overwrite its own best attempt. The fix clears evidence when the world moves, which is
 * correct, and it moved the baselines: verify-always went from 25,100 to 27,500 and valve-v0 from 27,920
 * to 35,740. The tasks and the cost model were NOT touched.
 *
 * Second, M7: the same fact was stored a third time, in `state.verification.tests`, which the fix beside
 * it did not clear, and that copy is the one the gated policies actually read. ADR 0005 measured the
 * contamination and took the decision to fix and re-measure. valve-v0 moved again, and this time the move
 * is not flattering: 3 solved / 35,740 / 0 escaped became 5 solved / 20,340 / 3 escaped. It is cheaper
 * because it no longer stops on a stale red, and it ships three defects that the stale red was hiding. The
 * M6 numbers it is not measured against, verify-always at 7 / 27,500 / 0, are unchanged, and neither are
 * test-always, naive-edit-first, act-always or stop-immediately: a re-baseline that touched every policy
 * would be a different project from this one.
 *
 * The freeze exists to stop a policy being fitted to the benchmark. A state tracking bug in the harness is
 * not that, and leaving a known-wrong measurement in place to protect a nicer number would defeat the
 * purpose of the whole project. The cost of the freeze is being paid here, visibly, twice.
 */
const FROZEN_FAMILY_BENCH = {
  "verify-always": { solved: 7, cost: 27500, escaped: 0 },
  "test-always": { solved: 4, cost: 10180, escaped: 3 },
  "valve-v0": { solved: 5, cost: 20340, escaped: 3 },
  "naive-edit-first": { solved: 2, cost: 15900, escaped: 0 },
  "act-always": { solved: 2, cost: 15900, escaped: 0 },
  "stop-immediately": { solved: 1, cost: 0, escaped: 0 },
}

test("criterion 8: M5 changed the benchmark, not the policies", () => {
  for (const [policyId, expected] of Object.entries(FROZEN_FAMILY_BENCH)) {
    const policy = POLICIES[policyId]
    if (!policy) throw new Error(`unknown policy ${policyId}`)
    let solved = 0
    let cost = 0
    let escaped = 0
    for (const task of tasks) {
      const ep = runEpisode({ task, policy, policyId })
      if (ep.success) solved++
      cost += ep.totalCostTokens
      if (ep.escapedDefect) escaped++
    }
    assert.equal(solved, expected.solved, `${policyId}: solved count changed`)
    assert.equal(cost, expected.cost, `${policyId}: total cost changed, so a policy moved`)
    assert.equal(escaped, expected.escaped, `${policyId}: escaped count changed`)
  }
})

/**
 * The result the expanded benchmark produces, stated so it cannot be quietly
 * improved away: V0 is dominated on both axes at once, by the safety baseline.
 *
 * REVISED 2026-09-28, and the revision is not in V0's favour. Measured against
 * the corrected runner, V0 is 5/8 at 20,340 against the baseline's 7/8 at
 * 27,500, so it is still dominated on success and is now CHEAPER. The
 * "no less on cost" assertion is gone because it is false, and it is not
 * replaced by "and cheaper, so it is now competitive", because that would be a
 * claim about escapedDefect that this file has no standing to make on its own.
 * The three escapes are pinned in FROZEN_FAMILY_BENCH above, where a reader
 * meets them next to the cost. Whether V0 being cheaper and less safe is still
 * domination, or a different claim about the thesis, is ADR 0005's open
 * decision and not this test's to settle.
 */
test("the expanded benchmark still finds V0 dominated on success", () => {
  const run = (id) => {
    const policy = POLICIES[id]
    let solved = 0
    for (const task of tasks) {
      const ep = runEpisode({ task, policy, policyId: id })
      if (ep.success) solved++
    }
    return { solved }
  }
  const safety = run("verify-always")
  const v0 = run("valve-v0")
  assert.ok(
    v0.solved <= safety.solved,
    "V0 solves no more than the safety baseline",
  )
  assert.ok(
    v0.solved < safety.solved,
    "and is strictly worse on success",
  )
})
