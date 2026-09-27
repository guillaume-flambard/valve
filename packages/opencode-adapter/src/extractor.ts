import type {
  CognitiveState,
  CognitiveAction,
  CognitiveActionKind,
  Evidence,
  Uncertainty,
  Constraint,
  ActionSummary,
  VerificationStatus,
  Resources,
  Authority,
  TrajectoryEvent,
  UtilityProfileName,
} from "@valve/schema";
import { createValveV0, ValveV0 } from "@valve/runtime";

export interface OpenCodeSession {
  id: string;
  messages: OpenCodeMessage[];
  tools: OpenCodeTool[];
  workingDirectory: string;
  startTime: number;
}

export interface OpenCodeMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: OpenCodeToolCall[];
  toolResult?: OpenCodeToolResult;
}

export interface OpenCodeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface OpenCodeToolResult {
  toolCallId: string;
  output: string;
  error?: string;
}

export interface OpenCodeTool {
  name: string;
  description: string;
  reversible: boolean;
  estimatedCost: number;
  estimatedLatencyMs: number;
}

export interface OpenCodeStateExtractorConfig {
  session: OpenCodeSession;
  valve: ValveV0;
  utilityProfile: UtilityProfileName;
  onDecision?: (event: TrajectoryEvent) => void;
}

export class OpenCodeStateExtractor {
  private session: OpenCodeSession;
  private valve: ValveV0;
  private utilityProfile: UtilityProfileName;
  private onDecision?: (event: TrajectoryEvent) => void;
  private stepCounter = 0;
  private episodeId: string;
  private lastActionTime = Date.now();

  constructor(config: OpenCodeStateExtractorConfig) {
    this.session = config.session;
    this.valve = config.valve;
    this.utilityProfile = config.utilityProfile;
    this.onDecision = config.onDecision;
    this.episodeId = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  extractState(): CognitiveState {
    const messages = this.session.messages;
    const tools = this.session.tools;

    const recentActions = this.extractRecentActions(messages);
    const evidence = this.extractEvidence(messages);
    const uncertainties = this.extractUncertainties(messages, evidence);
    const constraints = this.extractConstraints(messages);
    const verification = this.extractVerification(messages);
    const goal = this.extractGoal(messages);
    const currentTask = this.extractCurrentTask(messages);
    const progress = this.estimateProgress(messages, verification);
    const resources = this.extractResources(messages);
    const authority = this.extractAuthority();

    return {
      goal,
      progress,
      currentTask,
      evidence,
      uncertainties,
      constraints,
      recentActions,
      verification,
      resources,
      authority,
    };
  }

  private extractRecentActions(messages: OpenCodeMessage[]): ActionSummary[] {
    const actions: ActionSummary[] = [];

    for (const msg of messages.slice(-20)) {
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const call of msg.toolCalls) {
          const result = messages.find(
            (m) => m.role === "tool" && m.toolResult?.toolCallId === call.id
          );

          const actionKind = this.mapToolToAction(call.name);
          if (actionKind) {
            actions.push({
              action: actionKind,
              timestamp: msg.timestamp,
              outcome: result?.toolResult?.error ? "failure" : "success",
              cost: this.estimateToolCost(call.name),
              latencyMs: 0,
            });
          }
        }
      }
    }

