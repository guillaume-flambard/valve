import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// VALVE shadow observer. Pure sensor.
//
// CANONICAL SOURCE. Install by copying to ~/.config/opencode/plugin/:
//   cp plugin/valve-shadow.ts ~/.config/opencode/plugin/
// Override the spool location with VALVE_SPOOL_DIR.
//
// It records what OpenCode actually did, as NDJSON, and nothing else. It
// never blocks, never rewrites a tool call, and never asks VALVE anything.
// Every interpretation (CognitiveState, shadow decision, utility) happens at
// ingest time in the valve repo. That separation is deliberate: the valve repo
// owns a SQLite store backed by a native Node addon, which must not be loaded
// into the opencode process.
//
// Why NDJSON instead of SQLite here: a sensor that can crash the agent is not
// a sensor. appendFileSync failures are swallowed on purpose. A dropped
// observation is a gap in the dataset; a thrown error is a broken session.
//
// The value of this plugin is entirely in the disagreement between what
// OpenCode did and what VALVE would have done. So it must be exhaustively
// faithful to what actually happened, including the uncomfortable cases.

const SPOOL_DIR =
  process.env["VALVE_SPOOL_DIR"] ??
  join(homedir(), ".local", "share", "opencode", "valve")
const MAX_FIELD = 2000

// Appends are serialized per-process and flushed synchronously. If the spool
// directory cannot be created we disable writing entirely rather than throwing
// on every hook.
let enabled = true
let spoolPath = ""

try {
  mkdirSync(SPOOL_DIR, { recursive: true })
  spoolPath = join(SPOOL_DIR, "observed.ndjson")
} catch {
  enabled = false
}

const write = (record: Record<string, unknown>) => {
  if (!enabled) return
  try {
    appendFileSync(spoolPath, JSON.stringify(record) + "\n", "utf8")
  } catch {
    // Deliberately silent. See the header: a lost observation is recoverable,
    // a thrown error inside a hook is not.
  }
}

const base = (kind: string, sessionID: string) => ({
  v: 1 as const,
  kind,
  sessionID,
  ts: Date.now(),
})

const clip = (s: unknown) =>
  typeof s === "string" ? s.slice(0, MAX_FIELD) : String(s ?? "").slice(0, MAX_FIELD)

/**
 * Truncates every string in an argument object, and drops anything that is not
 * a flat JSON value. Tool args are attacker-influenced in the general case
 * (file contents, search patterns), so this keeps the spool from becoming an
 * unbounded write path.
 */
const clipArgs = (args: unknown): Record<string, unknown> | undefined => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null || v === undefined) continue
    if (typeof v === "string") out[k] = v.slice(0, MAX_FIELD)
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v
    else if (Array.isArray(v)) {
      out[k] = v
        .slice(0, 20)
        .map((x) => (typeof x === "string" ? x.slice(0, 200) : x))
        .filter((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")
    }
    // Objects are intentionally dropped: they are the unbounded case and
    // nothing in the current ingest path needs them.
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export default (async () => {
  // callID -> timestamp of its tool_intent, so tool_result can carry latency.
  const intents = new Map<string, number>()
  // Which tool a callID belongs to, so a permission.ask can name it.
  const callTools = new Map<string, string>()
  // sessionID -> the model that session is currently using.
  const sessionModel = new Map<string, { providerID: string; modelID: string }>()

  return {
    // A new user message is the closest thing to an episode boundary. It is
    // the goal statement, and it is the only place we learn what was asked.
    "chat.message": async (input, output) => {
      const first = output.parts?.[0]
      const goal = first && first.type === "text" ? first.text : ""
      const model = input.model
      if (model) sessionModel.set(input.sessionID, model)

      write({
        ...base("episode_open", input.sessionID),
        goal: clip(goal),
        agent: input.agent,
        model,
      })
    },

    // Fires immediately before each LLM call. This is the frontier-call
    // counter: the single most important cost signal VALVE would act on.
    // Model already carries both providerID and id, so there is no need to
    // reach into the provider context.
    "chat.params": async (input) => {
      write({
        ...base("llm_call", input.sessionID),
        agent: input.agent,
        model: {
          providerID: input.model.providerID,
          modelID: input.model.id,
        },
      })
    },

    "tool.execute.before": async (input) => {
      intents.set(input.callID, Date.now())
      callTools.set(input.callID, input.tool)
    },

    "tool.execute.after": async (input, output) => {
      const started = intents.get(input.callID)
      const latencyMs = started === undefined ? 0 : Date.now() - started
      intents.delete(input.callID)

      const text = typeof output?.output === "string" ? output.output : ""
      write({
        ...base("tool_result", input.sessionID),
        callID: input.callID,
        tool: input.tool,
        title: clip(output?.title),
        // Arguments are recorded because a bare tool name is not enough to
        // know what was done. "bash" running `npm test` is a verification
        // step; "bash" running `rm -rf` is a mutation. Collapsing those would
        // make the dataset actively lie about the agent's behaviour.
        args: clipArgs(input.args),
        output: clip(text),
        outputTruncated: text.length > MAX_FIELD,
        latencyMs,
        // An empty output with a non-empty title is the shape of a tool that
        // reported a problem without throwing. Treated as a soft failure so
        // ingest can weight it, not silently drop it.
        errored: text.length === 0 && Boolean(output?.title),
      })
    },

    // The agent stopped and wants permission. This is the observable form of
    // a human interruption, and one of the numbers VALVE is meant to reduce.
    "permission.ask": async (input, output) => {
      const props = input as unknown as {
        id?: string
        sessionID?: string
        metadata?: { tool?: string; callID?: string }
      }
      const callID = props.metadata?.callID
      write({
        ...base("human_interruption", props.sessionID ?? "unknown"),
        permissionID: props.id,
        tool: props.metadata?.tool ?? (callID ? callTools.get(callID) : undefined),
        callID,
      })
    },

    event: async ({ event }) => {
      const props = event.properties as Record<string, unknown> | undefined
      if (!props) return

      if (event.type === "session.idle") {
        write({
          ...base("episode_close", String(props["sessionID"])),
          reason: "idle",
        })
        return
      }

      if (event.type === "session.error") {
        write({
          ...base("session_error", String(props["sessionID"] ?? "unknown")),
          message: clip(JSON.stringify(props).slice(0, MAX_FIELD)),
        })
        return
      }

      if (event.type === "session.deleted") {
        const info = props["info"] as { id?: string } | undefined
        if (info?.id) {
          write({ ...base("episode_close", info.id), reason: "deleted" })
        }
      }
    },

    dispose: async () => {
      intents.clear()
      callTools.clear()
      sessionModel.clear()
    },
  }
}) satisfies Plugin
