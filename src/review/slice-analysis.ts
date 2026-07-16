import type { ChangedFile, CoverageDimension, ReviewCoverage } from "../domain/contracts.ts";
import type {
  AgentFinding,
  CodeAnalysis,
  SddCriterion,
  TestObservation,
  TestOnlyAnalysis,
} from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import { isEvidenceValid } from "./evidence-verifier.ts";
import type { ReviewSlice } from "./slicer.ts";

export interface SliceAnalysis {
  readonly findings: AgentFinding[];
  readonly coverage: Array<ReviewCoverage & { dimension: CoverageDimension }>;
  readonly limitations: Array<{
    scope: "global_unavailability" | "slice_isolation";
    description: string;
  }>;
}

function uniqueSortedEvidence<
  T extends { evidence: readonly ReviewCoverage["evidence"][number][] },
>(items: readonly T[]): ReviewCoverage["evidence"] {
  return items
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
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine ||
        left.endLine - right.endLine,
    )
    .slice(0, 3);
}

function validTestObservation(
  snapshot: ReviewContext["snapshot"],
  observation: TestObservation,
  allowedPaths: ReadonlySet<string>,
): TestObservation | null {
  if (observation.status === "not_verifiable") return observation;
  const evidence = observation.evidence.filter(
    (item) =>
      allowedPaths.has(item.path.replaceAll("\\", "/").toLowerCase()) &&
      isEvidenceValid(snapshot, item),
  );
  return evidence.length > 0 ? { ...observation, evidence } : null;
}

export function evidencePaths(files: readonly ChangedFile[]): Set<string> {
  return new Set(
    files.flatMap((file) =>
      [file.path, file.oldPath]
        .filter((path): path is string => path !== null)
        .map((path) => path.replaceAll("\\", "/").toLowerCase()),
    ),
  );
}

function sanitizeFindingForPaths(
  snapshot: ReviewContext["snapshot"],
  finding: AgentFinding,
  allowedPaths: ReadonlySet<string>,
): AgentFinding | null {
  const evidence = finding.evidence.filter(
    (item) =>
      allowedPaths.has(item.path.replaceAll("\\", "/").toLowerCase()) &&
      isEvidenceValid(snapshot, item),
  );
  return evidence.length > 0 ? { ...finding, evidence } : null;
}

function projectTestObservation(options: {
  criterion: SddCriterion;
  observations: readonly TestObservation[];
  findings: AgentFinding[];
  coverage: SliceAnalysis["coverage"];
}): "accepted" | "conflicting" | "invalid" {
  if (options.observations.length === 0) return "invalid";
  const statuses = new Set(options.observations.map((observation) => observation.status));
  if (statuses.size !== 1) return "conflicting";
  const winner = [...options.observations].sort((left, right) => {
    const leftConfidence =
      left.status === "partial" || left.status === "missing" ? (left.confidence ?? 0.7) : 1;
    const rightConfidence =
      right.status === "partial" || right.status === "missing" ? (right.confidence ?? 0.7) : 1;
    return rightConfidence - leftConfidence || left.notes.localeCompare(right.notes);
  })[0];
  if (winner === undefined) return "invalid";
  const evidence = uniqueSortedEvidence(
    options.observations.flatMap((observation) =>
      observation.status === "not_verifiable" ? [] : [{ evidence: observation.evidence }],
    ),
  );
  if (winner.status === "partial" || winner.status === "missing") {
    options.findings.push({
      id: `test-${options.criterion.id}`,
      severity: "medium",
      category: "test-coverage",
      impact: "test_coverage",
      testCoverageStatus: winner.status,
      claim: (winner.claim ?? winner.notes).slice(0, 500),
      evidence,
      confidence: winner.confidence ?? 0.7,
      suggestedAction:
        winner.suggestedAction ?? `Add criterion-specific assertions for ${options.criterion.id}.`,
      criterionIds: [options.criterion.id],
    });
  } else {
    options.coverage.push({
      criterionId: options.criterion.id,
      dimension: "tests",
      description: options.criterion.description,
      status: winner.status,
      evidence,
      notes: winner.notes,
    });
  }
  return "accepted";
}

function rejectionLimitation(role: string, missing: number, reasons: readonly string[]): string {
  const summary = [...new Set(reasons)]
    .sort()
    .map((reason) => `${reason}=${reasons.filter((candidate) => candidate === reason).length}`)
    .join(", ");
  return `${role} rejected ${missing} criterion assessment(s): ${summary || "unknown=1"}.`;
}

