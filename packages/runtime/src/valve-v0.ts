import {
  CognitiveState,
  CognitiveAction,
  CognitiveActionKind,
  DecisionInput,
  DecisionOutput,
  UtilityProfile,
  DEFAULT_UTILITY_PROFILES,
  TrajectoryEvent,
} from "@valve/schema";

export interface ValveConfig {
  utilityProfile: keyof typeof DEFAULT_UTILITY_PROFILES;
  jevEndpoint?: string;
  teacherEndpoint?: string;
  teacherApiKey?: string;
  enableShadowMode: boolean;
  logDir: string;
}

export interface HeuristicRule {
  name: string;
  condition: (state: CognitiveState, candidates: CognitiveAction[]) => boolean;
  action: CognitiveActionKind;
  confidence: number;
  priority: number;
}

export class ValveV0 {
  private config: ValveConfig;
  private heuristics: HeuristicRule[] = [];
  private eventLog: TrajectoryEvent[] = [];

  constructor(config: ValveConfig) {
    this.config = config;
    this.registerDefaultHeuristics();
  }

  private registerDefaultHeuristics(): void {
    const rules: HeuristicRule[] = [
      {
        name: "tests-never-run",
        priority: 100,
        confidence: 0.97,
        condition: (state: CognitiveState) => {
          const hasCodeChange = state.recentActions.some(
            (a) => a.action === "ACT" && a.outcome === "success"
          );
          const testsRun = state.recentActions.some((a) => a.action === "TEST");
          const verificationFailed = state.verification.tests === "failed";
          return hasCodeChange && !testsRun && !verificationFailed;
        },
        action: "TEST",
      },
      {
        name: "build-failed",
        priority: 95,
        confidence: 0.95,
        condition: (state: CognitiveState) => state.verification.build === "failed",
        action: "ACT",
      },
      {
        name: "tests-failing",
        priority: 90,
        confidence: 0.9,
        condition: (state: CognitiveState) => state.verification.tests === "failed",
        action: "ACT",
      },
      {
        name: "high-uncertainty-read",
        priority: 80,
        confidence: 0.85,
        condition: (state: CognitiveState) =>
          state.uncertainties.some((u) => u.severity > 0.7),
        action: "READ",
      },
      {
        // Only after a read has already failed to satisfy. Previously this
        // fired whenever evidence was empty, which is true at the start of
        // every task, so it outranked READ and opened every episode with a
        // search. Reading the known file first is the cheaper, more targeted
        // move; searching is the fallback for when reading did not help.
        name: "no-evidence-search",
        priority: 45,
        confidence: 0.7,
        condition: (state: CognitiveState) =>
          state.evidence.length === 0 &&
          state.recentActions.some((a) => a.action === "READ"),
        action: "SEARCH",
      },
      {
        name: "task-complete-stop",
        priority: 60,
        confidence: 0.8,
        condition: (state: CognitiveState) =>
          state.progress > 0.95 &&
          state.verification.tests === "passed" &&
          state.verification.build === "passed",
        action: "STOP",
      },
      {
        name: "budget-exhausted-stop",
        priority: 110,
        confidence: 0.95,
        condition: (state: CognitiveState) =>
          state.resources.remainingBudget !== undefined &&
          state.resources.remainingBudget <= 0,
        action: "STOP",
      },
      {
        name: "architectural-decision-reason",
        priority: 65,
        confidence: 0.8,
        condition: (state: CognitiveState) =>
          state.currentTask.includes("architecture") &&
          state.constraints.length > 2,
        action: "REASON_DEEP",
      },
      {
        // Gated on verification state, not on the word "fix" appearing in the
        // task text. Shadow mode sets currentTask to the echoed goal, so a
        // substring match here routed every goal containing "fix" to
        // REASON_FAST regardless of what the state actually said.
        name: "simple-fix-reason-fast",
        priority: 55,
        confidence: 0.75,
        condition: (state: CognitiveState) =>
          (state.verification.tests === "failed" || state.verification.build === "failed") &&
          state.uncertainties.length <= 2,
        action: "REASON_FAST",
      },
      {
        name: "human-required-ask",
        priority: 40,
        confidence: 0.85,
        condition: (state: CognitiveState) =>
          state.authority.canAskHuman &&
          state.uncertainties.some((u) => u.severity > 0.8 && u.relatedActions.includes("ASK_HUMAN")),
        action: "ASK_HUMAN",
      },
    ];

    this.heuristics = rules.sort((a, b) => b.priority - a.priority);
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    const { state, candidates, utilityProfile } = input;
    const profile = DEFAULT_UTILITY_PROFILES[utilityProfile];

    const heuristicResult = this.applyHeuristics(state, candidates);
    if (heuristicResult) {
      return this.createOutput(heuristicResult, "heuristic", state, candidates, profile);
    }

    const jevResult = await this.queryJEV(state, candidates);
    if (jevResult && jevResult.confidence > 0.7) {
      return this.createOutput(jevResult, "jev", state, candidates, profile);
    }

    const teacherResult = await this.queryTeacher(state, candidates);
    if (teacherResult) {
      return this.createOutput(teacherResult, "teacher", state, candidates, profile);
    }

    return this.defaultDecision(state, candidates, profile);
  }

