import { describe, expect, test } from "bun:test";
import type { ChangeRequestSnapshot } from "../../src/domain/contracts.ts";
import type { CodeAnalysis } from "../../src/review/agents/schemas.ts";
import { codeFirstAnalysisToSliceAnalysis } from "../../src/review/slice-analysis.ts";
import type { ReviewSlice } from "../../src/review/slicer.ts";

const headSha = "aaaaaaaaaaaaaaaa";
const baseSha = "bbbbbbbbbbbbbbbb";
const implementationFile = {
  oldPath: "src/feature.ts",
  path: "src/feature.ts",
  status: "modified" as const,
  patch: "+export const enabled = true;",
  headContent: "export const enabled = true;\n",
  baseContent: "export const enabled = false;\n",
  binary: false,
  truncated: false,
  additions: 1,
  deletions: 1,
};
const snapshot: ChangeRequestSnapshot = {
  number: 1,
  title: "feat(001): enable feature",
  description: "",
  author: "dev",
  sourceBranch: "feature/001-enable",
  targetBranch: "main",
  headSha,
  baseSha,
  headRepository: "acme/repo",
  baseRepository: "acme/repo",
  diff: implementationFile.patch,
  files: [implementationFile],
};
const slice: ReviewSlice = {
  id: "slice-1",
  scope: "implementation",
  criteria: [
    {
      id: "AC-001",
      description: "The feature is enabled.",
      required: true,
      sourcePath: "specs/001/spec.md",
    },
  ],
  implementationFiles: [implementationFile],
  testFiles: [],
  truncated: false,
};

describe("slice analysis projection", () => {
  test("accepts exact evidence confined to the implementation slice", () => {
    const analysis: CodeAnalysis = {
      reviews: [
        {
          criterionId: "AC-001",
          implementation: {
            status: "covered",
            evidence: [
              {
                revision: headSha,
                path: "src/feature.ts",
                startLine: 1,
                endLine: 1,
                excerpt: "export const enabled = true;",
              },
            ],
            notes: "The implementation directly enables the feature.",
          },
        },
      ],
      maintainabilityFindings: [],
      limitations: [],
    };

    const result = codeFirstAnalysisToSliceAnalysis({ analysis, slice, snapshot });

    expect(result.complete).toBeTrue();
    expect(result.analysis.findings).toEqual([]);
    expect(result.analysis.coverage).toEqual([
      expect.objectContaining({
        criterionId: "AC-001",
        dimension: "implementation",
        status: "covered",
      }),
    ]);
  });

  test("rejects evidence outside the assigned slice", () => {
    const analysis: CodeAnalysis = {
      reviews: [
        {
          criterionId: "AC-001",
          implementation: {
            status: "covered",
            evidence: [
              {
                revision: headSha,
                path: "src/other.ts",
                startLine: 1,
                endLine: 1,
                excerpt: "export const enabled = true;",
              },
            ],
            notes: "Invalid cross-slice evidence.",
          },
        },
      ],
      maintainabilityFindings: [],
      limitations: [],
    };

    const result = codeFirstAnalysisToSliceAnalysis({ analysis, slice, snapshot });

    expect(result.analysis.coverage).toEqual([]);
    expect(result.limitation).toContain("invalid_evidence=1");
  });
});
