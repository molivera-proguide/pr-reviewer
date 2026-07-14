import { describe, expect, test } from "bun:test";
import { sanitizeLogEvent } from "../../src/observability/logger.ts";

describe("safe structured diagnostics", () => {
  test("keeps allowlisted metadata and drops an invalid request identifier", () => {
    const sanitized = sanitizeLogEvent({
      event: "agent_attempt_failed",
      role: "code_explorer",
      sliceId: "slice-1",
      attempt: 2,
      failureKind: "schema_validation",
      requestId: "PRIVATE PROVIDER RESPONSE BODY",
      stopReason: "end_turn",
      statusCode: 400,
      counts: { inputTokens: 10, outputTokens: 5, validationIssues: 1 },
    });
    expect(sanitized).toEqual({
      event: "agent_attempt_failed",
      role: "code_explorer",
      sliceId: "slice-1",
      attempt: 2,
      failureKind: "schema_validation",
      stopReason: "end_turn",
      statusCode: 400,
      counts: { inputTokens: 10, outputTokens: 5, validationIssues: 1 },
    });
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
  });

  test("preserves a syntactically safe Anthropic request ID", () => {
    expect(
      sanitizeLogEvent({ event: "agent_completed", requestId: "req_01ABC.def-123" }).requestId,
    ).toBe("req_01ABC.def-123");
  });
});
