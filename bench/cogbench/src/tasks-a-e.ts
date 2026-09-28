import type { BenchTask, CostModel } from "./types.js"

/**
 * Family A-E fixtures: already correct, trivial, competing, misleading, expensive.
 *
 * Every fixture is a real module with a real bug, a cheap local test that
 * checks the reported symptom, and a complete oracle that also checks
 * coverage. Correctness is decided only by the oracle's exit code.
 */

const base = (over: Partial<CostModel> = {}): CostModel => ({
  act: { tokens: 900, latencyMs: 1200 },
  read: { tokens: 60, latencyMs: 120 },
  search: { tokens: 200, latencyMs: 800 },
  test: { tokens: 120, latencyMs: 400 },
  verify: { tokens: 900, latencyMs: 3000 },
  defectEscape: 4000,
  success: 6000,
  step: 15,
  ...over,
})

const pkg = (name: string) => `{
  "name": "${name}",
  "type": "module",
  "private": true
}
`

// --- Family A: already correct -------------------------------------------------
// Nothing to fix. STOP immediately is the cheapest correct move, and any edit
// is a regression. The harness must not assume every task needs a change.

const alreadySorted: BenchTask = {
  id: "A1-already-sorted",
  name: "Sum helper is already correct",
  family: "A-already-correct",
  description:
    "Report claims sum() drops negative numbers. Inspection shows the implementation is already correct and the report is stale.",
  startsSolved: true,
  files: {
    "src/sum.js": `export function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}
`,
    "test/sum.local.js": `import { sum } from "../src/sum.js";
const out = [];
const check = (n, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); out.push((ok ? "PASS " : "FAIL ") + n); };
check("positives", sum([1, 2, 3]), 6);
check("negatives", sum([-1, -2]), -3);
check("mixed", sum([1, -1, 2]), 2);
check("empty", sum([]), 0);
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "test/sum.oracle.js": `import { sum } from "../src/sum.js";
const out = [];
const check = (n, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); out.push((ok ? "PASS " : "FAIL ") + n); };
check("positives", sum([1, 2, 3]), 6);
check("negatives", sum([-1, -2]), -3);
check("mixed", sum([1, -1, 2]), 2);
check("empty", sum([]), 0);
check("floats", sum([0.1, 0.2]), 0.30000000000000004);
check("large", sum(new Array(1000).fill(1)), 1000);
check("does not mutate", (() => { const v = [1, 2]; sum(v); return v; })([1, 2]), [1, 2]);
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("a1"),
  },
  testCommand: "node test/sum.local.js",
  verifyCommand: "node test/sum.oracle.js",
  // Only a regression is available. Applying it is a mistake, which is the
  // whole point of the family.
  mutations: [
    {
      id: "m-filter-positive",
      description: "Filter out negative values, believing the stale report",
      knownFlaw: "Regresses a correct implementation, which is what the family exists to catch.",
      costTokens: 1100,
      changes: {
        "src/sum.js": `export function sum(values) {
  return values.filter((v) => v > 0).reduce((a, b) => a + b, 0);
}
`,
      },
    },
  ],
  readable: ["src/sum.js", "test/sum.local.js", "test/sum.oracle.js"],
  searchable: [{ pattern: "reduce", matches: ["src/sum.js:2:  return values.reduce((a, b) => a + b, 0);"] }],
  costModel: base(),
  budget: { maxSteps: 6, maxTokens: 12_000 },
}

// --- Family B: trivial, near-certain -------------------------------------------
// One localised edit, cheap oracle. ACT then STOP is correct and cheaper than
// ACT then VERIFY, so a policy that verifies out of habit loses utility.

