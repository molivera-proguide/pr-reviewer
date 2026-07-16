import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { z } from "zod";
import type { AgentFailureKind, AttemptSummary, RuntimeAgentRole } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";
import type { Logger } from "../observability/logger.ts";
import type { UsageBudget } from "../security/budget.ts";
import {
  type AttemptSummaryOptions,
  createAttemptSummary,
  logAgentAttempt,
} from "./agent-diagnostics.ts";
import { boundedOutput, retriesMaxTokens, userContent } from "./agent-request.ts";
import {
  classifyApiFailure,
  extractText,
  safeRequestId,
  safeValidationPath,
  totalInputTokens,
  usageDetails,
} from "./agent-response.ts";
import { type AgentModelRouting, isOrchestratorRole, modelForRole } from "./agent-routing.ts";

export type { AgentModelRouting } from "./agent-routing.ts";

export interface AgentRequest<T> {
  readonly role: RuntimeAgentRole;
  readonly sliceId?: string;
  readonly system: string;
  readonly payload: unknown;
  readonly schema: z.ZodType<T>;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

export interface AgentResponse<T> {
  readonly data: T;
  readonly usage: {
    inputTokens: number;
    outputTokens: number;
    baseInputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    thinkingTokens: number;
  };
  readonly requestId: string | null;
  readonly diagnostics: readonly AttemptSummary[];
}

export interface StructuredAgentClient {
  run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>>;
}

export type AgentMessageCreator = (
  params: MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal },
) => Promise<Message>;

function failureCode(kind: AgentFailureKind): ConstructorParameters<typeof ReviewerError>[0] {
  if (kind === "max_tokens") return "AGENT_MAX_TOKENS";
  if (kind === "refusal") return "AGENT_REFUSAL";
  if (kind === "schema_validation") return "AGENT_SCHEMA_VALIDATION";
  if (kind === "budget") return "BUDGET_EXCEEDED";
  if (kind === "cancelled") return "CANCELLED";
  return "AGENT_API_ERROR";
}

export class AgentExecutionError extends ReviewerError {
  constructor(
    readonly failureKind: AgentFailureKind,
    readonly diagnostics: readonly AttemptSummary[],
    role: RuntimeAgentRole,
    sliceId?: string,
  ) {
    super(
      failureCode(failureKind),
      `${role}${sliceId === undefined ? "" : ` (${sliceId})`} failed: ${failureKind}.`,
      { role, ...(sliceId === undefined ? {} : { sliceId }), failureKind },
    );
    this.name = "AgentExecutionError";
  }
}

export class AnthropicAgentClient implements StructuredAgentClient {
  private readonly client: Anthropic;
  private readonly createMessage: AgentMessageCreator;

  constructor(
    apiKey: string,
    private readonly routing: AgentModelRouting,
    private readonly budget: UsageBudget,
    private readonly logger: Logger,
    timeoutMs: number,
    createMessage?: AgentMessageCreator,
  ) {
    this.client = new Anthropic({
      apiKey,
      timeout: timeoutMs,
      maxRetries: 2,
      logLevel: "off",
    });
    this.createMessage =
      createMessage ?? ((params, options) => this.client.messages.create(params, options));
  }

