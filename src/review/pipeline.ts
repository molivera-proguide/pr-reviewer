import { createHash } from "node:crypto";
import { AgentExecutionError, type StructuredAgentClient } from "../anthropic/agent-client.ts";
import type {
  AgentFailureKind,
  AttemptSummary,
  CodeSliceSummary,
  CoverageDimension,
  Finding,
  ReviewCoverage,
  ReviewStatus,
  Usage,
} from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";
import type { UsageBudget } from "../security/budget.ts";
import { PROMPTS } from "./agents/prompts.ts";
import {
  type AgentFinding,
  type CodeAnalysis,
  codeAnalysisSchema,
  type SddAnalysis,
  sddAnalysisSchema,
  semanticVerificationSchema,
  synthesisSchema,
} from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import { verifyCoverage, verifyFindings } from "./evidence-verifier.ts";
import { createReviewSlices, type ReviewSlice } from "./slicer.ts";

export type CodeSliceResult =
  | {
      readonly status: "completed";
      readonly sliceId: string;
      readonly sliceKind: CoverageDimension;
      readonly analysis: CodeAnalysis;
      readonly diagnostics: readonly AttemptSummary[];
    }
  | {
      readonly status: "incomplete";
      readonly sliceId: string;
      readonly sliceKind: CoverageDimension;
      readonly failureKind: AgentFailureKind;
      readonly limitation: string;
      readonly diagnostics: readonly AttemptSummary[];
    };

export interface PipelineResult {
  readonly sdd: SddAnalysis;
  readonly coverage: ReviewCoverage[];
  readonly testCoverage: ReviewCoverage[];
  readonly findings: Finding[];
  readonly risks: string[];
  readonly pendingDecisions: string[];
  readonly limitations: string[];
  readonly stagesIncomplete: string[];
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

function classifiedFailure(error: unknown): {
  kind: AgentFailureKind;
  diagnostics: readonly AttemptSummary[];
} {
  if (error instanceof AgentExecutionError) {
    return { kind: error.failureKind, diagnostics: error.diagnostics };
  }
  if (error instanceof ReviewerError) {
    if (error.code === "CANCELLED") return { kind: "cancelled", diagnostics: [] };
    if (error.code === "BUDGET_EXCEEDED") return { kind: "budget", diagnostics: [] };
  }
  return { kind: "permanent_api", diagnostics: [] };
}

function safeStageLimitation(role: string, kind: AgentFailureKind, sliceId?: string): string {
  return `${role}${sliceId === undefined ? "" : ` ${sliceId}`} was incomplete (${kind}).`;
}

function stopsNewSlices(kind: AgentFailureKind): boolean {
  return kind === "budget" || kind === "cancelled" || kind === "permanent_api";
}

async function runCodeSlices(options: {
  slices: readonly ReviewSlice[];
  context: ReviewContext;
  sdd: SddAnalysis;
  changedFileInventory: readonly {
    path: string;
    status: string;
    binary: boolean;
    truncated: boolean;
  }[];
  client: StructuredAgentClient;
  signal: AbortSignal;
}): Promise<CodeSliceResult[]> {
  const output: Array<CodeSliceResult[] | undefined> = new Array(options.slices.length);
  let cursor = 0;
  let stopKind: AgentFailureKind | undefined;

  async function execute(slice: ReviewSlice): Promise<CodeSliceResult> {
    try {
      const response = await options.client.run({
        role: "code_explorer",
        sliceId: slice.id,
        system: PROMPTS.codeExplorer,
        payload: {
          repository: options.context.snapshot.baseRepository,
          headSha: options.context.snapshot.headSha,
          baseSha: options.context.snapshot.baseSha,
          slice,
          changedFileInventory: options.changedFileInventory,
          constraints: options.sdd.constraints,
          decisions: options.sdd.decisions,
        },
        schema: codeAnalysisSchema,
        maxTokens: 4_000,
        signal: options.signal,
      });
      return {
        status: "completed",
        sliceId: slice.id,
        sliceKind: slice.kind,
        analysis: response.data,
        diagnostics: response.diagnostics,
      };
    } catch (error) {
      const failure = classifiedFailure(error);
      return {
        status: "incomplete",
        sliceId: slice.id,
        sliceKind: slice.kind,
        failureKind: failure.kind,
        limitation: safeStageLimitation("Code exploration", failure.kind, slice.id),
        diagnostics: failure.diagnostics,
      };
    }
  }

  function split(slice: ReviewSlice): [ReviewSlice, ReviewSlice] | null {
    if (slice.files.length < 2) return null;
    const midpoint = Math.ceil(slice.files.length / 2);
    return [
      { ...slice, id: `${slice.id}.1`, files: slice.files.slice(0, midpoint) },
      { ...slice, id: `${slice.id}.2`, files: slice.files.slice(midpoint) },
    ];
  }

  async function worker(): Promise<void> {
    while (cursor < options.slices.length && stopKind === undefined) {
      const index = cursor;
      cursor += 1;
      const slice = options.slices[index];
      if (slice === undefined) continue;
      const result = await execute(slice);
      const children =
        result.status === "incomplete" && result.failureKind === "max_tokens" ? split(slice) : null;
      if (children === null) {
        output[index] = [result];
        if (result.status === "incomplete" && stopsNewSlices(result.failureKind)) {
          stopKind = result.failureKind;
        }
        continue;
      }
      const childResults: CodeSliceResult[] = [];
      for (const child of children) {
        const childResult = await execute(child);
        childResults.push(childResult);
        if (childResult.status === "incomplete" && stopsNewSlices(childResult.failureKind)) {
          stopKind = childResult.failureKind;
          break;
        }
      }
      if (stopKind !== undefined && childResults.length < children.length) {
        for (const child of children.slice(childResults.length)) {
          childResults.push({
            status: "incomplete",
            sliceId: child.id,
            sliceKind: child.kind,
            failureKind: stopKind,
            limitation: safeStageLimitation("Code exploration", stopKind, child.id),
            diagnostics: [],
          });
        }
      }
      if (childResults[0] !== undefined) {
        childResults[0] = {
          ...childResults[0],
          diagnostics: [...result.diagnostics, ...childResults[0].diagnostics],
        };
      }
      output[index] = childResults;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, options.slices.length) }, () => worker()));
  if (options.signal.aborted) {
    throw new ReviewerError("CANCELLED", "Code exploration was cancelled.");
  }
  for (let index = 0; index < options.slices.length; index += 1) {
    if (output[index] !== undefined) continue;
    const slice = options.slices[index];
    if (slice === undefined) continue;
    const kind = stopKind ?? "permanent_api";
    output[index] = [
      {
        status: "incomplete",
        sliceId: slice.id,
        sliceKind: slice.kind,
        failureKind: kind,
        limitation: safeStageLimitation("Code exploration", kind, slice.id),
        diagnostics: [],
      },
    ];
  }
  return output.flatMap((items) => items ?? []);
}

