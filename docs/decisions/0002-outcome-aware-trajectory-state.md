# M4: outcome-aware trajectory state

- **Date:** 2026-09-28
- **Status:** accepted
- **Milestone:** M4
- **Supersedes nothing.** Extends ADR 0001, whose negative result still stands.

## What changed

`recentActions` recorded a chronology. It now sits alongside an epistemology:
attempt identity, the state each attempt was made from, the change it produced,
and what came back when somebody looked.

The decisive query is now answerable. Same task, same two policies, same
intervention space — the base checkpoints are identical across both runs:

```
valve-v0        attempt 1  unattributable (compound)
                attempt 2  unattributable (compound)
                attempt 3  unattributable (compound)
                3 attempts, 0 falsified, 3 unattributable

test-always     attempt 1  falsified (individual)   evidence: test exit=1
                attempt 2  supported (individual)   evidence: test exit=0
                2 attempts, 1 falsified, 0 unattributable
```

The V0 representation could not have produced either column. It recorded
`ACT ACT ACT TEST` for the first run and could not say that causal attribution
had been destroyed, which is precisely the fact the second run preserves.

## The decisions that mattered

**Unattributable is a real verdict.** Three stacked edits and one failing test
cannot identify which edit was wrong. Recording three confident `falsified`
verdicts would fabricate information, and a model trained on it would learn to
avoid interventions that were never shown to fail. `attribution: "compound"`
records the loss instead of hiding it.

**Checkpoints are content-addressed.** Identity comes from the state, not from
an emitter naming things, so two attempts with the same delta from the same base
are the same move regardless of what either emitter called them. A falsified
attempt is a fact about `(base, intervention)`, never about the intervention in
general.

**Falsification survives rollback.** The bench resets state between edits by
construction, so `reverted` is true for most rejected attempts. A rejection that
a reset could erase would be a rejection the dataset quietly forgets.

**Repeats are detectable, not forbidden.** `findRepeats` reports an attempt
that repeats a falsified one from the same base. Forbidding it is a policy
decision, and M4 changes no policy.

## The invariant

`cognitiveAction ?? "ACT"` is gone. An unrecognised tool is recorded as
`UNKNOWN`, counted, and excluded from training. An ungrounded label is also not
scored as a shadow disagreement, because that would penalise the policy for a
gap in the observer rather than for a wrong decision.

Grounding is graded rather than boolean:

| grounding | meaning | trainable |
|---|---|---|
| `harness` | declared by the process that executed the step | yes |
| `deterministic` | tool name maps to exactly one operation | yes |
| `derived` | classified from a command or heuristics | no |
| `ungrounded` | nothing reliable available | no |

Measured on a real shadow session: `deterministic` 2 records (2 trainable),
`derived` 1 (0 trainable), `ungrounded` 1 (0 trainable). Agreement was 2/3
scored with 1 explicitly unscored.

## The consequence worth arguing about

**Only `read`, `edit` and `search` are trainable from the shadow corpus.** Every
shell-based operation is `derived`, because classifying `bash` from its command
is inference. In real OpenCode, running tests *is* a shell call.

So shadow data alone cannot train a model on verification decisions, which are
the decisions this project is about. Grounded verification labels come from a
harness that executes and observes an exit code. That is an argument for
investing in CogBench coverage rather than only accumulating sessions, and it
was not visible before M4 because `derived` and `harness` looked identical.

## What was not done

No heuristic was touched. The bench numbers are byte-identical to ADR 0001
(`valve-v0` 1/2 solved, 10,800 cost, 6 frontier calls; `test-always` 2/2,
11,900; the rest 1/2, 7,200), pinned by a test so any future drift is visible
rather than discovered later.

One M3 test was inverted rather than deleted. It asserted that an unrecognised
tool "degrades to ACT", which is the exact fallback that corrupted the first
CogBench run. The record is still kept, so nothing is dropped; only the
fabricated label is gone.

## Next

M5 may now introduce policies that read this state: never repeat a falsified
intervention from the same base, and compare expected value of verifying against
expected value of trying another hypothesis. The bar is still `test-always`.
The target is its success at lower cost, not higher success than it.
