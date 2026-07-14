import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import skillContent from "../../skills/pr-reviewer/SKILL.md" with { type: "text" };
import { ReviewerError } from "../domain/errors.ts";

const MANAGED_MARKER = "<!-- managed-by: pr-reviewer -->";

export interface ClaudeSkillInstallation {
  readonly path: string;
  readonly status: "installed" | "updated" | "unchanged";
}

export interface ClaudeSkillInstallOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly force?: boolean;
  readonly homeDirectory?: string;
}

export function claudeSkillPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configuredRoot = environment.CLAUDE_CONFIG_DIR?.trim();
  const root =
    configuredRoot === undefined || configuredRoot.length === 0
      ? join(homeDirectory, ".claude")
      : isAbsolute(configuredRoot)
        ? configuredRoot
        : resolve(configuredRoot);
  return join(root, "skills", "pr-reviewer", "SKILL.md");
}

async function existingContent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ReviewerError(
      "CONFIGURATION_ERROR",
      `Unable to read the existing Claude skill at ${path}.`,
    );
  }
}

export async function installClaudeSkill(
  options: ClaudeSkillInstallOptions = {},
): Promise<ClaudeSkillInstallation> {
  const path = claudeSkillPath(options.environment, options.homeDirectory);
  const existing = await existingContent(path);
  if (existing === skillContent) return { path, status: "unchanged" };
  if (existing !== undefined && !existing.includes(MANAGED_MARKER) && options.force !== true) {
    throw new ReviewerError(
      "CONFIGURATION_ERROR",
      `A Claude skill not managed by pr-reviewer already exists at ${path}. Use --force to replace it.`,
    );
  }

  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, skillContent, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch {
    throw new ReviewerError(
      "CONFIGURATION_ERROR",
      `Unable to install the Claude skill at ${path}.`,
    );
  }

  return { path, status: existing === undefined ? "installed" : "updated" };
}
