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
import { bytesToSnapshotContent, joinFileDiffs, parseJson } from "../provider-utils.ts";

const authorSchema = z.object({ username: z.string() });
const listItemSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  author: authorSchema,
  source_branch: z.string(),
  target_branch: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  sha: z.string(),
  updated_at: z.string(),
});

const mergeRequestSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  author: authorSchema,
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string(),
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
  references: z.object({ full: z.string() }).optional(),
  diff_refs: z.object({
    base_sha: z.string(),
    head_sha: z.string(),
    start_sha: z.string(),
  }),
});

const diffSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  diff: z.string(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
});

const projectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string(),
});
const treeItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["blob", "tree"]),
  path: z.string(),
});

export class GitLabProvider implements RepositoryProvider {
  readonly kind = "gitlab" as const;
  private readonly revisionProjectIds = new Map<string, number>();
  private projectId: number | undefined;

  constructor(
    private readonly identity: RepositoryIdentity,
    private readonly runner: CommandExecutor,
    private readonly limits: ProviderLimits,
    private readonly root: string,
  ) {}

  async checkAuthentication(signal: AbortSignal): Promise<AuthStatus> {
    if (Bun.which("glab") === null) {
      return { available: false, authenticated: false, detail: "glab is not installed." };
    }
    const result = await this.runner.run({
      executable: "glab",
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

  async identifyRepository(signal: AbortSignal): Promise<RepositoryIdentity> {
    const project = await this.getProject(signal);
    return { ...this.identity, projectId: project.id };
  }

  async listOpenChangeRequests(
    limit: number,
    signal: AbortSignal,
  ): Promise<ChangeRequestSummary[]> {
    const project = await this.getProject(signal);
    const endpoint = `projects/${project.id}/merge_requests?state=opened&per_page=${Math.min(limit, 100)}&page=1`;
    const values = await this.apiJson(endpoint, z.array(listItemSchema), signal, 4 * 1024 * 1024);
    return values.slice(0, limit).map((item) => ({
      number: item.iid,
      title: item.title,
      author: item.author.username,
      sourceBranch: item.source_branch,
      targetBranch: item.target_branch,
      draft: item.draft ?? item.work_in_progress ?? false,
      headSha: item.sha,
      updatedAt: new Date(item.updated_at).toISOString(),
    }));
  }

  async getChangeRequest(number: number, signal: AbortSignal): Promise<ChangeRequestSnapshot> {
    const targetProject = await this.getProject(signal);
    const mergeRequest = await this.apiJson(
      `projects/${targetProject.id}/merge_requests/${number}`,
      mergeRequestSchema,
      signal,
      2 * 1024 * 1024,
    );
    this.revisionProjectIds.set(mergeRequest.diff_refs.head_sha, mergeRequest.source_project_id);
    this.revisionProjectIds.set(mergeRequest.diff_refs.base_sha, mergeRequest.target_project_id);
    const sourceProject = await this.apiJson(
      `projects/${mergeRequest.source_project_id}`,
      projectSchema,
      signal,
      512 * 1024,
    );
    const diffs = await this.readDiffs(targetProject.id, number, signal);
    if (diffs.length > this.limits.maxFiles) {
      throw new ReviewerError(
        "CONTENT_LIMIT_EXCEEDED",
        "Merge request exceeds the changed-file limit.",
      );
    }
    const files: ChangedFile[] = [];
    for (const raw of diffs) {
      const status: ChangedFile["status"] = raw.new_file
        ? "added"
        : raw.deleted_file
          ? "deleted"
          : raw.renamed_file
            ? "renamed"
            : "modified";
      const headFile =
        status === "deleted"
          ? null
          : await this.tryReadTextFile(mergeRequest.diff_refs.head_sha, raw.new_path, signal);
      const baseFile =
        status === "deleted" || status === "renamed"
          ? await this.tryReadTextFile(mergeRequest.diff_refs.base_sha, raw.old_path, signal)
          : null;
      const patchUnavailable = raw.collapsed === true || raw.too_large === true;
      files.push({
        oldPath: raw.old_path,
        path: raw.new_path,
        status,
        patch: patchUnavailable ? null : raw.diff,
        headContent: headFile?.content ?? null,
        baseContent: baseFile?.content ?? null,
        binary: headFile?.binary ?? baseFile?.binary ?? patchUnavailable,
        truncated: headFile?.truncated ?? baseFile?.truncated ?? patchUnavailable,
        additions: countDiffLines(raw.diff, "+"),
        deletions: countDiffLines(raw.diff, "-"),
      });
    }
    const diff = joinFileDiffs(files);
    if (Buffer.byteLength(diff, "utf8") > this.limits.maxDiffBytes) {
      throw new ReviewerError(
        "CONTENT_LIMIT_EXCEEDED",
        "Merge request diff exceeds the byte limit.",
      );
    }
    return {
      number: mergeRequest.iid,
      title: mergeRequest.title,
      description: mergeRequest.description ?? "",
      author: mergeRequest.author.username,
      sourceBranch: mergeRequest.source_branch,
      targetBranch: mergeRequest.target_branch,
      headSha: mergeRequest.diff_refs.head_sha,
      baseSha: mergeRequest.diff_refs.base_sha,
      headRepository: sourceProject.path_with_namespace,
      baseRepository: targetProject.path_with_namespace,
      diff,
      files,
    };
  }

  async getCurrentHeadSha(number: number, signal: AbortSignal): Promise<string> {
    const project = await this.getProject(signal);
    const mergeRequest = await this.apiJson(
      `projects/${project.id}/merge_requests/${number}`,
      z.object({ sha: z.string(), diff_refs: z.object({ head_sha: z.string() }) }),
      signal,
      512 * 1024,
    );
    return mergeRequest.diff_refs.head_sha || mergeRequest.sha;
  }

  async listTree(revision: string, prefix: string, signal: AbortSignal): Promise<TreeEntry[]> {
    const projectId = this.projectForRevision(revision, await this.getProjectId(signal));
    const values: z.infer<typeof treeItemSchema>[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const endpoint = `projects/${projectId}/repository/tree?path=${encodeURIComponent(prefix)}&ref=${encodeURIComponent(revision)}&recursive=true&per_page=100&page=${page}`;
      const pageValues = await this.apiJson(
        endpoint,
        z.array(treeItemSchema),
        signal,
        4 * 1024 * 1024,
      );
      values.push(...pageValues);
      if (pageValues.length < 100) {
        break;
      }
    }
    return values.map((item) => ({ path: item.path, type: item.type, sha: item.id }));
  }

  async readTextFile(revision: string, path: string, signal: AbortSignal): Promise<SnapshotFile> {
    const projectId = this.projectForRevision(revision, await this.getProjectId(signal));
    const endpoint = `projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(revision)}`;
    let result: string;
    try {
      result = await this.apiRaw(endpoint, signal, this.limits.maxFileBytes + 1);
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
    const bytes = new TextEncoder().encode(result);
    const normalized = bytesToSnapshotContent(bytes, this.limits.maxFileBytes);
    return { path, revision, ...normalized };
  }

  private async tryReadTextFile(
    revision: string,
    path: string,
    signal: AbortSignal,
  ): Promise<SnapshotFile | null> {
    try {
      return await this.readTextFile(revision, path, signal);
    } catch (error) {
      if (error instanceof ReviewerError && error.code === "COMMAND_FAILED") {
        return null;
      }
      throw error;
    }
  }

  private async readDiffs(
    projectId: number,
    number: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof diffSchema>[]> {
    const values: z.infer<typeof diffSchema>[] = [];
    try {
      for (let page = 1; page <= 30; page += 1) {
        const endpoint = `projects/${projectId}/merge_requests/${number}/diffs?unidiff=true&per_page=100&page=${page}`;
        const pageValues = await this.apiJson(
          endpoint,
          z.array(diffSchema),
          signal,
          4 * 1024 * 1024,
        );
        values.push(...pageValues);
        if (pageValues.length < 100 || values.length > this.limits.maxFiles) {
          break;
        }
      }
      return values;
    } catch (error) {
      if (!(error instanceof ReviewerError) || error.code !== "COMMAND_FAILED") throw error;
      const legacy = await this.apiJson(
        `projects/${projectId}/merge_requests/${number}/changes?access_raw_diffs=true`,
        z.object({ changes: z.array(diffSchema) }),
        signal,
        8 * 1024 * 1024,
      );
      return legacy.changes;
    }
  }

  private async getProject(signal: AbortSignal): Promise<z.infer<typeof projectSchema>> {
    const project = await this.apiJson(
      `projects/${encodeURIComponent(`${this.identity.owner}/${this.identity.name}`)}`,
      projectSchema,
      signal,
      512 * 1024,
    );
    this.projectId = project.id;
    return project;
  }

  private async getProjectId(signal: AbortSignal): Promise<number> {
    return this.projectId ?? (await this.getProject(signal)).id;
  }

  private projectForRevision(revision: string, fallback: number): number {
    return this.revisionProjectIds.get(revision) ?? fallback;
  }

  private async apiJson<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<T> {
    const value = await this.apiRaw(endpoint, signal, maxOutputBytes);
    return parseJson(value, schema, `GitLab endpoint ${endpoint.split("?")[0]}`);
  }

  private async apiRaw(
    endpoint: string,
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<string> {
    const result = await this.runner.run({
      executable: "glab",
      args: ["api", "--method", "GET", "--hostname", this.identity.host, endpoint],
      cwd: this.root,
      signal,
      maxOutputBytes,
    });
    return result.stdout;
  }
}

function countDiffLines(diff: string, marker: "+" | "-"): number {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker) && !line.startsWith(`${marker}${marker}${marker}`))
    .length;
}