    return actions;
  }

  private mapToolToAction(toolName: string): CognitiveActionKind | null {
    const mapping: Record<string, CognitiveActionKind> = {
      read: "READ",
      write: "ACT",
      edit: "ACT",
      glob: "SEARCH",
      grep: "SEARCH",
      task: "ACT",
      bash: "ACT",
      todo_write: "ACT",
      test: "TEST",
      lint: "VERIFY",
      typecheck: "VERIFY",
    };
    return mapping[toolName] ?? null;
  }

  private estimateToolCost(toolName: string): number {
    const costs: Record<string, number> = {
      read: 50,
      write: 100,
      edit: 100,
      glob: 200,
      grep: 300,
      task: 5000,
      bash: 200,
      todo_write: 10,
      test: 2000,
      lint: 1000,
      typecheck: 1500,
    };
    return costs[toolName] ?? 100;
  }

  private extractEvidence(messages: OpenCodeMessage[]): Evidence[] {
    const evidence: Evidence[] = [];

    for (const msg of messages) {
      if (msg.role === "tool" && msg.toolResult) {
        evidence.push({
          id: `ev-${msg.toolResult.toolCallId}`,
          source: "tool",
          content: msg.toolResult.output.slice(0, 5000),
          relevance: msg.toolResult.error ? 0.3 : 0.8,
          timestamp: msg.timestamp,
        });
      }

      if (msg.role === "user" && msg.content.length > 50) {
        evidence.push({
          id: `ev-user-${msg.timestamp}`,
          source: "human",
          content: msg.content.slice(0, 2000),
          relevance: 0.9,
          timestamp: msg.timestamp,
        });
      }
    }

    return evidence.slice(-50);
  }

  private extractUncertainties(
    messages: OpenCodeMessage[],
    evidence: Evidence[]
  ): Uncertainty[] {
    const uncertainties: Uncertainty[] = [];
    const recentContent = messages.slice(-10).map((m) => m.content).join("\n");

    if (recentContent.includes("not sure") || recentContent.includes("uncertain")) {
      uncertainties.push({
        id: `unc-${Date.now()}-1`,
        description: "Agent expressed uncertainty",
        severity: 0.7,
        relatedActions: ["READ", "SEARCH", "REASON_FAST"],
      });
    }

    if (evidence.length === 0) {
      uncertainties.push({
        id: `unc-${Date.now()}-2`,
        description: "No evidence collected yet",
        severity: 0.8,
        relatedActions: ["READ", "SEARCH"],
      });
    }

    const hasTestFailure = evidence.some(
      (e) => e.source === "tool" && e.content.includes("FAIL")
    );
    if (hasTestFailure) {
      uncertainties.push({
        id: `unc-${Date.now()}-3`,
        description: "Test failures detected",
        severity: 0.9,
        relatedActions: ["ACT", "READ", "TEST"],
      });
    }

    return uncertainties;
  }

  private extractConstraints(messages: OpenCodeMessage[]): Constraint[] {
    const constraints: Constraint[] = [];
    const allContent = messages.map((m) => m.content).join("\n");

    const constraintPatterns = [
      { pattern: /must not|never|forbidden|prohibited/gi, type: "hard" as const },
      { pattern: /should|prefer|recommended/gi, type: "soft" as const },
      { pattern: /architecture|pattern|convention|style/gi, type: "soft" as const },
    ];

    for (const { pattern, type } of constraintPatterns) {
      const matches = allContent.match(pattern);
      if (matches) {
        constraints.push({
          id: `const-${Date.now()}-${constraints.length}`,
          description: `Constraint: ${matches.slice(0, 3).join(", ")}`,
          type,
          source: "user",
        });
      }
    }

    return constraints.slice(-10);
  }

  private extractVerification(messages: OpenCodeMessage[]): VerificationStatus {
    const content = messages.slice(-10).map((m) => m.content).join("\n");

    let build: VerificationStatus["build"] = "unknown";
    let tests: VerificationStatus["tests"] = "unknown";
    let qa: VerificationStatus["qa"] = "unknown";

    if (content.includes("build passed") || content.includes("compilation successful")) {
      build = "passed";
    } else if (content.includes("build failed") || content.includes("compilation error")) {
      build = "failed";
    } else if (content.includes("building") || content.includes("compiling")) {
      build = "pending";
    }

    if (content.includes("tests passed") || content.includes("all tests pass")) {
      tests = "passed";
    } else if (content.includes("test failed") || content.includes("FAIL")) {
      tests = "failed";
    } else if (content.includes("running tests") || content.includes("test:")) {
      tests = "pending";
    }

    if (content.includes("qa passed") || content.includes("qa: pass")) {
      qa = "passed";
    } else if (content.includes("qa failed") || content.includes("qa: fail")) {
      qa = "failed";
    }

    return { build, tests, qa };
  }

  private extractGoal(messages: OpenCodeMessage[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const firstContent = userMessages[0]?.content;
    if (!firstContent) return "Unknown goal";
    return firstContent.slice(0, 500);
  }

  private extractCurrentTask(messages: OpenCodeMessage[]): string {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant || !lastAssistant.content) return "Starting";
    const content = lastAssistant.content.slice(0, 200);
    return content || "Processing";
  }

  private estimateProgress(
    messages: OpenCodeMessage[],
    verification: VerificationStatus
  ): number {
    let progress = 0.1;

    const toolCalls = messages.filter((m) => m.role === "assistant" && m.toolCalls).length;
    progress += Math.min(0.3, toolCalls * 0.05);

    if (verification.build === "passed") progress += 0.2;
    if (verification.tests === "passed") progress += 0.3;
    if (verification.qa === "passed") progress += 0.2;

    const recentContent = messages.slice(-5).map((m) => m.content).join("\n");
    if (recentContent.includes("done") || recentContent.includes("complete")) {
      progress += 0.2;
    }

    return Math.min(1, progress);
  }

  private extractResources(messages: OpenCodeMessage[]): Resources {
    let contextTokens = 0;
    for (const msg of messages) {
      contextTokens += msg.content.length / 4;
      if (msg.toolCalls) {
        contextTokens += JSON.stringify(msg.toolCalls).length / 4;
      }
    }

    const elapsedMs = Date.now() - this.session.startTime;

    return {
      contextTokens: Math.round(contextTokens),
      elapsedMs,
    };
  }

  private extractAuthority(): Authority {
    return {
      canWrite: true,
      canDelete: false,
      canAskHuman: true,
    };
  }

  getAvailableActions(): CognitiveAction[] {
    const baseActions: CognitiveAction[] = [
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

    return baseActions;
  }

  async runDecisionCycle(): Promise<{ action: CognitiveActionKind; output: any }> {
    this.stepCounter++;
    const state = this.extractState();
    const candidates = this.getAvailableActions();

    const decisionInput = {
      state,
      candidates,
      utilityProfile: this.utilityProfile,
    };

    const decision = await this.valve.decide(decisionInput);

    const event: TrajectoryEvent = {
      episodeId: this.episodeId,
      step: this.stepCounter,
      timestamp: Date.now(),
      state,
      candidates,
      chosen: decision.action,
      source: decision.source,
      cost: {
        tokens: candidates.find((c) => c.kind === decision.action)?.estimatedCost ?? 0,
        usd: 0,
        latencyMs: candidates.find((c) => c.kind === decision.action)?.estimatedLatencyMs ?? 0,
      },
      outcome: {
        progressDelta: 0,
        uncertaintyDelta: 0,
        failureDetected: false,
        taskSuccess: null,
        regressions: [],
      },
      utilityProfile: this.utilityProfile,
    };

    this.valve.logEvent(event);
    this.onDecision?.(event);

    return { action: decision.action, output: decision };
  }

  getEpisodeId(): string {
    return this.episodeId;
  }

  getStepCounter(): number {
    return this.stepCounter;
  }
}

export function createOpenCodeAdapter(
  session: OpenCodeSession,
  valveConfig?: Partial<import("@valve/runtime").ValveConfig>
): OpenCodeStateExtractor {
  const valve = createValveV0(valveConfig);
  return new OpenCodeStateExtractor({
    session,
    valve,
    utilityProfile: "coding-balanced",
  });
}