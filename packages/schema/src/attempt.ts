import { createHash } from "node:crypto"
import type { CognitiveAction, Evidence } from "./types.js"

/**
 * M4: outcome-aware trajectory state.
 *
 * The V0 state recorded a chronology:
 *
 *     ACT, ACT, ACT, TEST
 *
 * which cannot distinguish "three edits that were each checked and two of them
 * rejected" from "three edits stacked on top of each other and checked once".
 * Those two situations demand opposite next actions, and CogBench showed V0
 * picking the wrong one because the representation never distinguished them.
 *
 * What is recorded instead is an epistemology: an identity for each attempt,
 * the state it was made from, the change it produced, and what came back when
 * somebody looked.
 */

/**
 * How a training-critical fact came to be known.
 *
 * Ordered by strength. Only `harness` and `environment` are primary facts.
 * `deterministic` and `derived` are interpretations of an observed fact, and
 * `agent` is a self-report. A model may supply interpretation freely; it may
 * never supply the fact.
 */
export type Provenance =
  | "harness"
  | "environment"
  | "deterministic"
  | "derived"
  | "agent"

/** Provenance strong enough to create a training label. */
export const PRIMARY_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>([
  "harness",
  "environment",
])

/**
 * Strength of the grounding behind a single labelled field.
 *
 * This is deliberately finer than a boolean. A shadow-mode `read` tool is
 * named unambiguously and its operation is a fact about the tool. A shadow-mode
 * `bash` is named ambiguously and its operation is a classification. Both are
 * inferences, but collapsing them to "inferred" would throw away the honest
 * half of the corpus, and calling both "grounded" would launder a guess.
 */
export type Grounding =
  /** Declared by the process that executed the step. */
  | "harness"
  /** A tool name that maps to exactly one operation. */
  | "deterministic"
  /** Classified from content, heuristics, or a shell command. */
  | "derived"
  /** Nothing reliable was available. */
  | "ungrounded"

/** Grounding sufficient to train an action predictor on. */
export const TRAINABLE_GROUNDING: ReadonlySet<Grounding> = new Set<Grounding>([
  "harness",
  "deterministic",
])

/**
 * The verdict on an attempt.
 *
 * `unattributable` is the one that matters most and is easy to forget. When
 * three edits are stacked and a single test run fails, nothing in the
 * observation distinguishes which one was wrong. Recording three confident
 * `falsified` verdicts would be a fabrication, and the resulting model would
 * learn to punish interventions that were never shown to be bad.
 */
export type AttemptVerdict =
  | "pending"
  | "supported"
  | "falsified"
  | "inconclusive"
  /** Stacked under other unverified attempts; the oracle cannot single this one out. */
  | "unattributable"

/**
 * Whether a verdict identifies a single attempt or a compound state.
 *
 * `compound` is an admission, not a failure: once causal attribution has been
 * destroyed by stacking, the honest record is that it was destroyed, and that
 * fact is itself something a scheduler can learn to avoid.
 */
export type Attribution = "individual" | "compound"

export interface EvidenceRef {
  evidenceId: string
  /** The observation that judged the attempt. */
  kind: "test" | "build" | "manual" | "none"
  /** Process exit code, when the observation was a real command. */
  exitCode?: number
  /** True when the observation was grounded rather than inferred. */
  grounded: boolean
}

export interface Attempt {
  id: string
  step: number
  episodeId: string
  cognitiveAction: CognitiveAction

  /**
   * Fingerprint of the state this attempt was made from. A falsified attempt
   * is only a fact about `(base, intervention)`, never about the intervention
   * in general: "this patch is bad" is wrong, "this patch is bad from here" is
   * right, and only the first half is actionable anyway.
   */
  baseCheckpoint: string

  /**
   * Fingerprint of the state this attempt produced. Two attempts with the same
   * delta fingerprint made from the same base are the same intervention, which
   * is what makes repeating a falsified attempt detectable.
   */
  deltaFingerprint: string

  /** What the attempt was supposed to establish, when the emitter knew. */
  hypothesis?: string

  verdict: AttemptVerdict
  attribution: Attribution

  evidence: EvidenceRef[]

  /** Checkpoint after the attempt, absent while the state is unknown. */
  resultingCheckpoint?: string

  /** Verifications that spoke to this attempt. */
  verifiedBy: string[]

  /** True once the state has been rolled back. Falsification outlives a reset. */
  reverted: boolean

  costTokens: number

  /** How the operation label was established. Absent label is never invented. */
  grounding: Grounding

  provenance: Provenance
}

