import type { BenchTask, CostModel } from "./types.js"

/**
 * Family F-H fixtures: cheap verifier, information before action, high risk.
 *
 * Together with A-E these make the correct amount of verification a *function*
 * of the price of verifying and the cost of being wrong, rather than a constant
 * a policy can hard-code.
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

// --- Family F: cheap verifier ---------------------------------------------------
// The oracle costs almost nothing. Skipping it saves nothing and risks a
// defect priced far above the test, so frequent verification is rational.

const cheapVerifier: BenchTask = {
  id: "F1-cheap-verifier",
  name: "Oracle is nearly free",
  family: "F-cheap-verifier",
  description:
    "rotate() is wrong. The oracle costs almost nothing, so there is no reason to skip it between attempts.",
  files: {
    "src/rotate.js": `export function rotate(list, n) {
  return list.slice(n);
}
`,
    "test/rotate.local.js": `import { rotate } from "../src/rotate.js";
// Only the reported case: a partial forward rotation.
const ok = rotate([1, 2, 3], 1)[0] === 2;
console.log(ok ? "PASS rotate" : "FAIL rotate");
process.exit(ok ? 0 : 1);
`,
    "test/rotate.oracle.js": `import { rotate } from "../src/rotate.js";
const out = [];
const check = (n, a, e) => { const r = JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("rotates forward", rotate([1, 2, 3], 1), [2, 3, 1]);
check("full cycle is identity", rotate([1, 2, 3], 3), [1, 2, 3]);
check("zero is identity", rotate([1, 2, 3], 0), [1, 2, 3]);
check("negative wraps", rotate([1, 2, 3], -1), [3, 1, 2]);
check("empty", rotate([], 2), []);
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("f1"),
  },
  testCommand: "node test/rotate.local.js",
  verifyCommand: "node test/rotate.oracle.js",
  mutations: [
    {
      id: "m-correct-wrap",
      description: "Normalise the offset, then rotate",
      costTokens: 1000,
      changes: {
        "src/rotate.js": `export function rotate(list, n) {
  if (list.length === 0) return [];
  const k = ((n % list.length) + list.length) % list.length;
  return list.slice(k).concat(list.slice(0, k));
}
`,
      },
    },
    {
      id: "m-broken-full-cycle",
      description: "Concat the tail with a shortened head",
      knownFlaw:
        "Returns the right answer for a partial rotation and loses every item on a full cycle, which only the oracle checks.",
      costTokens: 800,
      changes: {
        "src/rotate.js": `export function rotate(list, n) {
  return list.slice(n).concat(list.slice(0, n - list.length));
}
`,
      },
    },
  ],
  readable: ["src/rotate.js", "test/rotate.local.js", "test/rotate.oracle.js"],
  searchable: [{ pattern: "slice", matches: ["src/rotate.js:2:  return list.slice(n);"] }],
  costModel: base({
    // The oracle is 30x cheaper than a single edit. Skipping it is never right.
    verify: { tokens: 20, latencyMs: 30 },
    test: { tokens: 20, latencyMs: 30 },
    defectEscape: 5000,
  }),
  budget: { maxSteps: 8, maxTokens: 18_000 },
}

// --- Family G: information before action ----------------------------------------
// The only correct edit is obvious once the file is read, and a plausible
// blind edit is wrong. Acting first wastes an expensive edit plus a
// verification cycle that then has to be repeated.

const needsReading: BenchTask = {
  id: "G1-read-before-acting",
  name: "The constraint is in another file",
  family: "G-information-before-action",
  description:
    "divide() must reject a zero divisor, but the rule is stated in a sibling module, not in the failing file.",
  files: {
    "src/divide.js": `export function divide(a, b) {
  return a / b;
}
`,
    "src/contract.js": `// Contract for the numeric helpers. Consumers rely on this.
// - divide() MUST return null when the divisor is zero.
// - divide() MUST NOT throw.
// This constraint is enforced by the oracle and is not duplicated in divide.js.
export const CONTRACT = "numeric-helpers/v1";
`,
    "test/divide.local.js": `import { divide } from "../src/divide.js";
const ok = divide(6, 2) === 3;
console.log(ok ? "PASS basic" : "FAIL basic");
process.exit(ok ? 0 : 1);
`,
    "test/divide.oracle.js": `import { divide } from "../src/divide.js";
import { CONTRACT } from "../src/contract.js";
const out = [];
// Object.is for numbers: JSON.stringify turns Infinity into null, which would
// make a division by zero compare equal to the required null result.
const isNum = (v) => typeof v === "number";
const eq = (a, b) => (isNum(a) || isNum(b)) ? Object.is(a, b) : JSON.stringify(a) === JSON.stringify(b);
const check = (n, a, e) => { const r = eq(a, e); out.push((r ? "PASS " : "FAIL ") + n); };
check("contract is v1", CONTRACT, "numeric-helpers/v1");
check("basic", divide(6, 2), 3);
check("zero divisor returns null", divide(1, 0), null);
check("negative operands", divide(-6, 2), -3);
check("does not throw on zero", (() => { try { divide(1, 0); return "no-throw"; } catch { return "threw"; } })(), "no-throw");
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("g1"),
  },
  testCommand: "node test/divide.local.js",
  verifyCommand: "node test/divide.oracle.js",
  mutations: [
    {
      id: "m-correct-contract",
      description: "Return null on a zero divisor, per the contract",
      costTokens: 1000,
      changes: {
        "src/divide.js": `export function divide(a, b) {
  if (b === 0) return null;
  return a / b;
}
`,
      },
    },
    {
      id: "m-throw-on-zero",
      description: "Throw on a zero divisor, which is the common instinct",
      knownFlaw: "Violates the contract, which forbids throwing. Only visible in the sibling file.",
      costTokens: 900,
      changes: {
        "src/divide.js": `export function divide(a, b) {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}
`,
      },
    },
  ],
  readable: ["src/divide.js", "src/contract.js", "test/divide.local.js", "test/divide.oracle.js"],
  searchable: [
    {
      pattern: "MUST",
      matches: [
        "src/contract.js:3:// - divide() MUST return null when the divisor is zero.",
        "src/contract.js:4:// - divide() MUST NOT throw.",
      ],
    },
    { pattern: "CONTRACT", matches: ["src/contract.js:6:export const CONTRACT = \"numeric-helpers/v1\";"] },
  ],
  costModel: base(),
  budget: { maxSteps: 8, maxTokens: 18_000 },
}

// --- Family H: high risk ---------------------------------------------------------
// An escaped defect is priced far above any verification cost, so the oracle is
// worth running even when it is expensive and the task looks simple.

const highRisk: BenchTask = {
  id: "H1-high-risk",
  name: "Escaped defect is catastrophic",
  family: "H-high-risk",
  description:
    "A money-rounding helper looks fixed after the local check. The oracle prices a cent-level error as catastrophic.",
  files: {
    "src/money.js": `export function roundCents(amount) {
  return Math.round(amount);
}
`,
    "test/money.local.js": `import { roundCents } from "../src/money.js";
// The reported case only: a positive amount rounding half up.
const ok = roundCents(10.005) === 10.01;
console.log(ok ? "PASS rounds" : "FAIL rounds");
process.exit(ok ? 0 : 1);
`,
    "test/money.oracle.js": `import { roundCents } from "../src/money.js";
const out = [];
const check = (n, a, e) => { const r = JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("rounds to cents", roundCents(10.005), 10.01);
check("rounds down below half", roundCents(10.004), 10);
check("exact cent is unchanged", roundCents(10.01), 10.01);
check("negative amount rounds away from zero symmetrically", roundCents(-10.005), -10.01);
check("zero", roundCents(0), 0);
check("large amount", roundCents(123456.789), 123456.79);
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "package.json": pkg("h1"),
  },
  testCommand: "node test/money.local.js",
  verifyCommand: "node test/money.oracle.js",
  mutations: [
    {
      id: "m-drops-sign",
      description: "Round the magnitude, which handles the reported case",
      knownFlaw:
        "Drops the sign: -10.005 returns +10.01. Scaling to integer cents is not the flaw, this pair was verified not to be one.",
      costTokens: 1000,
      changes: {
        "src/money.js": `export function roundCents(amount) {
  return Math.round(Math.abs(amount) * 100) / 100;
}
`,
      },
    },
    {
      id: "m-eps-correct",
      description: "Round half away from zero with an epsilon",
      costTokens: 1400,
      changes: {
        "src/money.js": `export function roundCents(amount) {
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  return sign * (Math.round((abs + Number.EPSILON * abs) * 100) / 100);
}
`,
      },
    },
  ],
  readable: ["src/money.js", "test/money.local.js", "test/money.oracle.js"],
  searchable: [{ pattern: "Math.round", matches: ["src/money.js:2:  return Math.round(amount);"] }],
  costModel: base({
    verify: { tokens: 1500, latencyMs: 2000 },
    test: { tokens: 120, latencyMs: 400 },
    // Ten times the cost of a whole verification budget. Here the oracle is
    // never the wrong thing to buy.
    defectEscape: 60_000,
    success: 70_000,
  }),
  budget: { maxSteps: 8, maxTokens: 20_000 },
}

export const familyTasksMore: BenchTask[] = [cheapVerifier, needsReading, highRisk]
