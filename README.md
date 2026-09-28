# VALVE

**Value-Aware Latent Verification & Execution** — a System Zero cognitive scheduler for agentic systems.

## Status: research, not a product

There is **no trained model here yet**, and the current policy is a
hand-written heuristic set that has been **falsified by its own benchmark**.
Publishing that first is deliberate: a scheduler is only interesting if it
captures the safety of constant verification at lower cost, and the only
honest way to find out whether one is possible is to build the measurement
first and let it say no.

What exists:

| Milestone | State |
|---|---|
| M1 V0 policy (heuristics + JEV + teacher fallback) | done |
| M2 OpenCode shadow observer, spool, ingest, disagreement queries | done |
| M3 CogBench: real exit codes as the only success signal | done, **negative result** |
| M4 Outcome-aware state: attempts, checkpoints, verdicts, grounded labels | done |
| M5 CogBench families A–H, per-task verification cost | frozen |
| M6 Evidence-acquisition policies | done, **close but not sufficient** |
| M7 Replication corpus: 8 development tasks to 24 unseen | **next** |

The two results worth reading before anything else:

- **[ADR 0001](docs/decisions/0001-cogbench-falsifies-valve-v0.md)** — V0 costs
  50% more than doing nothing and solves the same number of tasks. Constant
  verification is the only policy that solves them.
- **[ADR 0002](docs/decisions/0002-outcome-aware-trajectory-state.md)** — the
  representation, not the policy, was the blocker, and the dataset can now say
  *why* a run went wrong.
- **[ADR 0003](docs/decisions/0003-cogbench-frozen.md)** — the benchmark varies
  the price of verification, includes tasks where *not* verifying is correct,
  and finds V0 dominated on **both** axes.
- **[ADR 0004](docs/decisions/0004-evidence-acquisition-policies.md)** — a
  gating policy beats V0 on both axes (6/8 against 3/8, cheaper) but still
  trails the safety bound. The policy the thesis predicts is the *worst* of them,
  which is reported as a negative result rather than tuned away.

## Overview

VALVE decides **whether cognition should happen, what kind, how much, and where** — before any LLM is called.

```
SYSTEM 0          SYSTEM 1              SYSTEM 2
─────────         ─────────            ─────────
VALVE      →      JEV         →        GPT/Claude
             (fast)    (judgment)     (reasoning)
```

## Architecture

| Package | Purpose |
|---------|---------|
| `@valve/schema` | Core types: `CognitiveState`, `CognitiveAction`, `UtilityProfile` (6 profiles), `TrajectoryEvent`, `ObservedEvent`, `CogBenchTask` |
| `@valve/runtime` | V0 policy: heuristics → JEV → teacher LLM fallback, plus `decideSync` for offline use |
| `@valve/opencode-adapter` | Turns the NDJSON spool into `CognitiveState` + shadow decisions (`ingestSpool`) |
| `@valve/jev-adapter` | JEV client for structured judgments (needMoreInfo, riskAssessment, bestSource, taskVerified, humanWorthIt) |
| `@valve/telemetry` | Event store on `node:sqlite` (episodes, events, counterfactuals, CogBench) |

## Shadow mode (current stage, M2)

VALVE does not control OpenCode yet. It watches, and records what it *would*
have done. The disagreement between the two is the training signal.

```
OpenCode ──► plugin/valve-shadow.ts   (installed to ~/.config/opencode/plugin/)
                    │  appends NDJSON, fail-open, never blocks
                    ▼
            ~/.local/share/opencode/valve/observed.ndjson
                    │
                    ▼  npm run ingest
            SQLite: episodes + events (chosen = ground truth, shadow = prediction)
```

```bash
cp plugin/valve-shadow.ts ~/.config/opencode/plugin/    # install the observer
export VALVE_SPOOL_DIR=/path/to/spool                   # optional
```

The plugin is a pure sensor: it records `episode_open`, `llm_call`,
`tool_result`, `human_interruption`, `session_error` and `episode_close`, and
nothing else. It imports no valve code and holds no database handle, matching
the conventions of that plugin directory and keeping a native dependency out of
the agent process. Every write failure is swallowed on purpose: a lost
observation is a gap in the dataset, a thrown error is a broken session.

