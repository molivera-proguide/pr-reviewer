import { describe, expect, test } from "bun:test";
import {
  AgentExecutionError,
  type AgentRequest,
  type AgentResponse,
  type StructuredAgentClient,
} from "../../src/anthropic/agent-client.ts";
import { estimateReviewCost } from "../../src/anthropic/pricing.ts";
import type {
  AgentFailureKind,
  AttemptSummary,
  ChangeRequestSnapshot,
} from "../../src/domain/contracts.ts";
import { buildReviewContext } from "../../src/review/context-builder.ts";
import { runReviewPipeline } from "../../src/review/pipeline.ts";
import { calculateVerdict } from "../../src/review/verdict.ts";
import { UsageBudget } from "../../src/security/budget.ts";

const headSha = "ecb4ccfd7d3815f1538856706ca55980d2f3f979";
const baseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const discountContent = [
  "export function discount(tier: string, cents: number) {",
  '  if (tier === "Bronze") return 0;',
  "  const rate =",
  '    tier === "Silver" ? 0.10 :',
  '    tier === "Gold" ? 0.20 : 0;',
  "  const computed = Math.round(cents * rate);",
  '  if (tier === "Silver") return computed;',
  '  if (tier === "Gold") return computed;',
  "  return computed;",
  "}",
].join("\n");

function attempt(
  request: AgentRequest<unknown>,
  status: "completed" | "failed",
  failureKind: AgentFailureKind = "refusal",
): AttemptSummary {
  return {
    role: request.role,
    model: request.role === "semantic_verifier" ? "claude-sonnet-5" : "claude-haiku-4-5-20251001",
    ...(request.sliceId === undefined ? {} : { sliceId: request.sliceId }),
    attempt: 1,
    status,
    ...(status === "failed" ? { failureKind } : {}),
    stopReason:
      status === "failed" && (failureKind === "refusal" || failureKind === "max_tokens")
        ? failureKind
        : status === "completed"
          ? "end_turn"
          : null,
    requestId: `req_${request.role}_${request.sliceId ?? "global"}`,
    statusCode: null,
    inputTokens: 100,
    outputTokens: 50,
    payloadBytes: 1_000,
    validationPaths: [],
  };
}

function snapshot(paths = ["src/discount.ts"]): ChangeRequestSnapshot {
  return {
    number: 1,
    title: "feat(001): tier discounts",
    description: "",
    author: "dev",
    sourceBranch: "feature/001-discounts",
    targetBranch: "main",
    headSha,
    baseSha,
    headRepository: "sanitized/test-pr-reviewer",
    baseRepository: "sanitized/test-pr-reviewer",
    diff: "+discount",
    files: paths.map((path) => ({
      oldPath: path,
      path,
      status: "modified" as const,
      patch: "+discount",
      headContent: path === "src/discount.ts" ? discountContent : "export const reviewed = true;",
      baseContent: null,
      binary: false,
      truncated: false,
      additions: 1,
      deletions: 0,
    })),
  };
}

const criteria = [
  {
    id: "AC-001",
    description: "Bronze receives no discount",
    required: true,
    sourcePath: "spec.md",
  },
  {
    id: "AC-002",
    description: "Silver receives five percent",
    required: true,
    sourcePath: "spec.md",
  },
  {
    id: "AC-003",
    description: "Gold is capped at 5000 cents",
    required: true,
    sourcePath: "spec.md",
  },
  {
    id: "AC-004",
    description: "Unknown tiers receive no discount",
    required: true,
    sourcePath: "spec.md",
  },
] as const;

const evidence = {
  revision: headSha,
  path: "src/discount.ts",
  startLine: 9,
  endLine: 9,
  excerpt: "return computed;",
};

const testEvidence = {
  revision: headSha,
  path: "tests/discount.test.ts",
  startLine: 1,
  endLine: 1,
  excerpt: "export const reviewed = true;",
};

function findings() {
  return [
    {
      id: "F-AC-002",
      severity: "high" as const,
      category: "contract",
      impact: "implementation" as const,
      claim: "Silver receives 10% instead of the required 5%.",
      evidence: [evidence],
      confidence: 0.99,
      suggestedAction: "Use the required Silver rate.",
      criterionIds: ["AC-002"],
    },
    {
      id: "F-AC-003",
      severity: "high" as const,
      category: "contract",
      impact: "implementation" as const,
      claim: "Gold does not apply the required 5000-cent maximum.",
      evidence: [evidence],
      confidence: 0.99,
      suggestedAction: "Cap the Gold discount at 5000 cents.",
      criterionIds: ["AC-003"],
    },
  ];
}

