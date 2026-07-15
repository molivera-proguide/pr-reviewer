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
  Severity,
  Usage,
} from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";
import type { UsageBudget } from "../security/budget.ts";
import { PROMPTS } from "./agents/prompts.ts";
import {
  type AgentFinding,
  type CodeAnalysis,
  type CoverageRepair,
  codeAnalysisSchema,
  coverageRepairSchema,
  type SddAnalysis,
  type SddCriterion,
  sddAnalysisSchema,
  semanticVerificationSchema,
  type TestAnalysis,
  testAnalysisSchema,
} from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import { isEvidenceValid, verifyCoverage, verifyFindings } from "./evidence-verifier.ts";
import { createReviewSlices, type ReviewSlice, sliceKindOf } from "./slicer.ts";

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
      readonly analysis?: CodeAnalysis;
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

const severityRank: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function applySeverityCap(finding: Finding): Finding {
  const maximum: Severity =
    finding.impact === "test_coverage"
      ? "medium"
      : finding.impact === "maintainability"
        ? "low"
        : "critical";
  return severityRank[finding.severity] < severityRank[maximum]
    ? { ...finding, severity: maximum }
    : finding;
}

const testAssertionSignal =
  /(?:\bexpect\s*\(|\bassert(?:\w*)?\s*\(|\bverify\s*\(|\bshould(?:\.|\s)|\.to(?:Be|Equal|Match|Contain|Throw|Have|StrictEqual)\b)/i;

const genericTestGapWords = new Set([
  "assertion",
  "assertions",
  "coverage",
  "customer",
  "customers",
  "discount",
  "exercise",
  "required",
  "scenario",
  "scenarios",
  "suite",
  "test",
  "tests",
  "tier",
]);

function hasRelevantAssertionEvidence(finding: Finding): boolean {
  const claimTokens = new Set(
    (finding.claim.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
      (token) => token.length >= 4 && !genericTestGapWords.has(token) && !/^ac_?\d+$/.test(token),
    ),
  );
  return finding.evidence.some((item) => {
    if (!testAssertionSignal.test(item.excerpt)) return false;
    const excerpt = item.excerpt.toLowerCase();
    return [...claimTokens].some((token) => excerpt.includes(token));
  });
}

export function normalizeTestCoverageFinding(finding: Finding): Finding {
  if (finding.impact !== "test_coverage") return finding;
  const testCoverageStatus =
    finding.testCoverageStatus === "partial" || hasRelevantAssertionEvidence(finding)
      ? "partial"
      : "missing";
  return finding.testCoverageStatus === testCoverageStatus
    ? finding
    : { ...finding, testCoverageStatus };
}

function testAnalysisToCodeAnalysis(options: {
  analysis: TestAnalysis;
  slice: ReviewSlice;
  snapshot: ReviewContext["snapshot"];
}): { analysis: CodeAnalysis; complete: boolean; limitation: string } {
  type TestAssessment = TestAnalysis["assessments"][number];
  const findings: AgentFinding[] = [];
  const coverage: CodeAnalysis["coverage"] = [];
  const acceptedIds = new Set<string>();
  const rejectionReasons: string[] = [];
  for (const criterion of options.slice.criteria) {
    const returned = options.analysis.assessments.filter(
      (assessment) => assessment.criterionId === criterion.id,
    );
    if (returned.length === 0) {
      rejectionReasons.push("missing_assessment");
      continue;
    }
    const validated = returned.flatMap((assessment) => {
      const evidence = assessment.evidence.filter((item) =>
        isEvidenceValid(options.snapshot, item),
      );
      return assessment.status === "not_verifiable" || evidence.length > 0
        ? ([{ ...assessment, evidence }] as TestAssessment[])
        : [];
    });
    if (validated.length === 0) {
      rejectionReasons.push("invalid_evidence");
      continue;
    }
    const statuses = new Set(validated.map((assessment) => assessment.status));
    if (statuses.size !== 1) {
      rejectionReasons.push("conflicting_statuses");
      continue;
    }
    const winner = [...validated].sort((left, right) => {
      const leftConfidence =
        left.status === "partial" || left.status === "missing" ? left.confidence : 1;
      const rightConfidence =
        right.status === "partial" || right.status === "missing" ? right.confidence : 1;
      const confidenceOrder = rightConfidence - leftConfidence;
      if (confidenceOrder !== 0) return confidenceOrder;
      const leftText =
        left.status === "partial" || left.status === "missing" ? left.claim : left.notes;
      const rightText =
        right.status === "partial" || right.status === "missing" ? right.claim : right.notes;
      return leftText.localeCompare(rightText);
    })[0];
    if (winner === undefined) continue;
    const evidence = validated
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
    acceptedIds.add(criterion.id);
    if (winner.status === "partial" || winner.status === "missing") {
      findings.push({
        id: `test-${criterion.id}`,
        severity: "medium",
        category: "test-coverage",
        impact: "test_coverage",
        testCoverageStatus: winner.status,
        claim: winner.claim,
        evidence,
        confidence: winner.confidence,
        suggestedAction: winner.suggestedAction,
        criterionIds: [criterion.id],
      });
      continue;
    }
    coverage.push({
      criterionId: criterion.id,
      dimension: "tests",
      description: criterion.description,
      status: winner.status,
      evidence,
      notes: winner.notes,
    });
  }
  const complete = acceptedIds.size === options.slice.criteria.length;
  const rejectionSummary = [...new Set(rejectionReasons)]
    .sort()
    .map(
      (reason) =>
        `${reason}=${rejectionReasons.filter((candidate) => candidate === reason).length}`,
    )
    .join(", ");
  return {
    analysis: { findings, coverage, limitations: options.analysis.limitations },
    complete,
    limitation: `Test exploration rejected ${options.slice.criteria.length - acceptedIds.size} criterion assessment(s): ${rejectionSummary || "unknown=1"}.`,
  };
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
      const payload = {
        repository: options.context.snapshot.baseRepository,
        headSha: options.context.snapshot.headSha,
        baseSha: options.context.snapshot.baseSha,
        slice,
        changedFileInventory: options.changedFileInventory,
        constraints: options.sdd.constraints,
        decisions: options.sdd.decisions,
      };
      if (slice.kind === "tests") {
        const response = await options.client.run({
          role: "code_explorer",
          sliceId: slice.id,
          system: PROMPTS.testExplorer,
          payload,
          schema: testAnalysisSchema,
          maxTokens: 3_200,
          signal: options.signal,
        });
        const converted = testAnalysisToCodeAnalysis({
          analysis: response.data,
          slice,
          snapshot: options.context.snapshot,
        });
        return converted.complete
          ? {
              status: "completed",
              sliceId: slice.id,
              sliceKind: slice.kind,
              analysis: converted.analysis,
              diagnostics: response.diagnostics,
            }
          : {
              status: "incomplete",
              sliceId: slice.id,
              sliceKind: slice.kind,
              failureKind: "schema_validation",
              limitation: converted.limitation,
              analysis: converted.analysis,
              diagnostics: response.diagnostics,
            };
      }
      const response = await options.client.run({
        role: "code_explorer",
        sliceId: slice.id,
        system: PROMPTS.codeExplorer,
        payload,
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

type FindingIdentity = Pick<
  Finding,
  "impact" | "category" | "claim" | "evidence" | "criterionIds" | "confidence" | "id"
>;

export function stableFindingId(finding: FindingIdentity): string {
  const first = finding.evidence[0];
  const criterionId = finding.criterionIds[0];
  const identity =
    criterionId === undefined
      ? [
          finding.impact ?? "unknown",
          finding.category.toLowerCase(),
          first?.revision ?? "",
          first?.path.toLowerCase() ?? "",
          first?.startLine ?? 0,
          finding.claim.toLowerCase().replace(/\s+/g, " ").trim(),
        ].join("|")
      : ["criterion", finding.impact ?? "unknown", criterionId, first?.revision ?? ""].join("|");
  return `finding-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function withStableFindingIds<T extends FindingIdentity>(findings: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const finding of findings) {
    const id = stableFindingId(finding);
    const candidate = { ...finding, id };
    const current = unique.get(id);
    if (
      current === undefined ||
      candidate.confidence > current.confidence ||
      (candidate.confidence === current.confidence &&
        candidate.claim.localeCompare(current.claim) < 0)
    ) {
      unique.set(id, candidate);
    }
  }
  return [...unique.values()];
}

function findingsFromCompletedSlices(
  results: readonly CodeSliceResult[],
  criteria: readonly SddCriterion[],
): AgentFinding[] {
  const validCriterionIds = new Set(criteria.map((criterion) => criterion.id));
  return withStableFindingIds(
    results.flatMap((result) => {
      if (result.analysis === undefined) return [];
      return result.analysis.findings.filter(
        (finding) =>
          finding.criterionIds.every((criterionId) => validCriterionIds.has(criterionId)) &&
          (finding.impact === "maintainability" ||
            (result.sliceKind === "tests" && finding.impact === "test_coverage") ||
            (result.sliceKind === "implementation" && finding.impact === "implementation")),
      );
    }),
  );
}

function coverageFromCompletedSlices(
  results: readonly CodeSliceResult[],
  dimension: CoverageDimension,
  findings: readonly Finding[],
): ReviewCoverage[] {
  const expectedImpact = dimension === "implementation" ? "implementation" : "test_coverage";
  const repairedCriterionIds = new Set(
    dimension === "implementation"
      ? results.flatMap((result) =>
          result.sliceId === "coverage-repair-1" && result.analysis !== undefined
            ? [
                ...result.analysis.coverage.map((item) => item.criterionId),
                ...result.analysis.findings.flatMap((finding) => finding.criterionIds),
              ]
            : [],
        )
      : [],
  );
  const defectCriterionIds = new Set(
    findings
      .filter((finding) => finding.impact === expectedImpact)
      .flatMap((finding) => finding.criterionIds),
  );
  return results.flatMap((result) => {
    if (result.analysis === undefined || result.sliceKind !== dimension) return [];
    const grouped = new Map<string, typeof result.analysis.coverage>();
    for (const item of result.analysis.coverage) {
      if (item.dimension !== dimension) continue;
      const group = grouped.get(item.criterionId) ?? [];
      group.push(item);
      grouped.set(item.criterionId, group);
    }
    return [...grouped.values()].flatMap((items) => {
      const first = items[0];
      if (
        first === undefined ||
        defectCriterionIds.has(first.criterionId) ||
        (result.sliceId !== "coverage-repair-1" && repairedCriterionIds.has(first.criterionId))
      )
        return [];
      const evidence = items
        .flatMap((item) => item.evidence)
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
        .slice(0, 3);
      const allCovered = items.every((item) => item.status === "covered");
      return [
        {
          criterionId: first.criterionId,
          description: first.description,
          status: allCovered ? ("covered" as const) : ("not_verifiable" as const),
          evidence,
          notes: allCovered
            ? items
                .map((item) => item.notes)
                .filter(Boolean)
                .join(" ")
                .slice(0, 1_000)
            : `The explorer did not provide one coherent covered assessment with a matching ${expectedImpact} finding.`,
        },
      ];
    });
  });
}

function globalAgentLimitations(results: readonly CodeSliceResult[]): string[] {
  return results.flatMap((result) =>
    result.analysis !== undefined
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
          status: dimension === "tests" ? (finding.testCoverageStatus ?? "missing") : "missing",
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
  findings: readonly Finding[];
  dimension: CoverageDimension;
  hasIncompleteSlices: boolean;
}): ReviewCoverage[] {
  const verified = verifyCoverage(options.context.snapshot, options.candidates);
  const expectedImpact =
    options.dimension === "implementation" ? "implementation" : "test_coverage";
  return options.sdd.criteria.map((criterion) => {
    const criterionFindings = options.findings.filter(
      (finding) =>
        finding.verified &&
        finding.impact === expectedImpact &&
        finding.criterionIds[0] === criterion.id,
    );
    if (criterionFindings.length > 0) {
      const findingStatus =
        options.dimension === "tests" &&
        criterionFindings.every((finding) => finding.testCoverageStatus === "partial")
          ? "partial"
          : "missing";
      return {
        criterionId: criterion.id,
        description: criterion.description,
        status: findingStatus,
        evidence: uniqueEvidence(
          criterionFindings.map((finding) => ({
            criterionId: criterion.id,
            description: criterion.description,
            status: findingStatus,
            evidence: finding.evidence,
            notes: finding.claim,
          })),
        ),
        notes: criterionFindings
          .map((finding) => finding.claim)
          .filter(Boolean)
          .join(" ")
          .slice(0, 1_000),
      };
    }
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
    const onlyCovered = statuses.size === 1 && statuses.has("covered");
    const status = statuses.has("missing")
      ? "missing"
      : options.hasIncompleteSlices && statuses.has("covered")
        ? "partial"
        : onlyCovered
          ? "covered"
          : "not_verifiable";
    return {
      criterionId: criterion.id,
      description: criterion.description,
      status,
      evidence,
      notes:
        options.hasIncompleteSlices && status === "partial"
          ? "Coverage is partial because at least one code slice was not reviewed."
          : status === "not_verifiable"
            ? "Completed slices did not return one coherent, deterministically verifiable assessment."
            : matching
                .map((item) => item.notes)
                .filter(Boolean)
                .join(" ")
                .slice(0, 1_000),
    };
  });
}

export function omittedImplementationCriteria(options: {
  snapshot: ReviewContext["snapshot"];
  criteria: readonly SddCriterion[];
  candidates: readonly ReviewCoverage[];
  findings: readonly Finding[];
}): SddCriterion[] {
  const assessedCriterionIds = new Set(
    verifyCoverage(options.snapshot, options.candidates).flatMap((item) =>
      item.status === "covered" && item.evidence.length > 0 ? [item.criterionId] : [],
    ),
  );
  const findingCriterionIds = new Set(
    options.findings.flatMap((finding) =>
      finding.verified && finding.impact === "implementation" ? finding.criterionIds : [],
    ),
  );
  return options.criteria.filter(
    (criterion) =>
      criterion.required &&
      !assessedCriterionIds.has(criterion.id) &&
      !findingCriterionIds.has(criterion.id),
  );
}

async function runCoverageRepair(options: {
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
      sliceKind: "implementation",
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
        const evidence = assessment.evidence.filter((item) =>
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
    const candidateCoverage: CodeAnalysis["coverage"] = accepted.flatMap((assessment) => {
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
    const analysis: CodeAnalysis = {
      findings: candidateFindings,
      coverage: candidateCoverage,
      limitations: [],
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
          sliceKind: "implementation",
          analysis,
          diagnostics: response.diagnostics,
        }
      : {
          status: "incomplete",
          sliceId,
          sliceKind: "implementation",
          failureKind: "schema_validation",
          limitation: `Coverage repair rejected ${options.criteria.length - fullyAcceptedIds.size} requested criterion assessment(s): ${rejectionSummary || "unknown=1"}.`,
          diagnostics: response.diagnostics,
          analysis,
        };
  } catch (error) {
    const failure = classifiedFailure(error);
    return {
      status: "incomplete",
      sliceId,
      sliceKind: "implementation",
      failureKind: failure.kind,
      limitation: safeStageLimitation("Coverage repair", failure.kind, sliceId),
      diagnostics: failure.diagnostics,
    };
  }
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
  const changedFileInventory = reviewFiles.map((file) => ({
    path: file.path,
    status: file.status,
    binary: file.binary,
    truncated: file.truncated,
  }));
  const slices = createReviewSlices(reviewFiles, sddResponse.data.criteria);
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
  let findings = verifyFindings(
    options.context.snapshot,
    findingsFromCompletedSlices(sliceResults, sddResponse.data.criteria),
  );
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
    (result) => result.status === "incomplete" && result.sliceKind === "implementation",
  );
  if (omittedCriteria.length > 0 && implementationExplorationComplete) {
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
    findings = verifyFindings(
      options.context.snapshot,
      findingsFromCompletedSlices(sliceResults, sddResponse.data.criteria),
    );
  }
  const incompleteSlices = sliceResults.filter((result) => result.status === "incomplete");
  const material = findings.filter(
    (finding) =>
      (finding.impact === "implementation" &&
        (finding.severity === "critical" || finding.severity === "high")) ||
      (finding.impact === "maintainability" &&
        sddResponse.data.criteria.some((criterion) => finding.claim.includes(criterion.id))),
  );
  if (material.length > 0) {
    try {
      const semantic = await options.client.run({
        role: "semantic_verifier",
        system: PROMPTS.verifier,
        payload: { criteria: sddResponse.data.criteria, findings: material },
        schema: semanticVerificationSchema,
        maxTokens: 2_000,
        signal: options.signal,
      });
      diagnostics.push(...semantic.diagnostics);
      const decisions = new Map(
        semantic.data.decisions.map((decision) => [decision.findingId, decision]),
      );
      const materialIds = new Set(material.map((finding) => finding.id));
      const validCriterionIds = new Set(sddResponse.data.criteria.map((criterion) => criterion.id));
      findings = findings.flatMap((finding) => {
        const decision = decisions.get(finding.id);
        if (decision === undefined) {
          return materialIds.has(finding.id) ? [] : [finding];
        }
        if (!decision.confirmed) return [];
        const criterionIds =
          decision.adjustedImpact === "maintainability"
            ? []
            : decision.confirmedCriterionIds.filter((id) => validCriterionIds.has(id));
        const { testCoverageStatus: _previousTestCoverageStatus, ...findingWithoutTestStatus } =
          finding;
        return [
          {
            ...findingWithoutTestStatus,
            severity: decision.adjustedSeverity,
            impact: decision.adjustedImpact,
            ...(decision.adjustedImpact === "test_coverage"
              ? { testCoverageStatus: decision.testCoverageStatus ?? "missing" }
              : {}),
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
  const coverage = deterministicCoverage({
    context: options.context,
    sdd: sddResponse.data,
    candidates: implementationCandidates,
    findings,
    dimension: "implementation",
    hasIncompleteSlices: incompleteSlices.some(
      (result) => result.sliceKind === "implementation" && result.sliceId !== "coverage-repair-1",
    ),
  });
  const testCoverage = deterministicCoverage({
    context: options.context,
    sdd: sddResponse.data,
    candidates: testCandidates,
    findings,
    dimension: "tests",
    hasIncompleteSlices: incompleteSlices.some((result) => result.sliceKind === "tests"),
  });
  const risks = findings
    .filter((finding) => finding.verified)
    .map((finding) => finding.claim)
    .filter((claim, index, all) => all.indexOf(claim) === index)
    .slice(0, 20);

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
