import { describe, expect, test } from "bun:test";
import { mapPipelineReviewResult, staleReviewResult } from "../../src/application/review-result.ts";
import type { PipelineResult } from "../../src/review/pipeline.ts";

const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const pipeline: PipelineResult = {
  reviewScope: "implementation",
  sdd: {
    objectives: [],
    criteria: [],
    constraints: [],
    tasks: [],
    decisions: [],
    conflicts: [],
    sddApproved: true,
  },
  coverage: [
    {
      criterionId: "AC-001",
      description: "Required behavior",
      status: "covered",
      evidence: [],
      notes: "Covered.",
    },
  ],
  testCoverage: [
    {
      criterionId: "AC-001",
      description: "Required behavior",
      status: "partial",
      evidence: [],
      notes: "Partial.",
    },
  ],
  findings: [
    {
      id: "finding-1",
      severity: "high",
      category: "contract",
      impact: "implementation",
      claim: "The required behavior is missing.",
      evidence: [
        {
          revision: sha,
          path: "src/example.ts",
          startLine: 1,
          endLine: 1,
          excerpt: "export const value = 1;",
        },
      ],
      confidence: 0.95,
      suggestedAction: "Implement it.",
      criterionIds: ["AC-001"],
      verified: true,
    },
  ],
  risks: [],
  pendingDecisions: [],
  limitations: [],
  stagesIncomplete: [],
  slices: [],
  attemptDiagnostics: [],
  status: "completed",
  usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
};

describe("review result projection", () => {
  test("creates a conservative stale result without a report", () => {
    const result = staleReviewResult({
      reviewId: "review-1",
      provider: "github",
      repository: "example/repo",
      root: "C:/repo",
      number: 7,
      expectedHeadSha: sha,
      currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(result.status).toBe("stale");
    expect(result.verdict).toBe("REQUIERE_DECISION");
    expect(result.reviewedHeadSha).toBeNull();
    expect(result.reportPath).toBeNull();
    expect(result.usage.calls).toBe(0);
  });

  test("summarizes pipeline findings and both coverage dimensions", () => {
    const result = mapPipelineReviewResult({
      reviewId: "review-2",
      pipeline,
      status: "completed",
      verdict: "RIESGO_BLOQUEANTE",
      provider: "github",
      repository: "example/repo",
      root: "C:/repo",
      number: 7,
      expectedHeadSha: sha,
      reviewedHeadSha: sha,
      currentHeadSha: sha,
      reportPath: "C:/reports/review-2.html",
    });

    expect(result.findingCount).toBe(1);
    expect(result.blockingFindingCount).toBe(1);
    expect(result.coverageSummary.covered).toBe(1);
    expect(result.testCoverageSummary.partial).toBe(1);
    expect(result.topFindings[0]).toEqual(
      expect.objectContaining({ path: "src/example.ts", line: 1 }),
    );
  });
});
