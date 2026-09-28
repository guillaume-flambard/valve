import type { BenchTask, CostModel } from "./types.js"

/**
 * M7: the replication corpus. 24 unseen tasks, three per family.
 *
 * Pre-registered in `docs/protocols/m7-replication.md` before this file existed. The author of these
 * fixtures has read all four M6 policies, which that document states as the largest weakness of the
 * result and which nothing in this file repairs. What it can do is refuse to be easy: every construction
 * here that hurts `evidence-gated` is in the corpus.
 *
 * These are not added to `tasks`. The M6 numbers are pinned against those 8 fixtures, and a replication
 * corpus that moved them would not be a replication of anything.
 *
 * Every fixture obeys three rules that `verify-fixtures.mjs` checks mechanically:
 * the pristine state fails the oracle, at least one mutation satisfies it, at least one does not, and
 * every number in an oracle is exactly representable, so no outcome is decided by a rounding accident.
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

/** The shared assertion helpers. Identical everywhere, so no fixture is easier to pass than another. */
const header = (imports: string) => `${imports}
const out = [];
const check = (n, a, e) => { const r = Object.is(a, e) || JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
`
const tail = `console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`

// =============================================================================================
// Family A: already correct. Every available edit is a regression.
// =============================================================================================

const a1Even: BenchTask = {
  id: "A-m7-1-stale-parity-report",
  name: "Stale report on a correct parity helper",
  family: "A-already-correct",
  description:
    "A report says isEven() always answers false. Inspection shows the implementation is correct and the report is stale.",
  startsSolved: true,
  files: {
    "src/parity.js": `export function isEven(n) {
  return n % 2 === 0;
}
`,
    "test/parity.local.js": `import { isEven } from "../src/parity.js";
const ok = [2, 4, 7].map(isEven).join(",") === "true,true,false";
console.log(ok ? "PASS parity" : "FAIL parity");
process.exit(ok ? 0 : 1);
`,
    "test/parity.oracle.js":
      header(`import { isEven } from "../src/parity.js"`) +
      `check("even", isEven(2), true);
check("odd", isEven(7), false);
check("zero", isEven(0), true);
check("negative even", isEven(-4), true);
check("negative odd", isEven(-7), false);
` +
      tail,
    "package.json": pkg("m7-a1"),
  },
  testCommand: "node test/parity.local.js",
  verifyCommand: "node test/parity.oracle.js",
  mutations: [
    {
      id: "m-invert",
      description: "Invert the comparison, which is the behaviour the report describes",
      knownFlaw: "Answers false for every input.",
      costTokens: 1100,
      changes: {
        "src/parity.js": `export function isEven(n) {
  return n % 2 !== 0;
}
`,
      },
    },
    {
      id: "m-always-true",
      description: "Trust the report and answer true",
      knownFlaw: "Answers true for every input.",
      costTokens: 1000,
      changes: {
        "src/parity.js": `export function isEven(n) {
  return true;
}
`,
      },
    },
  ],
  readable: ["src/parity.js", "test/parity.local.js", "test/parity.oracle.js"],
  searchable: [{ pattern: "% 2", matches: ["src/parity.js:2:  return n % 2 === 0;"] }],
  costModel: base(),
  budget: { maxSteps: 6, maxTokens: 12_000 },
}

const a2Unique: BenchTask = {
  id: "A-m7-2-stale-duplicate-report",
  name: "Stale report on a correct deduplicator",
  family: "A-already-correct",
  description:
    "A report says unique() keeps duplicates. The implementation is correct and the report predates the last fix.",
  startsSolved: true,
  files: {
    "src/unique.js": `export function unique(values) {
  return [...new Set(values)];
}
`,
    "test/unique.local.js": `import { unique } from "../src/unique.js";
const ok = unique([1, 1, 2]).join(",") === "1,2";
console.log(ok ? "PASS unique" : "FAIL unique");
process.exit(ok ? 0 : 1);
`,
    "test/unique.oracle.js":
      header(`import { unique } from "../src/unique.js"`) +
      `check("removes duplicates", unique([1, 1, 2]), [1, 2]);
check("preserves order", unique([3, 1, 3, 2]), [3, 1, 2]);
check("removes repeated strings", unique(["a", "a"]).length, 1);
check("empty", unique([]), []);
check("does not mutate", (() => { const v = [1, 1]; unique(v); return v.length; })(), 2);
` +
      tail,
    "package.json": pkg("m7-a2"),
  },
  testCommand: "node test/unique.local.js",
  verifyCommand: "node test/unique.oracle.js",
  mutations: [
    {
      id: "m-returns-input",
      description: "Return the input unchanged, which is what the report describes",
      knownFlaw: "Keeps every duplicate, which is the bug the report claims and does not have.",
      costTokens: 1000,
      changes: {
        "src/unique.js": `export function unique(values) {
  return values;
}
`,
      },
    },
    {
      id: "m-sorts",
      description: "Dedupe and sort, acting on the belief that the report is right",
      knownFlaw: "Removes duplicates but destroys the order the oracle requires.",
      costTokens: 1200,
      changes: {
        "src/unique.js": `export function unique(values) {
  return [...new Set(values)].sort();
}
`,
      },
    },
  ],
  readable: ["src/unique.js", "test/unique.local.js", "test/unique.oracle.js"],
  searchable: [{ pattern: "new Set", matches: ["src/unique.js:2:  return [...new Set(values)];"] }],
  costModel: base({ verify: { tokens: 400, latencyMs: 800 } }),
  budget: { maxSteps: 6, maxTokens: 12_000 },
}

const a3Title: BenchTask = {
  id: "A-m7-3-stale-case-report",
  name: "Stale report on a correct title caser",
  family: "A-already-correct",
  description:
    "A report says titleCase() lowercases everything. The implementation already handles every word and the report is old.",
  startsSolved: true,
  files: {
    "src/title.js": `export function titleCase(text) {
  return text.replace(/\\b\\w/g, (c) => c.toUpperCase());
}
`,
    "test/title.local.js": `import { titleCase } from "../src/title.js";
const ok = titleCase("hello world") === "Hello World";
console.log(ok ? "PASS title" : "FAIL title");
process.exit(ok ? 0 : 1);
`,
    "test/title.oracle.js":
      header(`import { titleCase } from "../src/title.js"`) +
      `check("two words", titleCase("hello world"), "Hello World");
check("already cased stays cased", titleCase("Hello World"), "Hello World");
check("single word", titleCase("hello"), "Hello");
check("empty", titleCase(""), "");
check("hyphen does not break it", titleCase("a-b c"), "A-B C");
` +
      tail,
    "package.json": pkg("m7-a3"),
  },
  testCommand: "node test/title.local.js",
  verifyCommand: "node test/title.oracle.js",
  mutations: [
    {
      id: "m-lowercases",
      description: "Lowercase the whole string, which is what the report describes",
      knownFlaw: "Lowercases everything, which is the reported bug and not a real one.",
      costTokens: 900,
      changes: {
        "src/title.js": `export function titleCase(text) {
  return text.toLowerCase();
}
`,
      },
    },
    {
      id: "m-first-letter",
      description: "Uppercase only the first character",
      knownFlaw: "Leaves every word after the first lowercase.",
      costTokens: 1000,
      changes: {
        "src/title.js": `export function titleCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
`,
      },
    },
  ],
  readable: ["src/title.js", "test/title.local.js", "test/title.oracle.js"],
  searchable: [{ pattern: "replace", matches: ["src/title.js:2:  return text.replace(/\\b\\w/g, (c) => c.toUpperCase());"] }],
  costModel: base({ verify: { tokens: 2600, latencyMs: 3400 } }),
  budget: { maxSteps: 6, maxTokens: 14_000 },
}

// =============================================================================================
// Family B: one localised fix, and a cheap oracle, so verifying is overhead.
// =============================================================================================

