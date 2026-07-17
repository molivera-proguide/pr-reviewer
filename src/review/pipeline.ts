import type { StructuredAgentClient } from "../anthropic/agent-client.ts";
import type {
  AttemptSummary,
  CodeSliceSummary,
  Finding,
  ReviewCoverage,
  ReviewStatus,
  SlicePlanningSummary,
  Usage,
} from "../domain/contracts.ts";
import type { UsageBudget } from "../security/budget.ts";
import { PROMPTS } from "./agents/prompts.ts";
import { type SddAnalysis, sddAnalysisSchema } from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import {
  coverageFromCompletedSlices,
  coverageFromFindings,
  deterministicCoverage,
  globalAgentLimitations,
  omittedImplementationCriteria,
} from "./coverage-projection.ts";
import { runCoverageRepair } from "./coverage-repair.ts";
import { verifyFindings } from "./evidence-verifier.ts";
import {
  applySeverityCap,
  findingsFromCompletedSlices,
  normalizeTestCoverageFinding,
  withStableFindingIds,
} from "./finding-projection.ts";
import { runSemanticVerification } from "./semantic-verification.ts";
import { type CodeSliceResult, runCodeSlices } from "./slice-executor.ts";
import { planReviewSlices } from "./slice-planner.ts";
import { classifyReviewChange, type ReviewSliceScope, sliceKindOf } from "./slicer.ts";

export { omittedImplementationCriteria } from "./coverage-projection.ts";
export {
  applySeverityCap,
  normalizeTestCoverageFinding,
  stableFindingId,
} from "./finding-projection.ts";
export type { CodeSliceResult } from "./slice-executor.ts";

export interface PipelineResult {
  readonly reviewScope: ReviewSliceScope;
  readonly sdd: SddAnalysis;
  readonly coverage: ReviewCoverage[];
  readonly testCoverage: ReviewCoverage[];
  readonly findings: Finding[];
  readonly risks: string[];
  readonly pendingDecisions: string[];
  readonly limitations: string[];
  readonly stagesIncomplete: string[];
  readonly planning?: SlicePlanningSummary;
  readonly slices: CodeSliceSummary[];
  readonly attemptDiagnostics: AttemptSummary[];
  readonly status: ReviewStatus;
  readonly usage: Usage;
}

export type PipelineProgress = (stage: string, progress: number) => Promise<void> | void;

function loadedArtifacts(
  context: ReviewContext,
  maxChars: number,
): {
  artifacts: { path: string; kind: string; content: string }[];
  truncated: boolean;
} {
  const output: { path: string; kind: string; content: string }[] = [];
  let remaining = maxChars;
  let truncated = false;
  for (const artifact of context.artifacts) {
    if (artifact.content === null) continue;
    const content = artifact.content.slice(0, Math.max(0, remaining));
    output.push({ path: artifact.path, kind: artifact.kind, content });
    remaining -= content.length;
    if (content.length < artifact.content.length) truncated = true;
    if (remaining <= 0) break;
  }
  return { artifacts: output, truncated };
}

function sliceSummary(result: CodeSliceResult): CodeSliceSummary {
  const diagnostics = result.diagnostics;
  const acceptedCriteria = result.analysis?.acceptedCriterionIds.length ?? 0;
  return {
    id: result.sliceId,
    kind: result.sliceScope === "implementation" ? "implementation" : "tests",
    scope: result.sliceScope,
    status: result.status,
    ...(result.status === "completed" ? { assessmentStatus: result.assessmentStatus } : {}),
    assignedCriteria: result.assignedCriteria,
    acceptedCriteria,
    ...(result.status === "incomplete" ? { failureKind: result.failureKind } : {}),
    attempts: diagnostics.length,
    inputTokens: diagnostics.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: diagnostics.reduce((sum, item) => sum + item.outputTokens, 0),
    requestIds: diagnostics.flatMap((item) => (item.requestId === null ? [] : [item.requestId])),
  };
}

