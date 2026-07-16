import {
  AgentExecutionError,
  AnthropicAgentClient,
  type StructuredAgentClient,
} from "../anthropic/agent-client.ts";
import type { ReviewerConfig } from "../config/config.ts";
import type { ReviewStatus } from "../domain/contracts.ts";
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
import type { CommandExecutor } from "../security/command-runner.ts";
import { resolveRepositoryRoot } from "../security/path-confinement.ts";
import { buildReviewReport } from "./review-report-builder.ts";
import {
  emptyReviewResult,
  mapPipelineReviewResult,
  type ReviewResult,
  staleReviewResult,
} from "./review-result.ts";
import type { DoctorResult, ListResult, ReviewProgress, RootInput } from "./reviewer-contracts.ts";
import { runReviewerDoctor } from "./reviewer-doctor.ts";

export type { ReviewResult } from "./review-result.ts";
export type {
  DoctorCheck,
  DoctorResult,
  ListResult,
  ReviewProgress,
  RootInput,
} from "./reviewer-contracts.ts";

export interface ReviewerDependencies {
  readonly createProvider: typeof createProvider;
  readonly createAgentClient: (options: {
    apiKey: string;
    config: ReviewerConfig;
    budget: UsageBudget;
    logger: Logger;
  }) => StructuredAgentClient;
  readonly runPipeline: typeof runReviewPipeline;
  readonly now: () => Date;
  readonly randomUUID: () => string;
}

const defaultDependencies: ReviewerDependencies = {
  createProvider,
  createAgentClient: ({ apiKey, config, budget, logger }) =>
    new AnthropicAgentClient(
      apiKey,
      {
        explorerModel: config.explorerModel,
        orchestratorModel: config.orchestratorModel,
        orchestratorEffort: config.orchestratorEffort,
      },
      budget,
      logger,
      config.timeoutMs,
    ),
  runPipeline: runReviewPipeline,
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

export class ReviewerService {
  readonly reports: ReportStore;
  private readonly dependencies: ReviewerDependencies;

  constructor(
    private readonly config: ReviewerConfig,
    private readonly runner: CommandExecutor,
    private readonly logger: Logger,
    reportStore?: ReportStore,
    dependencies: Partial<ReviewerDependencies> = {},
  ) {
    this.reports = reportStore ?? new ReportStore(runner, logger);
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async doctor(input: RootInput, signal: AbortSignal): Promise<DoctorResult> {
    return runReviewerDoctor({
      config: this.config,
      runner: this.runner,
      reports: this.reports,
      createProvider: this.dependencies.createProvider,
      resolveRoot: (rootInput) => this.resolveRoot(rootInput),
      input,
      signal,
    });
  }

  async listOpenChangeRequests(
    input: RootInput & { limit: number },
    signal: AbortSignal,
  ): Promise<ListResult> {
    const root = await this.resolveRoot(input);
    const provider = await this.dependencies.createProvider({
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
    const reviewId = this.dependencies.randomUUID();
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const reviewSignal = AbortSignal.any([signal, timeoutSignal]);
    const progress = onProgress ?? (() => undefined);
    await progress("repository_resolution", 5);
    const root = await this.resolveRoot(input);
    const provider = await this.dependencies.createProvider({
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
      return staleReviewResult({
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
      return staleReviewResult({
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
    const client = this.dependencies.createAgentClient({
      apiKey: this.config.anthropicApiKey,
      config: this.config,
      budget,
      logger: this.logger,
    });
    let pipeline: PipelineResult;
    try {
      pipeline = await this.dependencies.runPipeline({
        context,
        client,
        budget,
        signal: reviewSignal,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
    } catch (error) {
      const reviewerError = toReviewerError(error);
      const attemptDiagnostics = error instanceof AgentExecutionError ? [...error.diagnostics] : [];
      if (signal.aborted || (reviewerError.code === "CANCELLED" && !timeoutSignal.aborted)) {
        return emptyReviewResult({
          reviewId,
          status: "cancelled",
          provider: provider.kind,
          repository,
          root,
          number: input.number,
          expectedHeadSha: input.expectedHeadSha,
          reviewedHeadSha: snapshot.headSha,
          currentHeadSha: snapshot.headSha,
          usage: budget.snapshot(),
          message: "Review cancelled before a reliable report could be completed.",
        });
      }
      if (timeoutSignal.aborted || reviewerError.code === "TIMEOUT") {
        return emptyReviewResult({
          reviewId,
          status: "incomplete",
          provider: provider.kind,
          repository,
          root,
          number: input.number,
          expectedHeadSha: input.expectedHeadSha,
          reviewedHeadSha: snapshot.headSha,
          currentHeadSha: snapshot.headSha,
          usage: budget.snapshot(),
          message: "Review reached its time limit before a reliable report could be completed.",
        });
      }
      pipeline = {
        reviewScope: "implementation",
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
        testCoverage: [],
        findings: [],
        risks: [],
        pendingDecisions: ["The mandatory agent pipeline did not complete."],
        limitations: [reviewerError.message],
        stagesIncomplete: ["agent_pipeline"],
        slices: [],
        attemptDiagnostics,
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
    const coverageDecisions = (pipeline.reviewScope === "test_only" ? [] : pipeline.coverage)
      .filter(
        (coverage) =>
          requiredCriterionIds.has(coverage.criterionId) &&
          (coverage.status === "partial" || coverage.status === "not_verifiable"),
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
    const now = this.dependencies.now();
    const report = buildReviewReport({
      config: this.config,
      reviewId,
      now,
      provider: provider.kind,
      host: identity.host,
      repository,
      root,
      snapshot,
      feature,
      artifacts,
      pipeline,
      pendingDecisions,
      status,
      verdict,
    });
    await progress("report", 97);
    const reportPath = await this.reports.write(report, reviewSignal, input.openReport ?? true);
    await this.reports.cleanupExpired(this.config.reportTtlHours, reviewSignal);
    await progress("completed", 100);
    const result = mapPipelineReviewResult({
      reviewId,
      pipeline,
      status,
      verdict,
      provider: provider.kind,
      repository,
      root,
      number: input.number,
      expectedHeadSha: input.expectedHeadSha,
      reviewedHeadSha: snapshot.headSha,
      currentHeadSha: finalHeadSha,
      reportPath,
    });
    this.logger.log("info", {
      event: "review_completed",
      reviewId,
      provider: provider.kind,
      changeRequest: input.number,
      counts: {
        findings: result.findingCount,
        blockingFindings: result.blockingFindingCount,
      },
      reason: status,
    });
    return result;
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
}
