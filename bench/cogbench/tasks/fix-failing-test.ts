import type { CogBenchTask, CognitiveState, CognitiveActionKind } from "@valve/schema";

export const fixFailingTestTask: CogBenchTask = {
  id: "fix-failing-test-001",
  name: "Fix failing pagination test",
  description: "A unit test for pagination logic is failing after a refactor. The test expects page 2 to have 10 items but gets 8.",
  category: "fix-test",
  initialState: {
    goal: "Fix the failing pagination test without breaking other tests",
    progress: 0.1,
    currentTask: "Investigate failing test and identify root cause",
    evidence: [
      {
        id: "ev-1",
        source: "test",
        content: "FAIL tests/pagination.test.ts > Pagination > should return correct items for page 2\nExpected: 10 items\nReceived: 8 items",
        relevance: 0.95,
        timestamp: Date.now() - 10000,
      },
      {
        id: "ev-2",
        source: "file",
        content: "// src/pagination.ts\nexport function paginate(items: T[], page: number, pageSize: number): T[] {\n  const start = (page - 1) * pageSize;\n  return items.slice(start, start + pageSize);\n}",
        relevance: 0.9,
        timestamp: Date.now() - 8000,
      },
      {
        id: "ev-3",
        source: "file",
        content: "// tests/pagination.test.ts\nimport { paginate } from '../src/pagination';\ntest('should return correct items for page 2', () => {\n  const items = Array.from({ length: 25 }, (_, i) => i);\n  const result = paginate(items, 2, 10);\n  expect(result).toHaveLength(10);\n});",
        relevance: 0.9,
        timestamp: Date.now() - 7000,
      },
    ],
    uncertainties: [
      {
        id: "unc-1",
        description: "Root cause of off-by-one or slice issue unclear",
        severity: 0.8,
        relatedActions: ["READ", "REASON_FAST", "TEST"],
      },
      {
        id: "unc-2",
        description: "Whether other pagination tests pass",
        severity: 0.5,
        relatedActions: ["TEST"],
      },
    ],
    constraints: [
      {
        id: "const-1",
        description: "Must not change test expectations - fix the implementation",
        type: "hard",
        source: "policy",
      },
      {
        id: "const-2",
        description: "Follow existing code style in pagination.ts",
        type: "soft",
        source: "architecture",
      },
    ],
    recentActions: [],
    verification: {
      build: "passed",
      tests: "failed",
      qa: "unknown",
    },
    resources: {
      contextTokens: 1200,
      remainingBudget: 30000,
      elapsedMs: 15000,
    },
    authority: {
      canWrite: true,
      canDelete: false,
      canAskHuman: true,
    },
  },
  allowedActions: ["READ", "SEARCH", "TEST", "VERIFY", "REASON_FAST", "ACT", "STOP"],
  successCriteria: {
    testsPass: true,
    buildPass: true,
    noRegressions: true,
  },
  budget: {
    maxTokens: 30000,
    maxSeconds: 300,
    maxSteps: 20,
  },
  metadata: {
    difficulty: "easy",
    expectedSteps: 5,
    tags: ["pagination", "off-by-one", "unit-test"],
  },
};

export const implementFeatureTask: CogBenchTask = {
  id: "implement-feature-001",
  name: "Add retry logic to HTTP client",
  description: "Implement exponential backoff retry for failed requests in the HTTP client. Should respect Retry-After header and max retries config.",
  category: "implement-feature",
  initialState: {
    goal: "Add retry with exponential backoff to HTTP client",
    progress: 0.05,
    currentTask: "Read existing HTTP client and understand current structure",
    evidence: [
      {
        id: "ev-1",
        source: "file",
        content: "// src/http-client.ts\nexport class HttpClient {\n  constructor(private baseUrl: string) {}\n\n  async request<T>(method: string, path: string, body?: any): Promise<T> {\n    const response = await fetch(`${this.baseUrl}${path}`, {\n      method,\n      headers: { 'Content-Type': 'application/json' },\n      body: body ? JSON.stringify(body) : undefined,\n    });\n\n    if (!response.ok) {\n      throw new Error(`HTTP ${response.status}: ${response.statusText}`);\n    }\n\n    return response.json();\n  }\n}",
        relevance: 0.95,
        timestamp: Date.now() - 5000,
      },
      {
        id: "ev-2",
        source: "file",
        content: "// src/config.ts\nexport interface HttpClientConfig {\n  baseUrl: string;\n  timeout?: number;\n  maxRetries?: number;\n  retryDelay?: number;\n}",
        relevance: 0.8,
        timestamp: Date.now() - 4000,
      },
    ],
    uncertainties: [
      {
        id: "unc-1",
        description: "Exact retry algorithm: exponential backoff vs fixed delay",
        severity: 0.7,
        relatedActions: ["READ", "SEARCH", "REASON_FAST"],
      },
      {
        id: "unc-2",
        description: "How to handle Retry-After header parsing",
        severity: 0.6,
        relatedActions: ["SEARCH", "REASON_FAST"],
      },
      {
        id: "unc-3",
        description: "Which errors are retryable (network vs 4xx vs 5xx)",
        severity: 0.8,
        relatedActions: ["SEARCH", "REASON_DEEP"],
      },
    ],
    constraints: [
      {
        id: "const-1",
        description: "Must be configurable via HttpClientConfig",
        type: "hard",
        source: "architecture",
      },
      {
        id: "const-2",
        description: "Should not retry on 4xx errors (except 429)",
        type: "hard",
        source: "policy",
      },
      {
        id: "const-3",
        description: "Add tests for retry behavior",
        type: "hard",
        source: "policy",
      },
    ],
    recentActions: [],
    verification: {
      build: "passed",
      tests: "unknown",
      qa: "unknown",
    },
    resources: {
      contextTokens: 2100,
      remainingBudget: 50000,
      elapsedMs: 8000,
    },
    authority: {
      canWrite: true,
      canDelete: false,
      canAskHuman: true,
    },
  },
  allowedActions: ["READ", "SEARCH", "TEST", "VERIFY", "REASON_FAST", "REASON_DEEP", "ACT", "STOP"],
  successCriteria: {
    testsPass: true,
    buildPass: true,
    behaviorMatch: true,
    noRegressions: true,
  },
  budget: {
    maxTokens: 50000,
    maxSeconds: 600,
    maxSteps: 30,
  },
  metadata: {
    difficulty: "medium",
    expectedSteps: 12,
    tags: ["http", "retry", "exponential-backoff", "config"],
  },
};

export const cogbenchTasks: CogBenchTask[] = [
  fixFailingTestTask,
  implementFeatureTask,
];