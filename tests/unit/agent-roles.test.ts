import { describe, expect, test } from "bun:test";
import { agentRoleSchema, runtimeAgentRoleSchema } from "../../src/domain/contracts.ts";

describe("agent role compatibility", () => {
  test("keeps legacy synthesizer diagnostics readable without allowing new executions", () => {
    expect(agentRoleSchema.safeParse("synthesizer").success).toBeTrue();
    expect(runtimeAgentRoleSchema.safeParse("synthesizer").success).toBeFalse();
    expect(runtimeAgentRoleSchema.safeParse("slice_planner").success).toBeTrue();
    expect(runtimeAgentRoleSchema.safeParse("semantic_verifier").success).toBeTrue();
  });
});
