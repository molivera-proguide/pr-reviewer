import { z } from "zod";
import type { ProviderKind, RepositoryIdentity } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";

const remoteUrlSchema = z.string().min(1).max(4_096);

export interface ParsedRemote {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly remote: string;
}

export function parseRemoteUrl(remoteInput: string): ParsedRemote {
  const remote = remoteUrlSchema.parse(remoteInput.trim());
  let host: string;
  let pathname: string;
  const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
  if (scpMatch !== null && !remote.includes("://")) {
    const matchedHost = scpMatch[1];
    const matchedPath = scpMatch[2];
    if (matchedHost === undefined || matchedPath === undefined) {
      throw new ReviewerError("PROVIDER_NOT_DETECTED", `Cannot parse Git remote: ${remote}`);
    }
    host = matchedHost;
    pathname = matchedPath;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new ReviewerError("PROVIDER_NOT_DETECTED", `Cannot parse Git remote: ${remote}`);
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      throw new ReviewerError(
        "PROVIDER_NOT_DETECTED",
        `Unsupported Git remote scheme: ${url.protocol}`,
      );
    }
    host = url.hostname;
    pathname = url.pathname;
  }
  const segments = pathname
    .replace(/^\/+/, "")
    .replace(/\.git\/?$/i, "")
    .split("/")
    .filter(Boolean);
  const name = segments.pop();
  const owner = segments.join("/");
  if (name === undefined || owner.length === 0 || host.length === 0) {
    throw new ReviewerError(
      "PROVIDER_NOT_DETECTED",
      `Git remote lacks a repository path: ${remote}`,
    );
  }
  return { host: host.toLowerCase(), owner, name, remote };
}

export function knownProviderForHost(host: string): ProviderKind | null {
  const normalized = host.toLowerCase();
  if (normalized === "github.com" || normalized.endsWith(".ghe.com")) {
    return "github";
  }
  if (normalized === "gitlab.com") {
    return "gitlab";
  }
  return null;
}

export function toRepositoryIdentity(
  remote: ParsedRemote,
  provider: ProviderKind,
): RepositoryIdentity {
  return { provider, ...remote };
}
