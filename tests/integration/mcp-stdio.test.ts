import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

describe("MCP stdio conformance", () => {
  test("initializes and exposes exactly the three bounded tools", async () => {
    const state = await mkdtemp(join(tmpdir(), "sdd-reviewer-mcp-"));
    paths.push(state);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-env-file", "src/main.ts", "mcp"],
      cwd: process.cwd(),
      env: cleanEnvironment({ LOCALAPPDATA: state }),
      stderr: "pipe",
    });
    const client = new Client({ name: "contract-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        "list_open_change_requests",
        "review_change_requests",
        "reviewer_doctor",
      ]);
      expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBeTrue();
    } finally {
      await client.close();
    }
  }, 20_000);
});
