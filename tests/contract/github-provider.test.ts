import { describe, expect, test } from "bun:test";
import type { RepositoryIdentity } from "../../src/domain/contracts.ts";
import { GitHubProvider } from "../../src/providers/github/github-provider.ts";
import { FakeCommandExecutor, NEVER_ABORTED } from "../helpers/fakes.ts";

const identity: RepositoryIdentity = {
  provider: "github",
  host: "github.com",
  owner: "acme",
  name: "reviewed",
  remote: "https://github.com/acme/reviewed.git",
};

describe("GitHub provider contract", () => {
  test("maps open PR summaries", async () => {
    const runner = new FakeCommandExecutor(() => ({
      stdout: JSON.stringify([
        {
          number: 7,
          title: "feat(014): policy",
          author: { login: "developer" },
          headRefName: "feature/014-policy",
          baseRefName: "main",
          isDraft: false,
          headRefOid: "aaaaaaaaaaaaaaaa",
          updatedAt: "2026-07-13T00:00:00Z",
        },
      ]),
    }));
    const provider = new GitHubProvider(
      identity,
      runner,
      { maxFiles: 150, maxDiffBytes: 2_000_000, maxFileBytes: 512_000 },
      "C:/repo",
    );
    await expect(provider.listOpenChangeRequests(50, NEVER_ABORTED)).resolves.toEqual([
      {
        number: 7,
        title: "feat(014): policy",
        author: "developer",
        sourceBranch: "feature/014-policy",
        targetBranch: "main",
        draft: false,
        headSha: "aaaaaaaaaaaaaaaa",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    ]);
    expect(runner.requests[0]?.args).toContain("--json");
  });

  test("builds a fork-aware immutable snapshot with GET calls only", async () => {
    const runner = new FakeCommandExecutor((request) => {
      const endpoint = request.args.at(-1) ?? "";
      if (endpoint === "repos/acme/reviewed/pulls/7") {
        return {
          stdout: JSON.stringify({
            number: 7,
            title: "feat(014): policy",
            body: "Implements policy",
            user: { login: "developer" },
            head: {
              ref: "feature/014-policy",
              sha: "aaaaaaaaaaaaaaaa",
              repo: { full_name: "contributor/reviewed" },
            },
            base: {
              ref: "main",
              sha: "bbbbbbbbbbbbbbbb",
              repo: { full_name: "acme/reviewed" },
            },
          }),
        };
      }
      if (endpoint.includes("pulls/7/files")) {
        return {
          stdout: JSON.stringify([
            {
              filename: "src/policy.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: "@@ -1 +1 @@\n-false\n+true",
            },
          ]),
        };
      }
      if (endpoint.includes("repos/contributor/reviewed/contents/src/policy.ts")) {
        return {
          stdout: JSON.stringify({
            type: "file",
            encoding: "base64",
            content: Buffer.from("export const policy = true;\n").toString("base64"),
            size: 28,
            sha: "cccccccccccccccc",
          }),
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const provider = new GitHubProvider(
      identity,
      runner,
      { maxFiles: 150, maxDiffBytes: 2_000_000, maxFileBytes: 512_000 },
      "C:/repo",
    );
    const snapshot = await provider.getChangeRequest(7, NEVER_ABORTED);
    expect(snapshot.headRepository).toBe("contributor/reviewed");
    expect(snapshot.headSha).toBe("aaaaaaaaaaaaaaaa");
    expect(snapshot.files[0]?.headContent).toContain("policy = true");
    expect(
      runner.requests
        .filter((request) => request.args[0] === "api")
        .every((request) => {
          const index = request.args.indexOf("--method");
          return request.args[index + 1] === "GET";
        }),
    ).toBeTrue();
  });
});