const b1Multiply: BenchTask = {
  id: "B-m7-1-dropped-return",
  name: "Computed value never returned",
  family: "B-trivial",
  description: "multiply() computes the product and returns undefined. The oracle is cheap.",
  files: {
    "src/multiply.js": `export function multiply(a, b) {
  const product = a * b;
}
`,
    "test/multiply.local.js": `import { multiply } from "../src/multiply.js";
const ok = multiply(2, 3) === 6;
console.log(ok ? "PASS multiply" : "FAIL multiply");
process.exit(ok ? 0 : 1);
`,
    "test/multiply.oracle.js":
      header(`import { multiply } from "../src/multiply.js"`) +
      `check("positive", multiply(2, 3), 6);
check("negative", multiply(-2, 3), -6);
check("zero", multiply(0, 5), 0);
check("order is irrelevant", multiply(3, 2), 6);
` +
      tail,
    "package.json": pkg("m7-b1"),
  },
  testCommand: "node test/multiply.local.js",
  verifyCommand: "node test/multiply.oracle.js",
  mutations: [
    {
      id: "m-return-product",
      description: "Return the computed product",
      costTokens: 700,
      changes: {
        "src/multiply.js": `export function multiply(a, b) {
  const product = a * b;
  return product;
}
`,
      },
    },
    {
      id: "m-return-a",
      description: "Return the first operand instead",
      knownFlaw: "Returns a, so it only agrees when b is 1.",
      costTokens: 700,
      changes: {
        "src/multiply.js": `export function multiply(a, b) {
  const product = a * b;
  return a;
}
`,
      },
    },
  ],
  readable: ["src/multiply.js", "test/multiply.local.js", "test/multiply.oracle.js"],
  searchable: [{ pattern: "const product", matches: ["src/multiply.js:2:  const product = a * b;"] }],
  costModel: base({ verify: { tokens: 500, latencyMs: 900 } }),
  budget: { maxSteps: 6, maxTokens: 12_000 },
}

const b2JoinAll: BenchTask = {
  id: "B-m7-2-loop-bound",
  name: "Loop bound drops the last element",
  family: "B-trivial",
  description: "joinAll() skips the final element of the array. The oracle is a middling price.",
  files: {
    "src/join.js": `export function joinAll(parts) {
  let out = "";
  for (let i = 0; i < parts.length - 1; i++) {
    out += parts[i];
  }
  return out;
}
`,
    "test/join.local.js": `import { joinAll } from "../src/join.js";
const ok = joinAll(["a", "b", "c"]) === "abc";
console.log(ok ? "PASS join" : "FAIL join");
process.exit(ok ? 0 : 1);
`,
    "test/join.oracle.js":
      header(`import { joinAll } from "../src/join.js"`) +
      `check("three parts", joinAll(["a", "b", "c"]), "abc");
check("one part", joinAll(["a"]), "a");
check("empty", joinAll([]), "");
check("numbers are stringified", joinAll([1, 2]), "12");
` +
      tail,
    "package.json": pkg("m7-b2"),
  },
  testCommand: "node test/join.local.js",
  verifyCommand: "node test/join.oracle.js",
  mutations: [
    {
      id: "m-includes-undefined",
      description: "Change < to <=, which is the instinct when a bound looks off by one",
      knownFlaw: "Appends an undefined element, so every non-empty input grows a 'undefined'.",
      costTokens: 800,
      changes: {
        "src/join.js": `export function joinAll(parts) {
  let out = "";
  for (let i = 0; i <= parts.length; i++) {
    out += parts[i];
  }
  return out;
}
`,
      },
    },
    {
      id: "m-correct-bound",
      description: "Loop to the length",
      costTokens: 1100,
      changes: {
        "src/join.js": `export function joinAll(parts) {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
  }
  return out;
}
`,
      },
    },
    {
      id: "m-off-by-one-down",
      description: "Stop one element earlier than the bug did",
      knownFlaw: "Drops the last two elements instead of one.",
      costTokens: 800,
      changes: {
        "src/join.js": `export function joinAll(parts) {
  let out = "";
  for (let i = 0; i < parts.length - 2; i++) {
    out += parts[i];
  }
  return out;
}
`,
      },
    },
  ],
  readable: ["src/join.js", "test/join.local.js", "test/join.oracle.js"],
  searchable: [{ pattern: "length - 1", matches: ["src/join.js:3:  for (let i = 0; i < parts.length - 1; i++) {"] }],
  costModel: base({ verify: { tokens: 1800, latencyMs: 2400 } }),
  budget: { maxSteps: 8, maxTokens: 16_000 },
}

const b3Head: BenchTask = {
  id: "B-m7-3-two-correct-edits",
  name: "Two equally correct fixes, and a cheap oracle",
  family: "B-trivial",
  description:
    "head() returns undefined for an empty string. Two different edits are both correct, and the oracle is cheap.",
  files: {
    "src/head.js": `export function head(text) {
  return text[0];
}
`,
    "test/head.local.js": `import { head } from "../src/head.js";
const ok = head("abc") === "a" && head("") === "";
console.log(ok ? "PASS head" : "FAIL head");
process.exit(ok ? 0 : 1);
`,
    "test/head.oracle.js":
      header(`import { head } from "../src/head.js"`) +
      `check("one char", head("abc"), "a");
check("empty returns empty string", head(""), "");
check("single char", head("z"), "z");
` +
      tail,
    "package.json": pkg("m7-b3"),
  },
  testCommand: "node test/head.local.js",
  verifyCommand: "node test/head.oracle.js",
  mutations: [
    {
      id: "m-nullish",
      description: "Fall back to the empty string with a nullish coalesce",
      costTokens: 800,
      changes: {
        "src/head.js": `export function head(text) {
  return text[0] ?? "";
}
`,
      },
    },
    {
      id: "m-returns-undefined",
      description: "Return undefined explicitly on the empty string",
      knownFlaw: "The contract asks for the empty string, so this is a new failure rather than a fix.",
      costTokens: 800,
      changes: {
        "src/head.js": `export function head(text) {
  if (text.length === 0) return undefined;
  return text[0];
}
`,
      },
    },
    {
      id: "m-charat",
      description: "Use charAt, which already returns an empty string",
      costTokens: 900,
      changes: {
        "src/head.js": `export function head(text) {
  return text.charAt(0);
}
`,
      },
    },
  ],
  readable: ["src/head.js", "test/head.local.js", "test/head.oracle.js"],
  searchable: [{ pattern: "text[0]", matches: ["src/head.js:2:  return text[0];"] }],
  costModel: base({ verify: { tokens: 600, latencyMs: 1000 } }),
  budget: { maxSteps: 8, maxTokens: 16_000 },
}

// =============================================================================================
// Family C: competing hypotheses. The correct edit is not always first, and the count grows.
// =============================================================================================

const c1Truncate: BenchTask = {
  id: "C-m7-1-two-candidates",
  name: "Two candidate fixes for a truncation bug",
  family: "C-competing-hypotheses",
  description:
    "truncate() cuts mid-word where the contract says whole words. Two fixes are plausible and one is right.",
  files: {
    "src/truncate.js": `export function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}
`,
    "test/truncate.local.js": `import { truncate } from "../src/truncate.js";
const ok = truncate("hello brave world", 12) === "hello brave";
console.log(ok ? "PASS boundary" : "FAIL boundary");
process.exit(ok ? 0 : 1);
`,
    "test/truncate.oracle.js":
      header(`import { truncate } from "../src/truncate.js"`) +
      `check("fits", truncate("hello world", 11), "hello world");
check("breaks on a word boundary", truncate("hello brave world", 12), "hello brave");
check("already short", truncate("hi", 10), "hi");
check("no ellipsis is added", truncate("hello brave world", 12).length, 11);
check("a single word is cut at the limit", truncate("abcdef", 3), "abc");
` +
      tail,
    "package.json": pkg("m7-c1"),
  },
  testCommand: "node test/truncate.local.js",
  verifyCommand: "node test/truncate.oracle.js",
  mutations: [
    {
      id: "m-hard-cut-with-ellipsis",
      description: "Cut at the limit and mark it with an ellipsis, which is what readers expect",
      knownFlaw: "Adds an ellipsis, which the contract forbids, and still cuts mid-word.",
      costTokens: 900,
      changes: {
        "src/truncate.js": `export function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "...";
}
`,
      },
    },
    {
      id: "m-word-boundary",
      description: "Cut back to the last whole word",
      costTokens: 1300,
      changes: {
        "src/truncate.js": `export function truncate(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace <= 0 ? cut : cut.slice(0, lastSpace);
}
`,
      },
    },
  ],
  readable: ["src/truncate.js", "test/truncate.local.js", "test/truncate.oracle.js"],
  searchable: [{ pattern: "slice", matches: ["src/truncate.js:3:  return text.slice(0, limit);"] }],
  costModel: base(),
  budget: { maxSteps: 8, maxTokens: 18_000 },
}

