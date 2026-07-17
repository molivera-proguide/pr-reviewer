import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/config.ts";

describe("model routing configuration", () => {
  test("uses Haiku explorers and a medium-effort Sonnet orchestrator by default", () => {
    const config = loadConfig({});
    expect(config.explorerModel).toBe("claude-haiku-4-5-20251001");
    expect(config.orchestratorModel).toBe("claude-sonnet-5");
    expect(config.model).toBe(config.orchestratorModel);
    expect(config.orchestratorEffort).toBe("medium");
    expect(config.maxAgentCalls).toBe(10);
  });

  test("keeps the legacy model variable as an override for every role", () => {
    const config = loadConfig({ SDD_REVIEWER_MODEL: "claude-test" });
    expect(config.explorerModel).toBe("claude-test");
    expect(config.orchestratorModel).toBe("claude-test");
  });

  test("accepts independent role models and a bounded effort level", () => {
    const config = loadConfig({
      SDD_REVIEWER_EXPLORER_MODEL: "claude-haiku-test",
      SDD_REVIEWER_ORCHESTRATOR_MODEL: "claude-sonnet-test",
      SDD_REVIEWER_ORCHESTRATOR_EFFORT: "low",
    });
    expect(config.explorerModel).toBe("claude-haiku-test");
    expect(config.orchestratorModel).toBe("claude-sonnet-test");
    expect(config.orchestratorEffort).toBe("low");
  });
});
