import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ingestSpool } from "../packages/opencode-adapter/dist/index.js"
import { EventStore } from "../packages/telemetry/dist/index.js"

const dir = mkdtempSync(join(tmpdir(), "valve-ingest-"))

/**
 * Opens a store and guarantees it is closed when the test ends, pass or fail.
 *
 * Without this, a failing assertion skips the close, the native SQLite handle
 * is finalised by the garbage collector mid-process, and node aborts with a V8
 * assertion instead of reporting the assertion that actually failed. A test
 * harness that destroys its own failure report is worse than no harness.
 */
function openStore(t, dbPath) {
  const store = new EventStore({ dbPath })
  t.after(() => store.close())
  return store
}

/**
 * A spool that reproduces the situation VALVE exists to catch: the agent edits
 * code three times in a row and never runs the tests. The third edit is
 * exactly the point where a scheduler should have intervened with TEST.
 */
function writeSpool() {
  const t0 = Date.now() - 60000
  const records = [
    { v: 1, kind: "episode_open", sessionID: "ses_1", ts: t0, goal: "Add retry to http client" },
    { v: 1, kind: "llm_call", sessionID: "ses_1", ts: t0 + 100, agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } },
    { v: 1, kind: "tool_result", sessionID: "ses_1", ts: t0 + 900, callID: "c1", tool: "read", title: "read client", output: "class HttpClient {}", outputTruncated: false, latencyMs: 300, errored: false },
    { v: 1, kind: "llm_call", sessionID: "ses_1", ts: t0 + 1000, agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } },
    { v: 1, kind: "tool_result", sessionID: "ses_1", ts: t0 + 2100, callID: "c2", tool: "edit", title: "edit client", output: "wrote 40 lines", outputTruncated: false, latencyMs: 400, errored: false },
    { v: 1, kind: "llm_call", sessionID: "ses_1", ts: t0 + 2200, agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } },
    { v: 1, kind: "tool_result", sessionID: "ses_1", ts: t0 + 3400, callID: "c3", tool: "edit", title: "edit config", output: "wrote 12 lines", outputTruncated: false, latencyMs: 400, errored: false },
    { v: 1, kind: "llm_call", sessionID: "ses_1", ts: t0 + 3500, agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } },
    { v: 1, kind: "tool_result", sessionID: "ses_1", ts: t0 + 9800, callID: "c4", tool: "bash", title: "run tests", args: { command: "npm test" }, output: "3 passed 0 failed", outputTruncated: false, latencyMs: 5900, errored: false },
    { v: 1, kind: "episode_close", sessionID: "ses_1", ts: t0 + 10000, reason: "idle" },
  ]
  const spool = join(dir, "observed.ndjson")
  writeFileSync(spool, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return spool
}

test("ingest reconstructs state and records shadow prediction per decision point", (t) => {
  const spool = writeSpool()
  const db = join(dir, "valve.db")

  const result = ingestSpool({ spoolPath: spool, dbPath: db })

  assert.equal(result.linesRead, 10)
  assert.equal(result.linesSkipped, 0)
  assert.equal(result.episodes, 1)
  assert.equal(result.decisionPoints, 4, "one decision point per completed tool call")
  assert.equal(result.llmCalls, 4)
  assert.equal(result.humanInterruptions, 0)

  const store = openStore(t, db)
  const events = store.getEventsForEpisode("ses_1")
  assert.equal(events.length, 4)

  // Ground truth is what the agent actually did, not what VALVE wished.
  assert.deepEqual(events.map((e) => e.chosen), ["READ", "ACT", "ACT", "TEST"])

  // Every decision point carries a shadow prediction.
  for (const e of events) {
    assert.ok(e.shadow, "shadow prediction present")
    assert.equal(typeof e.shadow.action, "string")
    assert.equal(typeof e.shadow.agrees, "boolean")
  }

})

test("state handed to VALVE never contains the outcome it is judged against", (t) => {
  const spool = writeSpool()
  const db = join(dir, "valve-prefix.db")
  ingestSpool({ spoolPath: spool, dbPath: db })

  const store = openStore(t, db)
  const events = store.getEventsForEpisode("ses_1")

  // Decision point 1 sees an empty recent-action history: the read that
  // produced it has not happened yet at decision time.
  assert.equal(events[0].state.recentActions.length, 0)

  // Decision point 2 sees the read.
  assert.equal(events[1].state.recentActions.length, 1)
  assert.equal(events[1].state.recentActions[0].action, "READ")

  // The test run is the last step, so only the final state may know tests passed.
  const sawTestsPassing = events.filter(
    (e) => e.state.verification.tests === "passed"
  )
  assert.ok(
    sawTestsPassing.length <= 1,
    "test outcome cannot leak into earlier decision points"
  )

})

