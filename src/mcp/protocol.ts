import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReviewerService, ReviewResult } from "../application/reviewer-service.ts";
import { toReviewerError } from "../domain/errors.ts";
import type { Logger } from "../observability/logger.ts";

export async function clientFileRoots(server: McpServer, signal: AbortSignal): Promise<string[]> {
  if (server.server.getClientCapabilities()?.roots === undefined) return [];
  try {
    const result = await server.server.listRoots(undefined, { signal });
    return result.roots.flatMap((root) => {
      try {
        const url = new URL(root.uri);
        return url.protocol === "file:" ? [fileURLToPath(url)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function reviewStructuredContent(result: ReviewResult) {
  return {
    review_id: result.reviewId,
    status: result.status,
    verdict: result.verdict,
    provider: result.provider,
    repository: result.repository,
    root: result.root,
    change_request_number: result.changeRequestNumber,
    expected_head_sha: result.expectedHeadSha,
    reviewed_head_sha: result.reviewedHeadSha,
    current_head_sha: result.currentHeadSha,
    report_path: result.reportPath,
    finding_count: result.findingCount,
    blocking_finding_count: result.blockingFindingCount,
    top_findings: result.topFindings.map((finding) => ({ ...finding })),
    coverage_summary: {
      covered: result.coverageSummary.covered,
      partial: result.coverageSummary.partial,
      missing: result.coverageSummary.missing,
      not_verifiable: result.coverageSummary.notVerifiable,
    },
    test_coverage_summary: {
      covered: result.testCoverageSummary.covered,
      partial: result.testCoverageSummary.partial,
      missing: result.testCoverageSummary.missing,
      not_verifiable: result.testCoverageSummary.notVerifiable,
    },
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      calls: result.usage.calls,
    },
    message: result.message,
  };
}

export function toolError(error: unknown, logger: Logger, tool: string) {
  const reviewerError = toReviewerError(error);
  logger.log("error", { event: "tool_failed", stage: tool, reason: reviewerError.code });
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "failed",
          code: reviewerError.code,
          message: reviewerError.message,
        }),
      },
    ],
  };
}

export async function cleanupAtStartup(service: ReviewerService, ttlHours: number): Promise<void> {
  const signal = AbortSignal.timeout(30_000);
  try {
    await service.reports.cleanupExpired(ttlHours, signal);
  } catch {
    // Cleanup is best effort and must not prevent MCP startup.
  }
}
