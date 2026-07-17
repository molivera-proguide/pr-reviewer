import { describe, expect, test } from "bun:test";
import type { ChangeRequestSnapshot } from "../../src/domain/contracts.ts";
import { globalAgentLimitations } from "../../src/review/coverage-projection.ts";
import type { CodeSliceResult } from "../../src/review/slice-executor.ts";

function snapshot(truncated: boolean): ChangeRequestSnapshot {
  return {
    number: 1,
    title: "feat(001): verify limits",
    description: "",
    author: "dev",
    sourceBranch: "feature/001-limits",
    targetBranch: "main",
    headSha: "aaaaaaaaaaaaaaaa",
    baseSha: "bbbbbbbbbbbbbbbb",
    headRepository: "acme/repo",
    baseRepository: "acme/repo",
    diff: "+change",
    files: [
      {
        oldPath: "src/feature.ts",
        path: "src/feature.ts",
        status: "modified",
        patch: "+change",
        headContent: truncated ? null : "change",
        baseContent: "old",
        binary: false,
        truncated,
        additions: 1,
        deletions: 1,
      },
    ],
  };
}

const result: CodeSliceResult = {
  status: "completed",
  sliceId: "slice-1",
  sliceScope: "implementation",
  assignedCriteria: 1,
  assessmentStatus: "complete",
  diagnostics: [],
  analysis: {
    findings: [],
    coverage: [],
    acceptedCriterionIds: ["AC-001"],
    rejectedCriterionIds: [],
    limitations: [
      {
        scope: "global_unavailability",
        description: "Untrusted model-specific explanation.",
      },
    ],
  },
};

describe("global limitation projection", () => {
  test("drops an agent global limitation when the snapshot does not confirm it", () => {
    expect(globalAgentLimitations([result], snapshot(false))).toEqual([]);
  });

  test("uses a deterministic message when unavailable content confirms the limitation", () => {
    const limitations = globalAgentLimitations([result], snapshot(true));

    expect(limitations).toEqual([
      "Agent-reported global unavailability was confirmed for 1 changed file(s).",
    ]);
    expect(limitations.join(" ")).not.toContain("Untrusted");
  });
});
