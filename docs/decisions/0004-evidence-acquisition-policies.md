# M6: evidence acquisition, and a policy that is close but not yet sufficient

- **Date:** 2026-09-28
- **Status:** accepted, amended 2026-09-28 by ADR 0005. The `risk-adjusted` 3/8 result below is WITHDRAWN
  and the M6 headline that the bar was not met is WITHDRAWN. Both withdrawals and their replacements are
  stated in "Amended by ADR 0005" at the end. The table in "The result" is the as-measured one and is kept
  for the same reason the superseded M7 table is kept: a reader auditing the withdrawal has to be able to
  see the claim that was withdrawn.
- **Milestone:** M6
- **Benchmark:** frozen (ADR 0003), except two declared runner fixes, below
- **Next:** spent. M7 replication corpus, 8 development tasks to 24 unseen, was built and run; its result
  is ADR 0005.

## The question, restated

Not "how often should a policy check" but:

> How much evidence is enough to avoid buying the full oracle?

The loss is explicit: a check costs `costModel.verify`, shipping a defect costs
`costModel.defectEscape`, another edit costs `costModel.act` plus frontier
reasoning. So the decision is a comparison of prices, and the policies differ
only in how they judge whether the evidence in hand already suffices.

## The result

**SUPERSEDED 2026-09-28 by ADR 0005.** Every number here was measured on a harness that fed the gated
policies a refutation recorded against a state an edit had already destroyed. Three of these rows move; the
replacement numbers are in "Amended by ADR 0005". `verify-always`, `test-always` and the two M3 controls do
not move, and the reason they do not is in ADR 0005: those policies never read the field the bug lived in.

```
policy                solved  escaped  cheap  oracle  edits  cost
verify-always         7/8     0        0      11      11      27,500
evidence-gated        6/8     0        7      8       12      25,700
test-always           4/8     3        7      1       8       10,180
valve-v0              3/8     0        8      12      15      35,740
risk-adjusted         3/8     0        1      8       15      26,760
confidence-threshold  2/8     0        8      8       16      29,020
oracle-budgeted       2/8     0        8      8       16      29,020
```

**`evidence-gated` beats V0 on both axes at once**: 6/8 against 3/8, and 25,700
against 35,740. It ships no defects. Both halves of that sentence were measured
on the flawed harness. On the corrected harness `evidence-gated` still beats V0 on
success, 7/8 against 5/8, and still ships no defects, but it no longer beats it on
cost: 28,320 against 20,340, because V0 is cheaper once it stops leaning on a stale
red. The "on both axes at once" claim is withdrawn.

**It does not meet the bar.** The target is `verify-always`'s 7/8 at lower
cost. `evidence-gated` reaches 6/8 at a cost that is only 1,800 lower, which is
not a Pareto improvement on success and is a marginal one on cost. The gap is
one task, and it is stated in a test so it cannot be quietly closed by editing
the assertion.

**WITHDRAWN 2026-09-28.** On the corrected harness `evidence-gated` reaches 7/8,
which is the bar, and costs 28,320 against 27,500, which is 820 *more* rather than
1,800 less. The "does not meet the bar" headline is therefore withdrawn and the
reason it is withdrawn is not that the policy improved. It meets the bar on
success and pays for it. M6's reasoning, that a match on success bought at a
higher cost is not a Pareto improvement, is unchanged and is now stated as a pin
in `experiments/m6.test.mjs`.

The most interesting failure is `risk-adjusted`, the policy the thesis actually
predicts. At 3/8 it is the **worst** of the gated policies. The price
comparison is right in form and wrong in practice: with `pSufficient` set by
hand, the threshold almost never fires, and a policy that does not buy the
oracle gets no benefit from knowing what the oracle costs. This is a real
negative result about the thesis as stated, not a tuning problem.

**WITHDRAWN 2026-09-28.** This is the withdrawal ADR 0005 was written to make,
and it is the one that matters most in this document, because this paragraph is
the only place the project recorded a negative result about its own thesis. The
3/8 is an artefact of the stale latch: the same policy solves 7 of the 8
development tasks and all 24 of the unseen ones once the harness stops handing
it a refutation about a state that no longer exists. A negative result about the
thesis that a one-line harness fix erases was not a result about the thesis.

`oracle-budgeted` at 2/8 was measured with a budget of 5 oracle calls for 8
tasks. It spends its budget and degrades to the cheap channel, which is the
intended behaviour, but a budget that tight cannot support the safety property.
The scheduling question is real and remains open.

## Three bugs the milestone found, all in the harness rather than the policies

1. **Stale evidence survived an edit.** A refutation describes the state it was
   observed on. Carrying `oracle-red` across an edit let a policy apply a
   correct fix and then immediately overwrite it with the next one, because the
   state still looked refuted. Evidence is now cleared when the world moves.
