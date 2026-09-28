# CogBench is frozen, and the expanded benchmark still finds V0 dominated

- **Date:** 2026-09-28
- **Status:** accepted, freeze in effect
- **Milestone:** M5 (benchmark diversification)
- **Blocks:** M6 (rejection- and value-aware policy)

## Why this milestone existed

ADR 0001 falsified V0 on two fixtures, and said so: two tasks can falsify a
policy but cannot establish one. Worse, both fixtures were situations where
verifying was almost always right, so a scheduler could have scored well by
learning "verify more" and demonstrated nothing about value.

The fix was not more fixtures of the same kind. It was to make the *price* of
verification vary, and to add tasks where **not** verifying is correct.

## What changed in the harness

**Two channels, priced per task.** `testCommand` is a cheap partial check that
can pass on a wrong fix. `verifyCommand` is the complete oracle, and it costs
what the task says it costs. Previously every action had one global price, so
`test-always` paid a constant penalty and a policy could learn a rule that was
an artifact of the benchmark.

**`defectEscape`.** What shipping a defect the policy's own evidence missed
costs. Without it the benchmark can price a test run but cannot price skipping
one, which is the entire question.

**Utility is only compared within a task.** Success is priced from 6,000 on a
routine fix to 70,000 where a defect is catastrophic, so summing utility across
tasks adds numbers on different scales. The reported aggregate is "best utility
on N tasks".

## The families

| family | what it punishes |
|---|---|
| A already-correct | acting when nothing is wrong |
| B trivial | verifying out of habit when the oracle is cheap |
| C competing hypotheses | stacking edits before checking |
| D misleading local signal | trusting a cheap green test |
| E expensive verifier | checking so often the oracle dominates cost |
| F cheap verifier | saving a test that costs nothing to run |
| G information before action | editing blind to a constraint in another file |
| H high risk | skipping the oracle when a defect is catastrophic |

## The result

```
policy             solved  escaped  oracle  cost
verify-always      7/8     0        9       25,100
test-always        4/8     3        1       10,180
valve-v0           3/8     0        8       27,920
naive-edit-first   2/8     0        0       15,900
act-always         2/8     0        0       15,900
stop-immediately   1/8     0        0       0
```

**V0 is now dominated on both axes at once.** It solves fewer tasks than the
safety baseline *and* pays more. In ADR 0001 it was merely worse on cost; the
diversified benchmark shows it is also worse on success, which is a stronger and
more uncomfortable result than the one it replaces.

`test-always` is the informative failure: it is the cheapest policy that ships
anything, and it escapes 3 defects. That is the shape a useful scheduler has to
avoid without paying `verify-always`'s bill.

## The ADR 0001 numbers no longer reproduce

Recorded plainly because it would be easy to hide: M5 changed the harness, so
ADR 0001's figures (V0 1/2 solved at 10,800) are not reproducible by the
current code. That harness had one command priced globally. The **conclusion**
survived and hardened; the numbers did not.

## What the freeze means

From here, M6 writes a policy and **does not touch the tasks or the cost
model**. If a fixture looks wrong, it is fixed as a bug with a demonstrated
cause, and the change is recorded here. The frozen numbers are pinned by test,
so drift is visible rather than discovered later.

## Honesty work that this milestone required

Every fixture is checked against its own oracle by
`experiments/verify-fixtures.mjs`, which asserts: the initial state matches its
declared shape, exactly one edit is correct (zero for family A), and every
mutation documenting a flaw is actually rejected. It caught eight real problems,
including three that would have made the benchmark lie:

- `JSON.stringify(Infinity)` returns `"null"`, so a broken division compared
  equal to the required `null` and the task looked already solved.
- A local test and an oracle asserted **contradictory** values for the same
  input, so no edit could satisfy both.
- Two mutations documented as flawed were in fact correct implementations. The
  claimed "floating point residue" did not exist; the arithmetic was checked and
  the supposed flaw did not reproduce.
- The correct edit was last in most tasks, so "apply everything then stop" won
  6 of 8. Positions are now mixed, and a fixture invariant fails the build if
  the correct edit returns to being last more than half the time.

That last one had survived M3, where cumulative application was fixed but
ordering luck was not.
