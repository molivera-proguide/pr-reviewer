import type {
  Finding,
  ReviewCoverage,
  ReviewScope,
  ReviewStatus,
  Usage,
  Verdict,
} from "../domain/contracts.ts";
import type { PipelineResult } from "../review/pipeline.ts";
import { isBlockingFinding } from "../review/verdict.ts";

export interface ReviewResult {
  readonly reviewId: string;
  readonly status: ReviewStatus;
  readonly verdict: Verdict;
  readonly reviewScope: ReviewScope;
  readonly provider: "github" | "gitlab";
  readonly repository: string;
  readonly root: string;
  readonly changeRequestNumber: number;
  readonly expectedHeadSha: string;
  readonly reviewedHeadSha: string | null;
  readonly currentHeadSha: string;
  readonly reportPath: string | null;
  readonly findingCount: number;
  readonly blockingFindingCount: number;
  readonly topFindings: readonly {
    severity: "critical" | "high" | "medium" | "low";
    category: string;
    claim: string;
    path: string;
    line: number;
    confidence: number;
  }[];
  readonly coverageSummary: CoverageSummary;
  readonly testCoverageSummary: CoverageSummary;
  readonly usage: Usage;
  readonly message: string;
}

export interface CoverageSummary {
  readonly covered: number;
  readonly partial: number;
  readonly missing: number;
  readonly notVerifiable: number;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
const ZERO_COVERAGE: CoverageSummary = {
  covered: 0,
  partial: 0,
  missing: 0,
  notVerifiable: 0,
};

function summarizeCoverage(coverage: readonly ReviewCoverage[]): CoverageSummary {
  return {
    covered: coverage.filter((item) => item.status === "covered").length,
    partial: coverage.filter((item) => item.status === "partial").length,
    missing: coverage.filter((item) => item.status === "missing").length,
    notVerifiable: coverage.filter((item) => item.status === "not_verifiable").length,
  };
}

function topFindings(findings: readonly Finding[]): ReviewResult["topFindings"] {
  return findings.slice(0, 10).flatMap((finding) => {
    const evidence = finding.evidence[0];
    if (evidence === undefined) return [];
    return [
      {
        severity: finding.severity,
        category: finding.category.slice(0, 100),
        claim: finding.claim.slice(0, 320),
        path: evidence.path.slice(0, 500),
        line: evidence.startLine,
        confidence: finding.confidence,
      },
    ];
  });
}

export function emptyReviewResult(options: {
  reviewId: string;
  status: Extract<ReviewStatus, "cancelled" | "incomplete" | "stale">;
  provider: "github" | "gitlab";
  repository: string;
  root: string;
  number: number;
  expectedHeadSha: string;
  reviewedHeadSha: string | null;
  currentHeadSha: string;
  usage: Usage;
  message: string;
}): ReviewResult {
  return {
    reviewId: options.reviewId,
    status: options.status,
    verdict: "REQUIERE_DECISION",
    reviewScope: "implementation",
    provider: options.provider,
    repository: options.repository,
    root: options.root,
    changeRequestNumber: options.number,
    expectedHeadSha: options.expectedHeadSha,
    reviewedHeadSha: options.reviewedHeadSha,
    currentHeadSha: options.currentHeadSha,
    reportPath: null,
    findingCount: 0,
    blockingFindingCount: 0,
    topFindings: [],
    coverageSummary: ZERO_COVERAGE,
    testCoverageSummary: ZERO_COVERAGE,
    usage: options.usage,
    message: options.message,
  };
}

export function staleReviewResult(options: {
  reviewId: string;
  provider: "github" | "gitlab";
  repository: string;
  root: string;
  number: number;
  expectedHeadSha: string;
  currentHeadSha: string;
}): ReviewResult {
  return emptyReviewResult({
    ...options,
    status: "stale",
    reviewedHeadSha: null,
    usage: ZERO_USAGE,
    message: "HEAD no longer matches the SHA selected by the Tech Lead. List changes again.",
  });
}

export function mapPipelineReviewResult(options: {
  reviewId: string;
  pipeline: PipelineResult;
  status: ReviewStatus;
  verdict: Verdict;
  provider: "github" | "gitlab";
  repository: string;
  root: string;
  number: number;
  expectedHeadSha: string;
  reviewedHeadSha: string;
  currentHeadSha: string;
  reportPath: string;
}): ReviewResult {
  const blockingFindingCount = options.pipeline.findings.filter(isBlockingFinding).length;
  return {
    reviewId: options.reviewId,
    status: options.status,
    verdict: options.verdict,
    reviewScope: options.pipeline.reviewScope,
    provider: options.provider,
    repository: options.repository,
    root: options.root,
    changeRequestNumber: options.number,
    expectedHeadSha: options.expectedHeadSha,
    reviewedHeadSha: options.reviewedHeadSha,
    currentHeadSha: options.currentHeadSha,
    reportPath: options.reportPath,
    findingCount: options.pipeline.findings.length,
    blockingFindingCount,
    topFindings: topFindings(options.pipeline.findings),
    coverageSummary: summarizeCoverage(options.pipeline.coverage),
    testCoverageSummary: summarizeCoverage(options.pipeline.testCoverage),
    usage: options.pipeline.usage,
    message:
      options.status === "stale"
        ? "Review completed, but HEAD changed. The report is stale and must not be used for approval."
        : options.status === "incomplete"
          ? "Review incomplete; zero findings does not mean zero defects because part of the change may not have been reviewed."
          : `Review ${options.status}; Tech Lead decision required for verdict ${options.verdict}.`,
  };
}