function misclassifiedAc4Finding() {
  return {
    id: "F-AC-004",
    severity: "low" as const,
    category: "maintainability",
    impact: "maintainability" as const,
    claim: "The explicit AC-004 total invariant is not enforced.",
    evidence: [evidence],
    confidence: 0.9,
    suggestedAction: "Enforce the required total invariant.",
    criterionIds: [],
  };
}

class RegressionClient implements StructuredAgentClient {
  readonly startedSlices: string[] = [];
  readonly completedSlices: string[] = [];
  readonly repairRequests: { maxTokens: number; payload: unknown }[] = [];
  readonly semanticPayloads: unknown[] = [];

  constructor(
    private readonly budget: UsageBudget,
    private readonly failedSlice: string | null = null,
    private readonly failureKind: "refusal" | "permanent_api" | "max_tokens" = "refusal",
    private readonly delayedSlice: string | null = null,
    private readonly omitCoverage = false,
    private readonly includeMisclassifiedAc4 = false,
    private readonly includePartialTestCoverage = false,
    private readonly repairBehavior: {
      failureKind?: AgentFailureKind;
      includeOutsideCriterion?: boolean;
      omitLastCriterion?: boolean;
      defectCriterionId?: string;
      duplicateSameOutcome?: boolean;
      invalidRepairEvidence?: boolean;
      ambiguousCriterionId?: string;
      testGapStatus?: "partial" | "missing";
      omitTestGapMetadata?: boolean;
      crossDimensionTestEvidence?: boolean;
    } = {},
  ) {}

