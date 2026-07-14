import { describe, expect, test } from "bun:test";
import { estimateReviewCost } from "../../src/anthropic/pricing.ts";
import type { AttemptSummary } from "../../src/domain/contracts.ts";

function attempt(overrides: Partial<AttemptSummary>): AttemptSummary {
  return {
    role: "code_explorer",
    model: "claude-haiku-4-5-20251001",
    attempt: 1,
    status: "completed",
    stopReason: "end_turn",
    requestId: "req_test",
    statusCode: null,
    inputTokens: 3_000,
    outputTokens: 1_000,
    baseInputTokens: 1_000,
    cacheCreationInputTokens: 1_000,
    cacheReadInputTokens: 1_000,
    thinkingTokens: 0,
    payloadBytes: 100,
    validationPaths: [],
    ...overrides,
  };
}

describe("Anthropic cost estimates", () => {
  test("uses separate base, cache-write, cache-read, and output rates", () => {
    const result = estimateReviewCost([attempt({})], new Date("2026-07-14T00:00:00.000Z"));
    expect(result.amount).toBeCloseTo(0.00735, 8);
    expect(result.complete).toBeTrue();
  });

  test("applies the Sonnet introductory period and tracks failed-attempt cost", () => {
    const result = estimateReviewCost(
      [
        attempt({
          role: "synthesizer",
          model: "claude-sonnet-5",
          status: "failed",
          failureKind: "max_tokens",
          inputTokens: 1_000,
          baseInputTokens: 1_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1_000,
        }),
      ],
      new Date("2026-07-14T00:00:00.000Z"),
    );
    expect(result.amount).toBeCloseTo(0.012, 8);
    expect(result.failedAttemptAmount).toBe(result.amount);
  });

  test("marks estimates incomplete for unknown model pricing", () => {
    const result = estimateReviewCost(
      [attempt({ model: "private-model" })],
      new Date("2026-07-14T00:00:00.000Z"),
    );
    expect(result.amount).toBe(0);
    expect(result.complete).toBeFalse();
  });
});