const c2Chunk: BenchTask = {
  id: "C-m7-2-three-candidates",
  name: "Three candidate fixes for a batching bug",
  family: "C-competing-hypotheses",
  description: "chunk() drops the final partial batch. Three fixes are available and two are wrong.",
  files: {
    "src/chunk.js": `export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  if (out.length > 0 && out[out.length - 1].length < size) out.pop();
  return out;
}
`,
    "test/chunk.local.js": `import { chunk } from "../src/chunk.js";
const ok = JSON.stringify(chunk([1, 2, 3], 2)) === "[[1,2],[3]]";
console.log(ok ? "PASS partial" : "FAIL partial");
process.exit(ok ? 0 : 1);
`,
    "test/chunk.oracle.js":
      header(`import { chunk } from "../src/chunk.js"`) +
      `check("even split", chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
check("keeps the partial batch", chunk([1, 2, 3], 2), [[1, 2], [3]]);
check("exact multiple", chunk([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
check("empty input", chunk([], 2), []);
check("size larger than input", chunk([1], 5), [[1]]);
` +
      tail,
    "package.json": pkg("m7-c2"),
  },
  testCommand: "node test/chunk.local.js",
  verifyCommand: "node test/chunk.oracle.js",
  mutations: [
    {
      id: "m-correct-chunk",
      description: "Drop the post-processing and let the loop emit the tail",
      costTokens: 1200,
      changes: {
        "src/chunk.js": `export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}
`,
      },
    },
    {
      id: "m-drops-partial",
      description: "Filter out any batch that is not full",
      knownFlaw: "Loses the tail of every input whose length is not a multiple of the size.",
      costTokens: 900,
      changes: {
        "src/chunk.js": `export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out.filter((batch) => batch.length === size);
}
`,
      },
    },
    {
      id: "m-pads-tail",
      description: "Pad the final batch so every batch is full",
      knownFlaw: "Invents elements that were never in the input.",
      costTokens: 1000,
      changes: {
        "src/chunk.js": `export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    while (batch.length < size) batch.push(null);
    out.push(batch);
  }
  return out;
}
`,
      },
    },
  ],
  readable: ["src/chunk.js", "test/chunk.local.js", "test/chunk.oracle.js"],
  searchable: [{ pattern: "out.pop", matches: ["src/chunk.js:6:  if (out.length > 0 && out[out.length - 1].length < size) out.pop();"] }],
  costModel: base(),
  budget: { maxSteps: 10, maxTokens: 20_000 },
}

const c3Merge: BenchTask = {
  id: "C-m7-3-four-candidates",
  name: "Four candidate fixes for a merge bug",
  family: "C-competing-hypotheses",
  description: "merge() keeps keys whose patch value is undefined. Four fixes are available and three are wrong.",
  files: {
    "src/merge.js": `export function merge(target, patch) {
  const out = { ...target };
  for (const key of Object.keys(patch)) {
    out[key] = patch[key];
  }
  return out;
}
`,
    "test/merge.local.js": `import { merge } from "../src/merge.js";
const out = merge({ a: 1, b: 2 }, { b: undefined });
// "b" in out, rather than a comparison of the printed object: JSON.stringify drops an
// undefined value, so printing the object cannot tell a removed key from an
// undefined one, and the whole point of this fixture is that difference.
const ok = !("b" in out) && out.a === 1;
console.log(ok ? "PASS removal" : "FAIL removal");
process.exit(ok ? 0 : 1);
`,
    "test/merge.oracle.js":
      header(`import { merge } from "../src/merge.js"`) +
      `check("adds a key", merge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
check("undefined in the patch removes the key", merge({ a: 1, b: 2 }, { b: undefined }), { a: 1 });
check("the removed key is absent, not undefined", "b" in merge({ a: 1, b: 2 }, { b: undefined }), false);
check("does not mutate the target", (() => { const t = { a: 1 }; merge(t, { b: 2 }); return t; })(), { a: 1 });
check("null is a value, not a removal", merge({ a: 1 }, { a: null }), { a: null });
check("false is a value, not a removal", merge({ a: 1 }, { a: false }), { a: false });
` +
      tail,
    "package.json": pkg("m7-c3"),
  },
  testCommand: "node test/merge.local.js",
  verifyCommand: "node test/merge.oracle.js",
  mutations: [
    {
      id: "m-skips-undefined",
      description: "Skip undefined values rather than applying them",
      knownFlaw: "Leaves the target's own value where the patch asked for a removal.",
      costTokens: 1000,
      changes: {
        "src/merge.js": `export function merge(target, patch) {
  const out = { ...target };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue;
    out[key] = patch[key];
  }
  return out;
}
`,
      },
    },
    {
      id: "m-correct-merge",
      description: "Copy first, then delete on undefined, and leave null alone",
      costTokens: 1400,
      changes: {
        "src/merge.js": `export function merge(target, patch) {
  const out = { ...target };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) {
      delete out[key];
      continue;
    }
    out[key] = patch[key];
  }
  return out;
}
`,
      },
    },
    {
      id: "m-deletes-on-null",
      description: "Treat null as a removal too, which reads as tidying up",
      knownFlaw: "Null is a legitimate value here and the oracle stores one.",
      costTokens: 1000,
      changes: {
        "src/merge.js": `export function merge(target, patch) {
  const out = { ...target };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) {
      delete out[key];
      continue;
    }
    if (patch[key] === null) {
      delete out[key];
      continue;
    }
    out[key] = patch[key];
  }
  return out;
}
`,
      },
    },
    {
      id: "m-mutates-target",
      description: "Assign onto the target in place",
      knownFlaw: "Mutates the caller's object, which the oracle checks.",
      costTokens: 1100,
      changes: {
        "src/merge.js": `export function merge(target, patch) {
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) {
      delete target[key];
      continue;
    }
    target[key] = patch[key];
  }
  return target;
}
`,
      },
    },
  ],
  readable: ["src/merge.js", "test/merge.local.js", "test/merge.oracle.js"],
  searchable: [{ pattern: "delete", matches: ["src/merge.js:5:    out[key] = patch[key];"] }],
  costModel: base(),
  budget: { maxSteps: 12, maxTokens: 24_000 },
}

// =============================================================================================
// Family D: the cheap test passes on a wrong fix. Three different mechanisms, none of them a
// truthiness trap, because three truthiness traps would be one trap three times.
// =============================================================================================

const d1ToInt: BenchTask = {
  id: "D-m7-1-prefix-parse",
  name: "Loose parsing passes the reported case",
  family: "D-misleading-local-signal",
  description:
    "toInt() answers null for every input. A prefix-parsing fix satisfies the local check and still accepts trailing garbage.",
  files: {
    "src/toint.js": `export function toInt(text) {
  return null;
}
`,
    "test/toint.local.js": `import { toInt } from "../src/toint.js";
// The reported case only.
const ok = toInt("42") === 42;
console.log(ok ? "PASS reported" : "FAIL reported");
process.exit(ok ? 0 : 1);
`,
    "test/toint.oracle.js":
      header(`import { toInt } from "../src/toint.js"`) +
      `check("digits", toInt("42"), 42);
check("rejects trailing garbage", toInt("42abc"), null);
check("rejects empty", toInt(""), null);
check("rejects a decimal point", toInt("4.2"), null);
check("rejects a sign", toInt("-42"), null);
check("rejects surrounding whitespace", toInt(" 42"), null);
` +
      tail,
    "package.json": pkg("m7-d1"),
  },
  testCommand: "node test/toint.local.js",
  verifyCommand: "node test/toint.oracle.js",
  mutations: [
    {
      id: "m-loose-parse",
      description: "Parse the leading digits, which satisfies the local check",
      knownFlaw: "Accepts trailing garbage, a decimal point, a sign and padding whitespace.",
      costTokens: 900,
      changes: {
        "src/toint.js": `export function toInt(text) {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? null : n;
}
`,
      },
    },
    {
      id: "m-coerce",
      description: "Coerce with Number and truncate, which also satisfies the local check",
      knownFlaw: "Accepts a decimal point and padding whitespace.",
      costTokens: 800,
      changes: {
        "src/toint.js": `export function toInt(text) {
  const n = Number(text);
  return Number.isNaN(n) ? null : Math.trunc(n);
}
`,
      },
    },
    {
      id: "m-strict-digits",
      description: "Accept only a string of digits",
      costTokens: 1300,
      changes: {
        "src/toint.js": `export function toInt(text) {
  if (typeof text !== "string" || !/^\\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}
`,
      },
    },
  ],
  readable: ["src/toint.js", "test/toint.local.js", "test/toint.oracle.js"],
  searchable: [{ pattern: "return null", matches: ["src/toint.js:2:  return null;"] }],
  costModel: base({ defectEscape: 8000 }),
  budget: { maxSteps: 10, maxTokens: 20_000 },
}

