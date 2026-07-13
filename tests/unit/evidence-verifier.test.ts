import { describe, expect, test } from "bun:test";
import type { ChangeRequestSnapshot } from "../../src/domain/contracts.ts";
import { isEvidenceValid, verifyFindings } from "../../src/review/evidence-verifier.ts";

const snapshot: ChangeRequestSnapshot = {
  number: 1,
  title: "feat(001): auth",
  description: "",
  author: "dev",
  sourceBranch: "feature/001-auth",
  targetBranch: "main",
  headSha: "aaaaaaaaaaaaaaaa",
  baseSha: "bbbbbbbbbbbbbbbb",
  headRepository: "acme/repo",
  baseRepository: "acme/repo",
  diff: "",
  files: [
    {
      oldPath: "src/auth.ts",
      path: "src/auth.ts",
      status: "modified",
      patch: "@@",
      headContent: "export function allowed() {\r\n  return true;\r\n}\r\n",
      baseContent: null,
      binary: false,
      truncated: false,
      additions: 1,
      deletions: 1,
    },
  ],
};

describe("evidence verifier", () => {
  test("normalizes line endings and validates exact locations", () => {
    expect(
      isEvidenceValid(snapshot, {
        revision: snapshot.headSha,
        path: "src/auth.ts",
        startLine: 2,
        endLine: 2,
        excerpt: "return true;",
      }),
    ).toBeTrue();
  });

  test("rejects invented revisions, paths, lines, and excerpts", () => {
    expect(
      isEvidenceValid(snapshot, {
        revision: "cccccccc",
        path: "src/auth.ts",
        startLine: 99,
        endLine: 99,
        excerpt: "secret bypass",
      }),
    ).toBeFalse();
  });

  test("drops findings without valid evidence", () => {
    expect(
      verifyFindings(snapshot, [
        {
          id: "F-1",
          severity: "critical",
          category: "security",
          claim: "Invented claim",
          evidence: [
            {
              revision: snapshot.headSha,
              path: "src/auth.ts",
              startLine: 2,
              endLine: 2,
              excerpt: "return false;",
            },
          ],
          confidence: 1,
          suggestedAction: "Fix",
          criterionIds: ["AC-1"],
        },
      ]),
    ).toEqual([]);
  });
});