2. **Terminal states could be reached with no evidence at all.** With no edits
   left and nothing said about the resulting state, the policies returned STOP.
   `evidence-gated` finished family A having applied a regression and never
   looked at it. A state nobody has examined is not a finished state.
3. **The cheap channel was never invoked.** The first draft of the gated
   policies gated on "a cheap test is green" while never running the cheap
   test, so they had no evidence to gate on, applied sixteen edits and scored
   identically to `act-always`. The cycle has to be ACT, cheap check, decide.

## The freeze, and the two declared deviations

ADR 0003 froze the tasks and the cost model. Both are untouched. **The runner
changed twice**, because each policy milestone immediately surfaced a state
tracking bug in it, and the baselines moved as a result both times.

First, M6:

```
                    before     after
verify-always      25,100    27,500
valve-v0           27,920    35,740
```

Second, M7, which found that the M6 fix had cleared two of the three copies of
the same fact and left the one the gated policies actually read. That fix is in
`runner.ts` and the numbers it moved are in "Amended by ADR 0005" below. It moved
`valve-v0` from 3 / 35,740 / 0 escaped to 5 / 20,340 / 3 escaped, and
`evidence-gated` from 6 / 25,700 to 7 / 28,320. The second deviation is the one
that costs this document its own headline negative result, which is why it is
recorded here rather than only in ADR 0005.

The freeze exists to stop a policy being fitted to a benchmark. A harness bug
is not that, and preserving a known-wrong measurement to protect a nicer number
would defeat the purpose of the project. The deviation is recorded in the test
that pins the numbers rather than only here, so anyone reading the pin sees it.
Both are, in `experiments/m4.test.mjs` and `experiments/m6.test.mjs`.

**What neither deviation touched:** the tasks, the cost model, and the policy
sources. `policies.ts`, `policies-m6.ts` and `tasks.ts` still hash to exactly the
values frozen in `docs/protocols/m7-replication.md`. Twice now, the harness was
the thing that moved and the benchmark was not, which is the only reason a
re-measurement of the same corpus is legitimate at all.

## Guarding against the obvious cheat

A policy that branches on `task.family` is a lookup table: the families are an
analyst's grouping and nothing in a real agent observes them. A policy that
reads `knownFlaw` is reading the answer key. Both are checked by scanning the
policy sources, with comments stripped so prose about the families is not
mistaken for a branch.

## What has to happen before any strong claim

1. Freeze this policy set.
2. Build the 24 replication tasks, ideally by someone who has not seen which
   policy won.
3. Report on those alone.

Building the corpus after seeing the result, and then evaluating on it, is what
makes the number mean something. On 8 tasks with 1 instance per family, the
result above is a hypothesis, not a finding.

**All three were done**, and the result is ADR 0005. The corpus was not built by
someone who had not seen which policy won, which this document named as the ideal
and ADR 0005 records as the largest weakness of the result. What this document
did not anticipate is that the precondition would turn out to be the harness
rather than the corpus: the 8-task result above was not merely a hypothesis, it
was partly wrong, and no re-run of the 24 would have found that out.

## Amended by ADR 0005, 2026-09-28

The replacement table for "The result", measured on the corrected runner. Only
the rows that move are shown; the others are identical and that is evidence, not
an omission.

```
policy                solved  escaped  cost     was
verify-always         7/8     0        27,500   7/8, 0, 27,500     UNCHANGED
test-always           4/8     3        10,180   4/8, 3, 10,180     UNCHANGED
evidence-gated        7/8     0        28,320   6/8, 0, 25,700
risk-adjusted         7/8     0        31,780   3/8, 0, 26,760
valve-v0              5/8     3        20,340   3/8, 0, 35,740
```

Four things are withdrawn or restated by this amendment, and each is stated where
a reader of the withdrawn claim will meet it rather than only here:

1. **The `risk-adjusted` 3/8 negative result is withdrawn.** It was the only
   negative result this document recorded about the thesis, and it does not
   survive a one-line harness fix. The paragraph above carries the withdrawal.
2. **"It does not meet the bar" is withdrawn.** `evidence-gated` now reaches 7/8
   and costs 820 more, not 1,800 less. The bar reasoning is unchanged and is
   pinned in `experiments/m6.test.mjs`.
3. **"Beats V0 on both axes at once" is withdrawn.** It beats V0 on success and
   ships no defects; it no longer beats it on cost. The cost of V0 falling from
   35,740 to 20,340 is the same stale latch, and V0 now escapes 3 defects where
   it reported 0. Whether that is still domination is an open decision in
   ADR 0005, and this document does not pretend to have settled it.
4. **The next step is spent.** M7 was built, run, and reported.

Nothing in M1-M5 is touched. Each of those was measured against its own gate,
and the gate that changed here is the harness that fed the evidence, not the
fixtures or the cost model that priced it.