const d2FindById: BenchTask = {
  id: "D-m7-2-falsy-id",
  name: "A falsy id is not an id",
  family: "D-misleading-local-signal",
  description:
    "findById() always answers null. A loose comparison satisfies the local check and matches a string id against a numeric one.",
  files: {
    "src/find.js": `export function findById(records, id) {
  return null;
}
`,
    "test/find.local.js": `import { findById } from "../src/find.js";
// The reported case only, whose id is a number.
const ok = findById([{ id: 1, n: "a" }], 1).n === "a";
console.log(ok ? "PASS reported" : "FAIL reported");
process.exit(ok ? 0 : 1);
`,
    "test/find.oracle.js":
      header(`import { findById } from "../src/find.js"`) +
      `check("numeric id", findById([{ id: 1, n: "a" }], 1), { id: 1, n: "a" });
check("id zero is a real id", findById([{ id: 0, n: "z" }], 0), { id: 0, n: "z" });
check("the empty string is a real id", findById([{ id: "", n: "e" }], ""), { id: "", n: "e" });
check("a number does not match a string id", findById([{ id: "1", n: "s" }], 1), null);
check("missing id", findById([{ id: 1 }], 9), null);
check("empty list", findById([], 1), null);
` +
      tail,
    "package.json": pkg("m7-d2"),
  },
  testCommand: "node test/find.local.js",
  verifyCommand: "node test/find.oracle.js",
  mutations: [
    {
      id: "m-correct-find",
      description: "Compare ids strictly, so a falsy id is still an id",
      costTokens: 1200,
      changes: {
        "src/find.js": `export function findById(records, id) {
  for (const record of records) {
    if (record.id === id) return record;
  }
  return null;
}
`,
      },
    },
    {
      id: "m-loose-equality",
      description: "Compare ids loosely, which satisfies the local check",
      knownFlaw: "Matches the number 1 against the string \"1\", so a caller gets the wrong record.",
      costTokens: 1000,
      changes: {
        "src/find.js": `export function findById(records, id) {
  for (const record of records) {
    if (record.id == id) return record;
  }
  return null;
}
`,
      },
    },
    {
      id: "m-stringify",
      description: "Compare string forms, which also satisfies the local check",
      knownFlaw: "Has the same defect as a loose comparison, through a different route.",
      costTokens: 1100,
      changes: {
        "src/find.js": `export function findById(records, id) {
  for (const record of records) {
    if (String(record.id) === String(id)) return record;
  }
  return null;
}
`,
      },
    },
  ],
  readable: ["src/find.js", "test/find.local.js", "test/find.oracle.js"],
  searchable: [{ pattern: "for", matches: ["src/find.js:2:  return null;"] }],
  costModel: base({ defectEscape: 7000, verify: { tokens: 700, latencyMs: 1600 } }),
  budget: { maxSteps: 10, maxTokens: 20_000 },
}

const d3ReadJson: BenchTask = {
  id: "D-m7-3-empty-on-error",
  name: "Invalid JSON becomes an empty object",
  family: "D-misleading-local-signal",
  description:
    "readJson() throws on malformed input. A catch-all returning an empty object satisfies the local check and hands the caller a plausible empty document.",
  files: {
    "src/readjson.js": `export function readJson(text) {
  return JSON.parse(text);
}
`,
    "test/readjson.local.js": `import { readJson } from "../src/readjson.js";
// The valid case only.
const ok = readJson('{"a":1}').a === 1;
console.log(ok ? "PASS valid" : "FAIL valid");
process.exit(ok ? 0 : 1);
`,
    "test/readjson.oracle.js":
      header(`import { readJson } from "../src/readjson.js"`) +
      `check("valid object", readJson('{"a":1}'), { a: 1 });
check("malformed input is null", readJson("{oops"), null);
check("empty input is null", readJson(""), null);
check("json null is a value", readJson("null"), null);
check("json false is a value", readJson("false"), false);
check("does not throw on malformed input", (() => { try { readJson("{oops"); return "no-throw"; } catch { return "threw"; } })(), "no-throw");
` +
      tail,
    "package.json": pkg("m7-d3"),
  },
  testCommand: "node test/readjson.local.js",
  verifyCommand: "node test/readjson.oracle.js",
  mutations: [
    {
      id: "m-catch-empty",
      description: "Swallow the parse error and return an empty object, which satisfies the local check",
      knownFlaw: "Turns malformed input into a plausible empty document, so a caller cannot tell a failure from an empty result.",
      costTokens: 900,
      changes: {
        "src/readjson.js": `export function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
`,
      },
    },
    {
      id: "m-falsy-default",
      description: "Swallow the parse error and return false, which also satisfies the local check",
      knownFlaw: "Returns false where the contract says null, which the oracle distinguishes.",
      costTokens: 1000,
      changes: {
        "src/readjson.js": `export function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return false;
  }
}
`,
      },
    },
    {
      id: "m-null-on-error",
      description: "Swallow the parse error and return null",
      costTokens: 1200,
      changes: {
        "src/readjson.js": `export function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
`,
      },
    },
  ],
  readable: ["src/readjson.js", "test/readjson.local.js", "test/readjson.oracle.js"],
  searchable: [{ pattern: "JSON.parse", matches: ["src/readjson.js:2:  return JSON.parse(text);"] }],
  costModel: base({ defectEscape: 12_000, verify: { tokens: 1500, latencyMs: 2200 } }),
  budget: { maxSteps: 10, maxTokens: 20_000 },
}

// =============================================================================================
// Family E: the oracle is correct and priced. E1 is the case where buying the oracle after a
// green cheap test is pure waste, because the cheap test already rejects the wrong fix.
// =============================================================================================

const e1BuildMeta: BenchTask = {
  id: "E-m7-1-oracle-4x-caught-locally",
  name: "Oracle at 4x the local test, and the local test is enough",
  family: "E-expensive-verifier",
  description:
    "Two declarations are wrong. The oracle costs four times the local test, and the local test already rejects the plausible wrong fix, so the oracle only confirms what is known.",
  files: {
    "src/build.js": `export const BUILD = 1;
export const CHANNEL = "dev";
export function label() {
  return "ok";
}
`,
    "test/build.local.js": `import { BUILD, CHANNEL, label } from "../src/build.js";
const out = [];
const check = (n, a, e) => { const r = a === e; out.push((r ? "PASS " : "FAIL ") + n); };
// The local test knows every value the contract mentions.
check("build", BUILD, 2);
check("channel", CHANNEL, "prod");
check("label", label(), "ok");
console.log(out.join("\\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
`,
    "test/build.oracle.js":
      header(`import { BUILD, CHANNEL, label } from "../src/build.js"`) +
      `check("build", BUILD, 2);
check("channel", CHANNEL, "prod");
check("label", label(), "ok");
check("label is stable across calls", label(), label());
check("nothing is exported beyond the three", Object.keys(await import("../src/build.js")).length, 3);
` +
      tail,
    "package.json": pkg("m7-e1"),
  },
  testCommand: "node test/build.local.js",
  verifyCommand: "node test/build.oracle.js",
  mutations: [
    {
      id: "m-both-declarations",
      description: "Correct both declarations",
      costTokens: 1300,
      changes: {
        "src/build.js": `export const BUILD = 2;
export const CHANNEL = "prod";
export function label() {
  return "ok";
}
`,
      },
    },
    {
      id: "m-build-only",
      description: "Bump the build number only, which is the tempting half-fix",
      knownFlaw: "Leaves the channel wrong, which the local test also catches.",
      costTokens: 900,
      changes: {
        "src/build.js": `export const BUILD = 2;
export const CHANNEL = "dev";
export function label() {
  return "ok";
}
`,
      },
    },
  ],
  readable: ["src/build.js", "test/build.local.js", "test/build.oracle.js"],
  searchable: [
    { pattern: "export const", matches: ["src/build.js:1:export const BUILD = 1;", "src/build.js:2:export const CHANNEL = \"dev\";"] },
  ],
  costModel: base({
    verify: { tokens: 480, latencyMs: 1400 },
    test: { tokens: 120, latencyMs: 350 },
    defectEscape: 2500,
    success: 12_000,
  }),
  budget: { maxSteps: 8, maxTokens: 16_000 },
}