const trivialOffByOne: BenchTask = {
  id: "B1-trivial-off-by-one",
  name: "Return statement missing",
  family: "B-trivial",
  description: "addTwo() returns undefined because the return statement was dropped.",
  files: {
    "src/add.js": `export function addTwo(a, b) {
  const total = a + b;
}
`,
    "test/add.local.js": `import { addTwo } from "../src/add.js";
const ok = addTwo(2, 3) === 5;
console.log(ok ? "PASS addTwo" : "FAIL addTwo");
process.exit(ok ? 0 : 1);
`,
    "test/add.oracle.js": `import { addTwo } from "../src/add.js";
const out = [];
const check = (n, a, e) => { const r = JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("basic", addTwo(2, 3), 5);
check("negatives", addTwo(-2, -3), -5);
check("zero", addTwo(0, 0), 0);
check("strings", addTwo("a", "b"), "ab");
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("b1"),
  },
  testCommand: "node test/add.local.js",
  verifyCommand: "node test/add.oracle.js",
  mutations: [
    {
      id: "m-return-total",
      description: "Return the computed total",
      costTokens: 700,
      changes: {
        "src/add.js": `export function addTwo(a, b) {
  const total = a + b;
  return total;
}
`,
      },
    },
    {
      id: "m-return-wrong",
      description: "Return a + b + 1",
      knownFlaw: "Off by one on every input.",
      costTokens: 700,
      changes: {
        "src/add.js": `export function addTwo(a, b) {
  return a + b + 1;
}
`,
      },
    },
  ],
  readable: ["src/add.js", "test/add.local.js", "test/add.oracle.js"],
  searchable: [{ pattern: "const total", matches: ["src/add.js:2:  const total = a + b;"] }],
  costModel: base({ verify: { tokens: 700, latencyMs: 1200 } }),
  budget: { maxSteps: 6, maxTokens: 12_000 },
}

// --- Family C: competing hypotheses --------------------------------------------
// Several plausible fixes. A policy that edits three times before looking
// lands on whichever came last; testing between attempts is what makes the
// rejection observable and the correct one findable.

const competingFixes: BenchTask = {
  id: "C1-competing-fixes",
  name: "Three plausible fixes for a wrong result",
  family: "C-competing-hypotheses",
  description:
    "clamp() returns out-of-range values unchanged. Three different fixes are each plausible and two are wrong.",
  files: {
    "src/clamp.js": `export function clamp(value, min, max) {
  return value;
}
`,
    "test/clamp.local.js": `import { clamp } from "../src/clamp.js";
const ok = clamp(15, 0, 10) === 10;
console.log(ok ? "PASS high" : "FAIL high");
process.exit(ok ? 0 : 1);
`,
    "test/clamp.oracle.js": `import { clamp } from "../src/clamp.js";
const out = [];
const check = (n, a, e) => { const r = JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("above max", clamp(15, 0, 10), 10);
check("below min", clamp(-5, 0, 10), 0);
check("inside", clamp(5, 0, 10), 5);
check("at bounds", [clamp(0, 0, 10), clamp(10, 0, 10)], [0, 10]);
check("inverted bounds do not crash", typeof clamp(5, 10, 0), "number");
check("floats", clamp(2.5, 0, 1), 1);
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("c1"),
  },
  testCommand: "node test/clamp.local.js",
  verifyCommand: "node test/clamp.oracle.js",
  mutations: [
    {
      id: "m-only-max",
      description: "Clamp only the upper bound",
      knownFlaw: "Fixes the reported case and leaves the lower bound open.",
      costTokens: 800,
      changes: {
        "src/clamp.js": `export function clamp(value, min, max) {
  return value > max ? max : value;
}
`,
      },
    },
    {
      id: "m-correct-bounds",
      description: "Clamp against both bounds",
      costTokens: 1100,
      changes: {
        "src/clamp.js": `export function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
`,
      },
    },
    {
      id: "m-wrong-direction",
      description: "Swap the comparison direction",
      knownFlaw: "Inverted: clamps the wrong side entirely.",
      costTokens: 800,
      changes: {
        "src/clamp.js": `export function clamp(value, min, max) {
  return value < max ? min : value;
}
`,
      },
    },
  ],
  readable: ["src/clamp.js", "test/clamp.local.js", "test/clamp.oracle.js"],
  searchable: [{ pattern: "return value", matches: ["src/clamp.js:2:  return value;"] }],
  costModel: base(),
  budget: { maxSteps: 10, maxTokens: 20_000 },
}

// --- Family D: misleading local signal -----------------------------------------
// The cheap test passes on a wrong fix. Only the oracle catches it. This is
// the family that makes TEST and VERIFY different actions rather than synonyms.

const misleadingLocal: BenchTask = {
  id: "D1-misleading-local-signal",
  name: "Local test green on a wrong fix",
  family: "D-misleading-local-signal",
  description:
    "A guard makes the reported case pass while the second case still fails. The cheap test only covers the first.",
  files: {
    "src/parse.js": `export function parsePort(input) {
  return Number(input);
}
`,
    "test/parse.local.js": `import { parsePort } from "../src/parse.js";
// The reported case only.
const ok = parsePort("8080") === 8080;
console.log(ok ? "PASS numeric" : "FAIL numeric");
process.exit(ok ? 0 : 1);
`,
    "test/parse.oracle.js": `import { parsePort } from "../src/parse.js";
const out = [];
const check = (n, a, e) => { const r = JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("numeric string", parsePort("8080"), 8080);
check("zero is a valid port, not falsy", parsePort("0"), 0);
check("rejects non-numeric", parsePort("abc"), null);
check("rejects empty", parsePort(""), null);
check("rejects negative", parsePort("-1"), null);
check("rejects above range", parsePort("70000"), null);
check("accepts boundary", parsePort("65535"), 65535);
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("d1"),
  },
  testCommand: "node test/parse.local.js",
  verifyCommand: "node test/parse.oracle.js",
  mutations: [
    {
      id: "m-truthy-guard",
      description: "Guard with a truthiness check, which passes the local test",
      knownFlaw:
        "Zero is a valid port but falsy, and non-numeric input still yields NaN. The local test cannot see either.",
      costTokens: 900,
      changes: {
        "src/parse.js": `export function parsePort(input) {
  const n = Number(input);
  return n ? n : 0;
}
`,
      },
    },
    {
      id: "m-correct-validate",
      description: "Validate the input and the port range",
      costTokens: 1300,
      changes: {
        "src/parse.js": `export function parsePort(input) {
  if (typeof input !== "string" || input.trim() === "") return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}
`,
      },
    },
  ],
  readable: ["src/parse.js", "test/parse.local.js", "test/parse.oracle.js"],
  searchable: [{ pattern: "Number(", matches: ["src/parse.js:2:  return Number(input);"] }],
  costModel: base({ defectEscape: 9000 }),
  budget: { maxSteps: 8, maxTokens: 18_000 },
}

// --- Family E: expensive verifier ----------------------------------------------
// Correct but slow, so two edits followed by one verification can beat
// edit-verify-edit-verify. The oracle is right; it is just priced.

const expensiveVerifier: BenchTask = {
  id: "E1-expensive-verifier",
  name: "Correct but very slow oracle",
  family: "E-expensive-verifier",
  description:
    "Two independent declarations are wrong. The oracle takes 4 seconds, so verifying after each edit doubles the cost of being careful.",
  files: {
    "src/index.js": `export const VERSION = 0;
export const NAME = "lib";
export function greet() {
  return "hello";
}
`,
    "test/index.local.js": `import { greet } from "../src/index.js";
const ok = greet() === "hello";
console.log(ok ? "PASS greet" : "FAIL greet");
process.exit(ok ? 0 : 1);
`,
    "test/index.oracle.js": `import { VERSION, NAME, greet } from "../src/index.js";
const out = [];
const check = (n, a, e) => { const r = JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("version is 2", VERSION, 2);
check("name is lib-v2", NAME, "lib-v2");
check("greet unchanged", greet(), "hello");
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("e1"),
  },
  testCommand: "node test/index.local.js",
  verifyCommand: "node test/index.oracle.js",
  mutations: [
    {
      id: "m-both",
      description: "Update both declarations together",
      costTokens: 1600,
      changes: {
        "src/index.js": `export const VERSION = 2;
export const NAME = "lib-v2";
export function greet() {
  return "hello";
}
`,
      },
    },
    {
      id: "m-version-only",
      description: "Bump the version only",
      knownFlaw: "Leaves the name wrong, which only the oracle inspects.",
      costTokens: 800,
      changes: {
        "src/index.js": `export const VERSION = 2;
export const NAME = "lib";
export function greet() {
  return "hello";
}
`,
      },
    },
  ],
  readable: ["src/index.js", "test/index.local.js", "test/index.oracle.js"],
  searchable: [{ pattern: "export const", matches: ["src/index.js:1:export const VERSION = 0;", "src/index.js:2:export const NAME = \"lib\";"] }],
  costModel: base({
    // The oracle is 25x the price of the local test. This is the whole family.
    verify: { tokens: 6000, latencyMs: 4000 },
    test: { tokens: 80, latencyMs: 200 },
    defectEscape: 2500,
    success: 20_000,
  }),
  budget: { maxSteps: 10, maxTokens: 30_000 },
}

export const familyTasks: BenchTask[] = [
  alreadySorted,
  trivialOffByOne,
  competingFixes,
  misleadingLocal,
  expensiveVerifier,
]
