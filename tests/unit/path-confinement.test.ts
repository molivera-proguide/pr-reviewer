import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerError } from "../../src/domain/errors.ts";
import {
  confinedPath,
  isPathWithin,
  resolveRepositoryRoot,
} from "../../src/security/path-confinement.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sdd-reviewer-path-"));
  temporaryPaths.push(root);
  await mkdir(join(root, ".git"));
  return root;
}

describe("path confinement", () => {
  test("resolves an explicit Git root", async () => {
    const root = await repository();
    await expect(resolveRepositoryRoot({ repositoryPath: root })).resolves.toBe(
      await realpath(root),
    );
  });

  test("enforces client-approved roots", async () => {
    const root = await repository();
    const other = await repository();
    await expect(
      resolveRepositoryRoot({ repositoryPath: root, clientRoots: [other] }),
    ).rejects.toBeInstanceOf(ReviewerError);
  });

  test("does not silently use cwd", async () => {
    await expect(resolveRepositoryRoot({})).rejects.toThrow("ambiguous");
  });

  test("rejects traversal and absolute paths", async () => {
    const root = await repository();
    await expect(confinedPath(root, "../secret")).rejects.toBeInstanceOf(ReviewerError);
    await expect(confinedPath(root, join(root, "absolute"))).rejects.toBeInstanceOf(ReviewerError);
  });

  test("handles Windows-style comparison safely", () => {
    expect(isPathWithin("C:/repo", "C:/repo/src/file.ts")).toBeTrue();
    expect(isPathWithin("C:/repo", "C:/repository/file.ts")).toBeFalse();
  });
});