  /**
   * Synchronous decision: heuristics then the scored fallback, never the
   * network. This is the path shadow mode and bulk ingest use.
   *
   * It exists because a shadow decision must be reproducible offline. Calling
   * a teacher LLM per decision point would make the dataset depend on a
   * remote service's availability and latency, and would cost money on every
   * ingest run. The heuristics plus the utility model are deterministic, so
   * re-ingesting the same spool yields byte-identical predictions, which is
   * what makes a disagreement meaningful rather than noise.
   */
  decideSync(input: DecisionInput): DecisionOutput {
    const { state, candidates, utilityProfile } = input;
    const profile = DEFAULT_UTILITY_PROFILES[utilityProfile];

    const heuristicResult = this.applyHeuristics(state, candidates);
    if (heuristicResult) {
      return this.createOutput(heuristicResult, "heuristic", state, candidates, profile);
    }

    return this.defaultDecision(state, candidates, profile);
  }

  private applyHeuristics(
    state: CognitiveState,
    candidates: CognitiveAction[]
  ): { action: CognitiveActionKind; confidence: number } | null {
    for (const rule of this.heuristics) {
      if (rule.condition(state, candidates)) {
        const candidate = candidates.find((c) => c.kind === rule.action);
        if (candidate) {
          return { action: rule.action, confidence: rule.confidence };
        }
      }
    }
    return null;
  }

