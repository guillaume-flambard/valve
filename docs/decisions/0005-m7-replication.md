# M7: the replication holds its shape, and the harness turns out to be carrying the result

- **Date:** 2026-09-28
- **Status:** accepted, option 1 taken, two decisions left open and named
- **Milestone:** M7
- **Protocol:** [docs/protocols/m7-replication.md](../protocols/m7-replication.md), written before the corpus existed
- **Corpus:** [bench/cogbench/src/tasks-m7.ts](../../bench/cogbench/src/tasks-m7.ts), 24 tasks, frozen by hash in the protocol
- **Re-measured:** 2026-09-28, on the corrected runner. The M7 letter below is the corrected one, and the
  table in "The result, as run" is the as-run one, kept because a reader checking this ADR has to be able to
  see what was superseded and why.

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

Superseded. Kept verbatim because the freeze deviation is only auditable if the numbers it was measured
under stay on the page. The corrected run is in "The result, as re-measured" below.

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

## The result, as re-measured

This is the result. The one-line fix is in `runner.ts`, both corpora were re-run, and every number below
came out of that run.

```
policy                solved  escaped  cheap  oracle  edits  cost
verify-always         20/24   0        0      46      46     140,400
evidence-gated        21/24   0        34     31      47     125,730
test-always           16/24   5        31     8       39      58,850
valve-v0              19/24   5        129    9       33      66,330
risk-adjusted         24/24   0        2      62      41     134,120
confidence-threshold  14/24   0        32     28      60     136,410
oracle-budgeted       11/24   0        40     24      64     118,280
```

**Outcome: STRONG POSITIVE.** `evidence-gated` escaped nothing, solved 21 against 20, and cost 125,730
against 140,400. The letter follows from the protocol's pre-registered order applied to the table above,
in the order frozen before the corpus existed, and the order is unchanged: safety first, then success, then
cost. The letter is not a re-interpretation, it is the same derivation on a harness that no longer feeds
`evidence-gated` a refutation about a state that does not exist.

Three things about what did and did not move, because a re-baseline that moved everything would be a
different project:

1. **`verify-always` is byte-for-byte the same run.** 20/24, 0 escaped, 140,400. It never reads
   `state.verification` in its decision path, so it was immune to the defect and it is unchanged. One whole
   column of the safety comparison is therefore provably untouched, which is the reason the M7 letter could
   be re-issued at all.
2. **`test-always` is unchanged** at 16/24, 5 escaped, 58,850, for the same reason.
3. **`evidence-gated` spends more cheap calls to save oracle calls**: cheap 24 to 34, oracle 12 to 31. It
   is buying the cheap check instead of the expensive one, which is the mechanism the milestone was about,
   and it is why the cost fell while the cheap count rose.

The recorded artefact `experiments/m7-replication/results.json` was wrong by three solved tasks and 54,470
tokens before this run and no test noticed, because every reading assertion in
`experiments/m7-replication.test.mjs` compared that file against itself. `m7-replication.mjs` now exports
`buildResults()` and writes only when run as a program, so the test can run it and compare the whole
recorded object against a fresh run, field by field. The sentence in both files claiming the test re-runs
the result was false until this change; it is true now, and that is the second half of what this milestone
had to fix.

## The contamination, measured

**This table was originally a diagnostic, not a result.** It was measured with the one-line fix applied and
then reverted, with the freeze restored and verified by hash
(`b43aeeb665b01fd595ab3bace7dea6bd7f720f0934fad0a13f70630627610312`). That verification is why the `b43aeeb`
hash is still cited in `docs/protocols/m7-replication.md` even though `runner.ts` no longer hashes to it:
the diagnosis established the size of the contamination without moving the freeze, and the re-measurement
below then spent the freeze to fix it. **The "cleared" columns are no longer a counterfactual. They are
what the harness now produces, and every one of them was independently reproduced by the re-run.**

| policy | 24 tasks, as run | 24 tasks, stale field cleared | 8 development tasks, as recorded in ADR 0004 | 8, cleared |
|---|---|---|---|---|
| `verify-always` | 20/24, 0 escaped, 140,400 | 20/24, 0 escaped, 140,400 | 7/8, 27,500 | 7/8, 27,500 |
| `evidence-gated` | 18/24, 0 escaped, 71,260 | **21/24**, 0 escaped, 125,730 | 6/8, 25,700 | **7/8**, 28,320 |
| `risk-adjusted` | 14/24, 0 escaped, 87,810 | **24/24**, 0 escaped, 134,120 | 3/8, 26,760 | **7/8**, 31,780 |
| `valve-v0` | 14/24, **0** escaped, 111,540 | 19/24, **5** escaped, 66,330 | 3/8, 0 escaped, 35,740 | 5/8, **3** escaped, 20,340 |
| `test-always` | 16/24, 5 escaped, 58,850 | 16/24, 5 escaped, 58,850 | 4/8, 3 escaped, 10,180 | 4/8, 3 escaped, 10,180 |

Three things follow, and the second is the one that matters most.

1. **The M7 outcome letter changes** from efficiency tradeoff to strong positive, because the gated policy
   solves 21 against 20 at a lower cost with nothing escaped. It has now been re-measured and re-issued
   above; this line is the prediction the re-measurement confirmed.
2. **ADR 0004's most interesting negative result does not survive.** It recorded that
   `risk-adjusted`, the policy the thesis actually predicts, is the *worst* of the gated policies at 3/8,
   and called that a real result about the thesis as stated rather than a tuning problem. On this evidence
   it is an artefact of a stale latch: the same policy solves 7 of the 8 development tasks and all 24
   unseen ones once the harness stops feeding it a refutation about a state that no longer exists. A
   negative result about the thesis that a one-line harness fix erases was never a result about the thesis.
   ADR 0004 has been amended to withdraw it.
