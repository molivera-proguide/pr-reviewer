import { describe, expect, test } from "bun:test";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { codeAnalysisSchema } from "../../src/review/agents/schemas.ts";

describe("agent schema complexity", () => {
  test("keeps the code explorer output below the known-safe grammar envelope", () => {
    const encoded = JSON.stringify(zodOutputFormat(codeAnalysisSchema));

    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(5_700);
    expect(encoded).not.toContain("cross_slice_dependency");
  });
});
