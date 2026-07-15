import { describe, expect, test } from "bun:test";
import type { Finding } from "../../src/domain/contracts.ts";
import { ReviewerError } from "../../src/domain/errors.ts";
import { calculateVerdict } from "../../src/review/verdict.ts";
import { UsageBudget } from "../../src/security/budget.ts";

const highFinding: Finding = {
  id: "F-1",
  severity: "high",
  category: "contract",
  impact: "implementation",
  claim: "Required behavior is missing.",
  evidence: [
    {
      revision: "abcdef012345",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      excerpt: "return false",
    },
  ],
  confidence: 0.9,
  suggestedAction: "Implement it.",
  criterionIds: ["AC-1"],
  verified: true,
};

describe("budget and verdict invariants", () => {
  test("tracks calls and token consumption", () => {
    const budget = new UsageBudget({ maxCalls: 2, maxOutputTokens: 100, deadlineMs: 10_000 });
    budget.reserveCall(40);
    budget.recordUsage(20, 30);
    expect(budget.snapshot()).toEqual({
      inputTokens: 20,
      outputTokens: 30,
      calls: 1,
      baseInputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      thinkingTokens: 0,
    });
  });

  test("stops before a call that would exceed limits", () => {
    const budget = new UsageBudget({ maxCalls: 1, maxOutputTokens: 10, deadlineMs: 10_000 });
    budget.reserveCall(10);
    expect(() => budget.reserveCall(1)).toThrow(ReviewerError);
  });

  test("counts outstanding concurrent reservations before starting another call", () => {
    const budget = new UsageBudget({ maxCalls: 3, maxOutputTokens: 100, deadlineMs: 10_000 });
    const first = budget.reserveCall(60);
    expect(() => budget.reserveCall(50)).toThrow("output-token budget");
    budget.releaseReservation(first);
    expect(() => budget.reserveCall(50)).not.toThrow();
  });

  test("verified high required-criterion findings block", () => {
    expect(
      calculateVerdict({
        status: "completed",
        findings: [highFinding],
        pendingDecisions: [],
        sddApproved: true,
      }),
    ).toBe("RIESGO_BLOQUEANTE");
  });

  test("an incomplete review can never be green", () => {
    expect(
      calculateVerdict({
        status: "incomplete",
        findings: [],
        pendingDecisions: [],
        sddApproved: true,
      }),
    ).toBe("REQUIERE_DECISION");
  });

  test("a completed review with only low improvements has no blocking findings", () => {
    expect(
      calculateVerdict({
        status: "completed",
        findings: [{ ...highFinding, severity: "low", criterionIds: [] }],
        pendingDecisions: [],
        sddApproved: true,
      }),
    ).toBe("SIN_HALLAZGOS_BLOQUEANTES");
  });
});
