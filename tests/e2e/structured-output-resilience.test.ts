import { describe, expect, test } from "bun:test";
import {
  AgentExecutionError,
  type AgentRequest,
  type AgentResponse,
  type StructuredAgentClient,
} from "../../src/anthropic/agent-client.ts";
import type { AttemptSummary, ChangeRequestSnapshot } from "../../src/domain/contracts.ts";
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
  failureKind: "refusal" | "permanent_api" | "max_tokens" = "refusal",
): AttemptSummary {
  return {
    role: request.role,
    ...(request.sliceId === undefined ? {} : { sliceId: request.sliceId }),
    attempt: 1,
    status,
    ...(status === "failed" ? { failureKind } : {}),
    stopReason:
      status === "failed" && (failureKind === "refusal" || failureKind === "max_tokens")
        ? failureKind
        : "end_turn",
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
      criterionIds: ["AC-002", "AC-003"],
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
    severity: "medium" as const,
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

  constructor(
    private readonly budget: UsageBudget,
    private readonly failedSlice: string | null = null,
    private readonly failureKind: "refusal" | "permanent_api" | "max_tokens" = "refusal",
    private readonly delayedSlice: string | null = null,
    private readonly omitCoverage = false,
    private readonly includeMisclassifiedAc4 = false,
    private readonly includePartialTestCoverage = false,
  ) {}

  async run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>> {
    const reservation = this.budget.reserveCall(request.maxTokens);
    this.budget.recordUsage(100, 50, reservation);
    if (request.role === "code_explorer" && request.sliceId !== undefined) {
      this.startedSlices.push(request.sliceId);
    }
    if (request.role === "code_explorer" && request.sliceId === this.failedSlice) {
      const diagnostic = attempt(request, "failed", this.failureKind);
      throw new AgentExecutionError(this.failureKind, [diagnostic], request.role, request.sliceId);
    }
    if (request.role === "code_explorer" && request.sliceId === this.delayedSlice) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (request.role === "code_explorer" && request.sliceId !== undefined) {
      this.completedSlices.push(request.sliceId);
    }
    const primarySlice = request.sliceId === "slice-1" || request.sliceId === "slice-1.1";
    const testSlice =
      (request.payload as { slice?: { kind?: "implementation" | "tests" } }).slice?.kind ===
      "tests";
    const codeFindings = primarySlice
      ? [...findings(), ...(this.includeMisclassifiedAc4 ? [misclassifiedAc4Finding()] : [])]
      : [];
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
      code_explorer: {
        findings: codeFindings,
        coverage:
          this.includePartialTestCoverage && testSlice
            ? [
                {
                  criterionId: "AC-003",
                  dimension: "tests" as const,
                  description: "Gold is capped at 5000 cents",
                  status: "partial" as const,
                  evidence: [testEvidence],
                  notes: "The test exercises only part of the criterion.",
                },
              ]
            : primarySlice && !this.omitCoverage
              ? criteria.map((criterion) => ({
                  criterionId: criterion.id,
                  dimension: "implementation" as const,
                  description: criterion.description,
                  status:
                    criterion.id === "AC-002" || criterion.id === "AC-003"
                      ? ("missing" as const)
                      : criterion.id === "AC-001"
                        ? ("partial" as const)
                        : ("covered" as const),
                  evidence: [evidence],
                  notes: "Sanitized deterministic fixture.",
                }))
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
          confirmedCriterionIds: finding.claim.includes("AC-004")
            ? ["AC-004"]
            : finding.claim.includes("Silver")
              ? ["AC-002"]
              : finding.criterionIds,
        })),
      },
      synthesizer: {
        coverage: criteria.map((criterion) => ({
          criterionId: criterion.id,
          description: criterion.description,
          status: criterion.id === "AC-002" || criterion.id === "AC-003" ? "missing" : "covered",
          evidence: [evidence],
          notes: "Sanitized deterministic fixture.",
        })),
        risks: ["Incorrect customer discount"],
        pendingDecisions: [
          {
            question: "Should ordinary implementation choices be escalated?",
            conflictIndexes: [0],
          },
        ],
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

  test("lets semantic verification reclassify an explicit criterion violation", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot()),
      client: new RegressionClient(usage, null, "refusal", null, false, true),
      budget: usage,
      signal: new AbortController().signal,
    });
    const ac4 = result.findings.find((finding) => finding.criterionIds.includes("AC-004"));
    expect(ac4?.impact).toBe("implementation");
    expect(result.coverage.find((item) => item.criterionId === "AC-004")?.status).toBe("missing");
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

  test("preserves four criteria and successful slices when one of three slices refuses", async () => {
    const usage = budget();
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts", "docs/discount.md"])),
      client: new RegressionClient(usage, "slice-2"),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("incomplete");
    expect(result.coverage).toHaveLength(4);
    expect(result.coverage.filter((item) => item.status === "missing")).toHaveLength(2);
    expect(result.coverage.filter((item) => item.status === "partial")).toHaveLength(2);
    expect(result.findings).toHaveLength(2);
    expect(result.slices.map((slice) => slice.status)).toEqual([
      "completed",
      "incomplete",
      "completed",
    ]);
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
      context: context(snapshot(["src/discount.ts", "src/other.ts"])),
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
      client: new RegressionClient(usage, null, "refusal", null, true),
      budget: usage,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("incomplete");
    expect(result.stagesIncomplete).toContain("coverage:AC-001");
    expect(result.pendingDecisions).toEqual([]);
  });

  test("stops scheduling after a permanent failure and awaits an in-flight worker", async () => {
    const usage = budget();
    const client = new RegressionClient(usage, "slice-1", "permanent_api", "slice-2");
    const result = await runReviewPipeline({
      context: context(snapshot(["src/discount.ts", "tests/discount.test.ts", "docs/discount.md"])),
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
