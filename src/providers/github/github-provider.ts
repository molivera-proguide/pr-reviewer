import { z } from "zod";
import type {
  AuthStatus,
  ChangedFile,
  ChangeRequestSnapshot,
  ChangeRequestSummary,
  RepositoryIdentity,
  SnapshotFile,
  TreeEntry,
} from "../../domain/contracts.ts";
import { ReviewerError } from "../../domain/errors.ts";
import type { CommandExecutor } from "../../security/command-runner.ts";
import type { ProviderLimits, RepositoryProvider } from "../provider.ts";
import {
  assertTextWithinByteLimit,
  bytesToSnapshotContent,
  encodeRepositoryPath,
  joinFileDiffs,
  parseJson,
  readOptionalSnapshotFile,
} from "../provider-utils.ts";

const listItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  headRefName: z.string(),
  baseRefName: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  updatedAt: z.string(),
});

const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
});

const pullFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

const contentSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
  sha: z.string(),
});

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: z.string(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

function mapStatus(status: string): ChangedFile["status"] {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    case "modified":
    case "changed":
      return "modified";
    default:
      return "unknown";
  }
}

export class GitHubProvider implements RepositoryProvider {
  readonly kind = "github" as const;
  private readonly revisionRepositories = new Map<string, string>();

  constructor(
    private readonly identity: RepositoryIdentity,
    private readonly runner: CommandExecutor,
    private readonly limits: ProviderLimits,
    private readonly root: string,
  ) {}

  async checkAuthentication(signal: AbortSignal): Promise<AuthStatus> {
    const availability = Bun.which("gh");
    if (availability === null) {
      return { available: false, authenticated: false, detail: "gh is not installed." };
    }
    const result = await this.runner.run({
      executable: "gh",
      args: ["auth", "status", "--hostname", this.identity.host],
      cwd: this.root,
      signal,
      throwOnNonZero: false,
    });
    return {
      available: true,
      authenticated: result.exitCode === 0,
      detail: result.exitCode === 0 ? "Authenticated." : "Authentication is missing or expired.",
    };
  }

  async identifyRepository(_signal: AbortSignal): Promise<RepositoryIdentity> {
    return this.identity;
  }

  async listOpenChangeRequests(
    limit: number,
    signal: AbortSignal,
  ): Promise<ChangeRequestSummary[]> {
    const result = await this.runner.run({
      executable: "gh",
      args: [
        "pr",
        "list",
        "--repo",
        this.cliRepository(),
        "--state",
        "open",
        "--limit",
        String(limit),
        "--json",
        "number,title,author,headRefName,baseRefName,isDraft,headRefOid,updatedAt",
      ],
      cwd: this.root,
      signal,
    });
    return parseJson(result.stdout, z.array(listItemSchema), "gh pr list").map((item) => ({
      number: item.number,
      title: item.title,
      author: item.author?.login ?? "unknown",
      sourceBranch: item.headRefName,
      targetBranch: item.baseRefName,
      draft: item.isDraft,
      headSha: item.headRefOid,
      updatedAt: new Date(item.updatedAt).toISOString(),
    }));
  }

  async getChangeRequest(number: number, signal: AbortSignal): Promise<ChangeRequestSnapshot> {
    const repository = `${this.identity.owner}/${this.identity.name}`;
    const pull = await this.apiJson(
      `repos/${repository}/pulls/${number}`,
      pullSchema,
      signal,
      2 * 1024 * 1024,
    );
    const headRepository = pull.head.repo?.full_name;
    if (headRepository === undefined) {
      throw new ReviewerError(
        "COMMAND_FAILED",
        "The pull request source repository is unavailable.",
      );
    }
    this.revisionRepositories.set(pull.head.sha, headRepository);
    this.revisionRepositories.set(pull.base.sha, pull.base.repo.full_name);
    const rawFiles = await this.readPullFiles(repository, number, signal);
    if (rawFiles.length > this.limits.maxFiles) {
      throw new ReviewerError(
        "CONTENT_LIMIT_EXCEEDED",
        "Pull request exceeds the changed-file limit.",
        {
          actual: rawFiles.length,
          limit: this.limits.maxFiles,
        },
      );
    }
    const files: ChangedFile[] = [];
    for (const raw of rawFiles) {
      const status = mapStatus(raw.status);
      const headFile =
        status === "deleted"
          ? null
          : await readOptionalSnapshotFile(() =>
              this.readTextFile(pull.head.sha, raw.filename, signal),
            );
      const oldPath = raw.previous_filename ?? (status === "renamed" ? null : raw.filename);
      const baseFile =
        status === "deleted" || status === "renamed"
          ? await readOptionalSnapshotFile(() =>
              this.readTextFile(pull.base.sha, oldPath ?? raw.filename, signal),
            )
          : null;
      files.push({
        oldPath,
        path: raw.filename,
        status,
        patch: raw.patch ?? null,
        headContent: headFile?.content ?? null,
        baseContent: baseFile?.content ?? null,
        binary: headFile?.binary ?? baseFile?.binary ?? raw.patch === undefined,
        truncated: headFile?.truncated ?? baseFile?.truncated ?? false,
        additions: raw.additions,
        deletions: raw.deletions,
      });
    }
    const diff = joinFileDiffs(files);
    assertTextWithinByteLimit(
      diff,
      this.limits.maxDiffBytes,
      "Pull request diff exceeds the byte limit.",
    );
    return {
      number: pull.number,
      title: pull.title,
      description: pull.body ?? "",
      author: pull.user.login,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      headRepository,
      baseRepository: pull.base.repo.full_name,
      diff,
      files,
    };
  }