export async function runReviewPipeline(options: {
  context: ReviewContext;
  client: StructuredAgentClient;
  budget: UsageBudget;
  signal: AbortSignal;
  onProgress?: PipelineProgress;
}): Promise<PipelineResult> {
  const progress = options.onProgress ?? (() => undefined);
  const diagnostics: AttemptSummary[] = [];
  const postStageLimitations: string[] = [];
  const postStagesIncomplete: string[] = [];
  const postPendingDecisions: string[] = [];
  await progress("sdd_exploration", 30);
  const artifactPayload = loadedArtifacts(options.context, 600_000);
  const sddResponse = await options.client.run({
    role: "sdd_explorer",
    system: PROMPTS.sddExplorer,
    payload: {
      feature: options.context.feature,
      artifacts: artifactPayload.artifacts,
    },
    schema: sddAnalysisSchema,
    maxTokens: 3_000,
    signal: options.signal,
  });
  diagnostics.push(...sddResponse.diagnostics);
  const artifactPaths = new Set(
    options.context.artifacts.map((artifact) => artifact.path.replaceAll("\\", "/").toLowerCase()),
  );
  const reviewFiles = options.context.snapshot.files.filter(
    (file) =>
      !artifactPaths.has(file.path.replaceAll("\\", "/").toLowerCase()) &&
      (file.oldPath === null ||
        !artifactPaths.has(file.oldPath.replaceAll("\\", "/").toLowerCase())),
  );
  const changedFileInventory = reviewFiles.map((file) => ({
    path: file.path,
    status: file.status,
    binary: file.binary,
    truncated: file.truncated,
  }));
  const reviewScope: ReviewSliceScope =
    classifyReviewChange(reviewFiles) === "test_only" ? "test_only" : "implementation";
  await progress("slice_planning", 40);
  const planning = await planReviewSlices({
    files: reviewFiles,
    criteria: sddResponse.data.criteria,
    client: options.client,
    signal: options.signal,
  });
  diagnostics.push(...planning.diagnostics);
  const slices = [...planning.slices];
  await progress("code_exploration", 45);
  let sliceResults = await runCodeSlices({
    slices,
    changedFileInventory,
    context: options.context,
    sdd: sddResponse.data,
    client: options.client,
    signal: options.signal,
  });
  diagnostics.push(...sliceResults.flatMap((result) => result.diagnostics));
  await progress("evidence_verification", 68);
  const primaryFindings = verifyFindings(
    options.context.snapshot,
    findingsFromCompletedSlices(sliceResults, sddResponse.data.criteria),
  );
  const primarySemantic = await runSemanticVerification({
    findings: primaryFindings,
    criteria: sddResponse.data.criteria,
    client: options.client,
    signal: options.signal,
  });
  let findings = primarySemantic.findings;
  diagnostics.push(...primarySemantic.diagnostics);
  postStageLimitations.push(...primarySemantic.limitations);
  postStagesIncomplete.push(...primarySemantic.stagesIncomplete);
  postPendingDecisions.push(...primarySemantic.pendingDecisions);
  const initialImplementationCandidates = [
    ...coverageFromCompletedSlices(sliceResults, "implementation", findings),
    ...coverageFromFindings(findings, "implementation", sddResponse.data.criteria),
  ];
  const omittedCriteria = omittedImplementationCriteria({
    snapshot: options.context.snapshot,
    criteria: sddResponse.data.criteria,
    candidates: initialImplementationCandidates,
    findings,
  });
  const implementationExplorationComplete = !sliceResults.some(
    (result) => result.status === "incomplete" && result.sliceScope === "implementation",
  );
  if (
    reviewScope === "implementation" &&
    omittedCriteria.length > 0 &&
    implementationExplorationComplete
  ) {
    await progress("coverage_repair", 72);
    const repair = await runCoverageRepair({
      criteria: omittedCriteria,
      implementationFiles: reviewFiles.filter(
        (file) => sliceKindOf(file.path) === "implementation",
      ),
      evidenceHints: initialImplementationCandidates,
      context: options.context,
      sdd: sddResponse.data,
      client: options.client,
      signal: options.signal,
    });
    diagnostics.push(...repair.diagnostics);
    sliceResults = [...sliceResults, repair];
    const repairFindings = verifyFindings(
      options.context.snapshot,
      findingsFromCompletedSlices([repair], sddResponse.data.criteria),
    );
    const repairSemantic = await runSemanticVerification({
      findings: repairFindings,
      criteria: sddResponse.data.criteria,
      client: options.client,
      signal: options.signal,
    });
    findings = [...findings, ...repairSemantic.findings];
    diagnostics.push(...repairSemantic.diagnostics);
    postStageLimitations.push(...repairSemantic.limitations);
    postStagesIncomplete.push(...repairSemantic.stagesIncomplete);
    postPendingDecisions.push(...repairSemantic.pendingDecisions);
  }
  const incompleteSlices = sliceResults.filter((result) => result.status === "incomplete");
  findings = withStableFindingIds(findings.map(applySeverityCap).map(normalizeTestCoverageFinding));

  await progress("deterministic_synthesis", 82);
  const implementationCandidates = [
    ...coverageFromCompletedSlices(sliceResults, "implementation", findings),
    ...coverageFromFindings(findings, "implementation", sddResponse.data.criteria),
  ];
  const testCandidates = [
    ...coverageFromCompletedSlices(sliceResults, "tests", findings),
    ...coverageFromFindings(findings, "tests", sddResponse.data.criteria),
  ];
  const coverage =
    reviewScope === "test_only"
      ? sddResponse.data.criteria.map((criterion) => ({
          criterionId: criterion.id,
          description: criterion.description,
          status: "not_verifiable" as const,
          evidence: [],
          notes: "Implementation is outside the scope of this test-only change.",
        }))
      : deterministicCoverage({
          context: options.context,
          sdd: sddResponse.data,
          candidates: implementationCandidates,
          findings,
          dimension: "implementation",
          hasIncompleteSlices: incompleteSlices.some(
            (result) =>
              result.sliceScope === "implementation" && result.sliceId !== "coverage-repair-1",
          ),
        });
  const testCoverage = deterministicCoverage({
    context: options.context,
    sdd: sddResponse.data,
    candidates: testCandidates,
    findings,
    dimension: "tests",
    hasIncompleteSlices: incompleteSlices.length > 0,
  });
  const risks = findings
    .filter((finding) => finding.verified && finding.impact === "implementation")
    .map((finding) => finding.claim)
    .filter((claim, index, all) => all.indexOf(claim) === index)
    .slice(0, 20);

  const limitations = [
    ...options.context.limitations,
    ...globalAgentLimitations(sliceResults, options.context.snapshot),
    ...incompleteSlices.map((result) => result.limitation),
    ...postStageLimitations,
    ...(artifactPayload.truncated ? ["SDD agent context was truncated to its safety budget."] : []),
    ...slices
      .filter((slice) => slice.truncated)
      .map((slice) => `${slice.id} exceeded its context budget.`),
  ];
  const incompleteRequiredCoverage =
    reviewScope === "test_only"
      ? []
      : coverage.filter(
          (item) =>
            (item.status === "partial" || item.status === "not_verifiable") &&
            sddResponse.data.criteria.some(
              (criterion) => criterion.required && criterion.id === item.criterionId,
            ),
        );
  const stagesIncomplete = [
    ...(artifactPayload.truncated ? ["sdd_exploration"] : []),
    ...slices.filter((slice) => slice.truncated).map((slice) => `code_exploration:${slice.id}`),
    ...incompleteSlices.map((result) => `code_exploration:${result.sliceId}`),
    ...(options.context.snapshot.files.some((file) => file.truncated || file.binary)
      ? ["code_evidence"]
      : []),
    ...(sddResponse.data.criteria.length === 0 ? ["sdd_criteria"] : []),
    ...incompleteRequiredCoverage.map((item) => `coverage:${item.criterionId}`),
    ...postStagesIncomplete,
  ];
  const status: ReviewStatus = stagesIncomplete.length > 0 ? "incomplete" : "completed";
  const pendingDecisions = [
    ...sddResponse.data.conflicts,
    ...postPendingDecisions,
    ...(incompleteSlices.length > 0
      ? ["Zero findings does not mean zero defects: part of the change was not reviewed."]
      : []),
    ...(!sddResponse.data.sddApproved ? ["Missing explicit /sdd-review APROBADO marker."] : []),
  ];
  await progress("pipeline_complete", 90);
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  findings.sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      right.confidence - left.confidence,
  );
  return {
    reviewScope,
    sdd: sddResponse.data,
    coverage,
    testCoverage,
    findings,
    risks,
    pendingDecisions: [...new Set(pendingDecisions)],
    limitations: [...new Set(limitations)],
    stagesIncomplete: [...new Set(stagesIncomplete)],
    planning: planning.summary,
    slices: sliceResults.map(sliceSummary),
    attemptDiagnostics: diagnostics,
    status,
    usage: options.budget.snapshot(),
  };
}
