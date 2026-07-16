import { describe, expect, test } from "bun:test";
import type { ChangeRequestSnapshot, Finding, ReviewCoverage } from "../../src/domain/contracts.ts";
import {
  codeAnalysisSchema,
  semanticVerificationSchema,
  testOnlyAnalysisSchema,
} from "../../src/review/agents/schemas.ts";
import {
  applySeverityCap,
  normalizeTestCoverageFinding,
  omittedImplementationCriteria,
  stableFindingId,
} from "../../src/review/pipeline.ts";
import { calculateVerdict } from "../../src/review/verdict.ts";

const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const evidence = {
  revision: headSha,
  path: "src/rates.ts",
  startLine: 1,
  endLine: 1,
  excerpt: "export const rate = 10;",
};
const agentFinding = {
  id: "F-1",
  severity: "high" as const,
  category: "contract",
  impact: "implementation" as const,
  claim: "The Silver rate is incorrect.",
  evidence: [evidence],
  confidence: 0.95,
  suggestedAction: "Use the specified rate.",
  criterionIds: ["AC-002"],
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ...agentFinding,
    verified: true,
    ...overrides,
  };
}

const snapshot: ChangeRequestSnapshot = {
  number: 1,
  title: "Feature 001",
  description: "",
  author: "dev",
  sourceBranch: "feature/001",
  targetBranch: "main",
  headSha,
  baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  headRepository: "example/repo",
  baseRepository: "example/repo",
  diff: "+rate",
  files: [
    {
      oldPath: "src/rates.ts",
      path: "src/rates.ts",
      status: "modified",
      patch: "+export const rate = 10;",
      headContent: "export const rate = 10;",
      baseContent: "export const rate = 5;",
      binary: false,
      truncated: false,
      additions: 1,
      deletions: 1,
    },
  ],
};

const criteria = [
  { id: "AC-001", description: "Bronze", required: true, sourcePath: "spec.md" },
  { id: "AC-002", description: "Silver", required: true, sourcePath: "spec.md" },
];

