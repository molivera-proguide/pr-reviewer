import type { Finding, ReviewStatus, Verdict } from "../domain/contracts.ts";

export function isBlockingFinding(finding: Finding): boolean {
  return (
    finding.verified &&
    finding.impact === "implementation" &&
    (finding.severity === "critical" ||
      (finding.severity === "high" && finding.criterionIds.length > 0))
  );
}

export function calculateVerdict(options: {
  status: ReviewStatus;
  findings: readonly Finding[];
  pendingDecisions: readonly string[];
  sddApproved: boolean;
}): Verdict {
  const blocking = options.findings.some(isBlockingFinding);
  if (blocking) {
    return "RIESGO_BLOQUEANTE";
  }
  if (
    options.status !== "completed" ||
    options.findings.some((finding) => finding.severity !== "low") ||
    options.pendingDecisions.length > 0 ||
    !options.sddApproved
  ) {
    return "REQUIERE_DECISION";
  }
  return "SIN_HALLAZGOS_BLOQUEANTES";
}
