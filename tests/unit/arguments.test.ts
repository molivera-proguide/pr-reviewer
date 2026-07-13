import { describe, expect, test } from "bun:test";
import { parseArguments } from "../../src/cli/arguments.ts";

describe("CLI arguments", () => {
  test("uses MCP as the default command", () => {
    expect(parseArguments([])).toEqual({ command: "mcp" });
  });

  test("supports pr-reviewer --version", () => {
    expect(parseArguments(["--version"])).toEqual({ command: "version" });
  });

  test("keeps version as a compatible alias", () => {
    expect(parseArguments(["version"])).toEqual({ command: "version" });
  });
});
