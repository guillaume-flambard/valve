import { EventStore } from "../packages/telemetry/dist/index.js"
import { createValveV0 } from "../packages/runtime/dist/index.js"

const db = process.argv[2]
const session = process.argv[3] ?? "ses_fix"

const store = new EventStore({ dbPath: db })
const events = store.getEventsForEpisode(session)
const valve = createValveV0()

for (const e of events) {
  console.log(`\n--- step ${e.step}: chosen=${e.chosen} shadow=${e.shadow.action}`)
  console.log(
    `    evidence=${e.state.evidence.length} tests=${e.state.verification.tests} ` +
      `recent=[${e.state.recentActions.map((a) => a.action).join(",")}]`
  )
  // Which layer decided? Recompute the heuristic-only answer.
  const heuristicOnly = valve.decideSync({
    state: e.state,
    candidates: e.candidates,
    utilityProfile: "coding-balanced",
  })
  console.log(
    `    decideSync -> ${heuristicOnly.action} (source=${heuristicOnly.source}, U=${heuristicOnly.expectedUtility.toFixed(3)})`
  )
}

store.close()
