import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewerConfig } from "../config/config.ts";
import { toReviewerError } from "../domain/errors.ts";
import type { ReportStore } from "../report/report-store.ts";
import type { createProvider } from "../repository/provider-factory.ts";
import type { AllowedExecutable, CommandExecutor } from "../security/command-runner.ts";
import { APP_VERSION } from "../version.ts";
import type { DoctorCheck, DoctorResult, RootInput } from "./reviewer-contracts.ts";

function overallStatus(checks: readonly DoctorCheck[]): DoctorResult["overall"] {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

async function checkExecutable(
  executable: Extract<AllowedExecutable, "git" | "gh" | "glab">,
  runner: CommandExecutor,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  if (Bun.which(executable) === null) {
    return {
      name: `${executable}_availability`,
      status: executable === "git" ? "error" : "warning",
      detail: `${executable} is not installed or is not on PATH.`,
    };
  }
  const result = await runner.run({
    executable,
    args: ["--version"],
    signal,
    throwOnNonZero: false,
    maxOutputBytes: 32 * 1024,
  });
  return {
    name: `${executable}_availability`,
    status: result.exitCode === 0 ? "ok" : "warning",
    detail: result.stdout.trim().split(/\r?\n/)[0] ?? `${executable} detected.`,
  };
}

function result(options: {
  checks: readonly DoctorCheck[];
  root: string | null;
  provider: DoctorResult["provider"];
  repository: string | null;
}): DoctorResult {
  return {
    version: APP_VERSION,
    platform: `${process.platform}-${process.arch}`,
    root: options.root,
    provider: options.provider,
    repository: options.repository,
    overall: overallStatus(options.checks),
    checks: options.checks,
  };
}

export async function runReviewerDoctor(options: {
  config: ReviewerConfig;
  runner: CommandExecutor;
  reports: Pick<ReportStore, "root" | "ensureWritable">;
  createProvider: typeof createProvider;
  resolveRoot: (input: RootInput) => Promise<string>;
  input: RootInput;
  signal: AbortSignal;
}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  for (const executable of ["git", "gh", "glab"] as const) {
    checks.push(await checkExecutable(executable, options.runner, options.signal));
  }
  checks.push({
    name: "anthropic_api_key",
    status: options.config.anthropicApiKey === undefined ? "error" : "ok",
    detail:
      options.config.anthropicApiKey === undefined
        ? "ANTHROPIC_API_KEY is not present in the process environment."
        : "ANTHROPIC_API_KEY is present (value not displayed).",
  });
  try {
    await options.reports.ensureWritable();
    checks.push({ name: "report_directory", status: "ok", detail: options.reports.root });
  } catch {
    checks.push({
      name: "report_directory",
      status: "error",
      detail: "The private report directory is not writable.",
    });
  }

  let root: string;
  try {
    root = await options.resolveRoot(options.input);
    checks.push({ name: "repository_root", status: "ok", detail: root });
  } catch (error) {
    const reviewerError = toReviewerError(error);
    checks.push({ name: "repository_root", status: "error", detail: reviewerError.message });
    return result({ checks, root: null, provider: null, repository: null });
  }
  try {
    await stat(join(root, "specs"));
    checks.push({ name: "sdd_specs", status: "ok", detail: "specs/ exists." });
  } catch {
    checks.push({ name: "sdd_specs", status: "warning", detail: "specs/ is absent." });
  }
  try {
    const provider = await options.createProvider({
      root,
      config: options.config,
      runner: options.runner,
      signal: options.signal,
    });
    const auth = await provider.checkAuthentication(options.signal);
    checks.push({
      name: `${provider.kind}_authentication`,
      status: auth.authenticated ? "ok" : "error",
      detail: auth.detail,
    });
    if (!auth.authenticated) {
      return result({ checks, root, provider: provider.kind, repository: null });
    }
    const identity = await provider.identifyRepository(options.signal);
    return result({
      checks,
      root,
      provider: provider.kind,
      repository: `${identity.owner}/${identity.name}`,
    });
  } catch (error) {
    const reviewerError = toReviewerError(error);
    checks.push({ name: "provider", status: "error", detail: reviewerError.message });
    return result({ checks, root, provider: null, repository: null });
  }
}