  async run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>> {
    const reservation = this.budget.reserveCall(request.maxTokens);
    this.budget.recordUsage(100, 50, reservation);
    if (request.role === "code_explorer" && request.sliceId !== undefined) {
      this.startedSlices.push(request.sliceId);
    }
    if (request.role === "code_explorer" && request.sliceId === "coverage-repair-1") {
      this.repairRequests.push({ maxTokens: request.maxTokens, payload: request.payload });
    }
    if (request.role === "semantic_verifier") {
      this.semanticPayloads.push(request.payload);
    }
    if (request.role === "code_explorer" && request.sliceId === this.failedSlice) {
      const diagnostic = attempt(request, "failed", this.failureKind);
      throw new AgentExecutionError(this.failureKind, [diagnostic], request.role, request.sliceId);
    }
    if (request.role === "code_explorer" && request.sliceId === "coverage-repair-1") {
      if (this.repairBehavior.failureKind !== undefined) {
        const diagnostic = attempt(request, "failed", this.repairBehavior.failureKind);
        throw new AgentExecutionError(
          this.repairBehavior.failureKind,
          [diagnostic],
          request.role,
          request.sliceId,
        );
      }
    }
    if (request.role === "code_explorer" && request.sliceId === this.delayedSlice) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (request.role === "code_explorer" && request.sliceId !== undefined) {
      this.completedSlices.push(request.sliceId);
    }
    const primarySlice = request.sliceId === "slice-1" || request.sliceId === "slice-1.1";
    const requestSlice = (
      request.payload as {
        slice?: {
          scope?: "implementation" | "test_only";
          testFiles?: { path: string }[];
        };
      }
    ).slice;
    const testOnlySlice = requestSlice?.scope === "test_only";
    const hasRelatedTests = (requestSlice?.testFiles?.length ?? 0) > 0;
    const repairCriteria =
      (
        request.payload as {
          slice?: { criteria?: (typeof criteria)[number][] };
        }
      ).slice?.criteria ?? [];
    const returnedRepairCriteria = this.repairBehavior.omitLastCriterion
      ? repairCriteria.slice(0, -1)
      : repairCriteria;
    const repairEvidence = this.repairBehavior.invalidRepairEvidence
      ? [{ ...evidence, path: "src/not-present.ts" }]
      : [evidence];
    const repairAssessments: Array<
      | {
          criterionId: string;
          outcome: "covered";
          evidence: (typeof evidence)[];
          notes: string;
        }
      | {
          criterionId: string;
          outcome: "defect";
          evidence: (typeof evidence)[];
          notes: string;
          severity: "high";
          category: string;
          claim: string;
          confidence: number;
          suggestedAction: string;
        }
    > = returnedRepairCriteria.map((criterion) =>
      criterion.id === this.repairBehavior.defectCriterionId
        ? {
            criterionId: criterion.id,
            outcome: "defect" as const,
            evidence: repairEvidence,
            notes: "Directed repair found a criterion-specific defect.",
            severity: "high" as const,
            category: "contract",
            claim: `${criterion.id} is not implemented completely.`,
            confidence: 0.98,
            suggestedAction: "Implement the complete criterion.",
          }
        : {
            criterionId: criterion.id,
            outcome: "covered" as const,
            evidence: repairEvidence,
            notes: "Directed repair verified this criterion.",
          },
    );
    if (this.repairBehavior.includeOutsideCriterion) {
      repairAssessments.push({
        criterionId: "AC-999",
        outcome: "covered",
        evidence: [evidence],
        notes: "This row must be rejected.",
      });
    }
    const firstRepairAssessment = repairAssessments[0];
    if (this.repairBehavior.duplicateSameOutcome && firstRepairAssessment !== undefined) {
      repairAssessments.push({ ...firstRepairAssessment });
    }
    const testGapStatus =
      this.repairBehavior.testGapStatus ??
      (this.includePartialTestCoverage ? "partial" : undefined);
    const codeFindings = primarySlice
      ? [...findings(), ...(this.includeMisclassifiedAc4 ? [misclassifiedAc4Finding()] : [])]
      : [];
    const testObservations = criteria.map((criterion) =>
      criterion.id === "AC-003" && testGapStatus !== undefined
        ? {
            status: testGapStatus,
            evidence: [this.repairBehavior.crossDimensionTestEvidence ? evidence : testEvidence],
            notes: "The Gold cap assertion is incomplete.",
            ...(this.repairBehavior.omitTestGapMetadata
              ? {}
              : {
                  claim: "The Gold cap has no boundary assertion.",
                  confidence: 0.9,
                  suggestedAction: "Add the missing boundary assertion.",
                }),
          }
        : {
            status: "not_verifiable" as const,
            notes: "This fixture does not assess the criterion in tests.",
          },
    );
    const implementationReviews: Record<string, unknown>[] = criteria.flatMap(
      (criterion, index): Record<string, unknown>[] => {
        const defect = codeFindings.find((finding) => finding.criterionIds[0] === criterion.id);
        if (defect !== undefined) {
          return [
            {
              criterionId: criterion.id,
              implementation: {
                status: "defect" as const,
                finding: {
                  id: defect.id,
                  severity: defect.severity,
                  category: defect.category,
                  claim: defect.claim,
                  evidence: defect.evidence,
                  confidence: defect.confidence,
                  suggestedAction: defect.suggestedAction,
                },
              },
              ...(hasRelatedTests ? { tests: testObservations[index] } : {}),
            },
          ];
        }
        if (
          !primarySlice ||
          this.omitCoverage ||
          criterion.id === this.repairBehavior.ambiguousCriterionId
        ) {
          return [];
        }
        return [
          {
            criterionId: criterion.id,
            implementation: {
              status: "covered" as const,
              evidence: [evidence],
              notes: "Sanitized deterministic fixture.",
            },
            ...(hasRelatedTests ? { tests: testObservations[index] } : {}),
          },
        ];
      },
    );
    const values = {
      sdd_explorer: {
        objectives: ["Apply tier discounts"],
        criteria,
        constraints: [],
        tasks: [],
        decisions: [],
        conflicts: [],
        sddApproved: true,
      },
      code_explorer:
        request.sliceId === "coverage-repair-1"
          ? { assessments: repairAssessments }
          : testOnlySlice
            ? {
                assessments: criteria.map((criterion, index) => ({
                  criterionId: criterion.id,
                  observation: testObservations[index],
                })),
                maintainabilityFindings: [],
                limitations: [],
              }
            : {
                reviews: implementationReviews,
                maintainabilityFindings: this.includeMisclassifiedAc4
                  ? [misclassifiedAc4Finding()]
                  : [],
                limitations: [
                  {
                    scope: "slice_isolation" as const,
                    description: "Files assigned to another slice are not locally visible.",
                  },
                ],
              },
      semantic_verifier: {
        decisions: (
          (
            request.payload as {
              findings?: {
                id: string;
                claim: string;
                impact: "implementation" | "test_coverage" | "maintainability";
                testCoverageStatus?: "partial" | "missing";
                criterionIds: string[];
              }[];
            }
          ).findings ?? findings()
        ).map((finding) => ({
          findingId: finding.id,
          confirmed: true,
          rationale: "The exact implementation contradicts the required criterion.",
          adjustedSeverity: finding.claim.includes("AC-004")
            ? ("medium" as const)
            : ("high" as const),
          adjustedImpact: finding.claim.includes("AC-004")
            ? ("implementation" as const)
            : finding.impact,
          testCoverageStatus:
            finding.impact === "test_coverage" ? (finding.testCoverageStatus ?? "missing") : null,
          confirmedCriterionIds: finding.claim.includes("AC-004")
            ? ["AC-004"]
            : finding.claim.includes("Silver")
              ? ["AC-002"]
              : finding.criterionIds,
        })),
      },
    } as const;
    return {
      data: request.schema.parse(values[request.role]),
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        baseInputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        thinkingTokens: 0,
      },
      requestId: `req_${request.role}`,
      diagnostics: [attempt(request, "completed")],
    };
  }
}

