import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../../src/domain/contracts.ts";
import { classifyReviewChange, createReviewSlices, sliceKindOf } from "../../src/review/slicer.ts";

function changedFile(path: string, content = "change"): ChangedFile {
  return {
    oldPath: path,
    path,
    status: "modified",
    patch: `+${content}`,
    headContent: content,
    baseContent: "old",
    binary: false,
    truncated: false,
    additions: 1,
    deletions: 1,
  };
}

describe("review slicer", () => {
  test("classifies common test paths and review scope", () => {
    expect(sliceKindOf("tests/discount.ts")).toBe("tests");
    expect(sliceKindOf("src/discount.test.ts")).toBe("tests");
    expect(sliceKindOf("src/__tests__/discount.ts")).toBe("tests");
    expect(sliceKindOf("src/discount.ts")).toBe("implementation");
    expect(classifyReviewChange([changedFile("src/discount.ts")])).toBe("implementation_only");
    expect(
      classifyReviewChange([changedFile("src/discount.ts"), changedFile("tests/discount.test.ts")]),
    ).toBe("implementation_with_tests");
    expect(classifyReviewChange([changedFile("tests/discount.test.ts")])).toBe("test_only");
  });

  test("attaches related tests to the matching implementation domain without duplication", () => {
    const slices = createReviewSlices(
      [
        changedFile("src/billing/discount.ts"),
        changedFile("src/auth/policy.ts"),
        changedFile("tests/auth/policy.test.ts"),
        changedFile("tests/billing/discount.test.ts"),
      ],
      [],
    );
    expect(slices).toHaveLength(2);
    const billing = slices.find((slice) =>
      slice.implementationFiles.some((file) => file.path.includes("billing")),
    );
    const auth = slices.find((slice) =>
      slice.implementationFiles.some((file) => file.path.includes("auth")),
    );
    expect(billing?.testFiles.map((file) => file.path)).toEqual(["tests/billing/discount.test.ts"]);
    expect(auth?.testFiles.map((file) => file.path)).toEqual(["tests/auth/policy.test.ts"]);
    expect(slices.flatMap((slice) => slice.testFiles)).toHaveLength(2);
    expect(slices.every((slice) => slice.scope === "implementation")).toBeTrue();
  });

  test("does not mix unrelated implementation domains when within the slice bound", () => {
    const slices = createReviewSlices(
      [changedFile("src/auth/policy.ts"), changedFile("src/billing/invoice.ts")],
      [],
    );
    expect(slices).toHaveLength(2);
    expect(slices.every((slice) => slice.implementationFiles.length === 1)).toBeTrue();
  });

  test("produces explicit test-only slices without implementation files", () => {
    const slices = createReviewSlices(
      [changedFile("tests/auth/policy.test.ts"), changedFile("tests/auth/session.test.ts")],
      [],
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]?.scope).toBe("test_only");
    expect(slices[0]?.implementationFiles).toEqual([]);
    expect(slices[0]?.testFiles).toHaveLength(2);
  });

  test("preserves the character budget and marks conservative truncation", () => {
    const slices = createReviewSlices(
      [changedFile("src/discount.ts", "x".repeat(1_000))],
      [],
      3,
      120,
    );
    expect(slices[0]?.truncated).toBeTrue();
    expect(slices[0]?.implementationFiles[0]?.truncated).toBeTrue();
    const file = slices[0]?.implementationFiles[0];
    const chars =
      (file?.path.length ?? 0) +
      (file?.patch?.length ?? 0) +
      (file?.headContent?.length ?? 0) +
      (file?.baseContent?.length ?? 0);
    expect(chars).toBeLessThanOrEqual(120);
  });
});
