import type { StructuredAgentClient } from "../anthropic/agent-client.ts";
import type { ReviewCoverage } from "../domain/contracts.ts";
import { classifyAgentFailure, safeStageLimitation } from "./agent-failure.ts";
import { PROMPTS } from "./agents/prompts.ts";
import {
  type AgentFinding,
  type CoverageRepair,
  coverageRepairSchema,
  type SddAnalysis,
  type SddCriterion,
} from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import { isEvidenceValid } from "./evidence-verifier.ts";
import { evidencePaths, type SliceAnalysis } from "./slice-analysis.ts";
import type { CodeSliceResult } from "./slice-executor.ts";
import { createReviewSlices } from "./slicer.ts";

export async function runCoverageRepair(options: {
  criteria: readonly SddCriterion[];
  implementationFiles: ReviewContext["snapshot"]["files"];
  evidenceHints: readonly ReviewCoverage[];
  context: ReviewContext;
  sdd: SddAnalysis;
  client: StructuredAgentClient;
  signal: AbortSignal;
}): Promise<CodeSliceResult> {
  const sliceId = "coverage-repair-1";
  const repairSlice = createReviewSlices(options.implementationFiles, options.criteria, 1)[0];
  if (repairSlice === undefined) {
    return {
      status: "incomplete",
      sliceId,
      sliceScope: "implementation",
      assignedCriteria: options.criteria.length,
      failureKind: "schema_validation",
      limitation: "Coverage repair had no implementation files available.",
      diagnostics: [],
    };
  }
  try {
    const response = await options.client.run({
      role: "code_explorer",
      sliceId,
      system: PROMPTS.coverageRepair,
      payload: {
        repository: options.context.snapshot.baseRepository,
        headSha: options.context.snapshot.headSha,
        baseSha: options.context.snapshot.baseSha,
        slice: { ...repairSlice, id: sliceId },
        constraints: options.sdd.constraints,
        decisions: options.sdd.decisions,
        evidenceHints: options.evidenceHints
          .filter((item) => options.criteria.some((criterion) => criterion.id === item.criterionId))
          .map((item) => ({
            criterionId: item.criterionId,
            evidence: item.evidence.map(({ revision, path, startLine, endLine, excerpt }) => ({
              revision,
              path,
              startLine,
              endLine,
              excerpt,
            })),
          })),
      },
      schema: coverageRepairSchema,
      maxTokens: 1_600,
      signal: options.signal,
    });
    const criterionDescriptions = new Map(
      options.criteria.map((criterion) => [criterion.id, criterion.description]),
    );
    const implementationPaths = evidencePaths(options.implementationFiles);
    type RepairAssessment = CoverageRepair["assessments"][number];
    const accepted: RepairAssessment[] = [];
    const rejectionReasons: string[] = [];
    for (const criterion of options.criteria) {
      const returned = response.data.assessments.filter(
        (assessment) => assessment.criterionId === criterion.id,
      );
      if (returned.length === 0) {
        rejectionReasons.push("missing_assessment");
        continue;
      }
      const withValidEvidence = returned.flatMap((assessment) => {
        const evidence = assessment.evidence.filter(
          (item) =>
            implementationPaths.has(item.path.replaceAll("\\", "/").toLowerCase()) &&
            isEvidenceValid(options.context.snapshot, item),
        );
        return evidence.length > 0 ? [{ ...assessment, evidence }] : [];
      });
      if (withValidEvidence.length === 0) {
        rejectionReasons.push("invalid_evidence");
        continue;
      }
      const outcomes = new Set(withValidEvidence.map((assessment) => assessment.outcome));
      if (outcomes.size !== 1) {
        rejectionReasons.push("conflicting_outcomes");
        continue;
      }
      const evidence = withValidEvidence
        .flatMap((assessment) => assessment.evidence)
        .filter(
          (item, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.revision === item.revision &&
                candidate.path === item.path &&
                candidate.startLine === item.startLine &&
                candidate.endLine === item.endLine,
            ) === index,
        )
        .sort(
          (left, right) =>
            left.path.localeCompare(right.path) ||
            left.startLine - right.startLine ||
            left.endLine - right.endLine,
        )
        .slice(0, 3);
      const winner = [...withValidEvidence].sort((left, right) => {
        const leftConfidence = left.outcome === "defect" ? left.confidence : 1;
        const rightConfidence = right.outcome === "defect" ? right.confidence : 1;
        const confidenceOrder = rightConfidence - leftConfidence;
        if (confidenceOrder !== 0) return confidenceOrder;
        const leftText = left.outcome === "defect" ? left.claim : left.notes;
        const rightText = right.outcome === "defect" ? right.claim : right.notes;
        return leftText.localeCompare(rightText);
      })[0];
      if (winner !== undefined) accepted.push({ ...winner, evidence });
    }
    const fullyAcceptedIds = new Set(accepted.map((assessment) => assessment.criterionId));
    const candidateFindings: AgentFinding[] = accepted.flatMap((assessment) =>
      assessment.outcome === "defect" && fullyAcceptedIds.has(assessment.criterionId)
        ? [
            {
              id: `repair-${assessment.criterionId}`,
              severity: assessment.severity,
              category: assessment.category,
              impact: "implementation",
              claim: assessment.claim,
              evidence: assessment.evidence,
              confidence: assessment.confidence,
              suggestedAction: assessment.suggestedAction,
              criterionIds: [assessment.criterionId],
            },
          ]
        : [],
    );
    const candidateCoverage: SliceAnalysis["coverage"] = accepted.flatMap((assessment) => {
      const description = criterionDescriptions.get(assessment.criterionId);
      return assessment.outcome === "covered" &&
        fullyAcceptedIds.has(assessment.criterionId) &&
        description !== undefined
        ? [
            {
              criterionId: assessment.criterionId,
              dimension: "implementation",
              description,
              status: "covered",
              evidence: assessment.evidence,
              notes: assessment.notes,
            },
          ]
        : [];
    });
    const analysis: SliceAnalysis = {
      findings: candidateFindings,
      coverage: candidateCoverage,
      limitations: [],
      acceptedCriterionIds: [...fullyAcceptedIds].sort(),
      rejectedCriterionIds: options.criteria
        .map((criterion) => criterion.id)
        .filter((criterionId) => !fullyAcceptedIds.has(criterionId))
        .sort(),
    };
    const complete = fullyAcceptedIds.size === options.criteria.length;
    const rejectionSummary = [...new Set(rejectionReasons)]
      .sort()
      .map(
        (reason) =>
          `${reason}=${rejectionReasons.filter((candidate) => candidate === reason).length}`,
      )
      .join(", ");
    return complete
      ? {
          status: "completed",
          sliceId,
          sliceScope: "implementation",
          assignedCriteria: options.criteria.length,
          assessmentStatus: "complete",
          analysis,
          diagnostics: response.diagnostics,
        }
      : {
          status: "incomplete",
          sliceId,
          sliceScope: "implementation",
          assignedCriteria: options.criteria.length,
          failureKind: "schema_validation",
          limitation: `Coverage repair rejected ${options.criteria.length - fullyAcceptedIds.size} requested criterion assessment(s): ${rejectionSummary || "unknown=1"}.`,
          diagnostics: response.diagnostics,
          analysis,
        };
  } catch (error) {
    const failure = classifyAgentFailure(error);
    return {
      status: "incomplete",
      sliceId,
      sliceScope: "implementation",
      assignedCriteria: options.criteria.length,
      failureKind: failure.kind,
      limitation: safeStageLimitation("Coverage repair", failure.kind, sliceId),
      diagnostics: failure.diagnostics,
    };
  }
}
