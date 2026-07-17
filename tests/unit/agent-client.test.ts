import { describe, expect, test } from "bun:test";
import { APIConnectionError } from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import {
  AgentExecutionError,
  type AgentMessageCreator,
  AnthropicAgentClient,
} from "../../src/anthropic/agent-client.ts";
import type { LogEvent, Logger } from "../../src/observability/logger.ts";
import { UsageBudget } from "../../src/security/budget.ts";

class CapturingLogger implements Logger {
  readonly events: LogEvent[] = [];

  log(_level: "debug" | "info" | "warn" | "error", event: LogEvent): void {
    this.events.push(event);
  }
}

function message(options: {
  text: string;
  stopReason?: Message["stop_reason"];
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  thinkingTokens?: number;
}): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: options.text, citations: null }],
    stop_reason: options.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: options.inputTokens ?? 10,
      output_tokens: options.outputTokens ?? 5,
      cache_creation_input_tokens: options.cacheCreationInputTokens ?? null,
      cache_read_input_tokens: options.cacheReadInputTokens ?? null,
      server_tool_use: null,
      service_tier: "standard",
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details:
        options.thinkingTokens === undefined ? null : { thinking_tokens: options.thinkingTokens },
    },
    _request_id: options.requestId ?? "req_test",
  } as unknown as Message & { _request_id: string };
}

function client(creator: AgentMessageCreator, logger = new CapturingLogger()) {
  const budget = new UsageBudget({
    maxCalls: 8,
    maxOutputTokens: 40_000,
    deadlineMs: 60_000,
  });
  return {
    budget,
    logger,
    value: new AnthropicAgentClient(
      "test-key",
      {
        explorerModel: "claude-haiku-test",
        orchestratorModel: "claude-sonnet-test",
        orchestratorEffort: "medium",
      },
      budget,
      logger,
      60_000,
      creator,
    ),
  };
}

const schema = z.object({ value: z.number() });
const signal = new AbortController().signal;

