import type { Artifact, FeatureReference } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";
import type { RepositoryProvider } from "../providers/provider.ts";
import { isSensitivePath, redactSecrets } from "../security/redaction.ts";

const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".yaml", ".yml", ".json", ".toml"]);
const OPTIONAL_ROOT_ARTIFACTS = [
  "DECISIONS.md",
  "existing-arch.md",
  "specs/_registry/features.yaml",
  "graph/domain.yaml",
] as const;

function extension(path: string): string {
  const basename = path.split("/").at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function artifactKind(path: string): string {
  const basename = path.split("/").at(-1)?.toLowerCase() ?? path.toLowerCase();
  if (basename.includes("constitution")) return "constitution";
  if (basename === "spec.md") return "spec";
  if (basename === "plan.md") return "plan";
  if (basename === "tasks.md") return "tasks";
  if (basename === "input.md") return "input";
  if (basename.includes("decision")) return "decisions";
  if (basename.includes("handoff")) return "handoff";
  if (path.endsWith("features.yaml")) return "registry";
  if (path.endsWith("domain.yaml")) return "graph";
  return "feature_document";
}

export async function loadArtifacts(options: {
  provider: RepositoryProvider;
  feature: FeatureReference;
  revision: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<Artifact[]> {
  const tree = await options.provider.listTree(
    options.revision,
    options.feature.directory,
    options.signal,
  );
  const featurePaths = tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((path) => TEXT_EXTENSIONS.has(extension(path)))
    .sort();
  const candidates = [...new Set([...featurePaths, ...OPTIONAL_ROOT_ARTIFACTS])];
  const artifacts: Artifact[] = [];
  let accumulatedBytes = 0;
  for (const path of candidates) {
    if (isSensitivePath(path)) {
      artifacts.push({
        path,
        kind: artifactKind(path),
        revision: options.revision,
        content: null,
        status: "excluded",
        bytes: 0,
      });
      continue;
    }
    try {
      const file = await options.provider.readTextFile(options.revision, path, options.signal);
      if (file.truncated && file.content === null) {
        artifacts.push({
          path,
          kind: artifactKind(path),
          revision: options.revision,
          ...(file.sha === undefined ? {} : { sha: file.sha }),
          content: null,
          status: "truncated",
          bytes: file.bytes,
        });
        continue;
      }
      if (file.binary || file.content === null) {
        artifacts.push({
          path,
          kind: artifactKind(path),
          revision: options.revision,
          ...(file.sha === undefined ? {} : { sha: file.sha }),
          content: null,
          status: "binary",
          bytes: file.bytes,
        });
        continue;
      }
      if (accumulatedBytes + file.bytes > options.maxBytes) {
        artifacts.push({
          path,
          kind: artifactKind(path),
          revision: options.revision,
          ...(file.sha === undefined ? {} : { sha: file.sha }),
          content: null,
          status: "truncated",
          bytes: file.bytes,
        });
        continue;
      }
      accumulatedBytes += file.bytes;
      artifacts.push({
        path,
        kind: artifactKind(path),
        revision: options.revision,
        ...(file.sha === undefined ? {} : { sha: file.sha }),
        content: redactSecrets(file.content),
        status: file.truncated ? "truncated" : "loaded",
        bytes: file.bytes,
      });
    } catch (error) {
      if (
        OPTIONAL_ROOT_ARTIFACTS.includes(path as (typeof OPTIONAL_ROOT_ARTIFACTS)[number]) &&
        error instanceof ReviewerError &&
        error.code === "COMMAND_FAILED"
      ) {
        artifacts.push({
          path,
          kind: artifactKind(path),
          revision: options.revision,
          content: null,
          status: "missing",
          bytes: 0,
        });
        continue;
      }
      throw error;
    }
  }
  return artifacts;
}
