# M7 protocol: replication on an unseen corpus

- **Date:** 2026-09-28
- **Status:** pre-registered, written before any of the 24 tasks exists
- **Milestone:** M7
- **Frozen by this document:** the four M6 policies, byte for byte
- **Result:** `docs/decisions/0005-m7-replication.md`, written after the run

## The question

ADR 0004 recorded that on 8 tasks with one instance per family, `evidence-gated`
beating V0 is a hypothesis and not a finding, and named what has to happen before
a strong claim: freeze the policy set, build the replication corpus, report on
that corpus alone.

This is the corpus and the report. Nothing here is allowed to change the policies.

## The threat that cannot be removed, stated first

**The author of these 24 tasks has read all four M6 policies.** ADR 0004 asked for
the corpus to be built "ideally by someone who has not seen which policy won". That
is not possible here and no amount of care substitutes for it. It is the single
largest reason a result on this corpus is weaker than a genuinely blind one, and it
is not revised by anything below.

What can be done about it is bounded, and each measure below is a real constraint
rather than an intention:

1. **No policy can read the corpus.** The existing scan forbids a policy branching
   on `task.family` or reading `knownFlaw`, and it is extended to every policy file
   in M7. A policy sees a module, two commands, a price list and its own evidence.
2. **The corpus is built against the winner, not for it.** A corpus assembled from
   tasks whose evidence trajectories suit `evidence-gated` would be a corpus
   written to confirm a result. Section "Adversarial construction" states the
   specific pressures aimed at the M6 leader, and they are aimed before the run.
3. **The primary claim is a four-way table, not a win.** A collapse is a declared
   success of the experiment, and the exact wording of each outcome is fixed below
   so it cannot be rewritten afterwards.
4. **The author confound is recorded next to the number**, in the ADR, not in a
   footnote. A reader who wants a blind replication has to build the corpus
   themselves.

## Corpus composition, fixed

24 tasks, three independent instances of each of the eight families A-H. The eight
families are kept because the correct amount of verification is a function of what
verification costs and what an escaped defect costs, and eight prices are what
makes that a question rather than a constant.

| Family | Instances | What the three instances vary |
|---|---|---|
| A already-correct | 3 | the shape of the stale report; all three are states where any edit is a regression |
| B trivial | 3 | a cheap oracle, a middling oracle, and a cheap oracle with a second correct edit available |
| C competing hypotheses | 3 | two, three and four candidate edits, of which one is correct |
| D misleading local signal | 3 | three different ways a cheap test passes on a wrong fix |
| E expensive verifier | 3 | three oracle prices, 4x, 12x and 25x the local test |
| F cheap verifier | 3 | three oracle prices, 20x, 1x and 0.2x an edit |
| G information before action | 3 | the binding rule in a sibling module, a config file, and a comment in the test |
| H high risk | 3 | three `defectEscape` prices, 10x, 40x and 200x the oracle |

**Position of the correct edit is declared per instance, not left to chance.** The
development corpus put the correct edit first in five fixtures out of eight, which
rewards a policy that tries the obvious fix first and punishes one that reads
first. In the 24, the correct edit is first in 8 instances, second in 8 and third in
8, and this is checked by a test so the balance cannot drift.

## Adversarial construction, aimed at the M6 leader, fixed

`evidence-gated`'s rule is narrow and can be stated: **a green cheap test is the
only ambiguous evidence, so a green cheap test is always followed by the oracle.**
Every task below attacks that rule specifically, and all of them are in the corpus:

1. **Instances where the cheap test is complete.** Eight of the 24 have a local
   test that agrees with the oracle on every state a policy can reach. On those,
   the VERIFY after a green cheap test buys nothing and costs the full oracle
   price. Two of them are in family E at 25x, which is where that waste is largest.
2. **Instances where the oracle is nearly free.** Family F instance 3 prices the
   oracle at 0.2x an edit, so the "expensive" step is free and the waste argument
   inverts.
3. **Instances where skipping is genuinely correct.** Family E instance 1 and family
   B instance 1 are cheap enough that verifying is pure overhead relative to the
   edit that would otherwise be made, and the local test does catch the plausible
   wrong fix.
4. **Correct edit first, wrong edit first, and a wrong edit that the local test
   cannot see**, all three present in every family that admits them, so ordering
   and channel choice are not confounded.
5. **No task where a policy can recognise the family.** The tasks are eight
   different domains with eight different module shapes; the family is a label in
   the fixture, never in anything a policy can read.

## The policies, fixed

Frozen by this document, by sha256 of the source that runs, recorded before the corpus existed:

```
e9374cc48620a5a59a16f738f872ef9088addcdca9162e320648c55d41dc200a  bench/cogbench/src/policies.ts
f70f71f5a0969a8e30ba3e88e8c475ed33ceaa0b374d41ad3153b0e598140852  bench/cogbench/src/policies-m6.ts
b43aeeb665b01fd595ab3bace7dea6bd7f720f0934fad0a13f70630627610312  bench/cogbench/src/runner.ts
8e0e0787b0351e01e378ed5a5beefb2617dd3cfc3c2a7548e5b0b588c3041395  bench/cogbench/src/tasks.ts
```

### AMENDMENT, 2026-09-28, after the run: `runner.ts` freeze BROKEN and superseded

**`runner.ts` was frozen at `b43aeeb6…` above. The freeze was broken after the run and the file no longer
hashes to it. The result was re-measured on the corrected harness. The line above is left as it was written
before the corpus existed, because ADR 0005 still cites `b43aeeb6…` as the freeze that was verified
restored during diagnosis, and a reader of that ADR deserves to be able to see what it was citing.**

The current file, which is what every number in `results.json` was produced by:

```
5e08ae3c82c1b1c65bb4529ed1e2c3339be9de31dcd3b455b6e7d9d8ddf8daa6  bench/cogbench/src/runner.ts
```

**What changed.** One line, plus the comment that states why. The ACT case already cleared
`lastTestExit` and `lastVerifyExit` on an edit. It did not clear `state.verification.tests`, which is the
copy of the same fact that `evidenceOf()` falls through to and that every gated policy actually reads. A
red observed on a state that an edit has since destroyed survived into the next decision.

**Why the freeze was broken rather than the result withdrawn.** The freeze exists to stop a policy being
fitted to a benchmark. A harness that hands a policy a refutation about a deleted state is not a benchmark
question, it is a harness bug, and preserving a known-wrong measurement to protect a nicer number would
defeat the purpose of the project. The project refused that trade twice already, in ADR 0003 and ADR 0004.

**Under whose decision.** ADR 0005 took it: option 1 of three, "fix and re-measure", written out as the
recommendation there and adopted here. The cost, stated in ADR 0005 before it was paid, was four pinned
numbers in `experiments/m6.test.mjs`, the `risk-adjusted` 3/8 result in ADR 0004, and this document's
letter. All three are amended, and the deviation is recorded in the tests that pin the numbers, not only
here, per ADR 0004.

**What was NOT touched.** `policies.ts`, `policies-m6.ts` and `tasks.ts` still hash to exactly the values
above. The policies and the corpus are byte-identical, so the comparison the protocol fixed is the
comparison that was re-measured.

**The primary comparison is uncontaminated by a second defect this exposed.** Removing the stale latch
revealed that `valve-v0` has no cheap-green terminal condition and will re-run an identical green cheap test
until its step budget runs out. On the 24 that is 19 of 24 tasks for `valve-v0`, and 6 of 24 for
`risk-adjusted`. It touches neither primary policy: `verify-always` and `evidence-gated` both peak at a
run of 2 identical checks, on 0 tasks. That is why the letter below can be re-issued at all, and it is
recorded as an open decision in ADR 0005 rather than resolved here.

`runner.ts` and `tasks.ts` are frozen as well, which is a stronger claim than M6 made. The reason is
below, and it is not hypothetical: the replication found a harness defect, and a harness that can move
under a result is not a harness the result can be attributed to.

| Policy | Role in M7 |
|---|---|
| `verify-always` | **safety reference**, and half of the primary comparison |
| `evidence-gated` | **the M6 leader**, and the other half of the primary comparison |
| `test-always` | control: what trusting the cheap channel costs |
| `valve-v0` | control: the falsified predecessor |
| `risk-adjusted` | control: the policy the thesis predicts, recorded at 3/8 |

The `3/8` above is what ADR 0004 recorded on the 8-task development corpus before this protocol existed. It
is **withdrawn**: ADR 0005 found it to be an artefact of the stale latch, and the same policy solves 7 of
8 development tasks and 24 of 24 unseen ones on the corrected harness. The withdrawal is recorded in ADR
0004 and ADR 0005, not silently edited out of the line above, for the same reason the `b43aeeb6…` hash is
still here.
| `confidence-threshold`, `oracle-budgeted` | controls, reported but not compared on |

The M6 development result is reported in the same table, marked as the corpus it
came from. It is never merged with the 24.

## Metrics, fixed