function context(value: ChangeRequestSnapshot) {
  return buildReviewContext(
    value,
    { number: "001", origin: "title_and_branch", directory: "specs/001-discounts" },
    [
      {
        path: "specs/001-discounts/spec.md",
        kind: "spec",
        revision: headSha,
        content: "AC-001 through AC-004\n/sdd-review APROBADO",
        status: "loaded",
        bytes: 50,
      },
    ],
  );
}

function budget() {
  return new UsageBudget({ maxCalls: 8, maxOutputTokens: 40_000, deadlineMs: 60_000 });
}

describe("structured-output resilience regression", () => {
  test("detects the sanitized AC-002 and AC-003 regressions with exact line evidence", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.criterionIds[0])).toEqual(["AC-002", "AC-003"]);
    expect(result.findings[0]?.criterionIds).toEqual(["AC-002"]);
    expect(result.coverage.find((item) => item.criterionId === "AC-001")?.status).toBe("covered");
    expect(result.slices.some((slice) => slice.id === "coverage-repair-1")).toBeFalse();
    expect(result.coverage.find((item) => item.criterionId === "AC-002")?.notes).toContain(
      "Silver receives 10%",
    );
    expect(result.coverage.find((item) => item.criterionId === "AC-002")?.notes).not.toContain(
      "Gold",
    );
    expect(result.coverage.find((item) => item.criterionId === "AC-003")?.notes).toContain(
      "Gold does not apply",
    );
    expect(result.limitations).toEqual([]);
    expect(result.pendingDecisions).toEqual([]);
    expect(
      result.findings.every((finding) => finding.evidence[0]?.path === "src/discount.ts"),
    ).toBeTrue();
    expect(result.findings.every((finding) => finding.evidence[0]?.startLine === 9)).toBeTrue();
    expect(
      result.findings.every((finding) => finding.evidence[0]?.excerpt === "return computed;"),
    ).toBeTrue();
    expect(
      calculateVerdict({
        status: result.status,
        findings: result.findings,
        pendingDecisions: result.pendingDecisions,
        sddApproved: result.sdd.sddApproved,
      }),
    ).toBe("RIESGO_BLOQUEANTE");
  });

  test("keeps ordinary maintainability out of semantic verification", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, null, "refusal", null, false, true);
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    const maintainability = result.findings.find((finding) => finding.impact === "maintainability");
    expect(maintainability?.severity).toBe("low");
    expect(maintainability?.criterionIds).toEqual([]);
    const semanticPayload = client.semanticPayloads[0] as
      | { findings?: { impact?: string }[] }
      | undefined;
    expect(semanticPayload?.findings?.every((finding) => finding.impact === "implementation")).toBe(
      true,
    );
  });

  test("does not promote partial test coverage to covered", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts"])),
      client: new RegressionClient(usage, null, "refusal", null, false, false, true),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.testCoverage.find((item) => item.criterionId === "AC-003")?.status).toBe(
      "partial",
    );
  });

  test("repairs omitted implementation criteria exactly once with bounded diagnostics", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, null, "refusal", null, true);
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts"])),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(client.startedSlices.filter((id) => id === "coverage-repair-1")).toHaveLength(1);
    expect(result.slices.filter((slice) => slice.id === "coverage-repair-1")).toEqual([
      expect.objectContaining({ status: "completed", kind: "implementation" }),
    ]);
    expect(result.coverage.find((item) => item.criterionId === "AC-001")?.status).toBe("covered");
    expect(result.coverage.find((item) => item.criterionId === "AC-004")?.status).toBe("covered");
    expect(
      result.attemptDiagnostics.some((item) => item.sliceId === "coverage-repair-1"),
    ).toBeTrue();
    expect(client.repairRequests[0]?.maxTokens).toBeLessThan(4_000);
    const repairPayload = client.repairRequests[0]?.payload as
      | { slice?: { implementationFiles?: { path: string }[]; testFiles?: { path: string }[] } }
      | undefined;
    expect(
      repairPayload?.slice?.implementationFiles?.every((file) => !file.path.includes("test")),
    ).toBeTrue();
    expect(repairPayload?.slice?.testFiles).toEqual([]);
    expect(result.usage.calls).toBeLessThanOrEqual(4);
  });

  test("lets an accepted repair supersede an earlier ambiguous assessment", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, false, false, false, {
        ambiguousCriterionId: "AC-001",
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.coverage.find((item) => item.criterionId === "AC-001")?.status).toBe("covered");
    expect(result.slices).toContainEqual(
      expect.objectContaining({ id: "coverage-repair-1", status: "completed" }),
    );
  });

  test("accepts exactly one defect outcome from repair without a duplicate coverage row", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, true, false, false, {
        defectCriterionId: "AC-004",
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    const repaired = result.findings.find((finding) => finding.criterionIds[0] === "AC-004");
    expect(result.status).toBe("completed");
    expect(repaired).toEqual(
      expect.objectContaining({ impact: "implementation", severity: "medium", verified: true }),
    );
    expect(result.coverage.find((item) => item.criterionId === "AC-004")?.status).toBe("missing");
  });

  test("consolidates equivalent duplicate repair outcomes without another model call", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, true, false, false, {
        duplicateSameOutcome: true,
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.slices).toContainEqual(
      expect.objectContaining({ id: "coverage-repair-1", status: "completed" }),
    );
    expect(result.usage.calls).toBeLessThanOrEqual(4);
  });

  test("reports a safe repair rejection reason for invalid evidence", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, true, false, false, {
        invalidRepairEvidence: true,
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("incomplete");
    expect(result.limitations.join(" ")).toContain("invalid_evidence=2");
    expect(result.limitations.join(" ")).not.toContain("not-present");
  });

  test("rejects repair criterion IDs outside the requested set", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, true, false, false, {
        includeOutsideCriterion: true,
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.coverage.some((item) => item.criterionId === "AC-999")).toBeFalse();
  });

  test("keeps accepted repair evidence but remains incomplete when a criterion is omitted", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, null, "refusal", null, true, false, false, {
      omitLastCriterion: true,
    });
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("incomplete");
    expect(result.coverage.find((item) => item.criterionId === "AC-001")?.status).toBe("covered");
    expect(result.coverage.find((item) => item.criterionId === "AC-004")?.status).toBe(
      "not_verifiable",
    );
    expect(result.stagesIncomplete).toContain("code_exploration:coverage-repair-1");
    expect(client.startedSlices.filter((id) => id === "coverage-repair-1")).toHaveLength(1);
  });

  for (const failureKind of [
    "max_tokens",
    "refusal",
    "schema_validation",
    "cancelled",
    "budget",
  ] as const) {
    test(`preserves completed slices and does not retry after ${failureKind} repair failure`, async () => {
      const usage = budget();
      const client = new RegressionClient(usage, null, "refusal", null, true, false, false, {
        failureKind,
      });
      const result = await runReviewPipeline({
        context: context(snapshot()),
        client,
        budget: usage,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("incomplete");
      expect(result.findings.map((finding) => finding.criterionIds[0])).toEqual([
        "AC-002",
        "AC-003",
      ]);
      expect(client.startedSlices.filter((id) => id === "coverage-repair-1")).toHaveLength(1);
      expect(result.slices).toContainEqual(
        expect.objectContaining({ id: "slice-1", status: "completed" }),
      );
      expect(result.slices).toContainEqual(
        expect.objectContaining({
          id: "coverage-repair-1",
          status: "incomplete",
          failureKind,
        }),
      );
    });
  }

  test("caps high test gaps at medium without contaminating implementation coverage", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, null, "refusal", null, false, false, false, {
      testGapStatus: "partial",
    });
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts"])),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    const testGap = result.findings.find((finding) => finding.impact === "test_coverage");
    expect(testGap?.severity).toBe("medium");
    expect(testGap?.testCoverageStatus).toBe("partial");
    expect(result.testCoverage.find((item) => item.criterionId === "AC-003")?.status).toBe(
      "partial",
    );
    expect(result.coverage.find((item) => item.criterionId === "AC-003")?.status).toBe("missing");
    expect(result.coverage.find((item) => item.criterionId === "AC-003")?.notes).not.toContain(
      "boundary assertion",
    );
    const semanticPayload = client.semanticPayloads[0] as
      | { findings?: { impact?: string }[] }
      | undefined;
    expect(semanticPayload?.findings?.every((finding) => finding.impact === "implementation")).toBe(
      true,
    );
  });

  test("keeps a complete absence of relevant assertions as missing test coverage", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts"])),
      client: new RegressionClient(usage, null, "refusal", null, false, false, false, {
        testGapStatus: "missing",
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    const testGap = result.findings.find((finding) => finding.impact === "test_coverage");
    expect(testGap?.testCoverageStatus).toBe("missing");
    expect(result.testCoverage.find((item) => item.criterionId === "AC-003")?.status).toBe(
      "missing",
    );
    expect(result.coverage.find((item) => item.criterionId === "AC-003")?.status).toBe("missing");
  });

  test("rejects valid snapshot evidence when it crosses the slice dimension", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts"])),
      client: new RegressionClient(usage, null, "refusal", null, false, false, false, {
        testGapStatus: "partial",
        crossDimensionTestEvidence: true,
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.findings.some((finding) => finding.impact === "test_coverage")).toBeFalse();
    expect(result.testCoverage.find((item) => item.criterionId === "AC-003")?.status).toBe(
      "not_verifiable",
    );
    expect(result.coverage.find((item) => item.criterionId === "AC-003")?.status).toBe("missing");
    expect(result.slices.some((slice) => slice.id === "coverage-repair-1")).toBeFalse();
  });

  test("reviews test-only changes explicitly without functional incompleteness or repair", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, null, "refusal", null, false, false, false, {
      testGapStatus: "partial",
      omitTestGapMetadata: true,
    });
    const result = await runReviewPipeline({
      context: context(snapshot(["tests/discount.test.ts"])),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    const gap = result.findings.find((finding) => finding.criterionIds[0] === "AC-003");
    expect(result.reviewScope).toBe("test_only");
    expect(result.status).toBe("completed");
    expect(result.coverage.every((item) => item.status === "not_verifiable")).toBeTrue();
    expect(result.coverage.every((item) => item.notes.includes("outside the scope"))).toBeTrue();
    expect(gap).toEqual(
      expect.objectContaining({
        impact: "test_coverage",
        severity: "medium",
        testCoverageStatus: "partial",
        claim: "The Gold cap assertion is incomplete.",
        confidence: 0.7,
        suggestedAction: "Add criterion-specific assertions for AC-003.",
      }),
    );
    expect(result.slices).toEqual([
      expect.objectContaining({ scope: "test_only", status: "completed" }),
    ]);
    expect(client.startedSlices).toEqual(["slice-1"]);
    expect(client.startedSlices).not.toContain("coverage-repair-1");
    expect(result.usage.calls).toBe(2);
    expect(
      calculateVerdict({
        status: result.status,
        findings: result.findings,
        pendingDecisions: result.pendingDecisions,
        sddApproved: result.sdd.sddApproved,
      }),
    ).toBe("REQUIERE_DECISION");
  });

  test("produces stable semantic projections across three runs of the same SHA", async () => {
    const projections = [];
    for (let run = 0; run < 3; run += 1) {
      const usage = budget();
      const result = await runReviewPipeline({
        context: context(snapshot(["src/discount.ts", "tests/discount.test.ts"])),
        client: new RegressionClient(usage, null, "refusal", null, true),
        budget: usage,
        signal: new AbortController().signal,
      });
      projections.push({
        findings: result.findings.map((finding) => ({
          id: finding.id,
          criterionIds: finding.criterionIds,
          severity: finding.severity,
          impact: finding.impact,
        })),
        coverage: result.coverage.map((item) => ({
          criterionId: item.criterionId,
          status: item.status,
        })),
        testCoverage: result.testCoverage.map((item) => ({
          criterionId: item.criterionId,
          status: item.status,
        })),
        status: result.status,
        verdict: calculateVerdict({
          status: result.status,
          findings: result.findings,
          pendingDecisions: result.pendingDecisions,
          sddApproved: result.sdd.sddApproved,
        }),
        usage: result.usage,
        cost: estimateReviewCost(result.attemptDiagnostics, new Date("2026-07-14T12:00:00Z")),
      });
    }
    expect(projections[1]).toEqual(projections[0]);
    expect(projections[2]).toEqual(projections[0]);
    expect(projections[0]?.usage.calls).toBeLessThanOrEqual(4);
    expect(projections[0]?.cost.amount).toBeLessThan(0.1);
    expect(projections[0]?.cost.failedAttemptAmount).toBe(0);
  });

  test("preserves all criteria and successful slices when one domain slice refuses", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts", "docs/discount.md"])),
      client: new RegressionClient(usage, "slice-2"),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("incomplete");
    expect(result.coverage).toHaveLength(4);
    expect(result.coverage.some((item) => item.status === "not_verifiable")).toBeTrue();
    expect(result.slices.map((slice) => slice.status)).toEqual(["completed", "incomplete"]);
    expect(result.stagesIncomplete).toContain("code_exploration:slice-2");
    expect(result.pendingDecisions.join(" ")).toContain("Zero findings does not mean zero defects");
    expect(
      calculateVerdict({
        status: result.status,
        findings: result.findings,
        pendingDecisions: result.pendingDecisions,
        sddApproved: result.sdd.sddApproved,
      }),
    ).toBe("RIESGO_BLOQUEANTE");
  });

  test("splits a truncated multi-file code slice instead of repeating it", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, "slice-1", "max_tokens");
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "src/discount/other.ts"])),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(client.startedSlices).toEqual(["slice-1", "slice-1.1", "slice-1.2"]);
    expect(result.slices.map((slice) => slice.id)).toEqual(["slice-1.1", "slice-1.2"]);
    expect(result.slices.every((slice) => slice.status === "completed")).toBeTrue();
    expect(result.status).toBe("completed");
  });

  test("cannot complete green when required coverage is not verifiable", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, true, false, false, {
        failureKind: "refusal",
      }),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("incomplete");
    expect(result.stagesIncomplete).toContain("coverage:AC-001");
    expect(result.slices.filter((slice) => slice.id === "coverage-repair-1")).toHaveLength(1);
    expect(result.pendingDecisions.join(" ")).toContain("Zero findings does not mean zero defects");
  });

  test("stops scheduling after a permanent failure and awaits an in-flight worker", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, "slice-1", "permanent_api", "slice-2");
    const result = await runReviewPipeline({
      context: context(
        snapshot([
          "src/discount.ts",
          "tests/discount.test.ts",
          "docs/discount.md",
          "config/flag.ts",
        ]),
      ),
      client,
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(client.startedSlices).toEqual(["slice-1", "slice-2"]);
    expect(client.completedSlices).toEqual(["slice-2"]);
    expect(result.slices).toEqual([
      expect.objectContaining({ id: "slice-1", status: "incomplete" }),
      expect.objectContaining({ id: "slice-2", status: "completed" }),
      expect.objectContaining({ id: "slice-3", status: "incomplete" }),
    ]);
    expect(result.status).toBe("incomplete");
    expect(
      calculateVerdict({
        status: result.status,
        findings: result.findings,
        pendingDecisions: result.pendingDecisions,
        sddApproved: result.sdd.sddApproved,
      }),
    ).not.toBe("SIN_HALLAZGOS_BLOQUEANTES");
  });
});
