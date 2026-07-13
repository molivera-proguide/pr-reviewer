import type { ChangeRequestSnapshot, FeatureReference } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";
import type { RepositoryProvider } from "../providers/provider.ts";

function normalizeFeatureNumber(value: string): string {
  return value.padStart(3, "0");
}

function extractCandidates(value: string): string[] {
  const candidates = new Set<string>();
  const markerPattern =
    /(?:^|[^a-z0-9])(?:feat(?:ure)?|sdd|specs?)[\s(/:_-]*(\d{1,3})(?=$|[^0-9])/gi;
  for (const match of value.matchAll(markerPattern)) {
    const number = match[1];
    if (number !== undefined) {
      candidates.add(normalizeFeatureNumber(number));
    }
  }
  if (candidates.size === 0) {
    const threeDigitPattern = /(?:^|[^0-9])(\d{3})(?=$|[^0-9])/g;
    for (const match of value.matchAll(threeDigitPattern)) {
      const number = match[1];
      if (number !== undefined) {
        candidates.add(number);
      }
    }
  }
  return [...candidates];
}

export function detectFeatureNumber(
  title: string,
  sourceBranch: string,
): { number: string; origin: FeatureReference["origin"] } {
  const titleCandidates = extractCandidates(title);
  const branchCandidates = extractCandidates(sourceBranch);
  if (titleCandidates.length > 1 || branchCandidates.length > 1) {
    throw new ReviewerError("FEATURE_CONFLICT", "Multiple feature numbers were detected.", {
      titleCandidates,
      branchCandidates,
    });
  }
  const titleNumber = titleCandidates[0];
  const branchNumber = branchCandidates[0];
  if (titleNumber !== undefined && branchNumber !== undefined && titleNumber !== branchNumber) {
    throw new ReviewerError(
      "FEATURE_CONFLICT",
      `Title resolves to feature ${titleNumber}, but branch resolves to ${branchNumber}.`,
    );
  }
  const number = titleNumber ?? branchNumber;
  if (number === undefined) {
    throw new ReviewerError(
      "FEATURE_NOT_FOUND",
      "No SDD feature number was detected in the title or source branch.",
    );
  }
  return {
    number,
    origin:
      titleNumber !== undefined && branchNumber !== undefined
        ? "title_and_branch"
        : titleNumber !== undefined
          ? "title"
          : "branch",
  };
}

export async function resolveFeature(
  snapshot: ChangeRequestSnapshot,
  provider: RepositoryProvider,
  signal: AbortSignal,
): Promise<FeatureReference> {
  const detected = detectFeatureNumber(snapshot.title, snapshot.sourceBranch);
  const tree = await provider.listTree(snapshot.headSha, "specs", signal);
  const prefix = `specs/${detected.number}-`;
  const directories = new Set<string>();
  for (const entry of tree) {
    const [specs, directory] = entry.path.replaceAll("\\", "/").split("/");
    if (specs === "specs" && directory?.startsWith(`${detected.number}-`)) {
      directories.add(`specs/${directory}`);
    }
  }
  const matches = [...directories].filter((directory) => directory.startsWith(prefix));
  if (matches.length === 0) {
    throw new ReviewerError(
      "FEATURE_NOT_FOUND",
      `No directory matching specs/${detected.number}-* exists at HEAD ${snapshot.headSha}.`,
    );
  }
  if (matches.length > 1) {
    throw new ReviewerError(
      "FEATURE_NOT_UNIQUE",
      `Multiple directories match specs/${detected.number}-* at the reviewed HEAD.`,
      { matches },
    );
  }
  const directory = matches[0];
  if (directory === undefined) {
    throw new ReviewerError("FEATURE_NOT_FOUND", "Feature directory resolution failed.");
  }
  return { ...detected, directory };
}
