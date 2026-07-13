import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AnthropicAgentClient } from "../anthropic/agent-client.ts";
import type { ReviewerConfig } from "../config/config.ts";
import {
  type ChangeRequestSummary,
  type ReviewReport,
  type ReviewStatus,
  reviewReportSchema,
  type Usage,
  type Verdict,
} from "../domain/contracts.ts";
import { ReviewerError, toReviewerError } from "../domain/errors.ts";
import type { Logger } from "../observability/logger.ts";
import { ReportStore } from "../report/report-store.ts";
import { createProvider } from "../repository/provider-factory.ts";
import { buildReviewContext } from "../review/context-builder.ts";
import { type PipelineResult, runReviewPipeline } from "../review/pipeline.ts";
import { calculateVerdict } from "../review/verdict.ts";
import { loadArtifacts } from "../sdd/artifact-loader.ts";
import { resolveFeature } from "../sdd/feature-resolver.ts";
import { UsageBudget } from "../security/budget.ts";
import type { AllowedExecutable, CommandExecutor } from "../security/command-runner.ts";
import { resolveRepositoryRoot } from "../security/path-confinement.ts";
import { APP_VERSION } from "../version.ts";

export interface RootInput {
  readonly repositoryPath?: string;
  readonly clientRoots?: readonly string[];
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}

export interface DoctorResult {
  readonly version: string;
  readonly platform: string;
  readonly root: string | null;
  readonly provider: "github" | "gitlab" | null;
  readonly repository: string | null;
  readonly overall: "ok" | "warning" | "error";
  readonly checks: readonly DoctorCheck[];
}

export interface ListResult {
  readonly provider: "github" | "gitlab";
  readonly repository: string;
  readonly root: string;
  readonly changeRequests: readonly ChangeRequestSummary[];
}

export interface ReviewResult {
  readonly reviewId: string;
  readonly status: ReviewStatus;
  readonly verdict: Verdict;
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
  readonly coverageSummary: {
    covered: number;
    partial: number;
    missing: number;
    notVerifiable: number;
  };
  readonly usage: Usage;
  readonly message: string;
}

export type ReviewProgress = (stage: string, progress: number) => Promise<void> | void;