const e2Throttle: BenchTask = {
  id: "E-m7-2-oracle-12x",
  name: "Oracle at 12x the local test, and the local test is fooled",
  family: "E-expensive-verifier",
  description:
    "throttle() admits every call. The oracle costs twelve times the local test, and a count-only fix passes the local check while never consulting the window.",
  files: {
    "src/throttle.js": `export function throttle(state, now) {
  return { allowed: true, count: state.count + 1 };
}
`,
    "test/throttle.local.js": `import { throttle } from "../src/throttle.js";
// The reported case: a third call inside one window.
const ok = throttle({ count: 2, windowStart: 0, limit: 2 }, 100).allowed === false;
console.log(ok ? "PASS refuses" : "FAIL refuses");
process.exit(ok ? 0 : 1);
`,
    "test/throttle.oracle.js":
      header(`import { throttle } from "../src/throttle.js"`) +
      `const s = (count, windowStart) => ({ count, windowStart, limit: 2 });
check("first call in a fresh window is allowed", throttle(s(0, 0), 100).allowed, true);
check("second call is allowed", throttle(s(1, 0), 100).allowed, true);
check("third call in the same window is refused", throttle(s(2, 0), 100).allowed, false);
check("a new window resets the count", throttle(s(2, 0), 5000).allowed, true);
check("a refusal does not advance the count", throttle(s(2, 0), 100).count, 2);
` +
      tail,
    "package.json": pkg("m7-e2"),
  },
  testCommand: "node test/throttle.local.js",
  verifyCommand: "node test/throttle.oracle.js",
  mutations: [
    {
      id: "m-correct-window",
      description: "Reset on a new window and refuse past the limit",
      costTokens: 1500,
      changes: {
        "src/throttle.js": `export function throttle(state, now) {
  const inWindow = now - state.windowStart < 1000;
  const count = inWindow ? state.count : 0;
  if (count >= state.limit) return { allowed: false, count };
  return { allowed: true, count: count + 1, windowStart: inWindow ? state.windowStart : now };
}
`,
      },
    },
    {
      id: "m-counts-only",
      description: "Compare the count to the limit, which satisfies the local check",
      knownFlaw: "Never consults the window, so an old count refuses a call in a new window.",
      costTokens: 1000,
      changes: {
        "src/throttle.js": `export function throttle(state, now) {
  if (state.count >= state.limit) return { allowed: false, count: state.count };
  return { allowed: true, count: state.count + 1 };
}
`,
      },
    },
    {
      id: "m-resets-always",
      description: "Reset the count on every call, which the local test rejects",
      knownFlaw: "Never refuses anything, because the count is always zero when it is read.",
      costTokens: 1000,
      changes: {
        "src/throttle.js": `export function throttle(state, now) {
  return { allowed: true, count: 1, windowStart: now };
}
`,
      },
    },
  ],
  readable: ["src/throttle.js", "test/throttle.local.js", "test/throttle.oracle.js"],
  searchable: [{ pattern: "allowed", matches: ["src/throttle.js:2:  return { allowed: true, count: state.count + 1 };"] }],
  costModel: base({
    verify: { tokens: 1440, latencyMs: 2600 },
    test: { tokens: 120, latencyMs: 350 },
    defectEscape: 6000,
    success: 16_000,
  }),
  budget: { maxSteps: 10, maxTokens: 24_000 },
}

const e3Bucket: BenchTask = {
  id: "E-m7-3-oracle-25x",
  name: "Oracle at 25x the local test, one wrong fix caught locally and one not",
  family: "E-expensive-verifier",
  description:
    "bucket() is off by one bucket. The oracle costs twenty-five times the local test. A rounding fix is rejected by the local test, a ceiling fix is not, and only the oracle separates them.",
  files: {
    "src/bucket.js": `export function bucket(size, value) {
  return Math.min(size - 1, Math.floor(value / size));
}
`,
    "test/bucket.local.js": `import { bucket } from "../src/bucket.js";
// The reported case, well inside a bucket, and one past the last one.
const ok = bucket(10, 25) === 2 && bucket(10, 100) === 10;
console.log(ok ? "PASS buckets" : "FAIL buckets");
process.exit(ok ? 0 : 1);
`,
    "test/bucket.oracle.js":
      header(`import { bucket } from "../src/bucket.js"`) +
      `check("inside a bucket", bucket(10, 25), 2);
check("zero starts the first bucket", bucket(10, 0), 0);
check("a boundary starts the next bucket", bucket(10, 10), 1);
check("just below a boundary", bucket(10, 9), 0);
check("exact multiple", bucket(10, 30), 3);
check("past the last bucket", bucket(10, 100), 10);
check("a negative value floors below zero", bucket(10, -1), -1);
` +
      tail,
    "package.json": pkg("m7-e3"),
  },
  testCommand: "node test/bucket.local.js",
  verifyCommand: "node test/bucket.oracle.js",
  mutations: [
    {
      id: "m-rounds",
      description: "Round instead of floor, which the local test rejects",
      knownFlaw: "Puts 25 in bucket 3, so half of every bucket boundary is wrong.",
      costTokens: 1000,
      changes: {
        "src/bucket.js": `export function bucket(size, value) {
  return Math.round(value / size);
}
`,
      },
    },
    {
      id: "m-ceiling-minus-one",
      description: "Use a ceiling minus one, which is the other natural reading",
      knownFlaw: "Puts a value on a boundary in the previous bucket, and 0 in bucket -1.",
      costTokens: 1100,
      changes: {
        "src/bucket.js": `export function bucket(size, value) {
  return Math.ceil(value / size) - 1;
}
`,
      },
    },
    {
      id: "m-correct-bucket",
      description: "Floor, and let the boundaries fall where the floor puts them",
      costTokens: 1300,
      changes: {
        "src/bucket.js": `export function bucket(size, value) {
  return Math.floor(value / size);
}
`,
      },
    },
  ],
  readable: ["src/bucket.js", "test/bucket.local.js", "test/bucket.oracle.js"],
  searchable: [{ pattern: "Math.min", matches: ["src/bucket.js:2:  return Math.min(size - 1, Math.floor(value / size));"] }],
  costModel: base({
    verify: { tokens: 3000, latencyMs: 4200 },
    test: { tokens: 120, latencyMs: 350 },
    defectEscape: 9000,
    success: 20_000,
  }),
  budget: { maxSteps: 10, maxTokens: 30_000 },
}

// =============================================================================================
// Family F: the same bug at three oracle prices, from twenty times an edit to a fifth of one.
// =============================================================================================

const f1ApplyDefaults: BenchTask = {
  id: "F-m7-1-oracle-20x-edit",
  name: "Oracle at twenty times an edit",
  family: "F-cheap-verifier",
  description:
    "applyDefaults() lets the defaults overwrite the caller. The oracle costs twenty times an edit, so checking between attempts is the expensive move.",
  files: {
    "src/defaults.js": `export const DEFAULTS = { retries: 3, timeoutMs: 1000 };

export function applyDefaults(config) {
  return { ...config, ...DEFAULTS };
}
`,
    "test/defaults.local.js": `import { applyDefaults } from "../src/defaults.js";
const ok = applyDefaults({ retries: 5 }).retries === 5;
console.log(ok ? "PASS caller wins" : "FAIL caller wins");
process.exit(ok ? 0 : 1);
`,
    "test/defaults.oracle.js":
      header(`import { applyDefaults, DEFAULTS } from "../src/defaults.js"`) +
      `check("a caller value wins", applyDefaults({ retries: 5 }).retries, 5);
check("an absent value falls back to the default", applyDefaults({}).retries, 3);
check("an explicit undefined does not resurrect the default", applyDefaults({ retries: undefined }).retries, 3);
check("an explicit null is a value", applyDefaults({ retries: null }).retries, null);
check("defaults are untouched", DEFAULTS.retries, 3);
check("an unknown key survives", applyDefaults({ custom: 1 }).custom, 1);
` +
      tail,
    "package.json": pkg("m7-f1"),
  },
  testCommand: "node test/defaults.local.js",
  verifyCommand: "node test/defaults.oracle.js",
  mutations: [
    {
      id: "m-assign-both-ways",
      description: "Assign the defaults after the config, which the local test rejects",
      knownFlaw: "The original bug: the defaults overwrite every caller value.",
      costTokens: 1000,
      changes: {
        "src/defaults.js": `export const DEFAULTS = { retries: 3, timeoutMs: 1000 };

export function applyDefaults(config) {
  return Object.assign({}, config, DEFAULTS);
}
`,
      },
    },
    {
      id: "m-assign-defaults-first",
      description: "Assign the defaults first, which satisfies the local check",
      knownFlaw:
        "Treats an explicit undefined as absent, so the default comes back and the caller cannot unset a default.",
      costTokens: 1200,
      changes: {
        "src/defaults.js": `export const DEFAULTS = { retries: 3, timeoutMs: 1000 };

export function applyDefaults(config) {
  return Object.assign({}, DEFAULTS, config);
}
`,
      },
    },
    {
      id: "m-correct-defaults",
      description: "Drop only the undefined keys, then assign",
      costTokens: 1400,
      changes: {
        "src/defaults.js": `export const DEFAULTS = { retries: 3, timeoutMs: 1000 };

export function applyDefaults(config) {
  const defined = {};
  for (const key of Object.keys(config)) {
    if (config[key] !== undefined) defined[key] = config[key];
  }
  return Object.assign({}, DEFAULTS, defined);
}
`,
      },
    },
  ],
  readable: ["src/defaults.js", "test/defaults.local.js", "test/defaults.oracle.js"],
  searchable: [{ pattern: "DEFAULTS", matches: ["src/defaults.js:1:export const DEFAULTS = { retries: 3, timeoutMs: 1000 };"] }],
  costModel: base({
    // The oracle is twenty times an edit. This is the regime where checking between
    // attempts is the expensive move rather than the safe one.
    verify: { tokens: 18_000, latencyMs: 6000 },
    test: { tokens: 150, latencyMs: 400 },
    defectEscape: 3000,
    success: 14_000,
  }),
  budget: { maxSteps: 10, maxTokens: 34_000 },
}

