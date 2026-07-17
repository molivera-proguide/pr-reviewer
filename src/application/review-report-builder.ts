import { estimateReviewCost } from "../anthropic/pricing.ts";
import type { ReviewerConfig } from "../config/config.ts";
import {
  type Artifact,
  type ChangeRequestSnapshot,
  type FeatureReference,
  type ReviewReport,
  type ReviewStatus,
  reviewReportSchema,
  type Verdict,
} from "../domain/contracts.ts";
import type { PipelineResult } from "../review/pipeline.ts";
import { APP_VERSION } from "../version.ts";

export function buildReviewReport(options: {
  config: ReviewerConfig;
  reviewId: string;
  now: Date;
  provider: "github" | "gitlab";
  host: string;
  repository: string;
  root: string;
  snapshot: ChangeRequestSnapshot;
  feature: FeatureReference;
  artifacts: readonly Artifact[];
  pipeline: PipelineResult;
  pendingDecisions: readonly string[];
  status: ReviewStatus;
  verdict: Verdict;
}): ReviewReport {
  const expiresAt = new Date(
    options.now.getTime() + options.config.reportTtlHours * 60 * 60 * 1_000,
  );
  return reviewReportSchema.parse({
    schemaVersion: "1.6",
    reviewerVersion: APP_VERSION,
    reviewId: options.reviewId,
    createdAt: options.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    model: options.config.model,
    models: {
      explorer: options.config.explorerModel,
      orchestrator: options.config.orchestratorModel,
    },
    provider: options.provider,
    host: options.host,
    repository: options.repository,
    root: options.root,
    changeRequestNumber: options.snapshot.number,
    changeRequestTitle: options.snapshot.title,
    baseSha: options.snapshot.baseSha,
    headSha: options.snapshot.headSha,
    feature: options.feature,
    artifacts: options.artifacts.map((artifact) => ({ ...artifact, content: null })),
    reviewScope: options.pipeline.reviewScope,
    coverage: options.pipeline.coverage,
    testCoverage: options.pipeline.testCoverage,
    findings: options.pipeline.findings,
    risks: options.pipeline.risks,
    pendingDecisions: [...new Set(options.pendingDecisions)],
    limitations: options.pipeline.limitations,
    stagesIncomplete: options.pipeline.stagesIncomplete,
    ...(options.pipeline.planning === undefined ? {} : { planning: options.pipeline.planning }),
    slices: options.pipeline.slices,
    attemptDiagnostics: options.pipeline.attemptDiagnostics,
    costEstimate: estimateReviewCost(options.pipeline.attemptDiagnostics, options.now),
    status: options.status,
    verdict: options.verdict,
    usage: options.pipeline.usage,
  });
}