  private async queryJEV(
    state: CognitiveState,
    candidates: CognitiveAction[]
  ): Promise<{ action: CognitiveActionKind; confidence: number } | null> {
    if (!this.config.jevEndpoint) return null;

    try {
      const response = await fetch(`${this.config.jevEndpoint}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: this.serializeForJEV(state),
          candidates: candidates.map((c) => c.kind),
        }),
      });

      if (!response.ok) return null;

      const data = await response.json() as { action?: string; confidence?: number };
      const action = data.action as CognitiveActionKind | undefined;
      const candidate = candidates.find((c) => c.kind === action);
      return candidate && action ? { action, confidence: data.confidence ?? 0.5 } : null;
    } catch {
      return null;
    }
  }

  private serializeForJEV(state: CognitiveState): Record<string, unknown> {
    return {
      goal: state.goal,
      progress: state.progress,
      currentTask: state.currentTask,
      evidenceCount: state.evidence.length,
      uncertaintyCount: state.uncertainties.length,
      maxUncertainty: Math.max(0, ...state.uncertainties.map((u) => u.severity)),
      verification: state.verification,
      recentActions: state.recentActions.slice(-5).map((a) => a.action),
      resources: state.resources,
    };
  }

  private async queryTeacher(
    state: CognitiveState,
    candidates: CognitiveAction[]
  ): Promise<{ action: CognitiveActionKind; confidence: number } | null> {
    if (!this.config.teacherEndpoint || !this.config.teacherApiKey) return null;

    try {
      const prompt = this.buildTeacherPrompt(state, candidates);
      const response = await fetch(this.config.teacherEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.teacherApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 100,
        }),
      });

      if (!response.ok) return null;

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim().toUpperCase();
      if (!content) return null;

      const action = candidates.find(
        (c) => c.kind === content || content.includes(c.kind)
      );
      return action ? { action: action.kind, confidence: 0.6 } : null;
    } catch {
      return null;
    }
  }

  private buildTeacherPrompt(state: CognitiveState, candidates: CognitiveAction[]): string {
    return `You are VALVE, a cognitive scheduler. Choose the next cognitive operation.

GOAL: ${state.goal}
PROGRESS: ${(state.progress * 100).toFixed(0)}%
TASK: ${state.currentTask}
VERIFICATION: build=${state.verification.build ?? "unknown"}, tests=${state.verification.tests ?? "unknown"}
UNCERTAINTIES: ${state.uncertainties.map((u) => `${u.description}(${u.severity})`).join(", ") || "none"}
EVIDENCE: ${state.evidence.length} items
RECENT: ${state.recentActions.slice(-3).map((a) => a.action).join(" -> ") || "none"}
BUDGET: ${state.resources.remainingBudget ?? "unlimited"} tokens, ${state.resources.elapsedMs}ms elapsed

AVAILABLE ACTIONS: ${candidates.map((c) => `${c.kind}(cost=${c.estimatedCost},latency=${c.estimatedLatencyMs}ms,rev=${c.reversible})`).join(", ")}

Choose ONE action. Reply with ONLY the action name (e.g., TEST, READ, REASON_FAST, STOP).`;
  }

  private defaultDecision(
    state: CognitiveState,
    candidates: CognitiveAction[],
    profile: UtilityProfile
  ): DecisionOutput {
    const scored = candidates.map((c) => ({
      action: c.kind,
      score: this.estimateUtility(c, state, profile),
    }));

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) {
      return this.fallbackDecision(candidates, profile);
    }

    const total = scored.reduce((sum, s) => sum + Math.exp(s.score), 0);
    const probs = scored.map((s) => Math.exp(s.score) / total);

    return {
      action: best.action,
      probability: probs[0] ?? 1,
      expectedUtility: best.score,
      risk: this.estimateRisk(best.action, state),
      informationGain: this.estimateInfoGain(best.action, state),
      alternatives: scored.slice(1, 4).map((s, i) => ({
        action: s.action,
        expectedUtility: s.score,
        probability: probs[i + 1] ?? 0,
      })),
      source: "heuristic",
    };
  }

  private fallbackDecision(candidates: CognitiveAction[], profile: UtilityProfile): DecisionOutput {
    const action = candidates[0]?.kind ?? "STOP";
    return {
      action,
      probability: 1,
      expectedUtility: 0,
      risk: 0.5,
      informationGain: 0,
      alternatives: [],
      source: "heuristic",
    };
  }

  private estimateUtility(
    action: CognitiveAction,
    state: CognitiveState,
    profile: UtilityProfile
  ): number {
    let utility = 0;

    switch (action.kind) {
      case "TEST":
        utility += state.verification.tests === "unknown" ? 0.8 : 0.3;
        utility += state.recentActions.some((a) => a.action === "ACT") ? 0.5 : 0;
        break;
      case "READ":
        utility += state.evidence.length === 0 ? 0.7 : 0.2;
        utility += state.uncertainties.length > 0 ? 0.4 : 0;
        break;
      case "SEARCH":
        utility += state.evidence.length === 0 ? 0.5 : 0.1;
        break;
      case "VERIFY":
        utility += state.verification.tests === "passed" ? 0.6 : 0.2;
        break;
      case "REASON_FAST":
        utility += state.uncertainties.length > 0 ? 0.5 : 0.1;
        break;
      case "REASON_DEEP":
        utility += state.constraints.length > 2 ? 0.7 : 0.2;
        break;
      case "ACT":
        utility += state.progress < 0.5 ? 0.6 : 0.2;
        break;
      case "ASK_HUMAN":
        utility += state.authority.canAskHuman && state.uncertainties.some((u) => u.severity > 0.8) ? 0.6 : -0.5;
        break;
      case "STOP":
        utility += state.progress > 0.9 && state.verification.tests === "passed" ? 0.8 : -0.3;
        break;
      case "DELEGATE":
        utility += 0.1;
        break;
    }

    utility -= (action.estimatedCost * profile.weights.tokenCost) / 1000;
    utility -= (action.estimatedLatencyMs * profile.weights.latencyCost) / 1000;
    if (!action.reversible) {
      utility -=
        profile.weights.regressionCost * 0.01 * this.estimateRisk(action.kind, state);
    }

    return utility;
  }

  private estimateRisk(action: CognitiveActionKind, state: CognitiveState): number {
    switch (action) {
      case "ACT":
        return state.verification.tests !== "passed" ? 0.6 : 0.2;
      case "REASON_DEEP":
        return 0.1;
      case "ASK_HUMAN":
        return 0.05;
      case "STOP":
        return state.progress < 0.8 ? 0.5 : 0.05;
      default:
        return 0.1;
    }
  }

  private estimateInfoGain(action: CognitiveActionKind, state: CognitiveState): number {
    switch (action) {
      case "READ":
        return state.evidence.length === 0 ? 0.8 : 0.3;
      case "SEARCH":
        return state.evidence.length === 0 ? 0.7 : 0.2;
      case "TEST":
        return state.verification.tests === "unknown" ? 0.9 : 0.3;
      case "VERIFY":
        return 0.6;
      case "REASON_FAST":
        return 0.3;
      case "REASON_DEEP":
        return 0.5;
      case "ASK_HUMAN":
        return 0.8;
      default:
        return 0.1;
    }
  }

  private createOutput(
    decision: { action: CognitiveActionKind; confidence: number },
    source: "heuristic" | "jev" | "teacher" | "model",
    state: CognitiveState,
    candidates: CognitiveAction[],
    profile: UtilityProfile
  ): DecisionOutput {
    const candidate = candidates.find((c) => c.kind === decision.action)!;
    const utility = this.estimateUtility(candidate, state, profile);

    return {
      action: decision.action,
      probability: decision.confidence,
      expectedUtility: utility,
      risk: this.estimateRisk(decision.action, state),
      informationGain: this.estimateInfoGain(decision.action, state),
      alternatives: candidates
        .filter((c) => c.kind !== decision.action)
        .slice(0, 3)
        .map((c) => ({
          action: c.kind,
          expectedUtility: this.estimateUtility(c, state, profile),
          probability: (1 - decision.confidence) / 3,
        })),
      source,
    };
  }

  logEvent(event: TrajectoryEvent): void {
    this.eventLog.push(event);
  }

  getEventLog(): TrajectoryEvent[] {
    return [...this.eventLog];
  }

  clearEventLog(): void {
    this.eventLog = [];
  }
}

export function createValveV0(config: Partial<ValveConfig> = {}): ValveV0 {
  return new ValveV0({
    utilityProfile: "coding-balanced",
    enableShadowMode: true,
    logDir: "./data/valve-logs",
    ...config,
  });
}