const f2ClampAll: BenchTask = {
  id: "F-m7-2-oracle-1x-edit",
  name: "Oracle at the price of an edit",
  family: "F-cheap-verifier",
  description: "clampAll() clamps only the first element. The oracle costs about what an edit costs.",
  files: {
    "src/clampall.js": `export function clampAll(values, lo, hi) {
  return [Math.min(hi, Math.max(lo, values[0])), ...values.slice(1)];
}
`,
    "test/clampall.local.js": `import { clampAll } from "../src/clampall.js";
const ok = clampAll([5, 99], 0, 10).join(",") === "5,10";
console.log(ok ? "PASS mixed" : "FAIL mixed");
process.exit(ok ? 0 : 1);
`,
    "test/clampall.oracle.js":
      header(`import { clampAll } from "../src/clampall.js"`) +
      `check("clamps every element", clampAll([5, 99, 200], 0, 10), [5, 10, 10]);
check("leaves values inside the range", clampAll([1, 2, 3], 0, 10), [1, 2, 3]);
check("clamps the low end", clampAll([-1, 2, 3], 0, 10), [0, 2, 3]);
check("empty", clampAll([], 0, 10), []);
check("does not mutate the input", (() => { const v = [5, 99]; clampAll(v, 0, 10); return v; })(), [5, 99]);
` +
      tail,
    "package.json": pkg("m7-f2"),
  },
  testCommand: "node test/clampall.local.js",
  verifyCommand: "node test/clampall.oracle.js",
  mutations: [
    {
      id: "m-correct-map",
      description: "Map over every element into a new array",
      costTokens: 1200,
      changes: {
        "src/clampall.js": `export function clampAll(values, lo, hi) {
  return values.map((v) => Math.min(hi, Math.max(lo, v)));
}
`,
      },
    },
    {
      id: "m-first-two",
      description: "Clamp the first two elements, which satisfies the local check",
      knownFlaw: "Leaves every element from the third onwards unclamped.",
      costTokens: 1000,
      changes: {
        "src/clampall.js": `export function clampAll(values, lo, hi) {
  return [0, 1].map((i) => Math.min(hi, Math.max(lo, values[i]))).concat(values.slice(2));
}
`,
      },
    },
    {
      id: "m-in-place",
      description: "Clamp in place, which also satisfies the local check",
      knownFlaw: "Mutates the caller's array, which the oracle checks.",
      costTokens: 1100,
      changes: {
        "src/clampall.js": `export function clampAll(values, lo, hi) {
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.min(hi, Math.max(lo, values[i]));
  }
  return values;
}
`,
      },
    },
  ],
  readable: ["src/clampall.js", "test/clampall.local.js", "test/clampall.oracle.js"],
  searchable: [{ pattern: "slice(1)", matches: ["src/clampall.js:2:  return [Math.min(hi, Math.max(lo, values[0])), ...values.slice(1)];"] }],
  costModel: base({
    verify: { tokens: 900, latencyMs: 1400 },
    test: { tokens: 150, latencyMs: 400 },
    defectEscape: 5000,
  }),
  budget: { maxSteps: 10, maxTokens: 22_000 },
}

const f3NormalizeTag: BenchTask = {
  id: "F-m7-3-oracle-free",
  name: "Oracle at a fifth of an edit",
  family: "F-cheap-verifier",
  description:
    "normalizeTag() leaves the tag exactly as given. The oracle costs a fifth of an edit, so there is no reason to skip it.",
  files: {
    "src/tag.js": `export function normalizeTag(tag) {
  return tag;
}
`,
    "test/tag.local.js": `import { normalizeTag } from "../src/tag.js";
// The reported case, a padded tag.
const ok = normalizeTag("  Node  ") === "node";
console.log(ok ? "PASS normalized" : "FAIL normalized");
process.exit(ok ? 0 : 1);
`,
    "test/tag.oracle.js":
      header(`import { normalizeTag } from "../src/tag.js"`) +
      `check("trims and lowercases", normalizeTag("  Node  "), "node");
check("collapses inner runs", normalizeTag("a   b"), "a b");
check("already normalized is unchanged", normalizeTag("node"), "node");
check("whitespace only becomes empty", normalizeTag("   "), "");
check("tabs collapse like spaces", normalizeTag("a\\tb"), "a b");
` +
      tail,
    "package.json": pkg("m7-f3"),
  },
  testCommand: "node test/tag.local.js",
  verifyCommand: "node test/tag.oracle.js",
  mutations: [
    {
      id: "m-trim-only",
      description: "Trim only, which satisfies the local check on the reported case",
      knownFlaw: "Never lowercases and never collapses inner runs.",
      costTokens: 1000,
      changes: {
        "src/tag.js": `export function normalizeTag(tag) {
  return tag.trim();
}
`,
      },
    },
    {
      id: "m-lower-only",
      description: "Lowercase only, which also satisfies the local check on the reported case",
      knownFlaw: "Never trims, so a padded tag is returned padded.",
      costTokens: 1000,
      changes: {
        "src/tag.js": `export function normalizeTag(tag) {
  return tag.toLowerCase();
}
`,
      },
    },
    {
      id: "m-correct-normalize",
      description: "Trim, lowercase, then collapse inner whitespace",
      costTokens: 1300,
      changes: {
        "src/tag.js": `export function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\\s+/g, " ");
}
`,
      },
    },
  ],
  readable: ["src/tag.js", "test/tag.local.js", "test/tag.oracle.js"],
  searchable: [{ pattern: "return tag", matches: ["src/tag.js:2:  return tag;"] }],
  costModel: base({
    // A fifth of an edit. Skipping the oracle saves nothing and risks a defect priced far
    // above it, so frequent verification is the rational move here.
    verify: { tokens: 180, latencyMs: 60 },
    test: { tokens: 180, latencyMs: 60 },
    defectEscape: 6000,
  }),
  budget: { maxSteps: 8, maxTokens: 16_000 },
}

// =============================================================================================
// Family G: the binding rule is not in the failing file.
// =============================================================================================

const g1LabelFor: BenchTask = {
  id: "G-m7-1-rule-in-a-sibling",
  name: "The rule is in the sibling module",
  family: "G-information-before-action",
  description:
    "labelFor() throws on a missing record. The contract forbids throwing and says so in a file the failing module never imports.",
  files: {
    "src/label.js": `export function labelFor(record) {
  if (!record) throw new Error("no record");
  return record.name;
}
`,
    "src/records-contract.js": `// Contract for the record helpers. Consumers depend on this file.
// - labelFor() MUST return "unknown" when the record is missing.
// - labelFor() MUST NOT throw.
// The oracle enforces both, and neither is repeated in label.js.
export const RECORDS_CONTRACT = "records/v2";
`,
    "test/label.local.js": `import { labelFor } from "../src/label.js";
let ok = labelFor({ name: "a" }) === "a";
try {
  ok = ok && labelFor(null) === "unknown";
} catch {
  ok = false;
}
console.log(ok ? "PASS label" : "FAIL label");
process.exit(ok ? 0 : 1);
`,
    "test/label.oracle.js":
      header(`import { labelFor } from "../src/label.js";
import { RECORDS_CONTRACT } from "../src/records-contract.js"`) +
      `check("contract is v2", RECORDS_CONTRACT, "records/v2");
check("present record", labelFor({ name: "a" }), "a");
check("missing record returns unknown", labelFor(null), "unknown");
check("undefined record returns unknown", labelFor(undefined), "unknown");
check("does not throw on a missing record", (() => { try { labelFor(null); return "no-throw"; } catch { return "threw"; } })(), "no-throw");
` +
      tail,
    "package.json": pkg("m7-g1"),
  },
  testCommand: "node test/label.local.js",
  verifyCommand: "node test/label.oracle.js",
  mutations: [
    {
      id: "m-typed-error",
      description: "Keep throwing, but with a better message",
      knownFlaw: "Violates the contract in the sibling file, which the oracle reads.",
      costTokens: 900,
      changes: {
        "src/label.js": `export function labelFor(record) {
  if (!record) throw new TypeError("labelFor: record is required");
  return record.name;
}
`,
      },
    },
    {
      id: "m-correct-unknown",
      description: "Return the contract's sentinel instead of throwing",
      costTokens: 1100,
      changes: {
        "src/label.js": `export function labelFor(record) {
  if (!record) return "unknown";
  return record.name;
}
`,
      },
    },
  ],
  readable: ["src/label.js", "src/records-contract.js", "test/label.local.js", "test/label.oracle.js"],
  searchable: [
    {
      pattern: "MUST",
      matches: [
        "src/records-contract.js:3:// - labelFor() MUST return \"unknown\" when the record is missing.",
        "src/records-contract.js:4:// - labelFor() MUST NOT throw.",
      ],
    },
  ],
  costModel: base(),
  budget: { maxSteps: 8, maxTokens: 18_000 },
}