```bash
npm run build     # tsc -b, honours project references
npm test          # 30 tests: ingest, classifier, outcome-aware state, M4 criteria
npm run smoke     # V0 heuristic decisions
npm run ingest    # spool -> data/valve.db
```

Useful query once data exists:

```sql
-- where VALVE and the real agent disagreed: the training signal
SELECT chosen, json_extract(shadow,'$.action'), json_extract(shadow,'$.expectedUtility')
FROM events WHERE json_extract(shadow,'$.agrees') = 0;
```

### Outcome-aware state (M4)

`recentActions` is a chronology. Alongside it, each mutating step opens an
**attempt** with an identity: the checkpoint it was made from, a fingerprint of
the change it produced, and a verdict once somebody looked.

```
attempt 1  hypothesis: shift the start index by one
            base a541f974  delta 32b42da6  verdict: falsified (individual)
            evidence: test exit=1

attempt 2  hypothesis: compute start from page - 1
            base 27d6e46e  delta c309161c  verdict: supported (individual)
            evidence: test exit=0
```

Stacking edits and testing once cannot identify which edit was wrong. That is
recorded as `unattributable (compound)` rather than as three confident
rejections, because fabricating per-attempt verdicts would teach a model to
avoid interventions that were never shown to fail.

```bash
node experiments/attempts.mjs <taskId> <policyId>   # the decisive query
```

**Grounding is graded, and the grades are not equivalent:**

| grounding | meaning | trainable |
|---|---|---|
| `harness` | declared by the process that executed the step | yes |
| `deterministic` | tool name maps to one operation | yes |
| `derived` | classified from a command or heuristics | no |
| `ungrounded` | nothing reliable available | no |

An unrecognised tool is recorded as `UNKNOWN`, never coerced to the nearest
plausible label, and excluded from training. See ADR 0002 for why this means
**only `read`, `edit` and `search` are trainable from the shadow corpus**,
because every shell call is `derived` — and running tests is a shell call.

### Known measurement limits

These are the weakest links and they bound what the dataset can claim:

- **`deriveVerification` is regex over tool output prose.** It reads
  `FAIL` / `3 passed` out of stdout. There is no exit-code integration, so a
  test run that prints nothing is `unknown`, not `passed`. Replace it with real
  exit codes before trusting verification-dependent behaviour.
- **`progressDelta` and `taskSuccess` are `null` in shadow mode.** Nothing
  observes task success without a verifier, so they are left null rather than
  guessed. A fabricated progress delta would silently become a training label.
- **Most of the shadow corpus is not trainable.** See the grounding table
  above. Only CogBench, which executes and reads a real exit code, produces
  grounded verification labels.
- **The utility weights are hand-set, not fitted.** They are plausible, not
  calibrated. The numbers are for ranking candidates, not for reporting value.
- **Shadow decisions come from heuristics only** (`decideSync` skips the
  network), so disagreement rate measures V0's heuristics, not a trained model.
  It is a floor to beat, not a result.

## V0 Policy (No Training)

```typescript
const valve = createValveV0({
  utilityProfile: "coding-balanced",
  jevEndpoint: "http://localhost:8080",
  teacherEndpoint: "https://api.openai.com/v1/chat/completions",
  teacherApiKey: process.env.OPENAI_API_KEY,
});

const decision = await valve.decide({
  state: cognitiveState,
  candidates: availableActions,
  utilityProfile: "coding-balanced",
});
```

**Decision sources (in order):**
1. **Heuristics** — deterministic rules (tests never run → TEST, build failed → ACT)
2. **JEV** — structured judgments (need more info?, risk?, best source?, verified?, human worth it?)
3. **Teacher LLM** — frontier model for ambiguous cases
4. **Default scoring** — utility estimation fallback

## Cognitive Actions (V0)

