# CogBench falsifies VALVE-V0 on interleaved verification

- **Date:** 2026-09-28
- **Status:** accepted, open
- **Milestone:** M3 (CogBench)

## What was measured

Four decision policies, two task fixtures, identical loop, identical harness.
The only thing that varied was which operation the policy chose next. Success
was decided by each task's `verifyCommand` exit code, never by a policy
claiming it was done.

```
policy              solved  frontier  tests  cost    wasted
naive-edit-first    1/2     6         0      7,200   3
valve-v0            1/2     6         4      10,800  5
test-always         2/2     5         6      11,900  3
act-always          1/2     6         0      7,200   3
```

## The result

**VALVE-V0 is worse than the naive baseline on the axis it claims to win.**

It costs 50% more than a policy that does nothing but apply every edit
(10,800 vs 7,200) and solves the same number of tasks. `test-always`, the
policy that verifies after every single step, is the only one that solves
both tasks.

This is a negative result for the current V0 heuristics. It is not a negative
result for the thesis, and it is not a measurement of a trained model: V0 is
hand-written rules, and the bench is two fixtures.

## Root cause

VALVE stacks edits without checking whether the previous one worked.

On `fix-pagination-off-by-one` it applied all three edits in a row
(steps 2, 3, 4) and only then tested, landing on the last one, which is wrong.
`test-always` tested after each edit and so observed that the second edit was
the correct one.

The cause is a missing capability, not a mis-tuned constant: **V0 has no
notion of "this edit was tried and the oracle rejected it."** `recentActions`
records that an `ACT` happened, but nothing records that the resulting state
was falsified. So the `tests-failing` rule can only ever answer "make an
edit", and it will keep answering that after the edits are exhausted.

The shadow dataset cannot record this either, for the same reason: it logs
operations and outcomes but never a rejection. **This is the first concrete
schema gap the bench has produced.**

## What was fixed, and what was deliberately not

Fixed, because they were bugs rather than tuning:

- The bench applied mutations cumulatively, so the last edit in the list always
  won and every policy behaved identically. Mutations are now judged alone.
- `tests-failing` plus an exhausted edit list produced an unbounded loop. V0
  was exhibiting precisely the failure mode this project exists to prevent.
- The bench emitted `args: {action}` with no shell command, so ingest could not
  classify it and filed **all 41 test steps as `ACT`**. Silent label
  corruption in the dataset, which is the worst failure available here. Ingest
  now trusts a `cognitiveAction` declared by a harness that executed the step,
  and classifies only when the emitter could not know.

Deliberately not done: no heuristic was tuned to make VALVE win. Two tasks
cannot support that conclusion, and tuning against them would destroy the
only property that makes the bench worth having.

## Consequences

1. The "same success, fewer frontier calls" claim is **unsupported** at V0.
   Nothing in this run supports it.
2. `test-always` is the bar to beat, not `naive-edit-first`. It is also the
   honest control for a scheduler: its cost is verification, and a scheduler is
   only interesting if it captures most of that safety at less than that cost.
3. The next schema change is rejection memory: record that a state was
   falsified, and make `STOP` and the edit proposal aware of what has already
   been tried. That is a data-model change, and it should land before any
   training, or the model will learn the same stacking behaviour.

## Standing caveat

Two tasks, scripted mutations, heuristic policies. This harness can falsify a
claim and it just falsified one. It cannot establish one.