test("VALVE disagrees where the agent kept editing without testing", (t) => {
  const spool = writeSpool()
  const db = join(dir, "valve-disagree.db")
  const result = ingestSpool({ spoolPath: spool, dbPath: db })

  const store = openStore(t, db)
  const disagreements = store.getDisagreements()
  const stats = store.getShadowStats()

  assert.equal(stats.total, 4)
  assert.ok(
    disagreements.length > 0,
    "the core hypothesis: VALVE must disagree with edit-edit-no-test at least once"
  )

  // The disagreement that matters: VALVE wanted a test run, the agent edited.
  const wantedTest = disagreements.find((e) => e.shadow.action === "TEST")
  assert.ok(
    wantedTest,
    "VALVE should have proposed TEST against a run of unverified edits"
  )
  assert.equal(wantedTest.chosen, "ACT")
  assert.equal(wantedTest.shadow.agrees, false)

  assert.equal(result.agreementRate, stats.agreementRate)
  assert.equal(result.disagreements, disagreements.length)

})

test("spool is rotated, never deleted", (t) => {
  const spool = writeSpool()
  ingestSpool({ spoolPath: spool, dbPath: join(dir, "valve-rotate.db") })

  assert.equal(existsSync(spool), false, "original spool consumed")
  assert.equal(existsSync(`${spool}.ingested`), true, "rotated copy retained")
})

test("torn trailing line is skipped without losing the rest", (t) => {
  const spool = writeSpool()
  writeFileSync(spool, readFileSync(spool, "utf8") + '{"v":1,"kind":"tool_res')
  const result = ingestSpool({ spoolPath: spool, dbPath: join(dir, "valve-torn.db") })

  assert.equal(result.linesSkipped, 1)
  assert.equal(result.decisionPoints, 4, "complete records still ingested")
})

/**
 * M4 inverted this test's premise.
 *
 * It used to assert that an unrecognised tool "degrades to ACT", which is
 * exactly the silent fallback that corrupted the first CogBench run: 41 test
 * steps were ingested as ACT because no shell command was available to
 * classify them. The record is still kept, so nothing is dropped, but the
 * label is now UNKNOWN and the record is excluded from training.
 */