const g2WithRetry: BenchTask = {
  id: "G-m7-2-rule-in-a-config-file",
  name: "The limit lives in a config module",
  family: "G-information-before-action",
  description:
    "withRetry() gives up after one attempt. The attempt limit is declared in a config module the implementation is expected to honour and never reads.",
  files: {
    "src/retry.js": `import { LIMITS } from "../config/limits.js";

export function withRetry(attempt) {
  return attempt();
}
`,
    "config/limits.js": `// Deployment limits. Anything that retries MUST read this file.
export const LIMITS = {
  maxAttempts: 4,
  backoffMs: 50,
};
`,
    "test/retry.local.js": `import { withRetry } from "../src/retry.js";
let n = 0;
let ok = false;
try {
  ok = withRetry(() => {
    n++;
    if (n < 2) throw new Error("not yet");
    return "recovered";
  }) === "recovered";
} catch {
  ok = false;
}
console.log(ok ? "PASS retries" : "FAIL retries");
process.exit(ok ? 0 : 1);
`,
    "test/retry.oracle.js":
      header(`import { withRetry } from "../src/retry.js";
import { LIMITS } from "../config/limits.js"`) +
      `const run = (failures) => {
  let n = 0;
  try {
    withRetry(() => {
      n++;
      if (n <= failures) throw new Error("nope");
      return "recovered";
    });
    return { n, value: "recovered" };
  } catch {
    return { n, value: "gave-up" };
  }
};
check("config declares four attempts", LIMITS.maxAttempts, 4);
check("succeeds on the first attempt", run(0).value, "recovered");
check("recovers on the third attempt", run(2).value, "recovered");
check("gives up after exactly the configured attempts", run(9).n, 4);
` +
      tail,
    "package.json": pkg("m7-g2"),
  },
  testCommand: "node test/retry.local.js",
  verifyCommand: "node test/retry.oracle.js",
  mutations: [
    {
      id: "m-reads-config",
      description: "Read the limit from the config the module already imports",
      costTokens: 1400,
      changes: {
        "src/retry.js": `import { LIMITS } from "../config/limits.js";

export function withRetry(attempt) {
  for (let i = 0; i < LIMITS.maxAttempts; i++) {
    try {
      return attempt();
    } catch {
      if (i === LIMITS.maxAttempts - 1) throw new Error("gave up");
    }
  }
}
`,
      },
    },
    {
      id: "m-hardcoded-three",
      description: "Retry three times, which is the number most people would guess",
      knownFlaw:
        "Hard-codes a guess instead of reading the declared limit of 4, so it gives up one attempt early and would silently drift if the config changed.",
      costTokens: 1100,
      changes: {
        "src/retry.js": `import { LIMITS } from "../config/limits.js";

export function withRetry(attempt) {
  for (let i = 0; i < 3; i++) {
    try {
      return attempt();
    } catch {
      if (i === 2) throw new Error("gave up");
    }
  }
}
`,
      },
    },
  ],
  readable: ["src/retry.js", "config/limits.js", "test/retry.local.js", "test/retry.oracle.js"],
  searchable: [
    { pattern: "maxAttempts", matches: ["config/limits.js:3:  maxAttempts: 4,"] },
    { pattern: "MUST", matches: ["config/limits.js:1:// Deployment limits. Anything that retries MUST read this file."] },
  ],
  costModel: base({ verify: { tokens: 1100, latencyMs: 1800 } }),
  budget: { maxSteps: 10, maxTokens: 20_000 },
}

const g3RoundTo: BenchTask = {
  id: "G-m7-3-rule-in-a-test-comment",
  name: "The rule is only in a comment in the test",
  family: "G-information-before-action",
  description:
    "roundTo() rounds half up. The contract says half away from zero, and it is stated in a comment in the oracle file and nowhere else.",
  files: {
    "src/roundto.js": `export function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
`,
    "test/roundto.local.js": `import { roundTo } from "../src/roundto.js";
// The reported case, a negative half.
const ok = roundTo(-0.125, 2) === -0.13;
console.log(ok ? "PASS negative half" : "FAIL negative half");
process.exit(ok ? 0 : 1);
`,
    "test/roundto.oracle.js": `// The contract for this helper, in prose, and nowhere else in the repository:
//   roundTo() MUST round a half away from zero, not half up.
//   roundTo(0.5, 0) MUST be 1 and roundTo(-0.5, 0) MUST be -1.
//   roundTo(2.5, 0) MUST be 3, which rules out rounding half down.
import { roundTo } from "../src/roundto.js";
const out = [];
const check = (n, a, e) => { const r = Object.is(a, e) || JSON.stringify(a) === JSON.stringify(e); out.push((r ? "PASS " : "FAIL ") + n); };
check("rounds down below a half", roundTo(1.2345, 2), 1.23);
check("a positive half goes away from zero", roundTo(0.5, 0), 1);
check("a negative half goes away from zero", roundTo(-0.5, 0), -1);
check("two and a half goes to three", roundTo(2.5, 0), 3);
check("minus two and a half goes to minus three", roundTo(-2.5, 0), -3);
check("the reported case", roundTo(-0.125, 2), -0.13);
check("zero is unchanged", roundTo(0, 0), 0);
` + tail,
    "package.json": pkg("m7-g3"),
  },
  testCommand: "node test/roundto.local.js",
  verifyCommand: "node test/roundto.oracle.js",
  mutations: [
    {
      id: "m-shift-epsilon",
      description: "Nudge the value before rounding, which is the usual floating point remedy",
      knownFlaw:
        "Still rounds half up, so a negative half goes to zero and 2.5 goes to 2, both of which the comment forbids.",
      costTokens: 1100,
      changes: {
        "src/roundto.js": `export function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
`,
      },
    },
    {
      id: "m-toward-zero",
      description: "Truncate towards zero, which the local test rejects",
      knownFlaw: "Rounds down on both sides, so 0.5 becomes 0 rather than 1.",
      costTokens: 1000,
      changes: {
        "src/roundto.js": `export function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.trunc(value * factor) / factor;
}
`,
      },
    },
    {
      id: "m-correct-away-from-zero",
      description: "Round the magnitude and restore the sign",
      costTokens: 1400,
      changes: {
        "src/roundto.js": `export function roundTo(value, digits) {
  const factor = 10 ** digits;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * factor)) / factor;
}
`,
      },
    },
  ],
  readable: ["src/roundto.js", "test/roundto.local.js", "test/roundto.oracle.js"],
  searchable: [
    {
      pattern: "MUST",
      matches: ["test/roundto.oracle.js:2://   roundTo() MUST round a half away from zero, not half up."],
    },
  ],
  costModel: base({ verify: { tokens: 2000, latencyMs: 2800 }, defectEscape: 8000 }),
  budget: { maxSteps: 10, maxTokens: 22_000 },
}

// =============================================================================================
// Family H: an escaped defect is priced far above any verification cost.
// =============================================================================================

