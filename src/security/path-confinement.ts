import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ReviewerError } from "../domain/errors.ts";

function normalizedForComparison(path: string): string {
  const value = resolve(path).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedForComparison(root);
  const normalizedCandidate = normalizedForComparison(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

export async function canonicalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    throw new ReviewerError("REPOSITORY_NOT_FOUND", `Path does not exist: ${path}`);
  }
}

export async function assertRepositoryRoot(path: string): Promise<string> {
  const root = await canonicalizeExistingPath(path);
  try {
    await stat(resolve(root, ".git"));
  } catch {
    throw new ReviewerError("REPOSITORY_NOT_FOUND", `Path is not a Git repository: ${root}`);
  }
  return root;
}

export async function resolveRepositoryRoot(options: {
  repositoryPath?: string;
  claudeProjectDir?: string;
  clientRoots?: readonly string[];
}): Promise<string> {
  const clientRoots = options.clientRoots ?? [];
  const selected = options.repositoryPath ?? options.claudeProjectDir;
  if (selected !== undefined) {
    const root = await assertRepositoryRoot(selected);
    if (clientRoots.length > 0) {
      const canonicalApprovedRoots = await Promise.all(clientRoots.map(canonicalizeExistingPath));
      if (!canonicalApprovedRoots.some((approved) => isPathWithin(approved, root))) {
        throw new ReviewerError(
          "PATH_OUTSIDE_ROOT",
          "Resolved repository is outside client-approved roots.",
        );
      }
    }
    return root;
  }
  if (clientRoots.length === 1) {
    const onlyRoot = clientRoots[0];
    if (onlyRoot === undefined) {
      throw new ReviewerError("REPOSITORY_NOT_FOUND", "No repository root was supplied.");
    }
    return assertRepositoryRoot(onlyRoot);
  }
  throw new ReviewerError(
    "REPOSITORY_NOT_FOUND",
    "Repository root is ambiguous. Pass repository_path or set CLAUDE_PROJECT_DIR.",
  );
}

export async function confinedPath(root: string, untrustedPath: string): Promise<string> {
  if (isAbsolute(untrustedPath)) {
    throw new ReviewerError("PATH_OUTSIDE_ROOT", "Absolute snapshot paths are not allowed.");
  }
  const candidate = resolve(root, untrustedPath);
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === ".." || !isPathWithin(root, candidate)) {
    throw new ReviewerError(
      "PATH_OUTSIDE_ROOT",
      `Path escapes the approved root: ${untrustedPath}`,
    );
  }
  return candidate;
}
