import { describe, expect, test } from "bun:test";
import { AgentExecutionError } from "../../src/anthropic/agent-client.ts";
import type { AttemptSummary } from "../../src/domain/contracts.ts";
import { ReviewerError } from "../../src/domain/errors.ts";
import {
  classifyAgentFailure,
  safeStageLimitation,
  stopsNewSlices,
} from "../../src/review/agent-failure.ts";

const diagnostic: AttemptSummary = {
  role: "code_explorer",
  model: "claude-test",
  sliceId: "slice-1",
  attempt: 1,
  status: "failed",
  failureKind: "refusal",
  stopReason: "refusal",
  requestId: "req_refusal",
  statusCode: null,
  inputTokens: 10,
  outputTokens: 2,
  payloadBytes: 100,
  validationPaths: [],
};

describe("agent failure policy", () => {
  test("preserves the safe diagnostics carried by an agent execution error", () => {
    const error = new AgentExecutionError("refusal", [diagnostic], "code_explorer", "slice-1");

    expect(classifyAgentFailure(error)).toEqual({ kind: "refusal", diagnostics: [diagnostic] });
  });

  test("maps budget and cancellation errors without leaking arbitrary details", () => {
    expect(classifyAgentFailure(new ReviewerError("BUDGET_EXCEEDED", "secret details"))).toEqual({
      kind: "budget",
      diagnostics: [],
    });
    expect(classifyAgentFailure(new ReviewerError("CANCELLED", "cancelled"))).toEqual({
      kind: "cancelled",
      diagnostics: [],
    });
  });

  test("defines which failures stop new slices and emits a bounded limitation", () => {
    expect(stopsNewSlices("budget")).toBeTrue();
    expect(stopsNewSlices("max_tokens")).toBeFalse();
    expect(safeStageLimitation("Code exploration", "refusal", "slice-1")).toBe(
      "Code exploration slice-1 was incomplete (refusal).",
    );
  });
});
