import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSkillPath, installClaudeSkill } from "../../src/cli/claude-skill-installer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Claude skill installer", () => {
  test("installs and updates the bundled skill in CLAUDE_CONFIG_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-reviewer-skill-"));
    temporaryDirectories.push(root);
    const environment = { CLAUDE_CONFIG_DIR: join(root, "claude") };
    const path = claudeSkillPath(environment, root);

    const installed = await installClaudeSkill({ environment, homeDirectory: root });
    expect(installed).toEqual({ path, status: "installed" });
    expect(await readFile(path, "utf8")).toContain("<!-- managed-by: pr-reviewer -->");

    const unchanged = await installClaudeSkill({ environment, homeDirectory: root });
    expect(unchanged.status).toBe("unchanged");

    await writeFile(path, "custom skill", "utf8");
    await expect(installClaudeSkill({ environment, homeDirectory: root })).rejects.toThrow(
      "not managed by pr-reviewer",
    );
    const updated = await installClaudeSkill({
      environment,
      force: true,
      homeDirectory: root,
    });
    expect(updated.status).toBe("updated");
  });
});