  async run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>> {
    const diagnostics: AttemptSummary[] = [];
    const summarize = (options: Omit<AttemptSummaryOptions, "request" | "model">): AttemptSummary =>
      createAttemptSummary({
        ...options,
        request,
        model: modelForRole(request.role, this.routing),
      });
    let recovery: "initial" | "max_tokens" | "schema_validation" = "initial";
    let invalidOutput: string | undefined;
    let validationPaths: readonly string[] | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const content = userContent({
        request,
        recovery,
        ...(invalidOutput === undefined ? {} : { invalidOutput }),
        ...(validationPaths === undefined ? {} : { validationPaths }),
      });
      const payloadBytes = Buffer.byteLength(content, "utf8");
      let reservationId: number;
      try {
        reservationId = this.budget.reserveCall(request.maxTokens);
      } catch (error) {
        const classified = classifyApiFailure(error, request.signal);
        const summary = summarize({
          attempt,
          status: "failed",
          failureKind: classified.kind,
          requestId: classified.requestId,
          statusCode: classified.statusCode,
          payloadBytes,
        });
        diagnostics.push(summary);
        logAgentAttempt(this.logger, summary);
        throw new AgentExecutionError(classified.kind, diagnostics, request.role, request.sliceId);
      }

      let response: Message;
      try {
        const model = modelForRole(request.role, this.routing);
        const format = zodOutputFormat(request.schema);
        response = await this.createMessage(
          {
            model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [
              {
                role: "user",
                content,
              },
            ],
            output_config: isOrchestratorRole(request.role)
              ? { format, effort: this.routing.orchestratorEffort }
              : { format },
          },
          { signal: request.signal },
        );
      } catch (error) {
        this.budget.releaseReservation(reservationId);
        const classified = classifyApiFailure(error, request.signal);
        const summary = summarize({
          attempt,
          status: "failed",
          failureKind: classified.kind,
          requestId: classified.requestId,
          statusCode: classified.statusCode,
          payloadBytes,
        });
        diagnostics.push(summary);
        logAgentAttempt(this.logger, summary);
        throw new AgentExecutionError(classified.kind, diagnostics, request.role, request.sliceId);
      }

      const inputTokens = totalInputTokens(response);
      const outputTokens = response.usage.output_tokens;
      const details = usageDetails(response);
      const requestId = safeRequestId(
        (response as Message & { _request_id?: string | null })._request_id,
      );
      try {
        this.budget.recordUsage(inputTokens, outputTokens, reservationId, details);
      } catch {
        const summary = summarize({
          attempt,
          status: "failed",
          failureKind: "budget",
          stopReason: response.stop_reason,
          requestId,
          inputTokens,
          outputTokens,
          ...details,
          payloadBytes,
        });
        diagnostics.push(summary);
        logAgentAttempt(this.logger, summary);
        throw new AgentExecutionError("budget", diagnostics, request.role, request.sliceId);
      }

      if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
        const failureKind = response.stop_reason;
        const summary = summarize({
          attempt,
          status: "failed",
          failureKind,
          stopReason: response.stop_reason,
          requestId,
          inputTokens,
          outputTokens,
          ...details,
          payloadBytes,
        });
        diagnostics.push(summary);
        logAgentAttempt(this.logger, summary);
        if (failureKind === "max_tokens" && attempt === 1 && retriesMaxTokens(request.role)) {
          recovery = "max_tokens";
          continue;
        }
        throw new AgentExecutionError(failureKind, diagnostics, request.role, request.sliceId);
      }

      const rawOutput = extractText(response);
      let candidate: unknown;
      let currentValidationPaths: readonly string[] | undefined;
      try {
        candidate = JSON.parse(rawOutput);
      } catch {
        currentValidationPaths = ["$"];
      }
      let parsed: ReturnType<typeof request.schema.safeParse> | null = null;
      if (currentValidationPaths === undefined) {
        try {
          parsed = request.schema.safeParse(candidate);
        } catch {
          currentValidationPaths = ["$"];
        }
      }
      if (parsed?.success) {
        const summary = summarize({
          attempt,
          status: "completed",
          stopReason: response.stop_reason,
          requestId,
          inputTokens,
          outputTokens,
          ...details,
          payloadBytes,
        });
        diagnostics.push(summary);
        logAgentAttempt(this.logger, summary);
        return {
          data: parsed.data,
          usage: { inputTokens, outputTokens, ...details },
          requestId,
          diagnostics,
        };
      }
      if (parsed !== null && !parsed.success) {
        currentValidationPaths = [
          ...new Set(parsed.error.issues.map((issue) => safeValidationPath(issue.path))),
        ].slice(0, 50);
      }
      const summary = summarize({
        attempt,
        status: "failed",
        failureKind: "schema_validation",
        stopReason: response.stop_reason,
        requestId,
        inputTokens,
        outputTokens,
        ...details,
        payloadBytes,
        ...(currentValidationPaths === undefined
          ? {}
          : { validationPaths: currentValidationPaths }),
      });
      diagnostics.push(summary);
      logAgentAttempt(this.logger, summary);
      if (attempt === 1) {
        recovery = "schema_validation";
        invalidOutput = boundedOutput(rawOutput);
        validationPaths = currentValidationPaths;
        continue;
      }
      throw new AgentExecutionError(
        "schema_validation",
        diagnostics,
        request.role,
        request.sliceId,
      );
    }
    throw new AgentExecutionError("permanent_api", diagnostics, request.role, request.sliceId);
  }
}
