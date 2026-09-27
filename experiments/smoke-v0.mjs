import { createValveV0 } from "../packages/runtime/dist/index.js";

const valve = createValveV0();

const base = {
  goal: "Fix the failing pagination test",
  progress: 0.3,
  currentTask: "Investigate failing test and identify root cause",
  evidence: [
    { id: "ev-1", source: "test", content: "FAIL tests/pagination.test.ts", relevance: 0.95, timestamp: Date.now() },
  ],
  uncertainties: [
    { id: "unc-1", description: "Root cause unclear", severity: 0.8, relatedActions: ["READ", "TEST"] },
  ],
  constraints: [
    { id: "c1", description: "Must not change tests", type: "hard", source: "policy" },
  ],
  recentActions: [],
  verification: { build: "passed", tests: "unknown", qa: "unknown" },
  resources: { contextTokens: 1200, remainingBudget: 30000, elapsedMs: 15000 },
  authority: { canWrite: true, canDelete: false, canAskHuman: true },
};

const candidates = [
  { kind: "ACT", estimatedCost: 500, estimatedLatencyMs: 2000, reversible: false },
  { kind: "READ", estimatedCost: 50, estimatedLatencyMs: 500, reversible: true },
  { kind: "SEARCH", estimatedCost: 300, estimatedLatencyMs: 3000, reversible: true },
  { kind: "TEST", estimatedCost: 2000, estimatedLatencyMs: 10000, reversible: true },
  { kind: "VERIFY", estimatedCost: 1000, estimatedLatencyMs: 5000, reversible: true },
  { kind: "REASON_FAST", estimatedCost: 1000, estimatedLatencyMs: 3000, reversible: true },
  { kind: "REASON_DEEP", estimatedCost: 5000, estimatedLatencyMs: 15000, reversible: true },
  { kind: "DELEGATE", estimatedCost: 100, estimatedLatencyMs: 1000, reversible: true },
  { kind: "ASK_HUMAN", estimatedCost: 0, estimatedLatencyMs: 30000, reversible: true },
  { kind: "STOP", estimatedCost: 0, estimatedLatencyMs: 0, reversible: true },
];

const scenarios = [
  {
    name: "code changed, tests never run -> TEST",
    state: {
      ...base,
      recentActions: [
        { action: "ACT", timestamp: Date.now(), outcome: "success", cost: 100, latencyMs: 200 },
      ],
    },
    expect: "TEST",
  },
  {
    name: "tests failing -> ACT",
    state: { ...base, verification: { build: "passed", tests: "failed", qa: "unknown" } },
    expect: "ACT",
  },
  {
    name: "build failed -> ACT",
    state: { ...base, verification: { build: "failed", tests: "unknown", qa: "unknown" } },
    expect: "ACT",
  },
  {
    name: "task complete and verified -> STOP",
    state: {
      ...base,
      progress: 0.99,
      verification: { build: "passed", tests: "passed", qa: "passed" },
      uncertainties: [],
    },
    expect: "STOP",
  },
  {
    name: "budget exhausted -> STOP",
    state: { ...base, resources: { ...base.resources, remainingBudget: -100 } },
    expect: "STOP",
  },
];

let pass = 0;
let fail = 0;

for (const scenario of scenarios) {
  const decision = await valve.decide({
    state: scenario.state,
    candidates,
    utilityProfile: "coding-balanced",
  });

  const ok = decision.action === scenario.expect;
  if (ok) pass++;
  else fail++;

  const marker = ok ? "PASS" : "FAIL";
  console.log(
    `[${marker}] ${scenario.name}\n` +
    `        chose=${decision.action} p=${decision.probability.toFixed(2)} ` +
    `U=${decision.expectedUtility.toFixed(3)} source=${decision.source}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