test("an unknown tool is kept, labelled UNKNOWN, and never coerced to a mutation", (t) => {
  const t0 = Date.now()
  const spool = join(dir, "unknown.ndjson")
  writeFileSync(
    spool,
    [
      { v: 1, kind: "episode_open", sessionID: "ses_x", ts: t0, goal: "g" },
      { v: 1, kind: "tool_result", sessionID: "ses_x", ts: t0 + 1, callID: "z1", tool: "some_new_tool", title: "t", output: "o", outputTruncated: false, latencyMs: 10, errored: false },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  )

  const result = ingestSpool({ spoolPath: spool, dbPath: join(dir, "valve-unknown.db") })
  const store = openStore(t, join(dir, "valve-unknown.db"))
  const events = store.getEventsForEpisode("ses_x")

  assert.equal(events.length, 1, "the record is retained, not dropped")
  assert.equal(events[0].chosen, "UNKNOWN", "and not filed as a mutation")
  assert.equal(events[0].grounding, "ungrounded")
  assert.equal(result.ungroundedLabels, 1, "and counted so the gap stays visible")
  assert.equal(result.rejectedForTraining, 1)

  // A bash call with no observable command is the case that actually bit.
  const bashSpool = join(dir, "bare-bash.ndjson")
  writeFileSync(
    bashSpool,
    [
      { v: 1, kind: "episode_open", sessionID: "ses_bare", ts: t0, goal: "g" },
      { v: 1, kind: "tool_result", sessionID: "ses_bare", ts: t0 + 1, callID: "b1", tool: "bash", title: "npm test", output: "3 passed", outputTruncated: false, latencyMs: 10, errored: false },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  )
  ingestSpool({ spoolPath: bashSpool, dbPath: join(dir, "valve-bare.db") })
  const bareStore = openStore(t, join(dir, "valve-bare.db"))
  assert.equal(
    bareStore.getEventsForEpisode("ses_bare")[0].chosen,
    "UNKNOWN",
    "a bare bash call is the M3 corruption case and must not become ACT"
  )
})

test("missing spool is a no-op, not a crash", (t) => {
  const result = ingestSpool({
    spoolPath: join(dir, "does-not-exist.ndjson"),
    dbPath: join(dir, "valve-missing.db"),
  })
  assert.equal(result.linesRead, 0)
  assert.equal(result.episodes, 0)
})

// --- regressions for defects found by running the pipeline, not by reading it ---

/**
 * `bash` was labelled ACT, so a correct `npm test` was recorded as a generic
 * mutation and VALVE proposing TEST scored as a disagreement against an agent
 * that had done the right thing.
 */
test("shell commands are classified by what they run, not by tool name", (t) => {
  const t0 = Date.now()
  const spool = join(dir, "bash-classify.ndjson")
  const cases = [
    ["npm test", "TEST"],
    ["pnpm vitest run", "TEST"],
    ["cargo test", "TEST"],
    ["pytest -q", "TEST"],
    ["ruff check .", "VERIFY"],
    ["tsc --noEmit", "VERIFY"],
    ["grep -r foo src/", "SEARCH"],
    ["git diff HEAD~1", "READ"],
    ["git log --oneline", "READ"],
    ["git status", "ACT"],
    // Arguments must not drive classification. These are the cases that
    // produced a destructive command labelled VERIFY, because "build" and
    // "test" appeared in a path rather than as the operation.
    ["rm -rf /tmp/build", "ACT"],
    ["rm -rf ./test-fixtures", "ACT"],
    ["cat /var/log/test.log", "READ"],
    ["mv dist/test.js out/", "ACT"],
    // Chained segments are judged independently.
    ["cd /repo && npm test", "TEST"],
    ["npm run build && npm test", "TEST"],
    // A command that both verifies and mutates is recorded as a mutation,
    // because that is the operation carrying the risk.
    ["npm test && rm -rf dist", "ACT"],
  ]
  writeFileSync(
    spool,
    [
      { v: 1, kind: "episode_open", sessionID: "ses_b", ts: t0, goal: "g" },
      ...cases.map(([command], i) => ({
        v: 1,
        kind: "tool_result",
        sessionID: "ses_b",
        ts: t0 + i + 1,
        callID: `b${i}`,
        tool: "bash",
        title: command,
        args: { command },
        output: "ok",
        outputTruncated: false,
        latencyMs: 5,
        errored: false,
      })),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  )

  ingestSpool({ spoolPath: spool, dbPath: join(dir, "valve-bash.db") })
  const store = openStore(t, join(dir, "valve-bash.db"))
  const got = store.getEventsForEpisode("ses_b").map((e) => e.chosen)
  assert.deepEqual(got, cases.map(([, op]) => op))
})

/**
 * `state.evidence` was hardcoded to `[]`. Since `evidence.length` drives the
 * information-seeking priors, a state claiming zero evidence after the agent
 * read a file biased the policy permanently toward searching.
 */
test("state reports the evidence the agent actually gathered", (t) => {
  const t0 = Date.now()
  const spool = join(dir, "evidence.ndjson")
  writeFileSync(
    spool,
    [
      { v: 1, kind: "episode_open", sessionID: "ses_e", ts: t0, goal: "g" },
      { v: 1, kind: "tool_result", sessionID: "ses_e", ts: t0 + 1, callID: "e1", tool: "read", title: "read a.ts", args: { filePath: "a.ts" }, output: "export const a = 1", outputTruncated: false, latencyMs: 5, errored: false },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  )

  ingestSpool({ spoolPath: spool, dbPath: join(dir, "valve-ev.db") })
  const store = openStore(t, join(dir, "valve-ev.db"))
  const decisionPoint = store.getEventsForEpisode("ses_e")[0]
  // The read has not happened yet at decision time...
  assert.equal(decisionPoint.state.evidence.length, 0)
  // ...but the episode's final state must know about it.
  const episode = store.getEpisode("ses_e")
  assert.equal(episode.finalState.evidence.length, 1)
  assert.equal(episode.finalState.evidence[0].source, "file")
})

/**
 * The two heuristics below once produced false disagreements against a
 * correct trajectory, which is the worst kind of shadow bug: it would have
 * taught the model to disagree with good behaviour.
 *
 *  - `no-evidence-search` fired whenever evidence was empty, which is true at
 *    the start of every task, so every episode opened with SEARCH.
 *  - `simple-fix-reason-fast` matched the substring "fix" in the task text. In
 *    shadow mode currentTask is the echoed goal, so any goal containing "fix"
 *    routed to REASON_FAST regardless of state.
 */
test("a correct read-then-test trajectory produces no false disagreement", (t) => {
  const t0 = Date.now()
  const spool = join(dir, "correct.ndjson")
  writeFileSync(
    spool,
    [
      { v: 1, kind: "episode_open", sessionID: "ses_ok", ts: t0, goal: "fix the failing pagination test" },
      { v: 1, kind: "tool_result", sessionID: "ses_ok", ts: t0 + 1, callID: "k1", tool: "read", title: "read pagination.ts", args: { filePath: "p.ts" }, output: "export function paginate(){}", outputTruncated: false, latencyMs: 5, errored: false },
      { v: 1, kind: "tool_result", sessionID: "ses_ok", ts: t0 + 2, callID: "k2", tool: "bash", title: "npm test", args: { command: "npm test" }, output: "3 passed 0 failed", outputTruncated: false, latencyMs: 900, errored: false },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  )

  const result = ingestSpool({ spoolPath: spool, dbPath: join(dir, "valve-ok.db") })
  const store = openStore(t, join(dir, "valve-ok.db"))
  const events = store.getEventsForEpisode("ses_ok")

  assert.deepEqual(events.map((e) => e.chosen), ["READ", "TEST"])
  assert.deepEqual(events.map((e) => e.shadow.action), ["READ", "TEST"])
  assert.equal(result.disagreements, 0, "no phantom disagreement on correct behaviour")
  assert.equal(result.agreementRate, 1)
})
