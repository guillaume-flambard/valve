import type { BenchTask } from "./types.js"

/**
 * Off-by-one page start in a paginate helper.
 *
 * Verified against its own oracle: the initial state fails, the tempting
 * mutation passes the reported assertion and still fails, and only the correct
 * mutation passes.
 *
 * The tempting fix shifts the start index by one instead of correcting the
 * page arithmetic. It makes the reported symptom disappear, which is precisely
 * what makes it dangerous: an agent that verifies on the reported symptom
 * declares victory over a change that dropped an item. Only the coverage
 * assertion in the fixture sees it.
 */
export const paginateTask: BenchTask = {
  id: "fix-pagination-off-by-one",
  name: "Fix off-by-one page start in paginate",
  description:
    "paginate() computes the wrong start index, so page 2 skips items. The reported failure shows page 2 returning the wrong slice of the array.",
  category: "fix-test",

  files: {
    "src/pagination.js": `export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}
`,
    "test/pagination.test.js": `import { paginate } from "../src/pagination.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log("FAIL " + name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("PASS " + name);
  }
}

const items = Array.from({ length: 25 }, (_, i) => i);

// The case from the bug report.
check("page 2 has 10 items", paginate(items, 2, 10).length, 10);

// Coverage across pages. A fix that silences the reported symptom by shifting
// the window still loses the first item, and only this catches it.
const all = [1, 2, 3].flatMap((p) => paginate(items, p, 10));
check("all pages cover every item once", all.length, 25);
check("no duplicated items", new Set(all).size, 25);
check("first item is reachable", all.includes(0), true);

if (failed > 0) {
  console.log(failed + " test(s) failed");
  process.exit(1);
}
console.log("all tests passed");
`,
    "package.json": `{
  "name": "pagination-fixture",
  "type": "module",
  "private": true
}
`,
  },

  verifyCommand: "node test/pagination.test.js",
  testCommand: "node test/pagination.test.js",

  readable: ["src/pagination.js", "test/pagination.test.js", "package.json"],

  searchable: [
    {
      pattern: "slice",
      matches: ["src/pagination.js:3:  return items.slice(start, start + pageSize);"],
    },
    {
      pattern: "start",
      matches: ["src/pagination.js:2:  const start = page * pageSize;"],
    },
  ],

  mutations: [
    {
      id: "m-tempting-shift",
      description: "Shift the start index by one to make the reported case pass",
      knownFlaw:
        "Silences the reported assertion by sliding the window, so the first item is never returned. The coverage assertion catches it.",
      costTokens: 900,
      changes: {
        "src/pagination.js": `export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize + 1;
  return items.slice(start, start + pageSize);
}
`,
      },
    },
    {
      id: "m-correct-page-math",
      description: "Compute the start index from page - 1",
      costTokens: 1400,
      changes: {
        "src/pagination.js": `export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
`,
      },
    },
    {
      id: "m-drop-bounds",
      description: "Remove the slice end bound",
      knownFlaw: "Returns everything from the start index, so interior pages are far too long.",
      costTokens: 700,
      changes: {
        "src/pagination.js": `export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return items.slice(start);
}
`,
      },
    },
  ],

  budget: { maxSteps: 10, maxTokens: 20_000 },
}

/**
 * Missing exponential backoff on a retrying HTTP client.
 *
 * Verified against its own oracle, and each mutation is confirmed to fail for
 * the reason its `knownFlaw` claims. An earlier draft of the "no backoff"
 * mutation also retried 404s, because the guard threw inside the try block and
 * its own catch swallowed the error. A fixture whose documentation disagrees
 * with its behaviour is worse than no fixture, so the flaw is asserted here
 * rather than assumed.
 */