3. **`valve-v0` was hiding three escaped defects.** It reported zero escapes on the development corpus
   while shipping three. The stale red was making it stop before it could end on a claim it had not
   established, which flattered it on the one axis the safety gate reads.

This table is not pre-registered and was measured after the result was known, which is why the protocol
froze `runner.ts` in the first place. It is kept because it is the only record of how large the
contamination was, and "the harness was slightly wrong" is not a number anybody can check.

## What this does not decide

- It does not establish `evidence-gated`. The verdict is a strong positive on a corpus whose author had
  read the policies. The harness is no longer compromised in the way it was, and the confound is not.
- It does not resurrect `risk-adjusted` as the answer. 24/24 is a reason to re-measure, not a reason to
  believe a hand-set `pSufficient` of 0.4 is the right prior.
- It does not say a learned model is worth building. If anything it argues for fixing the harness before
  any training, because a dataset built on this harness would learn to stop on stale refutations.
- It does not touch the M1-M5 results, each of which was measured against its own gate.

## The decision that was open, and what it cost

The fix is one line and the measurement behind it was already made. What it cost is four pinned numbers in
`experiments/m6.test.mjs` and the 3/8 verdict in ADR 0004, which have to be rewritten with the deviation
recorded where the pins are, the way ADR 0004 itself recorded the runner change that moved `verify-always`
from 25,100 to 27,500.

**Option 1 was taken.** The line is in `runner.ts`, both corpora were re-run, the pins in `m6.test.mjs` and
`m4.test.mjs` carry measured values with the deviation stated in each file, ADR 0004's 3/8 is withdrawn, the
M7 letter is re-issued above, and the `runner.ts` freeze break is recorded in the protocol, in both tests
that pin the numbers, and here. What it cost, in fact and not as predicted: it moved two numbers no one
predicted would move, and it exposed a defect in `valve-v0` that the stale latch had been hiding, which is
the open decision below and is not about recorded results at all.

The cost of taking it was higher than the estimate. The estimate named four pins and one verdict. What
actually happened is four pins, one verdict, one wrong recorded artefact, one stale witness in `m4`, and
one newly real defect in a control policy. The last of those is the only one that is not a documentation
consequence of a decision already taken.

## The open decision: what `valve-v0` is, now that it cannot lean on a stale latch

Removing the stale latch did not only reveal that `valve-v0` was shipping three escaped defects. It
revealed that `valve-v0` has **no cheap-green terminal condition and no memory of having already checked.**
It stops only on a green oracle (`policies.ts`: `if (ctx.lastVerifyExit === 0) return "STOP"`), so when the
cheap test goes green it has nothing to act on and re-asks the heuristic, which asks for the cheap test
again. Measured:

- development corpus, 8 tasks: 7 of 8 tasks repeat an identical check more than twice, worst case
  `TEST:1 TEST:0 TEST:0 TEST:0 TEST:0 TEST:0 TEST:0 TEST:0` on `C1-competing-fixes`, i.e. six identical
  green cheap tests in a row.
- M7 corpus, 24 tasks: 19 of 24 tasks over the threshold, worst run of 7. `risk-adjusted` is over it on 6 of
  24. Every other policy is at or under the threshold on every task.
- **Neither primary policy is affected.** `verify-always` and `evidence-gated` both peak at a run of 2 on
  zero tasks. The M7 letter rests only on those two, so the result above is not contaminated by this.

`experiments/cogbench.test.mjs` asserts no policy repeats an identical check more than twice, and its own
docstring calls that the failure the bench was built to catch. It is now red, on `valve-v0/B1`, and it is
left red. There is no mechanical repair: to pass, the threshold would have to be raised to 7, which is to
permit exactly the behaviour the assertion exists to forbid. Re-baselining the constant is not available,
and quietly relaxing it would be the one move that makes a benchmark quietly stop meaning anything.

This is not taken here, because every option changes either the frozen policy set or the meaning of the
bench's spin guard, and both are the owner's:

1. **Re-specify `valve-v0` and re-run everything.** Give it a cheap-green guard the way `test-always` has
   one. Cost: the M7 policy freeze breaks, so the M7 result has to be re-run and re-issued a third time,
   and `valve-v0` stops being the falsified predecessor ADR 0001 recorded, because the thing it was falsified
   for is arguably a harness bug that this milestone has now fixed. Consequence: the thesis gets a much
   stronger and less interesting control, and the corpus has to be re-run under a third harness.
2. **Accept the spinning as the true measurement of the falsified predecessor**, and re-declare what the
   spin guard protects: not "no policy spins", but "no policy the milestone is evaluating spins". V0 is
   reported and not compared on (the protocol says so), and it is already falsified, so nothing in the M7
   result depends on it being well-behaved. Cost: the bench's oldest and most quotable guard gets an
   exemption, which is a real weakening and has to be written as one.
3. **Leave it red and treat this ADR as incomplete.** Cost: `npm test` does not pass, and the one red test
   is a true report rather than a defect. This is the state the repository is in right now.

**The recommendation is 1**, and it is expensive, and it is being recommended against the interest of the
result: option 2 is cheaper and leaves a strong positive standing. It is rejected because "the control
policy is allowed to spin" is the first exemption in a project whose entire argument is that a gate is only
as good as the harness feeding it, and an exemption granted once because the alternative was expensive is
how the next one gets granted. Option 3 is honest and is what is committed, so that nothing here is hidden
behind a passing suite.
