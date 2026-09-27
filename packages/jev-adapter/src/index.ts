import type {
  CognitiveState,
  CognitiveAction,
  CognitiveActionKind,
  OperationLabel,
} from "@valve/schema";

export interface JevDecisionRequest {
  state: {
    goal: string;
    progress: number;
    currentTask: string;
    evidenceCount: number;
    uncertaintyCount: number;
    maxUncertainty: number;
    verification: {
      build?: string;
      tests?: string;
      qa?: string;
    };
    recentActions: CognitiveActionKind[];
    resources: {
      contextTokens: number;
      remainingBudget?: number;
      elapsedMs: number;
    };
  };
  candidates: CognitiveActionKind[];
}

export interface JevDecisionResponse {
  action: CognitiveActionKind;
  confidence: number;
  reasoning?: string;
  probabilities?: Record<CognitiveActionKind, number>;
}

export interface JevScreenRequest {
  text: string;
  purpose?: string;
}

export interface JevScreenResponse {
  recommendation: "pass" | "review" | "block" | "skip";
  injectionProbability: number;
  substantiveProbability: number;
  relevanceProbability?: number;
}

export interface JevVerifyRequest {
  claims: string[];
  evidence: Array<{ id: string; text: string }>;
}

export interface JevVerifyResponse {
  results: Array<{
    claim: string;
    verdict: "verified" | "contradicted" | "unsupported";
    confidence: number;
  }>;
}

export interface JevConfig {
  endpoint: string;
  timeout?: number;
}

export class JevAdapter {
  private config: JevConfig;

  constructor(config: JevConfig) {
    this.config = {
      timeout: 10000,
      ...config,
    };
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.endpoint}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`JEV decide failed: ${response.status}`);
        return null;
      }

      return await response.json() as JevDecisionResponse;
    } catch (error) {
      console.warn("JEV decide error:", error);
      return null;
    }
  }

  async screen(request: JevScreenRequest): Promise<JevScreenResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.endpoint}/screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`JEV screen failed: ${response.status}`);
        return null;
      }

      return await response.json() as JevScreenResponse;
    } catch (error) {
      console.warn("JEV screen error:", error);
      return null;
    }
  }

  async verify(request: JevVerifyRequest): Promise<JevVerifyResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(`${this.config.endpoint}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`JEV verify failed: ${response.status}`);
        return null;
      }

      return await response.json() as JevVerifyResponse;
    } catch (error) {
      console.warn("JEV verify error:", error);
      return null;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.endpoint}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function createJevAdapter(endpoint: string): JevAdapter {
  return new JevAdapter({ endpoint });
}

export function createValveJevQueries(state: CognitiveState, candidates: CognitiveAction[]): {
  needMoreInfo: JevDecisionRequest;
  riskAssessment: JevDecisionRequest;
  bestSource: JevDecisionRequest;
  taskVerified: JevDecisionRequest;
  humanWorthIt: JevDecisionRequest;
} {
  // JEV is offered only real actions. An UNKNOWN past action is not a candidate.
  const candidateKinds: CognitiveActionKind[] = candidates.map((c) => c.kind);

  return {
    needMoreInfo: {
      state: {
        goal: state.goal,
        progress: state.progress,
        currentTask: state.currentTask,
        evidenceCount: state.evidence.length,
        uncertaintyCount: state.uncertainties.length,
        maxUncertainty: Math.max(0, ...state.uncertainties.map((u) => u.severity)),
        verification: state.verification,
        recentActions: state.recentActions
        .slice(-5)
        .map((a) => a.action)
        .filter((a): a is CognitiveActionKind => a !== "UNKNOWN"),
        resources: state.resources,
      },
      candidates: candidateKinds.filter((k) => ["READ", "SEARCH", "TEST", "VERIFY"].includes(k)),
    },
    riskAssessment: {
      state: {
        goal: state.goal,
        progress: state.progress,
        currentTask: state.currentTask,
        evidenceCount: state.evidence.length,
        uncertaintyCount: state.uncertainties.length,
        maxUncertainty: Math.max(0, ...state.uncertainties.map((u) => u.severity)),
        verification: state.verification,
        recentActions: state.recentActions
        .slice(-5)
        .map((a) => a.action)
        .filter((a): a is CognitiveActionKind => a !== "UNKNOWN"),
        resources: state.resources,
      },
      candidates: candidateKinds.filter((k) => ["ACT", "STOP", "ASK_HUMAN"].includes(k)),
    },
    bestSource: {
      state: {
        goal: state.goal,
        progress: state.progress,
        currentTask: state.currentTask,
        evidenceCount: state.evidence.length,
        uncertaintyCount: state.uncertainties.length,
        maxUncertainty: Math.max(0, ...state.uncertainties.map((u) => u.severity)),
        verification: state.verification,
        recentActions: state.recentActions
        .slice(-5)
        .map((a) => a.action)
        .filter((a): a is CognitiveActionKind => a !== "UNKNOWN"),
        resources: state.resources,
      },
      candidates: candidateKinds.filter((k) => ["READ", "SEARCH", "ASK_HUMAN"].includes(k)),
    },
    taskVerified: {
      state: {
        goal: state.goal,
        progress: state.progress,
        currentTask: state.currentTask,
        evidenceCount: state.evidence.length,
        uncertaintyCount: state.uncertainties.length,
        maxUncertainty: Math.max(0, ...state.uncertainties.map((u) => u.severity)),
        verification: state.verification,
        recentActions: state.recentActions
        .slice(-5)
        .map((a) => a.action)
        .filter((a): a is CognitiveActionKind => a !== "UNKNOWN"),
        resources: state.resources,
      },
      candidates: candidateKinds.filter((k) => ["VERIFY", "TEST", "STOP"].includes(k)),
    },
    humanWorthIt: {
      state: {
        goal: state.goal,
        progress: state.progress,
        currentTask: state.currentTask,
        evidenceCount: state.evidence.length,
        uncertaintyCount: state.uncertainties.length,
        maxUncertainty: Math.max(0, ...state.uncertainties.map((u) => u.severity)),
        verification: state.verification,
        recentActions: state.recentActions
        .slice(-5)
        .map((a) => a.action)
        .filter((a): a is CognitiveActionKind => a !== "UNKNOWN"),
        resources: state.resources,
      },
      candidates: ["ASK_HUMAN", "STOP", "REASON_DEEP"],
    },
  };
}