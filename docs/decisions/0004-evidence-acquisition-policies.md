# M6: evidence acquisition, and a policy that is close but not yet sufficient

- **Date:** 2026-09-28
- **Status:** accepted
- **Milestone:** M6
- **Benchmark:** frozen (ADR 0003), except one declared runner fix, below
- **Next:** M7 replication corpus, 8 development tasks to 24 unseen

## The question, restated

Not "how often should a policy check" but:

> How much evidence is enough to avoid buying the full oracle?

The loss is explicit: a check costs `costModel.verify`, shipping a defect costs
`costModel.defectEscape`, another edit costs `costModel.act` plus frontier
reasoning. So the decision is a comparison of prices, and the policies differ
only in how they judge whether the evidence in hand already suffices.

## The result

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
against 35,740. It ships no defects.

**It does not meet the bar.** The target is `verify-always`'s 7/8 at lower
cost. `evidence-gated` reaches 6/8 at a cost that is only 1,800 lower, which is
not a Pareto improvement on success and is a marginal one on cost. The gap is
one task, and it is stated in a test so it cannot be quietly closed by editing
the assertion.

The most interesting failure is `risk-adjusted`, the policy the thesis actually
predicts. At 3/8 it is the **worst** of the gated policies. The price
comparison is right in form and wrong in practice: with `pSufficient` set by
hand, the threshold almost never fires, and a policy that does not buy the
oracle gets no benefit from knowing what the oracle costs. This is a real
negative result about the thesis as stated, not a tuning problem.

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

## The freeze, and one declared deviation

ADR 0003 froze the tasks and the cost model. Both are untouched. **The runner
changed**, because the first policy written immediately surfaced a state
tracking bug, and the baselines moved as a result:

```
                    before     after
verify-always      25,100    27,500
valve-v0           27,920    35,740
```

The freeze exists to stop a policy being fitted to the benchmark. A harness bug
is not that, and preserving a known-wrong measurement to protect a nicer number
would defeat the purpose of the project. The deviation is recorded in the test
that pins the numbers rather than only here, so anyone reading the pin sees it.

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
