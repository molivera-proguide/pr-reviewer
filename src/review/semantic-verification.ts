import type { StructuredAgentClient } from "../anthropic/agent-client.ts";
import type { AttemptSummary, Finding } from "../domain/contracts.ts";
import { classifyAgentFailure, safeStageLimitation } from "./agent-failure.ts";
import { PROMPTS } from "./agents/prompts.ts";
import { type SddCriterion, semanticVerificationSchema } from "./agents/schemas.ts";

export interface SemanticVerificationResult {
  readonly findings: Finding[];
  readonly diagnostics: readonly AttemptSummary[];
  readonly limitations: readonly string[];
  readonly stagesIncomplete: readonly string[];
  readonly pendingDecisions: readonly string[];
}

export async function runSemanticVerification(options: {
  findings: readonly Finding[];
  criteria: readonly SddCriterion[];
  client: StructuredAgentClient;
  signal: AbortSignal;
}): Promise<SemanticVerificationResult> {
  const material = options.findings.filter(
    (finding) =>
      finding.impact === "implementation" &&
      (finding.severity === "critical" || finding.severity === "high"),
  );
  if (material.length === 0) {
    return {
      findings: [...options.findings],
      diagnostics: [],
      limitations: [],
      stagesIncomplete: [],
      pendingDecisions: [],
    };
  }
  try {
    const semantic = await options.client.run({
      role: "semantic_verifier",
      system: PROMPTS.verifier,
      payload: { criteria: options.criteria, findings: material },
      schema: semanticVerificationSchema,
      maxTokens: 2_000,
      signal: options.signal,
    });
    const decisions = new Map(
      semantic.data.decisions.map((decision) => [decision.findingId, decision]),
    );
    const materialIds = new Set(material.map((finding) => finding.id));
    const validCriterionIds = new Set(options.criteria.map((criterion) => criterion.id));
    const findings = options.findings.flatMap((finding) => {
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
    return {
      findings,
      diagnostics: semantic.diagnostics,
      limitations: [],
      stagesIncomplete: [],
      pendingDecisions: [],
    };
  } catch (error) {
    if (options.signal.aborted) throw error;
    const failure = classifyAgentFailure(error);
    return {
      findings: [...options.findings],
      diagnostics: failure.diagnostics,
      limitations: [safeStageLimitation("Semantic verification", failure.kind)],
      stagesIncomplete: ["semantic_verification"],
      pendingDecisions: ["Material findings could not be semantically revalidated."],
    };
  }
}
