import { describe, expect, test } from "bun:test";
import type { StructuredAgentClient } from "../../src/anthropic/agent-client.ts";
import type { ReviewContext } from "../../src/review/context-builder.ts";
import { runCodeSlices } from "../../src/review/slice-executor.ts";
import { NEVER_ABORTED } from "../helpers/fakes.ts";

const context: ReviewContext = {
  snapshot: {
    number: 1,
    title: "feat(001): empty",
    description: "",
    author: "dev",
    sourceBranch: "feature/001-empty",
    targetBranch: "main",
    headSha: "aaaaaaaaaaaaaaaa",
    baseSha: "bbbbbbbbbbbbbbbb",
    headRepository: "acme/repo",
    baseRepository: "acme/repo",
    diff: "",
    files: [],
  },
  feature: { number: "001", origin: "title", directory: "specs/001-empty" },
  artifacts: [],
  limitations: [],
};

describe("slice executor", () => {
  test("returns immediately when there are no review slices", async () => {
    let calls = 0;
    const client: StructuredAgentClient = {
      async run() {
        calls += 1;
        throw new Error("The client must not be called for an empty slice set.");
      },
    };

    const result = await runCodeSlices({
      slices: [],
      context,
      sdd: {
        objectives: [],
        criteria: [],
        constraints: [],
        tasks: [],
        decisions: [],
        conflicts: [],
        sddApproved: true,
      },
      changedFileInventory: [],
      client,
      signal: NEVER_ABORTED,
    });

    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });
});
