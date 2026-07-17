import type { CoverageDimension, Finding, ReviewCoverage } from "../domain/contracts.ts";
import type { SddAnalysis, SddCriterion } from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import { verifyCoverage } from "./evidence-verifier.ts";
import type { CodeSliceResult } from "./slice-executor.ts";

export function coverageFromCompletedSlices(
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
    if (result.analysis === undefined) return [];
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

export function globalAgentLimitations(
  results: readonly CodeSliceResult[],
  snapshot: ReviewContext["snapshot"],
): string[] {
  const agentReportedGlobalUnavailability = results.some((result) =>
    result.analysis?.limitations.some((limitation) => limitation.scope === "global_unavailability"),
  );
  if (!agentReportedGlobalUnavailability) return [];
  const unavailableFiles = snapshot.files.filter(
    (file) =>
      file.binary || file.truncated || (file.headContent === null && file.baseContent === null),
  );
  return unavailableFiles.length === 0
    ? []
    : [
        `Agent-reported global unavailability was confirmed for ${unavailableFiles.length} changed file(s).`,
      ];
}

export function coverageFromFindings(
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

export function deterministicCoverage(options: {
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
