import type { RuntimeAgentRole } from "../domain/contracts.ts";

export interface AgentModelRouting {
  readonly explorerModel: string;
  readonly orchestratorModel: string;
  readonly orchestratorEffort: "low" | "medium" | "high";
}

export function isOrchestratorRole(role: RuntimeAgentRole): boolean {
  return role === "slice_planner" || role === "semantic_verifier";
}

export function modelForRole(role: RuntimeAgentRole, routing: AgentModelRouting): string {
  return isOrchestratorRole(role) ? routing.orchestratorModel : routing.explorerModel;
}