function overallStatus(checks: readonly DoctorCheck[]): DoctorResult["overall"] {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
const ZERO_COVERAGE = { covered: 0, partial: 0, missing: 0, notVerifiable: 0 } as const;

export class ReviewerService {
  readonly reports: ReportStore;

  constructor(
    private readonly config: ReviewerConfig,
    private readonly runner: CommandExecutor,
    private readonly logger: Logger,
    reportStore?: ReportStore,
  ) {
    this.reports = reportStore ?? new ReportStore(runner, logger);
  }

  async doctor(input: RootInput, signal: AbortSignal): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];
    for (const executable of ["git", "gh", "glab"] as const) {
      checks.push(await this.checkExecutable(executable, signal));
    }
    checks.push({
      name: "anthropic_api_key",
      status: this.config.anthropicApiKey === undefined ? "error" : "ok",
      detail:
        this.config.anthropicApiKey === undefined
          ? "ANTHROPIC_API_KEY is not present in the process environment."
          : "ANTHROPIC_API_KEY is present (value not displayed).",
    });
    try {
      await this.reports.ensureWritable();
      checks.push({ name: "report_directory", status: "ok", detail: this.reports.root });
    } catch {
      checks.push({
        name: "report_directory",
        status: "error",
        detail: "The private report directory is not writable.",
      });
    }

    let root: string;
    try {
      root = await this.resolveRoot(input);
      checks.push({ name: "repository_root", status: "ok", detail: root });
    } catch (error) {
      const reviewerError = toReviewerError(error);
      checks.push({ name: "repository_root", status: "error", detail: reviewerError.message });
      return {
        version: APP_VERSION,
        platform: `${process.platform}-${process.arch}`,
        root: null,
        provider: null,
        repository: null,
        overall: overallStatus(checks),
        checks,
      };
    }
    try {
      await stat(join(root, "specs"));
      checks.push({ name: "sdd_specs", status: "ok", detail: "specs/ exists." });
    } catch {
      checks.push({ name: "sdd_specs", status: "warning", detail: "specs/ is absent." });
    }
    try {
      const provider = await createProvider({
        root,
        config: this.config,
        runner: this.runner,
        signal,
      });
      const auth = await provider.checkAuthentication(signal);
      checks.push({
        name: `${provider.kind}_authentication`,
        status: auth.authenticated ? "ok" : "error",
        detail: auth.detail,
      });
      if (!auth.authenticated) {
        return {
          version: APP_VERSION,
          platform: `${process.platform}-${process.arch}`,
          root,
          provider: provider.kind,
          repository: null,
          overall: overallStatus(checks),
          checks,
        };
      }
      const identity = await provider.identifyRepository(signal);
      return {
        version: APP_VERSION,
        platform: `${process.platform}-${process.arch}`,
        root,
        provider: provider.kind,
        repository: `${identity.owner}/${identity.name}`,
        overall: overallStatus(checks),
        checks,
      };
    } catch (error) {
      const reviewerError = toReviewerError(error);
      checks.push({ name: "provider", status: "error", detail: reviewerError.message });
      return {
        version: APP_VERSION,
        platform: `${process.platform}-${process.arch}`,
        root,
        provider: null,
        repository: null,
        overall: overallStatus(checks),
        checks,
      };
    }
  }

  async listOpenChangeRequests(
    input: RootInput & { limit: number },
    signal: AbortSignal,
  ): Promise<ListResult> {
    const root = await this.resolveRoot(input);
    const provider = await createProvider({
      root,
      config: this.config,
      runner: this.runner,
      signal,
    });
    const auth = await provider.checkAuthentication(signal);
    if (!auth.authenticated) {
      throw new ReviewerError("AUTH_REQUIRED", auth.detail);
    }
    const identity = await provider.identifyRepository(signal);
    const changeRequests = await provider.listOpenChangeRequests(input.limit, signal);
    return {
      provider: provider.kind,
      repository: `${identity.owner}/${identity.name}`,
      root,
      changeRequests,
    };
  }

  async reviewChangeRequest(
    input: RootInput & {
      number: number;
      expectedHeadSha: string;
      tlConfirmed: boolean;
      openReport?: boolean;
    },
    signal: AbortSignal,
    onProgress?: ReviewProgress,
  ): Promise<ReviewResult> {
    if (!input.tlConfirmed) {
      throw new ReviewerError("INVALID_INPUT", "Explicit Tech Lead confirmation is required.");
    }
    if (this.config.anthropicApiKey === undefined) {
      throw new ReviewerError(
        "AUTH_REQUIRED",
        "ANTHROPIC_API_KEY is missing from the environment.",
      );
    }
    const reviewId = crypto.randomUUID();
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const reviewSignal = AbortSignal.any([signal, timeoutSignal]);
    const progress = onProgress ?? (() => undefined);
    await progress("repository_resolution", 5);
    const root = await this.resolveRoot(input);
    const provider = await createProvider({
      root,
      config: this.config,
      runner: this.runner,
      signal: reviewSignal,
    });
    const auth = await provider.checkAuthentication(reviewSignal);
    if (!auth.authenticated) throw new ReviewerError("AUTH_REQUIRED", auth.detail);
    const identity = await provider.identifyRepository(reviewSignal);
    const repository = `${identity.owner}/${identity.name}`;
    await this.reports.cleanupExpired(this.config.reportTtlHours, reviewSignal);
    const initialHeadSha = await provider.getCurrentHeadSha(input.number, reviewSignal);
    if (initialHeadSha !== input.expectedHeadSha) {
      return this.staleResult({
        reviewId,
        provider: provider.kind,
        repository,
        root,
        number: input.number,
        expectedHeadSha: input.expectedHeadSha,
        currentHeadSha: initialHeadSha,
      });
    }
    await progress("snapshot", 15);
    const snapshot = await provider.getChangeRequest(input.number, reviewSignal);
    if (snapshot.headSha !== input.expectedHeadSha) {
      return this.staleResult({
        reviewId,
        provider: provider.kind,
        repository,
        root,
        number: input.number,
        expectedHeadSha: input.expectedHeadSha,
        currentHeadSha: snapshot.headSha,
      });
    }
    await progress("sdd_resolution", 23);
    const feature = await resolveFeature(snapshot, provider, reviewSignal);
    const artifacts = await loadArtifacts({
      provider,
      feature,
      revision: snapshot.headSha,
      maxBytes: this.config.maxArtifactBytes,
      signal: reviewSignal,
    });
    const context = buildReviewContext(snapshot, feature, artifacts);
    const budget = new UsageBudget({
      maxCalls: this.config.maxAgentCalls,
      maxOutputTokens: this.config.maxAgentOutputTokens,
      deadlineMs: this.config.timeoutMs,
    });
    const client = new AnthropicAgentClient(
      this.config.anthropicApiKey,
      this.config.model,
      budget,
      this.logger,
      this.config.timeoutMs,
    );
    let pipeline: PipelineResult;
    try {
      pipeline = await runReviewPipeline({
        context,
        client,
        budget,
        signal: reviewSignal,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
    } catch (error) {
      const reviewerError = toReviewerError(error);
      if (signal.aborted || (reviewerError.code === "CANCELLED" && !timeoutSignal.aborted)) {
        return {
          reviewId,
          status: "cancelled",
          verdict: "REQUIERE_DECISION",
          provider: provider.kind,
          repository,
          root,
          changeRequestNumber: input.number,
          expectedHeadSha: input.expectedHeadSha,
          reviewedHeadSha: snapshot.headSha,
          currentHeadSha: snapshot.headSha,
          reportPath: null,
          findingCount: 0,
          blockingFindingCount: 0,
          topFindings: [],
          coverageSummary: ZERO_COVERAGE,
          usage: budget.snapshot(),
          message: "Review cancelled before a reliable report could be completed.",
        };
      }
      if (timeoutSignal.aborted || reviewerError.code === "TIMEOUT") {
        return {
          reviewId,
          status: "incomplete",
          verdict: "REQUIERE_DECISION",
          provider: provider.kind,
          repository,
          root,
          changeRequestNumber: input.number,
          expectedHeadSha: input.expectedHeadSha,
          reviewedHeadSha: snapshot.headSha,
          currentHeadSha: snapshot.headSha,
          reportPath: null,
          findingCount: 0,
          blockingFindingCount: 0,
          topFindings: [],
          coverageSummary: ZERO_COVERAGE,
          usage: budget.snapshot(),
          message: "Review reached its time limit before a reliable report could be completed.",
        };
      }
      pipeline = {
        sdd: {
          objectives: [],
          criteria: [],
          constraints: [],
          tasks: [],
          decisions: [],
          conflicts: [],
          sddApproved: false,
        },
        coverage: [],
        findings: [],
        risks: [],
        pendingDecisions: ["The mandatory agent pipeline did not complete."],
        limitations: [reviewerError.message],
        stagesIncomplete: ["agent_pipeline"],
        status: "incomplete",
        usage: budget.snapshot(),
      };
    }
    await progress("head_revalidation", 93);
    const finalHeadSha = await provider.getCurrentHeadSha(input.number, reviewSignal);
    const status: ReviewStatus = finalHeadSha === snapshot.headSha ? pipeline.status : "stale";
    const requiredCriterionIds = new Set(
      pipeline.sdd.criteria
        .filter((criterion) => criterion.required)
        .map((criterion) => criterion.id),
    );
    const coverageDecisions = pipeline.coverage
      .filter(
        (coverage) =>
          requiredCriterionIds.has(coverage.criterionId) && coverage.status !== "covered",
      )
      .map(
        (coverage) =>
          `Required criterion ${coverage.criterionId} has coverage status ${coverage.status}.`,
      );
    const pendingDecisions = [
      ...pipeline.pendingDecisions,
      ...coverageDecisions,
      ...(status === "stale"
        ? ["The PR/MR HEAD changed during review; rerun against the new SHA."]
        : []),
    ];
    const verdict = calculateVerdict({
      status,
      findings: pipeline.findings,
      pendingDecisions: [...new Set(pendingDecisions)],
      sddApproved: pipeline.sdd.sddApproved,
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.reportTtlHours * 60 * 60 * 1_000);
    const report: ReviewReport = reviewReportSchema.parse({
      schemaVersion: "1.0",
      reviewId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      model: this.config.model,
      provider: provider.kind,
      host: identity.host,
      repository,
      root,
      changeRequestNumber: snapshot.number,
      changeRequestTitle: snapshot.title,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      feature,
      artifacts: artifacts.map((artifact) => ({ ...artifact, content: null })),
      coverage: pipeline.coverage,
      findings: pipeline.findings,
      risks: pipeline.risks,
      pendingDecisions: [...new Set(pendingDecisions)],
      limitations: pipeline.limitations,
      stagesIncomplete: pipeline.stagesIncomplete,
      status,
      verdict,
      usage: pipeline.usage,
    });
    await progress("report", 97);
    const reportPath = await this.reports.write(report, reviewSignal, input.openReport ?? true);
    await this.reports.cleanupExpired(this.config.reportTtlHours, reviewSignal);
    await progress("completed", 100);
    const blockingFindingCount = pipeline.findings.filter(
      (finding) =>
        finding.severity === "critical" ||
        (finding.severity === "high" && finding.criterionIds.length > 0),
    ).length;
    const topFindings = pipeline.findings.slice(0, 10).flatMap((finding) => {
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
    const coverageSummary = {
      covered: pipeline.coverage.filter((coverage) => coverage.status === "covered").length,
      partial: pipeline.coverage.filter((coverage) => coverage.status === "partial").length,
      missing: pipeline.coverage.filter((coverage) => coverage.status === "missing").length,
      notVerifiable: pipeline.coverage.filter((coverage) => coverage.status === "not_verifiable")
        .length,
    };
    this.logger.log("info", {
      event: "review_completed",
      reviewId,
      provider: provider.kind,
      changeRequest: input.number,
      counts: { findings: pipeline.findings.length, blockingFindings: blockingFindingCount },
      reason: status,
    });
    return {
      reviewId,
      status,
      verdict,
      provider: provider.kind,
      repository,
      root,
      changeRequestNumber: input.number,
      expectedHeadSha: input.expectedHeadSha,
      reviewedHeadSha: snapshot.headSha,
      currentHeadSha: finalHeadSha,
      reportPath,
      findingCount: pipeline.findings.length,
      blockingFindingCount,
      topFindings,
      coverageSummary,
      usage: pipeline.usage,
      message:
        status === "stale"
          ? "Review completed, but HEAD changed. The report is stale and must not be used for approval."
          : `Review ${status}; Tech Lead decision required for verdict ${verdict}.`,
    };
  }

  private resolveRoot(input: RootInput): Promise<string> {
    return resolveRepositoryRoot({
      ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
      ...(this.config.claudeProjectDir === undefined
        ? {}
        : { claudeProjectDir: this.config.claudeProjectDir }),
      ...(input.clientRoots === undefined ? {} : { clientRoots: input.clientRoots }),
    });
  }

  private async checkExecutable(
    executable: Extract<AllowedExecutable, "git" | "gh" | "glab">,
    signal: AbortSignal,
  ): Promise<DoctorCheck> {
    if (Bun.which(executable) === null) {
      return {
        name: `${executable}_availability`,
        status: executable === "git" ? "error" : "warning",
        detail: `${executable} is not installed or is not on PATH.`,
      };
    }
    const result = await this.runner.run({
      executable,
      args: ["--version"],
      signal,
      throwOnNonZero: false,
      maxOutputBytes: 32 * 1024,
    });
    return {
      name: `${executable}_availability`,
      status: result.exitCode === 0 ? "ok" : "warning",
      detail: result.stdout.trim().split(/\r?\n/)[0] ?? `${executable} detected.`,
    };
  }

  private staleResult(options: {
    reviewId: string;
    provider: "github" | "gitlab";
    repository: string;
    root: string;
    number: number;
    expectedHeadSha: string;
    currentHeadSha: string;
  }): ReviewResult {
    return {
      reviewId: options.reviewId,
      status: "stale",
      verdict: "REQUIERE_DECISION",
      provider: options.provider,
      repository: options.repository,
      root: options.root,
      changeRequestNumber: options.number,
      expectedHeadSha: options.expectedHeadSha,
      reviewedHeadSha: null,
      currentHeadSha: options.currentHeadSha,
      reportPath: null,
      findingCount: 0,
      blockingFindingCount: 0,
      topFindings: [],
      coverageSummary: ZERO_COVERAGE,
      usage: ZERO_USAGE,
      message: "HEAD no longer matches the SHA selected by the Tech Lead. List changes again.",
    };
  }
}