| Metric | Role |
|---|---|
| **safety gate** | `escapedDefect == 0`. Without it there is no safety claim to make at all, whatever the cost |
| **primary comparison** | `evidence-gated` against `verify-always`, on solved count first |
| **quality metric** | solved tasks, the full oracle exit code and nothing else |
| **economic metric** | total cost tokens, then oracle calls and cheap calls reported separately, because a cost reduction that comes from spending less on the wrong channel is not a saving |
| **diagnostic only** | edits applied, steps after the first correct state, action distribution. Reported, never used to decide an outcome |
| **per-task, cross-task-illegal** | utility is compared only within one task, because each task prices success and defect escape differently. Summing utility across 24 tasks produces a ranking in units that do not exist |

## The four outcomes, fixed before the run

```
Strong positive
  evidence-gated escaped == 0
  AND evidence-gated solved >= verify-always
  AND evidence-gated total cost  < verify-always total cost

Efficiency tradeoff
  evidence-gated escaped == 0
  AND evidence-gated cost      < verify-always cost
  AND evidence-gated solved    < verify-always solved

No advantage
  evidence-gated solved <= verify-always
  AND the cost reduction does not clear the bar above

Safety failure
  evidence-gated escaped a defect that verify-always caught
```

The order matters and is fixed: a safety failure is reported as a safety failure
even if the cost is better and the success count is equal, because that ordering is
the only one that does not let a cheap result buy a safety claim.

A fifth row exists and is not a loophole:

```
Uninformative
  the corpus cannot separate the policies on any task,
  which is reported as a corpus that failed to discriminate
  rather than as a tie between two good systems.
```

## Per-task divergence records, fixed

An aggregate hides the mechanism, so every task where the two primary policies
disagree is recorded in full. A disagreement is either a different success outcome
or a cost difference of at least 10% of the cheaper policy's total, declared here
so the set of recorded tasks cannot be chosen after the fact.

For each one:

```
task
  verify-always: solved, cost, action sequence
  evidence-gated: solved, cost, action sequence
  firstDivergenceStep        the first step where the two sequences differ
  stateBeforeDivergence      actions so far, last test exit, last verify exit,
                             edits left, pending attempts
  actionVerifyAlways         what verify-always chose there
  actionEvidenceGated        what evidence-gated chose there
  outcomeDivergence          which one solved, and the cost gap
  firstUnrecoverableStep     the first step at which this policy applied an edit
                             that is not the correct one, and a correct edit was
                             still available afterwards
```

`firstUnrecoverableStep` is a **proxy, declared as one**. "The point of no return"
has no mechanical definition in this harness. The proxy is the first step at which
the policy applied a flawed mutation while a correct one remained in the list, which
is the last moment a different decision could have changed the outcome. A task can
have no such step, and then the field says so rather than guessing.

## Threats, the rest of them

- 24 hand-written fixtures by one author. The instances are independent in content
  and not sampled from anything, so the corpus can show a failure mode exists and
  cannot say how often it occurs in the wild.
- Every task is a single small module with scripted candidate edits. Real work has
  edit sequences the author did not anticipate, and a policy that picks well among
  three scripted edits has not been shown to pick well among forty invented ones.
- `escapedDefect` is defined as "the policy believed a cheap green and the oracle
  disagreed". A policy that ends on no evidence at all is not counted as an escape,
  so the safety gate is weaker than it looks, and that is a property of the M3
  harness rather than of M7.
- Node's `Object.is` and float arithmetic decide several oracle comparisons, so a
  task can be decided by a rounding detail the author did not intend. The
  `verify-fixtures` sweep is run on the 24 before any policy touches them, and every
  fixture must have at least one correct mutation and at least one flawed one.

## Reproduction

```bash
npm --prefix bench/cogbench run build
npm test
node experiments/m7-replication.mjs
```

`npm test` runs `experiments/m7-replication.test.mjs`, which checks the freeze, the
corpus balance, the fixture sweep and the four-way outcome against the recorded
result. `m7-replication.mjs` prints the per-policy table and the divergence records.

It also calls `buildResults()` and compares the whole recorded object against a fresh run, field by field,
so the artefact cannot drift away from the harness without the test saying so. That check was missing
while the stale latch was in the runner, and it is the reason the recorded `18/24` at 71,260 survived three
corrections of the measured table without anything failing.

**The re-measured letter is Strong positive**: `evidence-gated` escaped nothing, solved 21 against 20, and
cost 125,730 against 140,400. The letter this protocol first received, on the frozen harness, was
Efficiency tradeoff at 18 against 20. Both letters, and why the second supersedes the first, are in
ADR 0005. The four outcomes above are unchanged: the corrected run was scored by the same pre-registered
order, and it is that order rather than the outcome which was frozen.
