/**
 * Raw sensor records emitted by the OpenCode shadow plugin.
 *
 * These are written as NDJSON by ~/.config/opencode/plugin/valve-shadow.ts.
 * The plugin is a pure sensor: it records what OpenCode actually did and
 * never interprets it. Interpretation, CognitiveState construction and the
 * VALVE shadow decision all happen during ingest, in the valve repo.
 *
 * CogBench writes the same records through the same reader, so a benchmark run
 * and a real session land in one dataset behind one set of queries. Two
 * measurement pipelines would drift, and the disagreement query is only
 * meaningful over a single corpus.
 *
 * Rationale for the split: the plugin stays dependency-free (matching every
 * other plugin in that directory) and, critically, the valve repo's SQLite
 * store is pure JS, so nothing native is loaded into the opencode process.
 */

import type { CognitiveActionKind } from "./types.js";
import type { Grounding, Provenance } from "./attempt.js";

export type ObservedKind =
  | "episode_open"
  | "episode_close"
  | "tool_intent"
  | "tool_result"
  | "llm_call"
  | "human_interruption"
  | "session_error";

export interface ObservedBase {
  /** Schema version, so a stale spool can be detected rather than misread. */
  v: 1;
  kind: ObservedKind;
  /** OpenCode sessionID, used as the episode key. */
  sessionID: string;
  /** Milliseconds since epoch. */
  ts: number;
}

export interface EpisodeOpenObserved extends ObservedBase {
  kind: "episode_open";
  /** First user message, truncated: the goal of the episode. */
  goal: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

export interface EpisodeCloseObserved extends ObservedBase {
  kind: "episode_close";
  reason: "idle" | "deleted" | "error";
}

export interface ToolIntentObserved extends ObservedBase {
  kind: "tool_intent";
  callID: string;
  tool: string;
}

export interface ToolResultObserved extends ObservedBase {
  kind: "tool_result";
  callID: string;
  tool: string;
  title: string;
  /**
   * Tool arguments, truncated. Required, not optional-in-practice: without
   * the command text a `bash` call is indistinguishable from an arbitrary
   * mutation, so "npm test" and "rm -rf" would collapse to the same label.
   */
  args?: Record<string, unknown>;
  /**
   * The cognitive operation this step actually performed, when the emitter
   * knows it because it executed the step.
   *
   * Present on CogBench records and absent on shadow-plugin records. That
   * asymmetry is the whole point: a bench harness executes a step and knows
   * what it did, whereas the shadow plugin only sees a tool name and has to
   * classify it. Ingest trusts this field when present and classifies
   * otherwise, and it never infers an operation from a field the emitter left
   * blank, because a wrong label here becomes a training label.
   */
  cognitiveAction?: CognitiveActionKind;
  /**
   * Declared strength of the grounding behind `cognitiveAction`. Emitters state
   * it rather than letting the reader assume it, so an ungrounded step is
   * visible in the corpus instead of being quietly promoted to ACT.
   */
  grounding?: Grounding;
  /**
   * How the outcome attached to this record was observed. The plugin sees
   * environment output, so it emits "environment"; the bench sees a real exit
   * code, so it emits "harness".
   */
  provenance?: Provenance;
  /**
   * Exit code, when the emitter observed a real process exit. A timeout is not
   * a test failure and must not be recorded as one.
   */
  exitCode?: number;
  timedOut?: boolean;
  /** Truncated. Full output stays in OpenCode's own storage. */
  output: string;
  outputTruncated: boolean;
  /** Wall time between tool_intent and tool_result for this callID. */
  latencyMs: number;
  /** Tool threw. Presence of an error is the only reliable failure signal here. */
  errored: boolean;
}

export interface LlmCallObserved extends ObservedBase {
  kind: "llm_call";
  agent: string;
  model: { providerID: string; modelID: string };
  maxOutputTokens: number | undefined;
}

export interface HumanInterruptionObserved extends ObservedBase {
  kind: "human_interruption";
  permissionID?: string;
  /** What the agent was trying to do when it needed a human. */
  tool?: string;
  callID?: string;
}

export interface SessionErrorObserved extends ObservedBase {
  kind: "session_error";
  message: string;
}

export type ObservedEvent =
  | EpisodeOpenObserved
  | EpisodeCloseObserved
  | ToolIntentObserved
  | ToolResultObserved
  | LlmCallObserved
  | HumanInterruptionObserved
  | SessionErrorObserved;

export const SPOOL_SCHEMA_VERSION = 1 as const;
export const SPOOL_MAX_FIELD = 2000 as const;
