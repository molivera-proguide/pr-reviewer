import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentFailureKind, AttemptSummary, RuntimeAgentRole } from "../domain/contracts.ts";
import type { Logger } from "../observability/logger.ts";
import { safeIdentifier } from "./agent-response.ts";

export interface AttemptSummaryOptions {
  readonly request: { readonly role: RuntimeAgentRole; readonly sliceId?: string };
  readonly model: string;
  readonly attempt: number;
  readonly status: "completed" | "failed";
  readonly failureKind?: AgentFailureKind;
  readonly stopReason?: Message["stop_reason"];
  readonly requestId?: string | null;
  readonly statusCode?: number | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly baseInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly thinkingTokens?: number;
  readonly payloadBytes?: number;
  readonly validationPaths?: readonly string[];
}

export function createAttemptSummary(options: AttemptSummaryOptions): AttemptSummary {
  return {
    role: options.request.role,
    model: safeIdentifier(options.model) ?? "unknown_model",
    ...(options.request.sliceId === undefined ? {} : { sliceId: options.request.sliceId }),
    attempt: options.attempt,
    status: options.status,
    ...(options.failureKind === undefined ? {} : { failureKind: options.failureKind }),
    stopReason: options.stopReason ?? null,
    requestId: options.requestId ?? null,
    statusCode: options.statusCode ?? null,
    inputTokens: options.inputTokens ?? 0,
    outputTokens: options.outputTokens ?? 0,
    baseInputTokens: options.baseInputTokens ?? 0,
    cacheCreationInputTokens: options.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: options.cacheReadInputTokens ?? 0,
    thinkingTokens: options.thinkingTokens ?? 0,
    payloadBytes: options.payloadBytes ?? 0,
    validationPaths: [...(options.validationPaths ?? [])],
  };
}

export function logAgentAttempt(logger: Logger, summary: AttemptSummary): void {
  logger.log(summary.status === "completed" ? "info" : "warn", {
    event: summary.status === "completed" ? "agent_completed" : "agent_attempt_failed",
    stage: summary.role,
    role: summary.role,
    ...(summary.model === undefined ? {} : { model: summary.model }),
    ...(summary.sliceId === undefined ? {} : { sliceId: summary.sliceId }),
    attempt: summary.attempt,
    ...(summary.failureKind === undefined ? {} : { failureKind: summary.failureKind }),
    ...(summary.requestId === null ? {} : { requestId: summary.requestId }),
    ...(summary.stopReason === null ? {} : { stopReason: summary.stopReason }),
    ...(summary.statusCode === null ? {} : { statusCode: summary.statusCode }),
    counts: {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      baseInputTokens: summary.baseInputTokens ?? 0,
      cacheCreationInputTokens: summary.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: summary.cacheReadInputTokens ?? 0,
      thinkingTokens: summary.thinkingTokens ?? 0,
      payloadBytes: summary.payloadBytes,
      validationIssues: summary.validationPaths.length,
    },
  });
}
