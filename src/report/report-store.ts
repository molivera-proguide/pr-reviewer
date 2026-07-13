import {
  chmod,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ReviewReport } from "../domain/contracts.ts";
import type { Logger } from "../observability/logger.ts";
import type { CommandExecutor } from "../security/command-runner.ts";
import { isPathWithin } from "../security/path-confinement.ts";
import { renderReportHtml } from "./html-renderer.ts";

export function reportsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return join(
      environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "sdd-pr-reviewer",
      "reports",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "sdd-pr-reviewer", "reports");
  }
  return join(
    environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "sdd-pr-reviewer",
    "reports",
  );
}

function safeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "repository"
  );
}

export class ReportStore {
  readonly root: string;

  constructor(
    private readonly runner: CommandExecutor,
    private readonly logger: Logger,
    root = reportsDirectory(),
  ) {
    this.root = resolve(root);
  }

  async ensureWritable(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const probe = join(this.root, `.probe-${crypto.randomUUID()}`);
    await writeFile(probe, "ok", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await unlink(probe);
  }

  async write(report: ReviewReport, signal: AbortSignal, open = true): Promise<string> {
    await this.ensureWritable();
    const repositoryDir = join(this.root, safeSegment(`${report.host}-${report.repository}`));
    if (!isPathWithin(this.root, repositoryDir)) throw new Error("Invalid report directory.");
    await mkdir(repositoryDir, { recursive: true, mode: 0o700 });
    const finalPath = join(
      repositoryDir,
      `pr-${report.changeRequestNumber}-${safeSegment(report.headSha)}.html`,
    );
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    if (!isPathWithin(this.root, finalPath) || !isPathWithin(this.root, temporaryPath)) {
      throw new Error("Invalid report path.");
    }
    await writeFile(temporaryPath, renderReportHtml(report), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, finalPath);
    try {
      await chmod(finalPath, 0o600);
    } catch {
      this.logger.log("debug", { event: "report_permissions_not_changed" });
    }
    if (open) await this.openBestEffort(finalPath, signal);
    return finalPath;
  }

  async cleanupExpired(ttlHours: number, signal: AbortSignal): Promise<number> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.root);
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1_000;
    let deleted = 0;
    for (const directory of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (signal.aborted) break;
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      const directoryPath = join(canonicalRoot, directory.name);
      const canonicalDirectory = await realpath(directoryPath);
      if (!isPathWithin(canonicalRoot, canonicalDirectory)) continue;
      for (const file of await readdir(canonicalDirectory, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".html")) continue;
        const filePath = join(canonicalDirectory, file.name);
        const canonicalFile = await realpath(filePath);
        if (!isPathWithin(canonicalRoot, canonicalFile)) continue;
        const metadata = await stat(canonicalFile);
        if (metadata.mtimeMs < cutoff) {
          await unlink(canonicalFile);
          deleted += 1;
        }
      }
      try {
        await rmdir(canonicalDirectory);
      } catch {
        // Non-empty directories remain in place.
      }
    }
    return deleted;
  }

  private async openBestEffort(path: string, signal: AbortSignal): Promise<void> {
    const executable =
      process.platform === "win32"
        ? "explorer"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    try {
      await this.runner.run({
        executable,
        args: [path],
        signal,
        timeoutMs: 10_000,
        throwOnNonZero: false,
      });
    } catch {
      this.logger.log("debug", { event: "report_open_failed" });
    }
  }
}
