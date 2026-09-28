# M7: the replication holds its shape, and the harness turns out to be carrying the result

- **Date:** 2026-09-28
- **Status:** accepted, with one decision left open and named
- **Milestone:** M7
- **Protocol:** [docs/protocols/m7-replication.md](../protocols/m7-replication.md), written before the corpus existed
- **Corpus:** [bench/cogbench/src/tasks-m7.ts](../../bench/cogbench/src/tasks-m7.ts), 24 tasks, frozen by hash in the protocol

## What was run

24 unseen tasks, three per family across the same eight families, every policy run on exactly the same
corpus, with the four M6 policies frozen by sha256 before the corpus was written. The author of the
fixtures has read all four policies, which the protocol states as the largest weakness of the result and
which nothing here removes.

The corpus passed its sweep before any policy touched it: one correct edit per solvable task, every
documented flaw rejected by its own oracle, the correct edit's position spread 8/6/7 rather than
front-loaded, the oracle priced from 0.2x to 20x an edit, and 12 of the 24 tasks carrying a wrong fix the
cheap channel cannot see.

## The result, as run

```
policy                solved  escaped  cheap  oracle  edits  cost
verify-always         20/24   0        0      46      46     140,400
evidence-gated        18/24   0        24     12      51      71,260
test-always           16/24   5        31     8       39      58,850
valve-v0              14/24   0        24     25      58     111,540
risk-adjusted         14/24   0        1      23      58      87,810
confidence-threshold  11/24   0        32     9       64      82,550
oracle-budgeted       11/24   0        32     9       64      82,550
```

**Outcome: efficiency tradeoff.** `evidence-gated` escaped nothing, cost 71,260 against 140,400, and
solved 18 against 20. The same shape M6 recorded on 8 tasks, at 75% solved in both, with the gap widened
from one task to two.

The safety gate holds: `evidence-gated` escaped nothing on 24 unseen tasks, and `test-always` escaped 5,
which is the misleading-signal family doing the job it exists for. Re-running the 8 development fixtures
through the same runner reproduced ADR 0004's numbers exactly, including `verify-always` at 7 solved and
27,500, so the comparison being made is the one M6 recorded.

The one place the leader wins outright is family F, where the oracle costs twenty times an edit:
`evidence-gated` 3/3 against `verify-always` 2/2. It is a budget win rather than a competence win. Both
policies applied the same wrong first edit, and `verify-always` then spent 38,260 on a task budgeted at
34,000 and ran out before it recovered.

## The mechanism, which is one decision

Sixteen of the 24 tasks record a divergence, and every single one of them is the same decision at the same
step. At step 3, after the first edit, with one edit applied and nothing observed:

```
verify-always  ->  VERIFY
evidence-gated ->  TEST
```

`verify-always` buys the oracle after every edit. `evidence-gated` runs the cheap test and buys the oracle
only if the cheap test is green. Everything the aggregate shows follows from that one rule, which is
exactly why the per-task records are the artefact and the score is not.

## The defect the replication found, and it is not small

`evidence-gated` loses three tasks and wins one. On all three losses it behaves the same way, and
`experiments/probe-stale-evidence.mjs` shows it step by step:

```
step 3: TEST   state.verification.tests=unknown  lastTest=null
step 4: ACT    state.verification.tests=failed   lastTest=1
step 5: ACT    state.verification.tests=failed   lastTest=null     <-- the world moved, the red did not
step 6: STOP   state.verification.tests=failed   lastTest=null     unverifiedDelta=true
```

**ADR 0004 fixed this bug in one place and left it in another.** It cleared `lastTestExit` and
`lastVerifyExit` on an edit, which is why the comment in `runner.ts` says "any edit invalidates the earlier
evidence, both green and red". But the same fact is stored a third time, in `state.verification.tests`,
which no edit clears. `evidenceOf()` falls through to it, so a policy reads a **red observed on a state
that no longer exists**. With no edits left, `terminal()` treats that stale red as conclusive and returns
STOP.

On `B-m7-2` and `C-m7-3` the policy applies the correct fix and then overwrites it before stopping, having
never looked at the state it produced. On `H-m7-2` the same. That is the exact failure ADR 0004 claimed to
have eliminated, reproduced by a second copy of the same fact.

`verify-always` is immune because it never reads `state.verification` in its decision path. Every M6
gated policy does, so every one of them is affected and the safety reference is not.

## What the defect is worth, measured, and explicitly not the result

One line, applying the rule ADR 0004 already wrote to the third copy of the fact:

```ts
// inside the ACT case, beside the two the fix already clears
verification = { build: "unknown", tests: "unknown", qa: "unknown" }
```

Measured on both corpora and then reverted, with the freeze restored and verified by hash
(`b43aeeb665b01fd595ab3bace7dea6bd7f720f0934fad0a13f70630627610312`):

| policy | 24 tasks, as run | 24 tasks, stale field cleared | 8 development tasks, as recorded in ADR 0004 | 8, cleared |
|---|---|---|---|---|
| `verify-always` | 20/24, 0 escaped, 140,400 | 20/24, 0 escaped, 140,400 | 7/8, 27,500 | 7/8, 27,500 |
| `evidence-gated` | 18/24, 0 escaped, 71,260 | **21/24**, 0 escaped, 125,730 | 6/8, 25,700 | **7/8**, 28,320 |
| `risk-adjusted` | 14/24, 0 escaped, 87,810 | **24/24**, 0 escaped, 134,120 | 3/8, 26,760 | **7/8**, 31,780 |
| `valve-v0` | 14/24, **0** escaped, 111,540 | 19/24, **5** escaped, 66,330 | 3/8, 0 escaped, 35,740 | 5/8, **3** escaped, 20,340 |
| `test-always` | 16/24, 5 escaped, 58,850 | 16/24, 5 escaped, 58,850 | 4/8, 3 escaped, 10,180 | 4/8, 3 escaped, 10,180 |

Three things follow, and the second is the one that matters most.

1. **The M7 outcome letter changes** from efficiency tradeoff to strong positive, because the gated policy
   would solve 21 against 20 at a lower cost with nothing escaped.
2. **ADR 0004's most interesting negative result does not survive.** It recorded that
   `risk-adjusted`, the policy the thesis actually predicts, is the *worst* of the gated policies at 3/8,
   and called that a real result about the thesis as stated rather than a tuning problem. On this evidence
   it is an artefact of a stale latch: the same policy solves 7 of the 8 development tasks and all 24
   unseen ones once the harness stops feeding it a refutation about a state that no longer exists. A
   negative result about the thesis that a one-line harness fix erases was never a result about the thesis.
3. **`valve-v0` was hiding three escaped defects.** It reported zero escapes on the development corpus
   while shipping three. The stale red was making it stop before it could end on a claim it had not
   established, which flattered it on the one axis the safety gate reads.

This table is a diagnostic, not a result. It is not pre-registered, it was measured after the result was
known, and the protocol froze `runner.ts` for exactly this reason. It is recorded here so the size of the
contamination is not a guess.

## What this does not decide

- It does not establish `evidence-gated`. The verdict above is an efficiency tradeoff on a corpus whose
  author had read the policies, and a compromised harness.
- It does not resurrect `risk-adjusted` as the answer. 24/24 with a stale field cleared is a reason to
  re-measure, not a reason to believe a hand-set `pSufficient` of 0.4 is the right prior.
- It does not say a learned model is worth building. If anything it argues for fixing the harness before
  any training, because a dataset built on this harness would learn to stop on stale refutations.
- It does not touch the M1-M5 results, each of which was measured against its own gate.

## The open decision

The fix is one line and the measurement behind it is already made. What it costs is four pinned numbers
in `experiments/m6.test.mjs` and the 3/8 verdict in ADR 0004, which have to be rewritten with the
deviation recorded where the pins are, the way ADR 0004 itself recorded the runner change that moved
`verify-always` from 25,100 to 27,500.

That is a decision about recorded results, so it is not taken here.

1. **Fix and re-measure.** One line in the runner, re-run both corpora, rewrite the four pins in
   `m6.test.mjs` with the deviation stated in the test, amend ADR 0004's 3/8 with the number that replaces
   it, and issue this ADR's M7 letter as the corrected one. Cost: half an hour. Consequence: the recorded
   M6 negative result about `risk-adjusted` is withdrawn, and M7 becomes a strong positive on a corpus
   whose author was not blind.
2. **Fix the harness, re-run M7 only, and leave M6 standing as a record of what the harness did.** Cost:
   the same. Consequence: two corpora measured under two different harnesses, and the project carries a
   known-wrong measurement in order to protect a number.
3. **Do nothing yet.** Cost: zero. Consequence: the harness keeps feeding stale refutations to every gated
   policy, and any dataset built on it teaches a model to stop without looking. This is the option the
   project refused twice already, in ADR 0003 and ADR 0004.

The recommendation is 1. The freeze exists to stop a policy being fitted to a benchmark, and a harness
that hands a policy a refutation about a deleted state is not a benchmark question.