  async getCurrentHeadSha(number: number, signal: AbortSignal): Promise<string> {
    const repository = `${this.identity.owner}/${this.identity.name}`;
    const value = await this.apiJson(
      `repos/${repository}/pulls/${number}`,
      z.object({ head: z.object({ sha: z.string() }) }),
      signal,
      512 * 1024,
    );
    return value.head.sha;
  }

  async listTree(revision: string, prefix: string, signal: AbortSignal): Promise<TreeEntry[]> {
    const repository = this.repositoryForRevision(revision);
    const tree = await this.apiJson(
      `repos/${repository}/git/trees/${encodeURIComponent(revision)}?recursive=1`,
      treeSchema,
      signal,
      8 * 1024 * 1024,
    );
    if (tree.truncated) {
      throw new ReviewerError(
        "CONTENT_LIMIT_EXCEEDED",
        "GitHub returned a truncated repository tree.",
      );
    }
    const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
    return tree.tree
      .filter((item): item is typeof item & { type: "blob" | "tree" } => item.type !== "commit")
      .filter(
        (item) =>
          normalizedPrefix.length === 0 ||
          item.path.startsWith(`${normalizedPrefix}/`) ||
          item.path === normalizedPrefix,
      )
      .map((item) => ({
        path: item.path,
        type: item.type,
        sha: item.sha,
        ...(item.size === undefined ? {} : { size: item.size }),
      }));
  }

  async readTextFile(revision: string, path: string, signal: AbortSignal): Promise<SnapshotFile> {
    const repository = this.repositoryForRevision(revision);
    let content: z.infer<typeof contentSchema>;
    try {
      content = await this.apiJson(
        `repos/${repository}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(revision)}`,
        contentSchema,
        signal,
        Math.max(2 * 1024 * 1024, Math.ceil(this.limits.maxFileBytes * 1.5) + 256 * 1024),
      );
    } catch (error) {
      if (error instanceof ReviewerError && error.code === "CONTENT_LIMIT_EXCEEDED") {
        return {
          path,
          revision,
          content: null,
          binary: false,
          truncated: true,
          bytes: this.limits.maxFileBytes + 1,
        };
      }
      throw error;
    }
    const decoded = Buffer.from(content.content.replace(/\s/g, ""), "base64");
    const normalized = bytesToSnapshotContent(decoded, this.limits.maxFileBytes);
    return { path, revision, ...normalized, sha: content.sha };
  }

  private async readPullFiles(
    repository: string,
    number: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof pullFileSchema>[]> {
    const files: z.infer<typeof pullFileSchema>[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const values = await this.apiJson(
        `repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
        z.array(pullFileSchema),
        signal,
        4 * 1024 * 1024,
      );
      files.push(...values);
      if (values.length < 100 || files.length > this.limits.maxFiles) {
        break;
      }
    }
    return files;
  }

  private async apiJson<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<T> {
    const result = await this.runner.run({
      executable: "gh",
      args: [
        "api",
        "--method",
        "GET",
        "--hostname",
        this.identity.host,
        "-H",
        "Accept: application/vnd.github+json",
        endpoint,
      ],
      cwd: this.root,
      signal,
      maxOutputBytes,
    });
    return parseJson(result.stdout, schema, `GitHub endpoint ${endpoint.split("?")[0]}`);
  }

  private repositoryForRevision(revision: string): string {
    return (
      this.revisionRepositories.get(revision) ?? `${this.identity.owner}/${this.identity.name}`
    );
  }

  private cliRepository(): string {
    const path = `${this.identity.owner}/${this.identity.name}`;
    return this.identity.host === "github.com" ? path : `${this.identity.host}/${path}`;
  }
}