export const retryTask: BenchTask = {
  id: "add-retry-backoff",
  name: "Add capped exponential backoff to the HTTP client",
  description:
    "The HTTP client performs no retries. Add retry with exponential backoff, capped, and do not retry 4xx responses other than 429.",
  category: "implement-feature",

  files: {
    "src/http-client.js": `export async function request(fetchImpl, url, { maxRetries = 3, retryDelay = 100 } = {}) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }
  return response.json();
}
`,
    "test/http-client.test.js": `import { request } from "../src/http-client.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log("FAIL " + name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("PASS " + name);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(statuses) {
  let call = 0;
  return async () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call++;
    return { ok: status < 400, status, json: async () => ({ ok: true }) };
  };
}

async function main() {
  // 1. Retries a 500 and eventually succeeds.
  const res = await request(fakeFetch([500, 500, 200]), "http://x", { retryDelay: 10 });
  check("eventually succeeds after retrying 5xx", res, { ok: true });

  // 2. Backoff must actually wait. Measured on the wall clock with a generous
  //    lower bound so the assertion is about ordering, not machine speed.
  let attempts = 0;
  const started = Date.now();
  const flaky = async () => {
    attempts++;
    return { ok: attempts >= 3, status: attempts >= 3 ? 200 : 503, json: async () => ({ ok: true }) };
  };
  await request(flaky, "http://x", { retryDelay: 60 }).catch(() => {});
  const elapsed = Date.now() - started;
  check("retried at least twice", attempts >= 3, true);
  check("waited between attempts", elapsed >= 100, true);

  // 3. 4xx other than 429 must not be retried: exactly one attempt.
  let fourxxAttempts = 0;
  const notFound = async () => {
    fourxxAttempts++;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await request(notFound, "http://x", { retryDelay: 10 }).catch(() => {});
  check("does not retry a 404", fourxxAttempts, 1);

  // 4. 429 is retryable, so it must be attempted more than once.
  let throttled = 0;
  const tooMany = async () => {
    throttled++;
    return { ok: throttled >= 2, status: throttled >= 2 ? 200 : 429, json: async () => ({ ok: true }) };
  };
  await request(tooMany, "http://x", { retryDelay: 10 }).catch(() => {});
  check("does retry a 429", throttled >= 2, true);

  if (failed > 0) {
    console.log(failed + " test(s) failed");
    process.exit(1);
  }
  console.log("all tests passed");
}

main().catch((error) => {
  console.log("FAIL request threw: " + error.message);
  process.exit(1);
});
`,
    "package.json": `{
  "name": "retry-fixture",
  "type": "module",
  "private": true
}
`,
  },

  verifyCommand: "node test/http-client.test.js",
  testCommand: "node test/http-client.test.js",

  readable: ["src/http-client.js", "test/http-client.test.js", "package.json"],

  searchable: [
    {
      pattern: "retry",
      matches: [
        "src/http-client.js:1: export async function request(fetchImpl, url, { maxRetries = 3, retryDelay = 100 } = {}) {",
      ],
    },
  ],

  mutations: [
    {
      id: "m-retry-no-backoff",
      description: "Retry immediately, with no delay between attempts",
      knownFlaw:
        "Satisfies the retry and 4xx assertions but never waits, so the backoff assertion fails. An early verify catches it; a late one ships a hammering client.",
      costTokens: 1100,
      changes: {
        "src/http-client.js": `export async function request(fetchImpl, url, { maxRetries = 3, retryDelay = 100 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(url);
    if (response.ok) return await response.json();
    if (response.status < 500 && response.status !== 429) {
      throw new Error("HTTP " + response.status);
    }
  }
  throw new Error("HTTP exhausted");
}
`,
      },
    },
    {
      id: "m-retry-any-4xx",
      description: "Add backoff but retry every non-ok response, 4xx included",
      knownFlaw: "Passes the backoff assertion but retries a 404, which the oracle rejects.",
      costTokens: 1300,
      changes: {
        "src/http-client.js": `export async function request(fetchImpl, url, { maxRetries = 3, retryDelay = 100 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(url);
    if (response.ok) return await response.json();
    lastError = new Error("HTTP " + response.status);
    const wait = retryDelay * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw lastError;
}
`,
      },
    },
    {
      id: "m-correct-backoff",
      description: "Exponential backoff, capped, skipping non-retryable 4xx",
      costTokens: 1800,
      changes: {
        "src/http-client.js": `const MAX_BACKOFF = 5000;

function shouldRetry(status) {
  return status === 429 || status >= 500;
}

export async function request(fetchImpl, url, { maxRetries = 3, retryDelay = 100 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(url);
    if (response.ok) return await response.json();
    if (!shouldRetry(response.status)) {
      throw new Error("HTTP " + response.status);
    }
    if (attempt === maxRetries) {
      throw new Error("HTTP " + response.status);
    }
    const wait = Math.min(retryDelay * 2 ** attempt, MAX_BACKOFF);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error("HTTP exhausted");
}
`,
      },
    },
  ],

  budget: { maxSteps: 12, maxTokens: 25_000 },
}

export const tasks: BenchTask[] = [paginateTask, retryTask]
