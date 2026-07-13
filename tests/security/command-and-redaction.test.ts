import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/domain/errors.ts";
import { CommandRunner } from "../../src/security/command-runner.ts";
import { isSensitivePath, redactSecrets } from "../../src/security/redaction.ts";
import { NEVER_ABORTED } from "../helpers/fakes.ts";

describe("process and secret security", () => {
  test("rejects mutating git operations before spawn", async () => {
    const runner = new CommandRunner();
    await expect(
      runner.run({ executable: "git", args: ["fetch", "origin"], signal: NEVER_ABORTED }),
    ).rejects.toBeInstanceOf(ReviewerError);
    await expect(
      runner.run({
        executable: "git",
        args: ["remote", "set-url", "origin", "attacker/repo"],
        signal: NEVER_ABORTED,
      }),
    ).rejects.toThrow("Disallowed git operation");
    await expect(
      runner.run({
        executable: "gh",
        args: ["pr", "merge", "7"],
        signal: NEVER_ABORTED,
      }),
    ).rejects.toThrow("Disallowed gh operation");
  });

  test("rejects provider API write methods and fields", async () => {
    const runner = new CommandRunner();
    await expect(
      runner.run({
        executable: "gh",
        args: ["api", "--method", "POST", "repos/acme/repo/issues"],
        signal: NEVER_ABORTED,
      }),
    ).rejects.toThrow("Only GET");
    await expect(
      runner.run({
        executable: "glab",
        args: ["api", "-f", "body=value", "projects/1/notes"],
        signal: NEVER_ABORTED,
      }),
    ).rejects.toThrow("fields");
  });

  test("redacts supported token families", () => {
    const value = "sk-ant-1234567890abcdef ghp_123456789012345678901234 glpat-1234567890abcdef";
    const redacted = redactSecrets(value);
    expect(redacted).not.toContain("sk-ant-");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).not.toContain("glpat-");
  });

  test("denies secret-bearing paths", () => {
    expect(isSensitivePath(".env.production")).toBeTrue();
    expect(isSensitivePath("certs/server.pem")).toBeTrue();
    expect(isSensitivePath("src/config.ts")).toBeFalse();
  });
});