const h1ApplyTax: BenchTask = {
  id: "H-m7-1-escape-10x-oracle",
  name: "Escaped defect priced at ten times the oracle",
  family: "H-high-risk",
  description:
    "applyTax() adds nothing. A fix that takes the absolute value satisfies the local check and turns a refund into a charge.",
  files: {
    "src/tax.js": `export function applyTax(amount, rate) {
  return amount;
}
`,
    "test/tax.local.js": `import { applyTax } from "../src/tax.js";
// The reported case only: a positive base.
const ok = applyTax(100, 0.2) === 120;
console.log(ok ? "PASS positive" : "FAIL positive");
process.exit(ok ? 0 : 1);
`,
    "test/tax.oracle.js":
      header(`import { applyTax } from "../src/tax.js"`) +
      `check("positive base", applyTax(100, 0.2), 120);
check("negative base is taxed downwards, not upwards", applyTax(-100, 0.2), -120);
check("zero rate", applyTax(100, 0), 100);
check("full rate", applyTax(100, 1), 200);
check("zero amount", applyTax(0, 0.2), 0);
` +
      tail,
    "package.json": pkg("m7-h1"),
  },
  testCommand: "node test/tax.local.js",
  verifyCommand: "node test/tax.oracle.js",
  mutations: [
    {
      id: "m-absolute",
      description: "Add the tax and take the magnitude, which satisfies the local check",
      knownFlaw: "A negative base becomes positive, so a refund turns into a charge.",
      costTokens: 1000,
      changes: {
        "src/tax.js": `export function applyTax(amount, rate) {
  return Math.abs(amount + amount * rate);
}
`,
      },
    },
    {
      id: "m-correct-tax",
      description: "Scale by one plus the rate, which is sign-agnostic by construction",
      costTokens: 1200,
      changes: {
        "src/tax.js": `export function applyTax(amount, rate) {
  return amount * (1 + rate);
}
`,
      },
    },
  ],
  readable: ["src/tax.js", "test/tax.local.js", "test/tax.oracle.js"],
  searchable: [{ pattern: "return amount", matches: ["src/tax.js:2:  return amount;"] }],
  costModel: base({
    verify: { tokens: 1200, latencyMs: 1800 },
    test: { tokens: 120, latencyMs: 350 },
    defectEscape: 12_000,
    success: 18_000,
  }),
  budget: { maxSteps: 8, maxTokens: 20_000 },
}

const h2NextDeadline: BenchTask = {
  id: "H-m7-2-escape-40x-oracle",
  name: "Escaped defect priced at forty times the oracle",
  family: "H-high-risk",
  description:
    "nextDeadline() drops an item that is due exactly now. A fix that sorts instead of filtering satisfies the local check and returns the wrong item entirely.",
  files: {
    "src/deadline.js": `export function nextDeadline(items, now) {
  return items.filter((i) => i.due > now);
}
`,
    "test/deadline.local.js": `import { nextDeadline } from "../src/deadline.js";
// The reported case: an item due exactly now.
const ok = nextDeadline([{ due: 50 }], 50).length === 1;
console.log(ok ? "PASS boundary" : "FAIL boundary");
process.exit(ok ? 0 : 1);
`,
    "test/deadline.oracle.js":
      header(`import { nextDeadline } from "../src/deadline.js"`) +
      `check("drops items that are past", nextDeadline([{ due: 10 }, { due: 100 }], 50), [{ due: 100 }]);
check("keeps an item due exactly now", nextDeadline([{ due: 50 }], 50), [{ due: 50 }]);
check("empty", nextDeadline([], 50), []);
check("returns the caller's objects", (() => { const items = [{ due: 100 }]; return nextDeadline(items, 50)[0] === items[0]; })(), true);
check("an overdue item is never returned", nextDeadline([{ due: 1 }], 50).length, 0);
` +
      tail,
    "package.json": pkg("m7-h2"),
  },
  testCommand: "node test/deadline.local.js",
  verifyCommand: "node test/deadline.oracle.js",
  mutations: [
    {
      id: "m-shifts-now",
      description: "Add a day to now before filtering, which the local test rejects",
      knownFlaw: "Surfaces items that are up to a day overdue, which is the failure this prices.",
      costTokens: 1000,
      changes: {
        "src/deadline.js": `export function nextDeadline(items, now) {
  return items.filter((i) => i.due > now + 86400);
}
`,
      },
    },
    {
      id: "m-correct-boundary",
      description: "Keep items due at or after now, in place",
      costTokens: 1400,
      changes: {
        "src/deadline.js": `export function nextDeadline(items, now) {
  return items.filter((i) => i.due >= now);
}
`,
      },
    },
    {
      id: "m-sorts",
      description: "Sort and take the first, which satisfies the local check",
      knownFlaw: "Returns the earliest item rather than the upcoming ones, including an overdue one.",
      costTokens: 1100,
      changes: {
        "src/deadline.js": `export function nextDeadline(items, now) {
  return [...items].sort((a, b) => a.due - b.due).slice(0, 1);
}
`,
      },
    },
  ],
  readable: ["src/deadline.js", "test/deadline.local.js", "test/deadline.oracle.js"],
  searchable: [{ pattern: "filter", matches: ["src/deadline.js:2:  return items.filter((i) => i.due > now);"] }],
  costModel: base({
    verify: { tokens: 900, latencyMs: 1500 },
    test: { tokens: 120, latencyMs: 350 },
    defectEscape: 36_000,
    success: 40_000,
  }),
  budget: { maxSteps: 10, maxTokens: 24_000 },
}

const h3Convert: BenchTask = {
  id: "H-m7-3-escape-200x-oracle",
  name: "Escaped defect priced at two hundred times the oracle",
  family: "H-high-risk",
  description:
    "convert() ignores the rate table. A fix that multiplies by the destination rate alone satisfies the local check and is wrong for every other pair.",
  files: {
    "src/convert.js": `export function convert(amount, from, to, rates) {
  return amount;
}
`,
    "test/convert.local.js": `import { convert } from "../src/convert.js";
// The reported pair only.
const ok = convert(10, "EUR", "USD", { EUR: 1, USD: 2 }) === 20;
console.log(ok ? "PASS reported" : "FAIL reported");
process.exit(ok ? 0 : 1);
`,
    "test/convert.oracle.js":
      header(`import { convert } from "../src/convert.js"`) +
      `const rates = { EUR: 1, USD: 2, JPY: 0.5 };
check("reported pair", convert(10, "EUR", "USD", rates), 20);
check("the inverse pair uses the inverse rate", convert(20, "USD", "EUR", rates), 10);
check("a third currency", convert(10, "EUR", "JPY", rates), 5);
check("the same currency is the identity", convert(10, "EUR", "EUR", rates), 10);
check("zero", convert(0, "EUR", "USD", rates), 0);
` +
      tail,
    "package.json": pkg("m7-h3"),
  },
  testCommand: "node test/convert.local.js",
  verifyCommand: "node test/convert.oracle.js",
  mutations: [
    {
      id: "m-multiply-by-destination",
      description: "Multiply by the destination rate, which satisfies the local check",
      knownFlaw:
        "Ignores the source rate, so the inverse pair and every third currency come out wrong.",
      costTokens: 1000,
      changes: {
        "src/convert.js": `export function convert(amount, from, to, rates) {
  return amount * rates[to];
}
`,
      },
    },
    {
      id: "m-inverted-ratio",
      description: "Invert the ratio, which the local test rejects",
      knownFlaw: "Converts in the wrong direction wherever the rates differ.",
      costTokens: 1100,
      changes: {
        "src/convert.js": `export function convert(amount, from, to, rates) {
  if (from === to) return amount;
  return amount * (rates[from] / rates[to]);
}
`,
      },
    },
    {
      id: "m-correct-convert",
      description: "Scale by the ratio of the two rates, guarding the identity case",
      costTokens: 1300,
      changes: {
        "src/convert.js": `export function convert(amount, from, to, rates) {
  if (from === to) return amount;
  return amount * (rates[to] / rates[from]);
}
`,
      },
    },
  ],
  readable: ["src/convert.js", "test/convert.local.js", "test/convert.oracle.js"],
  searchable: [{ pattern: "rates", matches: ["src/convert.js:2:  return amount;"] }],
  costModel: base({
    verify: { tokens: 700, latencyMs: 1200 },
    test: { tokens: 120, latencyMs: 350 },
    defectEscape: 140_000,
    success: 150_000,
  }),
  budget: { maxSteps: 10, maxTokens: 24_000 },
}

/**
 * The 24, in family order. The position of the first correct edit is spread rather than
 * front-loaded, because the development corpus put it first in five fixtures out of eight,
 * which quietly rewards a policy that tries the obvious fix before it reads.
 */
export const replicationTasks: BenchTask[] = [
  a1Even,
  a2Unique,
  a3Title,
  b1Multiply,
  b2JoinAll,
  b3Head,
  c1Truncate,
  c2Chunk,
  c3Merge,
  d1ToInt,
  d2FindById,
  d3ReadJson,
  e1BuildMeta,
  e2Throttle,
  e3Bucket,
  f1ApplyDefaults,
  f2ClampAll,
  f3NormalizeTag,
  g1LabelFor,
  g2WithRetry,
  g3RoundTo,
  h1ApplyTax,
  h2NextDeadline,
  h3Convert,
]
