import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../../src/domain/contracts.ts";
import { createReviewSlices, sliceKindOf } from "../../src/review/slicer.ts";

function changedFile(path: string): ChangedFile {
  return {
    oldPath: path,
    path,
    status: "modified",
    patch: "+change",
    headContent: "change",
    baseContent: "old",
    binary: false,
    truncated: false,
    additions: 1,
    deletions: 1,
  };
}

describe("review slicer", () => {
  test("classifies common test paths", () => {
    expect(sliceKindOf("tests/discount.ts")).toBe("tests");
    expect(sliceKindOf("src/discount.test.ts")).toBe("tests");
    expect(sliceKindOf("src/__tests__/discount.ts")).toBe("tests");
    expect(sliceKindOf("src/discount.ts")).toBe("implementation");
  });

  test("never mixes implementation and test files in one slice", () => {
    const slices = createReviewSlices(
      [
        changedFile("src/discount.ts"),
        changedFile("tests/discount.test.ts"),
        changedFile("docs/discount.md"),
      ],
      [],
    );
    expect(slices).toHaveLength(3);
    expect(
      slices.every((slice) => slice.files.every((file) => sliceKindOf(file.path) === slice.kind)),
    ).toBeTrue();
  });
});