function stableFindingId(finding: AgentFinding): string {
  const first = finding.evidence[0];
  const identity = [
    finding.impact,
    finding.category.toLowerCase(),
    first?.revision ?? "",
    first?.path.toLowerCase() ?? "",
    first?.startLine ?? 0,
    finding.claim.toLowerCase().replace(/\s+/g, " ").trim(),
  ].join("|");
  return `finding-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function findingsFromCompletedSlices(results: readonly CodeSliceResult[]): AgentFinding[] {
  return results.flatMap((result) => {
    if (result.status !== "completed") return [];
    return result.analysis.findings
      .filter(
        (finding) =>
          finding.impact === "maintainability" ||
          (result.sliceKind === "tests" && finding.impact === "test_coverage") ||
          (result.sliceKind === "implementation" && finding.impact === "implementation"),
      )
      .map((finding) => ({ ...finding, id: stableFindingId(finding) }));
  });
}

function coverageFromCompletedSlices(
  results: readonly CodeSliceResult[],
  dimension: CoverageDimension,
  findings: readonly Finding[],
): ReviewCoverage[] {
  const expectedImpact = dimension === "implementation" ? "implementation" : "test_coverage";
  const defectCriterionIds = new Set(
    findings
      .filter((finding) => finding.impact === expectedImpact)
      .flatMap((finding) => finding.criterionIds),
  );
  return results.flatMap((result) => {
    if (result.status !== "completed" || result.sliceKind !== dimension) return [];
    return result.analysis.coverage
      .filter((item) => item.dimension === dimension)
      .map(({ dimension: _dimension, ...item }) => {
        if (defectCriterionIds.has(item.criterionId)) return item;
        if (item.status === "partial" && dimension === "implementation") {
          return {
            ...item,
            status: "covered" as const,
            notes: `Verified ${dimension} evidence with no matching verified defect.`,
          };
        }
        if (item.status === "missing") {
          return {
            ...item,
            status: "not_verifiable" as const,
            notes: `The explorer reported missing ${dimension} coverage without a matching verified defect.`,
          };
        }
        return item;
      });
  });
}

function globalAgentLimitations(results: readonly CodeSliceResult[]): string[] {
  return results.flatMap((result) =>
    result.status === "completed"
      ? result.analysis.limitations
          .filter((limitation) => limitation.scope === "global_unavailability")
          .map((limitation) => limitation.description)
      : [],
  );
}

function coverageFromFindings(
  findings: readonly Finding[],
  dimension: CoverageDimension,
  criteria: ReadonlyArray<SddAnalysis["criteria"][number]>,
): ReviewCoverage[] {
  const expectedImpact = dimension === "implementation" ? "implementation" : "test_coverage";
  const descriptions = new Map(criteria.map((criterion) => [criterion.id, criterion.description]));
  return findings.flatMap((finding) => {
    if (finding.impact !== expectedImpact) return [];
    return finding.criterionIds.flatMap((criterionId) => {
      const description = descriptions.get(criterionId);
      if (description === undefined) return [];
      return [
        {
          criterionId,
          description,
          status: "missing" as const,
          evidence: finding.evidence,
          notes: finding.claim.slice(0, 1_000),
        },
      ];
    });
  });
}

function uniqueEvidence(items: readonly ReviewCoverage[]): ReviewCoverage["evidence"] {
  const seen = new Set<string>();
  return items.flatMap((item) =>
    item.evidence.filter((evidence) => {
      const key = `${evidence.revision}|${evidence.path}|${evidence.startLine}|${evidence.endLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function deterministicCoverage(options: {
  context: ReviewContext;
  sdd: SddAnalysis;
  candidates: readonly ReviewCoverage[];
  hasIncompleteSlices: boolean;
}): ReviewCoverage[] {
  const verified = verifyCoverage(options.context.snapshot, options.candidates);
  return options.sdd.criteria.map((criterion) => {
    const matching = verified.filter((item) => item.criterionId === criterion.id);
    const evidence = uniqueEvidence(matching);
    if (matching.length === 0 || evidence.length === 0) {
      return {
        criterionId: criterion.id,
        description: criterion.description,
        status: "not_verifiable",
        evidence: [],
        notes: "No completed slice returned deterministically verifiable coverage.",
      };
    }
    const statuses = new Set(matching.map((item) => item.status));
    const status = statuses.has("missing")
      ? "missing"
      : options.hasIncompleteSlices || statuses.size > 1 || statuses.has("partial")
        ? "partial"
        : statuses.has("covered")
          ? "covered"
          : "not_verifiable";
    return {
      criterionId: criterion.id,
      description: criterion.description,
      status,
      evidence,
      notes:
        options.hasIncompleteSlices && status !== "missing"
          ? "Coverage is partial because at least one code slice was not reviewed."
          : matching
              .map((item) => item.notes)
              .filter(Boolean)
              .join(" ")
              .slice(0, 1_000),
    };
  });
}

function sliceSummary(result: CodeSliceResult): CodeSliceSummary {
  const diagnostics = result.diagnostics;
  return {
    id: result.sliceId,
    kind: result.sliceKind,
    status: result.status,
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
  const slices = createReviewSlices(reviewFiles, sddResponse.data.criteria);
  await progress("code_exploration", 45);
  const sliceResults = await runCodeSlices({
    slices,
    changedFileInventory: reviewFiles.map((file) => ({
      path: file.path,
      status: file.status,
      binary: file.binary,
      truncated: file.truncated,
    })),
    context: options.context,
    sdd: sddResponse.data,
    client: options.client,
    signal: options.signal,
  });
  diagnostics.push(...sliceResults.flatMap((result) => result.diagnostics));
  const incompleteSlices = sliceResults.filter((result) => result.status === "incomplete");
  await progress("evidence_verification", 68);
  let findings = verifyFindings(
    options.context.snapshot,
    findingsFromCompletedSlices(sliceResults),
  );
  const material = findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  );
  if (material.length > 0) {
    try {
      const semantic = await options.client.run({
        role: "semantic_verifier",
        system: PROMPTS.verifier,
        payload: { criteria: sddResponse.data.criteria, findings },
        schema: semanticVerificationSchema,
        maxTokens: 3_000,
        signal: options.signal,
      });
      diagnostics.push(...semantic.diagnostics);
      const decisions = new Map(
        semantic.data.decisions.map((decision) => [decision.findingId, decision]),
      );
      const validCriterionIds = new Set(sddResponse.data.criteria.map((criterion) => criterion.id));
      findings = findings.flatMap((finding) => {
        const decision = decisions.get(finding.id);
        if (decision === undefined) {
          return finding.severity === "critical" || finding.severity === "high" ? [] : [finding];
        }
        if (!decision.confirmed) return [];
        const criterionIds =
          decision.adjustedImpact === "maintainability"
            ? []
            : decision.confirmedCriterionIds.filter((id) => validCriterionIds.has(id));
        return [
          {
            ...finding,
            severity: decision.adjustedSeverity,
            impact: decision.adjustedImpact,
            criterionIds,
            verified: true,
          },
        ];
      });
    } catch (error) {
      const failure = classifiedFailure(error);
      diagnostics.push(...failure.diagnostics);
      postStagesIncomplete.push("semantic_verification");
      postStageLimitations.push(safeStageLimitation("Semantic verification", failure.kind));
      postPendingDecisions.push("Material findings could not be semantically revalidated.");
      if (options.signal.aborted) throw error;
    }
  }

  await progress("synthesis", 82);
  const implementationCandidates = [
    ...coverageFromCompletedSlices(sliceResults, "implementation", findings),
    ...coverageFromFindings(findings, "implementation", sddResponse.data.criteria),
  ];
  const testCandidates = [
    ...coverageFromCompletedSlices(sliceResults, "tests", findings),
    ...coverageFromFindings(findings, "tests", sddResponse.data.criteria),
  ];
  const coverage = deterministicCoverage({
    context: options.context,
    sdd: sddResponse.data,
    candidates: implementationCandidates,
    hasIncompleteSlices: incompleteSlices.some((result) => result.sliceKind === "implementation"),
  });
  const testCoverage = deterministicCoverage({
    context: options.context,
    sdd: sddResponse.data,
    candidates: testCandidates,
    hasIncompleteSlices: incompleteSlices.some((result) => result.sliceKind === "tests"),
  });
  let risks: string[];
  let synthesisPending: string[];
  try {
    const synthesis = await options.client.run({
      role: "synthesizer",
      system: PROMPTS.synthesizer,
      payload: {
        criteria: sddResponse.data.criteria.map(({ id, description, required }) => ({
          id,
          description,
          required,
        })),
        findings: findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          category: finding.category,
          impact: finding.impact,
          claim: finding.claim,
          confidence: finding.confidence,
          criterionIds: finding.criterionIds,
          evidence: finding.evidence.map(({ revision, path, startLine, endLine }) => ({
            revision,
            path,
            startLine,
            endLine,
          })),
        })),
        implementationCoverage: coverage.map((item) => ({
          criterionId: item.criterionId,
          status: item.status,
          notes: item.notes,
          evidence: item.evidence.map(({ revision, path, startLine, endLine }) => ({
            revision,
            path,
            startLine,
            endLine,
          })),
        })),
        testCoverage: testCoverage.map((item) => ({
          criterionId: item.criterionId,
          status: item.status,
          notes: item.notes,
          evidence: item.evidence.map(({ revision, path, startLine, endLine }) => ({
            revision,
            path,
            startLine,
            endLine,
          })),
        })),
        conflicts: sddResponse.data.conflicts.map((description, index) => ({
          index,
          description,
        })),
        limitations: [
          ...options.context.limitations,
          ...globalAgentLimitations(sliceResults),
          ...incompleteSlices.map((result) => result.limitation),
        ],
      },
      schema: synthesisSchema,
      maxTokens: 2_500,
      signal: options.signal,
    });
    diagnostics.push(...synthesis.diagnostics);
    risks = synthesis.data.risks;
    synthesisPending = synthesis.data.pendingDecisions
      .filter((decision) =>
        decision.conflictIndexes.every((index) => index < sddResponse.data.conflicts.length),
      )
      .map((decision) => decision.question);
  } catch (error) {
    const failure = classifiedFailure(error);
    diagnostics.push(...failure.diagnostics);
    postStagesIncomplete.push("synthesis");
    postStageLimitations.push(safeStageLimitation("Synthesis", failure.kind));
    postPendingDecisions.push("Coverage synthesis did not complete; deterministic fallback used.");
    risks = [];
    synthesisPending = [];
    if (options.signal.aborted) throw error;
  }

  const limitations = [
    ...options.context.limitations,
    ...globalAgentLimitations(sliceResults),
    ...incompleteSlices.map((result) => result.limitation),
    ...postStageLimitations,
    ...(artifactPayload.truncated ? ["SDD agent context was truncated to its safety budget."] : []),
    ...slices
      .filter((slice) => slice.truncated)
      .map((slice) => `${slice.id} exceeded its context budget.`),
  ];
  const incompleteRequiredCoverage = coverage.filter(
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
    ...(synthesisPending.length > 0 ? synthesisPending : sddResponse.data.conflicts),
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
    sdd: sddResponse.data,
    coverage,
    testCoverage,
    findings,
    risks,
    pendingDecisions: [...new Set(pendingDecisions)],
    limitations: [...new Set(limitations)],
    stagesIncomplete: [...new Set(stagesIncomplete)],
    slices: sliceResults.map(sliceSummary),
    attemptDiagnostics: diagnostics,
    status,
    usage: options.budget.snapshot(),
  };
}
