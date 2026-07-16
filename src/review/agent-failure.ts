import { AgentExecutionError } from "../anthropic/agent-client.ts";
import type { AgentFailureKind, AttemptSummary } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";

export function classifyAgentFailure(error: unknown): {
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

export function safeStageLimitation(
  role: string,
  kind: AgentFailureKind,
  sliceId?: string,
): string {
  return `${role}${sliceId === undefined ? "" : ` ${sliceId}`} was incomplete (${kind}).`;
}

export function stopsNewSlices(kind: AgentFailureKind): boolean {
  return kind === "budget" || kind === "cancelled" || kind === "permanent_api";
}