export function codeFirstAnalysisToSliceAnalysis(options: {
  analysis: CodeAnalysis;
  slice: ReviewSlice;
  snapshot: ReviewContext["snapshot"];
}): { analysis: SliceAnalysis; complete: boolean; limitation: string } {
  const implementationPaths = evidencePaths(options.slice.implementationFiles);
  const testPaths = evidencePaths(options.slice.testFiles);
  const allPaths = new Set([...implementationPaths, ...testPaths]);
  const findings: AgentFinding[] = options.analysis.maintainabilityFindings
    .map((finding) => sanitizeFindingForPaths(options.snapshot, finding, allPaths))
    .filter((finding): finding is AgentFinding => finding !== null);
  const coverage: SliceAnalysis["coverage"] = [];
  const acceptedIds = new Set<string>();
  const rejectionReasons: string[] = [];
  for (const criterion of options.slice.criteria) {
    const returned = options.analysis.reviews.filter(
      (review) => review.criterionId === criterion.id,
    );
    if (returned.length === 0) {
      rejectionReasons.push("missing_assessment");
      continue;
    }
    const validImplementation: Array<CodeAnalysis["reviews"][number]["implementation"]> = [];
    for (const review of returned) {
      if (review.implementation.status === "covered") {
        const evidence = review.implementation.evidence.filter(
          (item) =>
            implementationPaths.has(item.path.replaceAll("\\", "/").toLowerCase()) &&
            isEvidenceValid(options.snapshot, item),
        );
        if (evidence.length > 0) validImplementation.push({ ...review.implementation, evidence });
        continue;
      }
      const evidence = review.implementation.finding.evidence.filter(
        (item) =>
          implementationPaths.has(item.path.replaceAll("\\", "/").toLowerCase()) &&
          isEvidenceValid(options.snapshot, item),
      );
      if (evidence.length > 0) {
        validImplementation.push({
          ...review.implementation,
          finding: { ...review.implementation.finding, evidence },
        });
      }
    }
    if (validImplementation.length === 0) {
      rejectionReasons.push("invalid_evidence");
      continue;
    }
    const outcomes = new Set(validImplementation.map((assessment) => assessment.status));
    if (outcomes.size !== 1) {
      rejectionReasons.push("conflicting_outcomes");
      continue;
    }
    const winner = [...validImplementation].sort((left, right) => {
      const leftConfidence = left.status === "defect" ? left.finding.confidence : 1;
      const rightConfidence = right.status === "defect" ? right.finding.confidence : 1;
      return rightConfidence - leftConfidence;
    })[0];
    if (winner === undefined) continue;
    acceptedIds.add(criterion.id);
    if (winner.status === "defect") {
      findings.push({
        ...winner.finding,
        impact: "implementation",
        criterionIds: [criterion.id],
      });
    } else {
      coverage.push({
        criterionId: criterion.id,
        dimension: "implementation",
        description: criterion.description,
        status: "covered",
        evidence: uniqueSortedEvidence(
          validImplementation.flatMap((assessment) =>
            assessment.status === "covered" ? [{ evidence: assessment.evidence }] : [],
          ),
        ),
        notes: validImplementation
          .flatMap((assessment) => (assessment.status === "covered" ? [assessment.notes] : []))
          .join(" ")
          .slice(0, 1_000),
      });
    }
    const testObservations = returned
      .flatMap((review) => (review.tests === undefined ? [] : [review.tests]))
      .map((observation) => validTestObservation(options.snapshot, observation, testPaths))
      .filter((observation): observation is TestObservation => observation !== null);
    if (testObservations.length > 0) {
      projectTestObservation({ criterion, observations: testObservations, findings, coverage });
    }
  }
  // A structurally valid response may still omit or contradict a required criterion. Those
  // criteria are deliberately left unassessed so the single directed implementation repair can
  // resolve them without turning test observations or optional metadata into schema retries.
  const complete = true;
  return {
    analysis: { findings, coverage, limitations: options.analysis.limitations },
    complete,
    limitation: rejectionLimitation(
      "Code-first exploration",
      options.slice.criteria.length - acceptedIds.size,
      rejectionReasons,
    ),
  };
}

export function testOnlyAnalysisToSliceAnalysis(options: {
  analysis: TestOnlyAnalysis;
  slice: ReviewSlice;
  snapshot: ReviewContext["snapshot"];
}): { analysis: SliceAnalysis; complete: boolean; limitation: string } {
  const testPaths = evidencePaths(options.slice.testFiles);
  const findings: AgentFinding[] = options.analysis.maintainabilityFindings
    .map((finding) => sanitizeFindingForPaths(options.snapshot, finding, testPaths))
    .filter((finding): finding is AgentFinding => finding !== null);
  const coverage: SliceAnalysis["coverage"] = [];
  const acceptedIds = new Set<string>();
  const rejectionReasons: string[] = [];
  for (const criterion of options.slice.criteria) {
    const observations = options.analysis.assessments
      .filter((assessment) => assessment.criterionId === criterion.id)
      .map((assessment) =>
        validTestObservation(options.snapshot, assessment.observation, testPaths),
      )
      .filter((observation): observation is TestObservation => observation !== null);
    const result = projectTestObservation({ criterion, observations, findings, coverage });
    if (result === "accepted") acceptedIds.add(criterion.id);
    else
      rejectionReasons.push(result === "conflicting" ? "conflicting_statuses" : "invalid_evidence");
  }
  const complete = acceptedIds.size === options.slice.criteria.length;
  return {
    analysis: { findings, coverage, limitations: options.analysis.limitations },
    complete,
    limitation: rejectionLimitation(
      "Test-only exploration",
      options.slice.criteria.length - acceptedIds.size,
      rejectionReasons,
    ),
  };
}