export interface Verification {
  id: string
  step: number
  episodeId: string
  /**
   * Which attempts this observation speaks to. A test that runs against a
   * state carrying three stacked edits speaks to all three, and to none of
   * them individually.
   */
  targets: string[]
  command: string
  exitCode: number
  /** Checkpoint the command ran against. */
  checkpoint: string
  provenance: Provenance
  grounded: boolean
  timedOut: boolean
}

/** A state change that has not yet been judged. */
export function pendingAttempts(attempts: Attempt[]): Attempt[] {
  return attempts.filter((a) => a.verdict === "pending")
}

/** An unverified delta exists: the world moved and nobody has looked. */
export function hasUnverifiedDelta(state: {
  verifiedCheckpoint: string
  currentCheckpoint: string
}): boolean {
  return state.verifiedCheckpoint !== state.currentCheckpoint
}

/**
 * Attempts already falsified from the same base with the same delta.
 *
 * Not yet a prohibition, only detectability. Forbidding a repeat is a policy
 * decision, and M4 changes no policy.
 */
export function findRepeats(attempts: Attempt[]): Array<{ attempted: Attempt; matches: Attempt[] }> {
  const falsified = attempts.filter((a) => a.verdict === "falsified")
  const out: Array<{ attempted: Attempt; matches: Attempt[] }> = []
  for (const attempt of attempts) {
    if (attempt.verdict !== "pending") continue
    const matches = falsified.filter(
      (f) => f.baseCheckpoint === attempt.baseCheckpoint && f.deltaFingerprint === attempt.deltaFingerprint
    )
    if (matches.length > 0) out.push({ attempted: attempt, matches })
  }
  return out
}

/**
 * A checkpoint is a fingerprint of a set of file contents.
 *
 * Content-addressed on purpose: identical state yields an identical
 * checkpoint, so "did anything actually change" needs no extra bookkeeping and
 * two agents that converged on the same state share a checkpoint.
 */
export function checkpointOf(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const path of Object.keys(files).sort()) {
    hash.update(path)
    hash.update("\0")
    hash.update(files[path] ?? "")
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 32)
}

/**
 * The identity of an intervention, independent of the state it landed in.
 *
 * Two attempts with the same delta fingerprint made from the same base are the
 * same move. Derived from the changed paths and their contents, so it does not
 * depend on the emitter having named the attempt anything in particular.
 */
export function deltaFingerprintOf(
  before: Record<string, string>,
  after: Record<string, string>
): string {
  const hash = createHash("sha256")
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const path of [...paths].sort()) {
    const a = before[path]
    const b = after[path]
    if (a === b) continue
    hash.update(path)
    hash.update("\0")
    hash.update(b ?? "\u0000absent")
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 32)
}

/**
 * Assigns verdicts after a verification.
 *
 * This is the rule that makes the schema honest rather than decorative. When
 * several attempts are pending, one test run cannot attribute the result to
 * any single one of them, so all of them become `unattributable` rather than
 * `falsified`. A model trained on fabricated per-attempt verdicts would learn
 * to avoid interventions that were never shown to fail, which is worse than
 * having no model at all.
 */
export function attributeVerdict(
  attempts: Attempt[],
  verification: Verification,
  pass: boolean
): Attempt[] {
  const targeted = attempts.filter(
    (a) => a.verifiedBy.includes(verification.id) || verification.targets.includes(a.id)
  )
  const pending = targeted.filter((a) => a.verdict === "pending")
  if (pending.length === 0) return attempts

  const compound = pending.length > 1
  return attempts.map((a) => {
    if (!pending.includes(a)) return a
    if (compound) {
      return {
        ...a,
        verdict: "unattributable" as AttemptVerdict,
        attribution: "compound" as Attribution,
        evidence: [...a.evidence, evidenceRefFor(verification)],
      }
    }
    return {
      ...a,
      verdict: pass ? ("supported" as AttemptVerdict) : ("falsified" as AttemptVerdict),
      attribution: "individual" as Attribution,
      evidence: [...a.evidence, evidenceRefFor(verification)],
    }
  })
}

function evidenceRefFor(verification: Verification): EvidenceRef {
  return {
    evidenceId: verification.id,
    kind: "test",
    exitCode: verification.exitCode,
    grounded: verification.grounded,
  }
}

/** Convenience for building a CognitiveState that carries an epistemology. */
export interface EpistemicState {
  verifiedCheckpoint: string
  currentCheckpoint: string
  attempts: Attempt[]
  evidence: Evidence[]
}
