import type {
  ChangeRequestSnapshot,
  Evidence,
  Finding,
  ReviewCoverage,
} from "../domain/contracts.ts";
import type { AgentFinding } from "./agents/schemas.ts";

function normalizedLines(value: string): string[] {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function evidenceContent(snapshot: ChangeRequestSnapshot, evidence: Evidence): string | null {
  for (const file of snapshot.files) {
    if (evidence.revision === snapshot.headSha && evidence.path === file.path) {
      return file.headContent;
    }
    const basePath = file.oldPath ?? file.path;
    if (evidence.revision === snapshot.baseSha && evidence.path === basePath) {
      return file.baseContent;
    }
  }
  return null;
}

export function isEvidenceValid(snapshot: ChangeRequestSnapshot, evidence: Evidence): boolean {
  if (evidence.endLine < evidence.startLine || evidence.excerpt.trim().length === 0) {
    return false;
  }
  const content = evidenceContent(snapshot, evidence);
  if (content === null) {
    return false;
  }
  const lines = normalizedLines(content);
  if (evidence.startLine > lines.length || evidence.endLine > lines.length) {
    return false;
  }
  const actual = lines
    .slice(evidence.startLine - 1, evidence.endLine)
    .join("\n")
    .trim();
  const expected = evidence.excerpt.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  return actual.includes(expected);
}

export function verifyFindings(
  snapshot: ChangeRequestSnapshot,
  findings: readonly AgentFinding[],
): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const evidence = finding.evidence.filter((item) => isEvidenceValid(snapshot, item));
    if (evidence.length === 0) {
      continue;
    }
    const first = evidence[0];
    if (first === undefined) continue;
    const key = [
      finding.category.toLowerCase(),
      first.path.toLowerCase(),
      first.startLine,
      finding.claim.toLowerCase().replace(/\s+/g, " "),
    ].join("|");
    const verified: Finding = { ...finding, evidence, verified: true };
    const current = unique.get(key);
    if (current === undefined || verified.confidence > current.confidence) {
      unique.set(key, verified);
    }
  }
  return [...unique.values()];
}

export function verifyCoverage(
  snapshot: ChangeRequestSnapshot,
  coverage: readonly ReviewCoverage[],
): ReviewCoverage[] {
  return coverage.map((item) => {
    const evidence = item.evidence.filter((value) => isEvidenceValid(snapshot, value));
    if (item.evidence.length > 0 && evidence.length === 0) {
      return { ...item, evidence, status: "not_verifiable" as const };
    }
    return { ...item, evidence };
  });
}
