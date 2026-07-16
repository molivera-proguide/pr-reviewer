import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentFailureKind } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";

export function safeIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const sanitized = value.replace(/[^A-Za-z0-9_.$:\\/-]/g, "_").slice(0, 256);
  return sanitized.length === 0 ? null : sanitized;
}

export function safeRequestId(value: string | null | undefined): string | null {
  const sanitized = safeIdentifier(value);
  return sanitized !== null && /^req[_-][A-Za-z0-9_.:-]+$/.test(sanitized) ? sanitized : null;
}

export function safeValidationPath(path: readonly PropertyKey[]): string {
  const value = path.map(String).join(".") || "$";
  return safeIdentifier(value) ?? "$";
}

export function extractText(response: Message): string {
  return response.content
    .filter(
      (block): block is Extract<(typeof response.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

export function totalInputTokens(response: Message): number {
  return (
    response.usage.input_tokens +
    (response.usage.cache_creation_input_tokens ?? 0) +
    (response.usage.cache_read_input_tokens ?? 0)
  );
}

export function usageDetails(response: Message): {
  baseInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  thinkingTokens: number;
} {
  return {
    baseInputTokens: response.usage.input_tokens,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

export function classifyApiFailure(
  error: unknown,
  signal: AbortSignal,
): {
  kind: AgentFailureKind;
  requestId: string | null;
  statusCode: number | null;
} {
  if (signal.aborted || error instanceof APIUserAbortError) {
    return { kind: "cancelled", requestId: null, statusCode: null };
  }
  if (error instanceof ReviewerError && error.code === "BUDGET_EXCEEDED") {
    return { kind: "budget", requestId: null, statusCode: null };
  }
  if (error instanceof APIConnectionError) {
    return {
      kind: "transient_api",
      requestId: safeRequestId(error.requestID),
      statusCode: null,
    };
  }
  if (error instanceof APIError) {
    const statusCode = error.status ?? null;
    const transient =
      statusCode === null ||
      statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 429 ||
      statusCode >= 500;
    return {
      kind: transient ? "transient_api" : "permanent_api",
      requestId: safeRequestId(error.requestID),
      statusCode,
    };
  }
  return { kind: "permanent_api", requestId: null, statusCode: null };
}
