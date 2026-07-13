import { describe, expect, test } from "bun:test";
import type { RepositoryIdentity } from "../../src/domain/contracts.ts";
import { GitLabProvider } from "../../src/providers/gitlab/gitlab-provider.ts";
import { FakeCommandExecutor, NEVER_ABORTED } from "../helpers/fakes.ts";

const identity: RepositoryIdentity = {
  provider: "gitlab",
  host: "gitlab.example.com",
  owner: "platform/security",
  name: "reviewed",
  remote: "git@gitlab.example.com:platform/security/reviewed.git",
};

describe("GitLab provider contract", () => {
  test("supports Self-Managed summary responses", async () => {
    const runner = new FakeCommandExecutor((request) => {
      const endpoint = request.args.at(-1) ?? "";
      if (endpoint.startsWith("projects/platform%2Fsecurity%2Freviewed")) {
        return {
          stdout: JSON.stringify({ id: 10, path_with_namespace: "platform/security/reviewed" }),
        };
      }
      if (endpoint.startsWith("projects/10/merge_requests?")) {
        return {
          stdout: JSON.stringify([
            {
              iid: 4,
              title: "feat(014): policy",
              author: { username: "developer" },
              source_branch: "feature/014-policy",
              target_branch: "main",
              draft: false,
              sha: "aaaaaaaaaaaaaaaa",
              updated_at: "2026-07-13T00:00:00Z",
            },
          ]),
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const provider = new GitLabProvider(
      identity,
      runner,
      { maxFiles: 150, maxDiffBytes: 2_000_000, maxFileBytes: 512_000 },
      "C:/repo",
    );
    const values = await provider.listOpenChangeRequests(50, NEVER_ABORTED);
    expect(values[0]).toMatchObject({
      number: 4,
      headSha: "aaaaaaaaaaaaaaaa",
      sourceBranch: "feature/014-policy",
    });
    expect(runner.requests.every((request) => request.executable === "glab")).toBeTrue();
  });

  test("uses source project for HEAD file content", async () => {
    const runner = new FakeCommandExecutor((request) => {
      const endpoint = request.args.at(-1) ?? "";
      if (endpoint === "projects/platform%2Fsecurity%2Freviewed") {
        return {
          stdout: JSON.stringify({ id: 10, path_with_namespace: "platform/security/reviewed" }),
        };
      }
      if (endpoint === "projects/10/merge_requests/4") {
        return {
          stdout: JSON.stringify({
            iid: 4,
            title: "feat(014): policy",
            description: "Implements policy",
            author: { username: "developer" },
            source_branch: "feature/014-policy",
            target_branch: "main",
            sha: "aaaaaaaaaaaaaaaa",
            source_project_id: 20,
            target_project_id: 10,
            diff_refs: {
              base_sha: "bbbbbbbbbbbbbbbb",
              head_sha: "aaaaaaaaaaaaaaaa",
              start_sha: "bbbbbbbbbbbbbbbb",
            },
          }),
        };
      }
      if (endpoint === "projects/20") {
        return { stdout: JSON.stringify({ id: 20, path_with_namespace: "contributor/reviewed" }) };
      }
      if (endpoint.startsWith("projects/10/merge_requests/4/diffs?")) {
        return {
          stdout: JSON.stringify([
            {
              old_path: "src/policy.ts",
              new_path: "src/policy.ts",
              diff: "@@ -1 +1 @@\n-false\n+true",
              new_file: false,
              renamed_file: false,
              deleted_file: false,
              collapsed: false,
              too_large: false,
            },
          ]),
        };
      }
      if (endpoint.startsWith("projects/20/repository/files/src%2Fpolicy.ts/raw?")) {
        return { stdout: "export const policy = true;\n" };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const provider = new GitLabProvider(
      identity,
      runner,
      { maxFiles: 150, maxDiffBytes: 2_000_000, maxFileBytes: 512_000 },
      "C:/repo",
    );
    const snapshot = await provider.getChangeRequest(4, NEVER_ABORTED);
    expect(snapshot.headRepository).toBe("contributor/reviewed");
    expect(snapshot.files[0]?.headContent).toContain("policy = true");
    expect(
      runner.requests.every((request) => {
        const methodIndex = request.args.indexOf("--method");
        return methodIndex < 0 || request.args[methodIndex + 1] === "GET";
      }),
    ).toBeTrue();
  });
});
