import type { StructuredAgentClient } from "../anthropic/agent-client.ts";
import type { Finding, ReviewCoverage, ReviewStatus, Usage } from "../domain/contracts.ts";
import type { UsageBudget } from "../security/budget.ts";
import { PROMPTS } from "./agents/prompts.ts";
import {
  codeAnalysisSchema,
  type SddAnalysis,
  sddAnalysisSchema,
  semanticVerificationSchema,
  synthesisSchema,
} from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import { verifyCoverage, verifyFindings } from "./evidence-verifier.ts";
import { createReviewSlices } from "./slicer.ts";

export interface PipelineResult {
  readonly sdd: SddAnalysis;
  readonly coverage: ReviewCoverage[];
  readonly findings: Finding[];
  readonly risks: string[];
  readonly pendingDecisions: string[];
  readonly limitations: string[];
  readonly stagesIncomplete: string[];
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output: R[] = new Array(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) {
        output[index] = await mapper(value, index);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

export async function runReviewPipeline(options: {
  context: ReviewContext;
  client: StructuredAgentClient;
  budget: UsageBudget;
  signal: AbortSignal;
  onProgress?: PipelineProgress;
}): Promise<PipelineResult> {
  const progress = options.onProgress ?? (() => undefined);
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
    maxTokens: 5_000,
    signal: options.signal,
  });
  const slices = createReviewSlices(options.context.snapshot.files, sddResponse.data.criteria);
  await progress("code_exploration", 45);
  const analyses = await mapWithConcurrency(slices, 2, async (slice) => {
    const response = await options.client.run({
      role: "code_explorer",
      system: PROMPTS.codeExplorer,
      payload: {
        repository: options.context.snapshot.baseRepository,
        headSha: options.context.snapshot.headSha,
        baseSha: options.context.snapshot.baseSha,
        slice,
        constraints: sddResponse.data.constraints,
        decisions: sddResponse.data.decisions,
      },
      schema: codeAnalysisSchema,
      maxTokens: 5_000,
      signal: options.signal,
    });
    return response.data;
  });
  await progress("evidence_verification", 68);
  let findings = verifyFindings(
    options.context.snapshot,
    analyses.flatMap((analysis) => analysis.findings),
  );
  const material = findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  );
  if (material.length > 0) {
    const semantic = await options.client.run({
      role: "semantic_verifier",
      system: PROMPTS.verifier,
      payload: { criteria: sddResponse.data.criteria, findings: material },
      schema: semanticVerificationSchema,
      maxTokens: 3_000,
      signal: options.signal,
    });
    const decisions = new Map(
      semantic.data.decisions.map((decision) => [decision.findingId, decision]),
    );
    findings = findings.flatMap((finding) => {
      if (finding.severity !== "critical" && finding.severity !== "high") return [finding];
      const decision = decisions.get(finding.id);
      if (decision?.confirmed !== true) return [];
      return [{ ...finding, severity: decision.adjustedSeverity, verified: true }];
    });
  }
  await progress("synthesis", 82);
  const synthesis = await options.client.run({
    role: "synthesizer",
    system: PROMPTS.synthesizer,
    payload: {
      criteria: sddResponse.data.criteria,
      findings,
      candidateCoverage: analyses.flatMap((analysis) => analysis.coverage),
      conflicts: sddResponse.data.conflicts,
      limitations: [
        ...options.context.limitations,
        ...analyses.flatMap((analysis) => analysis.limitations),
      ],
    },
    schema: synthesisSchema,
    maxTokens: 4_000,
    signal: options.signal,
  });
  const synthesizedIds = new Set(synthesis.data.coverage.map((item) => item.criterionId));
  const filledCoverage: ReviewCoverage[] = [
    ...synthesis.data.coverage,
    ...sddResponse.data.criteria
      .filter((criterion) => !synthesizedIds.has(criterion.id))
      .map((criterion) => ({
        criterionId: criterion.id,
        description: criterion.description,
        status: "not_verifiable" as const,
        evidence: [],
        notes: "The synthesizer did not return coverage for this criterion.",
      })),
  ];
  const limitations = [
    ...options.context.limitations,
    ...analyses.flatMap((analysis) => analysis.limitations),
    ...(artifactPayload.truncated ? ["SDD agent context was truncated to its safety budget."] : []),
    ...slices
      .filter((slice) => slice.truncated)
      .map((slice) => `${slice.id} exceeded its context budget.`),
  ];
  const stagesIncomplete = [
    ...(artifactPayload.truncated ? ["sdd_exploration"] : []),
    ...(slices.some((slice) => slice.truncated) ? ["code_exploration"] : []),
    ...(options.context.snapshot.files.some((file) => file.truncated || file.binary)
      ? ["code_evidence"]
      : []),
    ...(sddResponse.data.criteria.length === 0 ? ["sdd_criteria"] : []),
  ];
  const status: ReviewStatus = stagesIncomplete.length > 0 ? "incomplete" : "completed";
  const pendingDecisions = [
    ...synthesis.data.pendingDecisions,
    ...sddResponse.data.conflicts,
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
    coverage: verifyCoverage(options.context.snapshot, filledCoverage),
    findings,
    risks: synthesis.data.risks,
    pendingDecisions: [...new Set(pendingDecisions)],
    limitations: [...new Set(limitations)],
    stagesIncomplete: [...new Set(stagesIncomplete)],
    status,
    usage: options.budget.snapshot(),
  };
}
