import { describe, expect, test } from "bun:test";
import type { ChangeRequestSnapshot } from "../../src/domain/contracts.ts";
import { ReviewerError } from "../../src/domain/errors.ts";
import type { RepositoryProvider } from "../../src/providers/provider.ts";
import { detectFeatureNumber, resolveFeature } from "../../src/sdd/feature-resolver.ts";
import { NEVER_ABORTED } from "../helpers/fakes.ts";

const snapshot: ChangeRequestSnapshot = {
  number: 7,
  title: "feat(014): enforce policy",
  description: "",
  author: "dev",
  sourceBranch: "feature/014-policy",
  targetBranch: "main",
  headSha: "abcdef0123456789",
  baseSha: "1234567890abcdef",
  headRepository: "acme/repo",
  baseRepository: "acme/repo",
  diff: "",
  files: [],
};

describe("feature resolution", () => {
  test("normalizes marker-aware feature numbers", () => {
    expect(detectFeatureNumber("feat(14): x", "topic")).toEqual({
      number: "014",
      origin: "title",
    });
  });

  test("accepts matching title and branch", () => {
    expect(detectFeatureNumber(snapshot.title, snapshot.sourceBranch)).toEqual({
      number: "014",
      origin: "title_and_branch",
    });
  });

  test("rejects conflicting sources", () => {
    expect(() => detectFeatureNumber("feat(014): x", "feature/015-y")).toThrow(
      "Title resolves to feature 014, but branch resolves to 015",
    );
  });

  test("requires exactly one remote specs directory", async () => {
    const provider = {
      listTree: async () => [
        { path: "specs/014-policy", type: "tree" as const },
        { path: "specs/014-policy/spec.md", type: "blob" as const },
      ],
    } as unknown as RepositoryProvider;
    await expect(resolveFeature(snapshot, provider, NEVER_ABORTED)).resolves.toEqual({
      number: "014",
      origin: "title_and_branch",
      directory: "specs/014-policy",
    });
  });

  test("rejects ambiguous remote specs directories", async () => {
    const provider = {
      listTree: async () => [
        { path: "specs/014-a/spec.md", type: "blob" as const },
        { path: "specs/014-b/spec.md", type: "blob" as const },
      ],
    } as unknown as RepositoryProvider;
    await expect(resolveFeature(snapshot, provider, NEVER_ABORTED)).rejects.toBeInstanceOf(
      ReviewerError,
    );
  });
});
