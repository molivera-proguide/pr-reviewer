import type { ReviewerConfig } from "../config/config.ts";
import { ReviewerError } from "../domain/errors.ts";
import { GitHubProvider } from "../providers/github/github-provider.ts";
import { GitLabProvider } from "../providers/gitlab/gitlab-provider.ts";
import type { RepositoryProvider } from "../providers/provider.ts";
import type { CommandExecutor } from "../security/command-runner.ts";
import { knownProviderForHost, parseRemoteUrl, toRepositoryIdentity } from "./remote-parser.ts";

async function readRemote(
  root: string,
  runner: CommandExecutor,
  signal: AbortSignal,
): Promise<string> {
  const origin = await runner.run({
    executable: "git",
    args: ["remote", "get-url", "origin"],
    cwd: root,
    signal,
    throwOnNonZero: false,
  });
  if (origin.exitCode === 0 && origin.stdout.trim().length > 0) {
    return origin.stdout.trim();
  }
  const remotes = await runner.run({
    executable: "git",
    args: ["remote"],
    cwd: root,
    signal,
  });
  const names = remotes.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (names.length !== 1) {
    throw new ReviewerError(
      "PROVIDER_NOT_DETECTED",
      "No origin remote exists and alternative remotes are ambiguous.",
    );
  }
  const onlyRemote = names[0];
  if (onlyRemote === undefined) {
    throw new ReviewerError("PROVIDER_NOT_DETECTED", "No Git remote is configured.");
  }
  const result = await runner.run({
    executable: "git",
    args: ["remote", "get-url", onlyRemote],
    cwd: root,
    signal,
  });
  return result.stdout.trim();
}

async function detectEnterpriseProvider(
  host: string,
  runner: CommandExecutor,
  signal: AbortSignal,
): Promise<"github" | "gitlab"> {
  const [github, gitlab] = await Promise.all([
    runner.run({
      executable: "gh",
      args: ["auth", "status", "--hostname", host],
      signal,
      throwOnNonZero: false,
    }),
    runner.run({
      executable: "glab",
      args: ["auth", "status", "--hostname", host],
      signal,
      throwOnNonZero: false,
    }),
  ]);
  const matches = [
    ...(github.exitCode === 0 ? (["github"] as const) : []),
    ...(gitlab.exitCode === 0 ? (["gitlab"] as const) : []),
  ];
  if (matches.length !== 1) {
    throw new ReviewerError(
      "PROVIDER_NOT_DETECTED",
      `Host ${host} could not be mapped unambiguously to GitHub or GitLab.`,
    );
  }
  const provider = matches[0];
  if (provider === undefined) {
    throw new ReviewerError("PROVIDER_NOT_DETECTED", `Provider for ${host} is unavailable.`);
  }
  return provider;
}

export async function createProvider(options: {
  root: string;
  config: ReviewerConfig;
  runner: CommandExecutor;
  signal: AbortSignal;
}): Promise<RepositoryProvider> {
  const remote = parseRemoteUrl(await readRemote(options.root, options.runner, options.signal));
  const providerKind =
    knownProviderForHost(remote.host) ??
    (await detectEnterpriseProvider(remote.host, options.runner, options.signal));
  const identity = toRepositoryIdentity(remote, providerKind);
  const limits = {
    maxFiles: options.config.maxFiles,
    maxDiffBytes: options.config.maxDiffBytes,
    maxFileBytes: options.config.maxFileBytes,
  };
  return providerKind === "github"
    ? new GitHubProvider(identity, options.runner, limits, options.root)
    : new GitLabProvider(identity, options.runner, limits, options.root);
}
