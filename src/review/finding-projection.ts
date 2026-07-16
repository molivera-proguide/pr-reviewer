import { createHash } from "node:crypto";
import type { Finding, Severity } from "../domain/contracts.ts";
import type { AgentFinding, SddCriterion } from "./agents/schemas.ts";
import type { CodeSliceResult } from "./slice-executor.ts";

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

export function withStableFindingIds<T extends FindingIdentity>(findings: readonly T[]): T[] {
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

export function findingsFromCompletedSlices(
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
            finding.impact === "test_coverage" ||
            (result.sliceScope === "implementation" && finding.impact === "implementation")),
      );
    }),
  );
}