describe("semantic stability policies", () => {
  test("uses criterion-keyed implementation findings and rejects multi-criterion semantic decisions", () => {
    expect(
      codeAnalysisSchema.safeParse({
        reviews: [
          {
            criterionId: "AC-001",
            implementation: {
              status: "defect",
              finding: {
                id: agentFinding.id,
                severity: agentFinding.severity,
                category: agentFinding.category,
                claim: agentFinding.claim,
                evidence: agentFinding.evidence,
                confidence: agentFinding.confidence,
                suggestedAction: agentFinding.suggestedAction,
              },
            },
          },
        ],
        maintainabilityFindings: [],
        limitations: [],
      }).success,
    ).toBeTrue();
    expect(
      semanticVerificationSchema.safeParse({
        decisions: [
          {
            findingId: "F-1",
            confirmed: true,
            rationale: "Both were claimed.",
            adjustedSeverity: "high",
            adjustedImpact: "implementation",
            testCoverageStatus: null,
            confirmedCriterionIds: ["AC-001", "AC-002"],
          },
        ],
      }).success,
    ).toBeFalse();
  });

  test("accepts criterion-free maintainability and separate findings sharing evidence", () => {
    const parsed = codeAnalysisSchema.safeParse({
      reviews: ["AC-001", "AC-002"].map((criterionId) => ({
        criterionId,
        implementation: {
          status: "defect",
          finding: {
            id: `F-${criterionId}`,
            severity: agentFinding.severity,
            category: agentFinding.category,
            claim: agentFinding.claim,
            evidence: agentFinding.evidence,
            confidence: agentFinding.confidence,
            suggestedAction: agentFinding.suggestedAction,
          },
        },
      })),
      maintainabilityFindings: [
        {
          ...agentFinding,
          id: "F-M",
          impact: "maintainability",
          severity: "low",
          claim: "The rate table can be clearer.",
          criterionIds: [],
        },
      ],
      limitations: [],
    });
    expect(parsed.success).toBeTrue();
  });

  test("keeps contractual IDs stable across wording, category, and evidence-range changes", () => {
    const original = finding();
    const reworded = finding({
      category: "Silver calculation",
      claim: "AC-002 is violated because every non-guest receives ten percent.",
      evidence: [
        {
          ...evidence,
          startLine: 1,
          endLine: 2,
          excerpt: "export const rate = 10;\nexport const cap = 5000;",
        },
      ],
    });
    expect(stableFindingId(reworded)).toBe(stableFindingId(original));
    expect(stableFindingId(finding({ criterionIds: ["AC-001"] }))).not.toBe(
      stableFindingId(original),
    );
  });

  test("keeps test observations separate from implementation outcomes", () => {
    for (const testCoverageStatus of ["partial", "missing"] as const) {
      expect(
        codeAnalysisSchema.safeParse({
          reviews: [
            {
              criterionId: "AC-002",
              implementation: {
                status: "covered",
                evidence: [evidence],
                notes: "Implementation is complete.",
              },
              tests: {
                status: testCoverageStatus,
                evidence: [{ ...evidence, path: "tests/rates.test.ts" }],
                notes: "Assertions are incomplete.",
              },
            },
          ],
          maintainabilityFindings: [],
          limitations: [],
        }).success,
      ).toBeTrue();
    }
  });

  test("accepts derivable test-gap metadata but keeps evidence mandatory", () => {
    const base = {
      evidence: [{ ...evidence, path: "tests/rates.test.ts" }],
      notes: "Silver is not asserted.",
    };
    expect(
      testOnlyAnalysisSchema.safeParse({
        assessments: [{ criterionId: "AC-002", observation: { ...base, status: "missing" } }],
        maintainabilityFindings: [],
        limitations: [],
      }).success,
    ).toBeTrue();
    expect(
      testOnlyAnalysisSchema.safeParse({
        assessments: [
          {
            criterionId: "AC-002",
            observation: {
              status: "missing",
              evidence: [],
              notes: "Missing evidence.",
            },
          },
        ],
        maintainabilityFindings: [],
        limitations: [],
      }).success,
    ).toBeFalse();
  });

  test("treats a confirmed test gap with assertion evidence as partial", () => {
    const normalized = normalizeTestCoverageFinding(
      finding({
        impact: "test_coverage",
        severity: "medium",
        testCoverageStatus: "missing",
        evidence: [
          {
            ...evidence,
            path: "tests/rates.test.ts",
            excerpt: "expect(calculateRate(100)).toBe(10);",
          },
        ],
      }),
    );
    expect(normalized.testCoverageStatus).toBe("partial");
    expect(
      normalizeTestCoverageFinding(
        finding({
          impact: "test_coverage",
          severity: "medium",
          testCoverageStatus: "missing",
        }),
      ).testCoverageStatus,
    ).toBe("missing");
    expect(
      normalizeTestCoverageFinding(
        finding({
          impact: "test_coverage",
          severity: "medium",
          testCoverageStatus: "missing",
          claim: "Silver has no test coverage.",
          evidence: [
            {
              ...evidence,
              path: "tests/rates.test.ts",
              excerpt: 'expect(calculateRate("gold")).toBe(10);',
            },
          ],
        }),
      ).testCoverageStatus,
    ).toBe("missing");
  });

  test("caps severity by impact", () => {
    expect(applySeverityCap(finding({ impact: "test_coverage", severity: "high" })).severity).toBe(
      "medium",
    );
    expect(
      applySeverityCap(finding({ impact: "maintainability", severity: "high" })).severity,
    ).toBe("low");
    expect(
      applySeverityCap(finding({ impact: "implementation", severity: "critical" })).severity,
    ).toBe("critical");
  });

  test("only verified implementation findings can block", () => {
    expect(
      calculateVerdict({
        status: "completed",
        findings: [finding({ impact: "test_coverage", severity: "high" })],
        pendingDecisions: [],
        sddApproved: true,
      }),
    ).toBe("REQUIERE_DECISION");
    expect(
      calculateVerdict({
        status: "completed",
        findings: [finding({ impact: "implementation", severity: "high" })],
        pendingDecisions: [],
        sddApproved: true,
      }),
    ).toBe("RIESGO_BLOQUEANTE");
    expect(
      calculateVerdict({
        status: "incomplete",
        findings: [finding({ impact: "test_coverage", severity: "medium" })],
        pendingDecisions: [],
        sddApproved: true,
      }),
    ).not.toBe("SIN_HALLAZGOS_BLOQUEANTES");
  });

  test("detects only required criteria without valid coverage or a verified finding", () => {
    const candidates: ReviewCoverage[] = [
      {
        criterionId: "AC-001",
        description: "Bronze",
        status: "covered",
        evidence: [evidence],
        notes: "Verified.",
      },
    ];
    expect(
      omittedImplementationCriteria({ snapshot, criteria, candidates, findings: [] }).map(
        (criterion) => criterion.id,
      ),
    ).toEqual(["AC-002"]);
    expect(
      omittedImplementationCriteria({
        snapshot,
        criteria,
        candidates,
        findings: [finding()],
      }),
    ).toEqual([]);
    expect(
      omittedImplementationCriteria({
        snapshot,
        criteria,
        candidates: candidates.map((candidate) => ({ ...candidate, status: "partial" })),
        findings: [],
      }).map((criterion) => criterion.id),
    ).toEqual(["AC-001", "AC-002"]);
  });
});