| Action | Purpose |
|--------|---------|
| `ACT` | Execute a code change / tool call |
| `READ` | Read a file / context |
| `SEARCH` | Search codebase / web |
| `TEST` | Run tests |
| `VERIFY` | Run verification (lint, typecheck, QA) |
| `REASON_FAST` | Cheap reasoning (small model, few tokens) |
| `REASON_DEEP` | Expensive reasoning (frontier model) |
| `DELEGATE` | Hand off to specialized agent |
| `ASK_HUMAN` | Interrupt for human input |
| `STOP` | Task sufficiently complete |

## Utility Profiles

Predefined weights for different contexts:

- `coding-balanced` — default
- `coding-correctness` — correctness > speed
- `coding-speed` — latency optimized
- `interactive-ui` — low latency critical
- `production-migration` — risk averse
- `research` — information gain valued

## CogBench

Benchmark suite measuring:

- Task Success ↑
- Cost ($) ↓
- Latency ↓
- Frontier Model Calls ↓
- Steps ↓
- Human Interventions ↓
- Escaped Defects ↓

Run baseline vs VALVE on identical tasks.

## Development

```bash
npm install
npm run build     # tsc -b across project references
npm test          # node:test suites
npm run smoke     # V0 decision scenarios
npm run ingest    # shadow spool -> SQLite
```

Requires Node 22.5+ for `node:sqlite` (developed on 24). There is no native
addon: `better-sqlite3` was removed because its finalizer aborts the process
during garbage collection under Node 24, which destroyed test failure reports.

## CogBench (M3)

A benchmark where **success is a process exit code**, never a hand-declared
label. Each task is a real repository state with a real test command; each
candidate edit is a real file write, judged only by whether the oracle exits 0.
An edit is applied as a discrete alternative, reset to pristine first, so the
last edit in the list cannot win by ordering alone.

```bash
node bench/cogbench/dist/cli.js                    # compare policies
node bench/cogbench/dist/cli.js --spool out.ndjson # also feed the shared reader
```

Current result is a **negative finding**. V0 is dominated on both axes:

```
policy             solved  escaped  cost
verify-always      7/8     0        25,100
test-always        4/8     3        10,180
valve-v0           3/8     0        27,920
stop-immediately   1/8     0        0
```

`verify-always` is the safety reference: it cannot ship a defect because the
oracle is the thing it runs. `test-always` is the informative failure: the
cheapest policy that ships anything, and it escapes 3 defects. The bar is
`verify-always`'s solved count and zero escaped, at lower cost.

Two channels, priced per task: a cheap partial `testCommand` that can pass on a
wrong fix, and the complete `verifyCommand` oracle. A `defectEscape` weight
prices what shipping a missed bug costs, which is what makes skipping
verification a decision rather than an omission. Utility is compared only within
a task, because each task prices success differently.

## Roadmap

- **M0** ✓ Spec & schema
- **M1** ✓ V0 runtime (heuristics + JEV + teacher)
- **M2** ✓ OpenCode shadow observer, spool, ingest, disagreement queries
- **M3** ✓ CogBench harness + 2 verified fixtures (negative result on V0, ADR 0001)
- **M4** ✓ Outcome-aware state: attempts, checkpoints, verdicts, graded grounding (ADR 0002)
- **M5** ✓ CogBench families A–H, per-task verification cost, escaped-defect
  weight. **Frozen** — see ADR 0003. Two fixtures can falsify a policy but cannot
  establish one, and a benchmark where verifying is almost always right rewards
  any policy that simply verifies more.
- **M6** ✓ Evidence-acquisition policies: confidence-threshold, evidence-gated,
  risk-adjusted, oracle-budgeted. The question is how much evidence is enough to
  avoid buying the full oracle. **The policy set is now frozen too.**
- **M7** Replication corpus: 8 development tasks to 24 unseen ones, evaluated
  without touching the policies. On 8 tasks with one instance per family, the
  M6 result is a hypothesis, not a finding.
- **M7** Counterfactual replay from checkpoints
- **M8** Dataset v1 (100k+ decision points)
- **M9** VALVE-1: small supervised model, then calibration (ECE, Brier)
- **M10** Low-risk live control

## License

MIT