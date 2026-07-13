import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ReviewerService } from "../application/reviewer-service.ts";
import type { ReviewerConfig } from "../config/config.ts";
import type { Logger } from "../observability/logger.ts";
import { APP_NAME, APP_VERSION } from "../version.ts";
import {
  cleanupAtStartup,
  clientFileRoots,
  reviewStructuredContent,
  toolError,
} from "./protocol.ts";
import {
  doctorInputShape,
  doctorOutputShape,
  listInputShape,
  listOutputShape,
  reviewInputShape,
  reviewOutputShape,
} from "./tools/schemas.ts";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export async function startMcpServer(
  service: ReviewerService,
  config: ReviewerConfig,
  logger: Logger,
): Promise<McpServer> {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "reviewer_doctor",
    {
      title: "Diagnose SDD PR Reviewer",
      description:
        "Run read-only installation, repository, provider authentication, Anthropic environment, and report-directory diagnostics.",
      inputSchema: doctorInputShape,
      outputSchema: doctorOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ repository_path }, extra) => {
      try {
        const clientRoots = await clientFileRoots(server, extra.signal);
        const result = await service.doctor(
          {
            ...(repository_path === undefined ? {} : { repositoryPath: repository_path }),
            clientRoots,
          },
          extra.signal,
        );
        const structuredContent = {
          version: result.version,
          platform: result.platform,
          root: result.root,
          provider: result.provider,
          repository: result.repository,
          overall: result.overall,
          checks: result.checks.map((check) => ({ ...check })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return toolError(error, logger, "reviewer_doctor");
      }
    },
  );

  server.registerTool(
    "list_open_change_requests",
    {
      title: "List open pull or merge requests",
      description:
        "List open GitHub PRs or GitLab MRs with immutable HEAD SHAs. Show the result to the Tech Lead before requesting a review.",
      inputSchema: listInputShape,
      outputSchema: listOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ repository_path, limit }, extra) => {
      try {
        const clientRoots = await clientFileRoots(server, extra.signal);
        const result = await service.listOpenChangeRequests(
          {
            ...(repository_path === undefined ? {} : { repositoryPath: repository_path }),
            clientRoots,
            limit,
          },
          extra.signal,
        );
        const structuredContent = {
          provider: result.provider,
          repository: result.repository,
          root: result.root,
          change_requests: result.changeRequests.map((item) => ({
            number: item.number,
            title: item.title,
            author: item.author,
            source_branch: item.sourceBranch,
            target_branch: item.targetBranch,
            draft: item.draft,
            head_sha: item.headSha,
            updated_at: item.updatedAt,
          })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return toolError(error, logger, "list_open_change_requests");
      }
    },
  );

  server.registerTool(
    "review_change_requests",
    {
      title: "Review one selected pull or merge request",
      description:
        "Review exactly one displayed PR/MR after explicit Tech Lead selection. Never set tl_confirmed=true on the user's behalf. expected_head_sha must come from list_open_change_requests. The operation is read-only, synchronous, cancellable, and may take up to 15 minutes.",
      inputSchema: reviewInputShape,
      outputSchema: reviewOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ repository_path, tl_confirmed, selections }, extra) => {
      try {
        const selection = selections[0];
        if (selection === undefined) throw new Error("One selection is required.");
        const clientRoots = await clientFileRoots(server, extra.signal);
        const result = await service.reviewChangeRequest(
          {
            ...(repository_path === undefined ? {} : { repositoryPath: repository_path }),
            clientRoots,
            number: selection.number,
            expectedHeadSha: selection.expected_head_sha,
            tlConfirmed: tl_confirmed,
          },
          extra.signal,
          async (stage, progress) => {
            if (extra._meta?.progressToken === undefined) return;
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress,
                total: 100,
                message: stage,
              },
            });
          },
        );
        const structuredContent = reviewStructuredContent(result);
        return {
          content: [
            {
              type: "text",
              text:
                `${result.message}\nStatus: ${result.status}\nVerdict: ${result.verdict}\n` +
                `Findings: ${result.findingCount} (${result.blockingFindingCount} blocking)\n` +
                `Report: ${result.reportPath ?? "not generated"}`,
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return toolError(error, logger, "review_change_requests");
      }
    },
  );

  await cleanupAtStartup(service, config.reportTtlHours);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once("end", () => {
    void server.close();
  });
  logger.log("info", { event: "mcp_started" });
  return server;
}