describe("Anthropic agent client structured output", () => {
  test("parses a successful create response and records safe diagnostics", async () => {
    const requests: Parameters<AgentMessageCreator>[0][] = [];
    const setup = client(async (params) => {
      requests.push(params);
      return message({
        text: '{"value":7}',
        requestId: "req_success",
        inputTokens: 10,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
        thinkingTokens: 2,
      });
    });
    const result = await setup.value.run({
      role: "sdd_explorer",
      system: "system",
      payload: { safe: true },
      schema,
      maxTokens: 1_000,
      signal,
    });
    expect(result.data).toEqual({ value: 7 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        status: "completed",
        requestId: "req_success",
        model: "claude-haiku-test",
        baseInputTokens: 10,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
        thinkingTokens: 2,
      }),
    ]);
    expect(requests[0]?.model).toBe("claude-haiku-test");
    expect(requests[0]?.output_config?.effort).toBeUndefined();
    expect(setup.budget.snapshot()).toEqual({
      inputTokens: 17,
      outputTokens: 5,
      calls: 1,
      baseInputTokens: 10,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
      thinkingTokens: 2,
    });
  });

  test("performs one contextual schema repair without logging invalid output", async () => {
    const invalidOutput = '{"value":"PRIVATE_REPOSITORY_OUTPUT"}';
    const requests: string[] = [];
    let call = 0;
    const logger = new CapturingLogger();
    const setup = client(async (params) => {
      requests.push(JSON.stringify(params.messages));
      call += 1;
      return call === 1
        ? message({ text: invalidOutput, requestId: "req_invalid", inputTokens: 11 })
        : message({ text: '{"value":9}', requestId: "req_repaired", inputTokens: 12 });
    }, logger);
    const result = await setup.value.run({
      role: "code_explorer",
      sliceId: "slice-1",
      system: "system",
      payload: { repositoryData: "safe fixture" },
      schema,
      maxTokens: 1_000,
      signal,
    });
    expect(result.data.value).toBe(9);
    expect(requests[1]).toContain("UNTRUSTED_PREVIOUS_MODEL_OUTPUT");
    expect(requests[1]).toContain("PRIVATE_REPOSITORY_OUTPUT");
    expect(requests[1]).toContain("value");
    expect(result.diagnostics.map((item) => item.status)).toEqual(["failed", "completed"]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_REPOSITORY_OUTPUT");
    expect(JSON.stringify(logger.events)).not.toContain("PRIVATE_REPOSITORY_OUTPUT");
    expect(setup.budget.snapshot()).toEqual({
      inputTokens: 23,
      outputTokens: 10,
      calls: 2,
      baseInputTokens: 23,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      thinkingTokens: 0,
    });
  });

  test("retries truncated SDD extraction once with a concise request", async () => {
    const requests: string[] = [];
    let call = 0;
    const setup = client(async (params) => {
      requests.push(JSON.stringify(params.messages));
      call += 1;
      return call === 1
        ? message({ text: '{"value":', stopReason: "max_tokens", outputTokens: 1_000 })
        : message({ text: '{"value":3}', requestId: "req_compact" });
    });
    const result = await setup.value.run({
      role: "sdd_explorer",
      system: "system",
      payload: { files: [{ patch: "duplicate", headContent: "full content" }] },
      schema,
      maxTokens: 1_000,
      signal,
    });
    expect(result.data.value).toBe(3);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({ failureKind: "max_tokens", outputTokens: 1_000 }),
    );
    expect(requests[1]).toContain("output limit");
    expect(requests[1]).not.toContain("duplicate");
    expect(setup.budget.snapshot().outputTokens).toBe(1_005);
  });

  test("leaves truncated code slices to the pipeline without repeating the same request", async () => {
    let calls = 0;
    const setup = client(async () => {
      calls += 1;
      return message({ text: "", stopReason: "max_tokens", outputTokens: 1_000 });
    });
    const promise = setup.value.run({
      role: "code_explorer",
      sliceId: "slice-2",
      system: "system",
      payload: {},
      schema,
      maxTokens: 1_000,
      signal,
    });
    await expect(promise).rejects.toBeInstanceOf(AgentExecutionError);
    expect(calls).toBe(1);
  });

  test("does not retry a refusal", async () => {
    let calls = 0;
    const setup = client(async () => {
      calls += 1;
      return message({ text: "", stopReason: "refusal", requestId: "req_refusal" });
    });
    const promise = setup.value.run({
      role: "code_explorer",
      sliceId: "slice-3",
      system: "system",
      payload: {},
      schema,
      maxTokens: 1_000,
      signal,
    });
    expect(promise).rejects.toBeInstanceOf(AgentExecutionError);
    try {
      await promise;
    } catch (error) {
      expect((error as AgentExecutionError).failureKind).toBe("refusal");
    }
    expect(calls).toBe(1);
    expect(setup.budget.snapshot().outputTokens).toBe(5);
  });

  test("routes semantic verification to medium-effort Sonnet and does not retry max_tokens", async () => {
    const requests: Parameters<AgentMessageCreator>[0][] = [];
    const setup = client(async (params) => {
      requests.push(params);
      return message({ text: "", stopReason: "max_tokens", outputTokens: 1_000 });
    });
    const promise = setup.value.run({
      role: "semantic_verifier",
      system: "system",
      payload: {},
      schema,
      maxTokens: 1_000,
      signal,
    });
    await expect(promise).rejects.toBeInstanceOf(AgentExecutionError);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("claude-sonnet-test");
    expect(requests[0]?.output_config?.effort).toBe("medium");
  });

  test("routes slice planning to the bounded Sonnet orchestrator", async () => {
    const requests: Parameters<AgentMessageCreator>[0][] = [];
    const setup = client(async (params) => {
      requests.push(params);
      return message({ text: JSON.stringify({ value: 1 }) });
    });
    await setup.value.run({
      role: "slice_planner",
      system: "system",
      payload: {},
      schema,
      maxTokens: 1_000,
      signal,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("claude-sonnet-test");
    expect(requests[0]?.output_config?.effort).toBe("medium");
  });

  test("classifies an exhausted transient API failure without application retry", async () => {
    let calls = 0;
    const logger = new CapturingLogger();
    const setup = client(async () => {
      calls += 1;
      throw new APIConnectionError({ message: "PRIVATE_PROVIDER_BODY", cause: new Error() });
    }, logger);
    try {
      await setup.value.run({
        role: "semantic_verifier",
        system: "system",
        payload: {},
        schema,
        maxTokens: 1_000,
        signal,
      });
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect((error as AgentExecutionError).failureKind).toBe("transient_api");
    }
    expect(calls).toBe(1);
    expect(JSON.stringify(logger.events)).not.toContain("PRIVATE_PROVIDER_BODY");
  });
});
