import { describe, expect, test } from "bun:test";
import type {
  AgentRequest,
  AgentResponse,
  StructuredAgentClient,
} from "../../src/anthropic/agent-client.ts";
import type { ChangedFile } from "../../src/domain/contracts.ts";
import type { SddCriterion, SlicePlanProposal } from "../../src/review/agents/schemas.ts";
import {
  planReviewSlices,
  shouldUseSingleSlice,
  validateSlicePlan,
} from "../../src/review/slice-planner.ts";
import { NEVER_ABORTED } from "../helpers/fakes.ts";

function changedFile(path: string, content = "export const value = true;"): ChangedFile {
  return {
    oldPath: path,
    path,
    status: "modified",
    patch: `+${content}`,
    headContent: content,
    baseContent: "",
    binary: false,
    truncated: false,
    additions: 1,
    deletions: 0,
  };
}

const criteria: SddCriterion[] = [
  {
    id: "AC-001",
    description: "A silver customer receives the configured discount.",
    required: true,
    sourcePath: "specs/001/spec.md",
  },
  {
    id: "AC-002",
    description: "The cart total applies the discount.",
    required: true,
    sourcePath: "specs/001/spec.md",
  },
];

function clientFor(proposal: SlicePlanProposal, roles: string[]): StructuredAgentClient {
  return {
    async run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>> {
      roles.push(request.role);
      return {
        data: request.schema.parse(proposal),
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          baseInputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          thinkingTokens: 0,
        },
        requestId: "req_planner",
        diagnostics: [],
      };
    },
  };
}

describe("hybrid slice planning", () => {
  test("uses one holistic slice for a bounded cross-file change", async () => {
    const files = [
      changedFile("src/cart.ts"),
      changedFile("src/discount.ts"),
      changedFile("tests/cart.test.ts"),
    ];
    const roles: string[] = [];

    const result = await planReviewSlices({
      files,
      criteria,
      client: clientFor({ slices: [] }, roles),
      signal: NEVER_ABORTED,
    });

    expect(shouldUseSingleSlice(files, criteria)).toBeTrue();
    expect(roles).toEqual([]);
    expect(result.summary.mode).toBe("single");
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]?.criteria.map((criterion) => criterion.id)).toEqual([
      "AC-001",
      "AC-002",
    ]);
    expect(result.slices[0]?.implementationFiles.map((file) => file.path).sort()).toEqual([
      "src/cart.ts",
      "src/discount.ts",
    ]);
  });

  test("accepts and canonicalizes a valid model plan for a large inventory", async () => {
    const files = Array.from({ length: 21 }, (_, index) =>
      changedFile(`src/domain-${String(index).padStart(2, "0")}.ts`),
    );
    const roles: string[] = [];
    const proposal: SlicePlanProposal = {
      slices: [
        {
          criterionIds: ["AC-002", "AC-001"],
          implementationPaths: files.map((file) => file.path),
          testPaths: [],
        },
      ],
    };

    const result = await planReviewSlices({
      files,
      criteria,
      client: clientFor(proposal, roles),
      signal: NEVER_ABORTED,
    });

    expect(roles).toEqual(["slice_planner"]);
    expect(result.summary.mode).toBe("model");
    expect(result.slices[0]?.id).toBe("slice-1");
    expect(result.slices[0]?.criteria.map((criterion) => criterion.id)).toEqual([
      "AC-001",
      "AC-002",
    ]);
  });

  test("rejects invented paths and requires exact criterion coverage", () => {
    const files = [changedFile("src/discount.ts")];
    const invented = validateSlicePlan({
      proposal: {
        slices: [
          {
            criterionIds: ["AC-001", "AC-002"],
            implementationPaths: ["src/invented.ts"],
            testPaths: [],
          },
        ],
      },
      files,
      criteria,
    });
    const omitted = validateSlicePlan({
      proposal: {
        slices: [
          {
            criterionIds: ["AC-001"],
            implementationPaths: ["src/discount.ts"],
            testPaths: [],
          },
        ],
      },
      files,
      criteria,
    });

    expect(invented).toEqual({ success: false, reason: "unknown_path" });
    expect(omitted).toEqual({ success: false, reason: "criterion_coverage_invalid" });
  });

  test("allows a file-only slice while assigning each criterion exactly once", () => {
    const files = [changedFile("src/discount.ts"), changedFile("src/telemetry.ts")];
    const result = validateSlicePlan({
      proposal: {
        slices: [
          {
            criterionIds: ["AC-001", "AC-002"],
            implementationPaths: ["src/discount.ts"],
            testPaths: [],
          },
          {
            criterionIds: [],
            implementationPaths: ["src/telemetry.ts"],
            testPaths: [],
          },
        ],
      },
      files,
      criteria,
    });

    expect(result.success).toBeTrue();
    if (result.success) expect(result.slices).toHaveLength(2);
  });

  test("falls back deterministically when the model plan is invalid", async () => {
    const files = Array.from({ length: 21 }, (_, index) =>
      changedFile(`src/domain-${String(index).padStart(2, "0")}.ts`),
    );
    const result = await planReviewSlices({
      files,
      criteria,
      client: clientFor(
        {
          slices: [
            {
              criterionIds: ["AC-001", "AC-002"],
              implementationPaths: ["src/invented.ts"],
              testPaths: [],
            },
          ],
        },
        [],
      ),
      signal: NEVER_ABORTED,
    });

    expect(result.summary).toEqual(
      expect.objectContaining({
        mode: "deterministic_fallback",
        fallbackReason: "unknown_path",
      }),
    );
    expect(result.slices.length).toBeGreaterThan(0);
  });
});
