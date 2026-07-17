import type { ChangedFile, CoverageDimension, ReviewScope } from "../domain/contracts.ts";
import type { SddCriterion } from "./agents/schemas.ts";

export type ReviewSliceScope = ReviewScope;
export type ReviewChangeKind = "implementation_with_tests" | "implementation_only" | "test_only";

export interface ReviewSlice {
  readonly id: string;
  readonly scope: ReviewSliceScope;
  readonly criteria: readonly SddCriterion[];
  readonly implementationFiles: readonly ChangedFile[];
  readonly testFiles: readonly ChangedFile[];
  readonly truncated: boolean;
}

export function sliceKindOf(path: string): CoverageDimension {
  const normalized = `/${path.replaceAll("\\", "/").toLowerCase()}`;
  return /\/(?:tests?|__tests__)\//.test(normalized) || /\.(?:test|spec)\.[^/]+$/.test(normalized)
    ? "tests"
    : "implementation";
}

export function classifyReviewChange(files: readonly ChangedFile[]): ReviewChangeKind {
  const hasImplementation = files.some((file) => sliceKindOf(file.path) === "implementation");
  const hasTests = files.some((file) => sliceKindOf(file.path) === "tests");
  if (!hasImplementation && !hasTests) return "implementation_only";
  if (!hasImplementation) return "test_only";
  return hasTests ? "implementation_with_tests" : "implementation_only";
}

const conventionalRoots = new Set([
  "app",
  "apps",
  "lib",
  "libs",
  "package",
  "packages",
  "src",
  "test",
  "tests",
  "__tests__",
]);

function normalizedSegments(path: string): string[] {
  return path.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
}

function stemOf(path: string): string {
  const filename = normalizedSegments(path).at(-1) ?? "root";
  return filename.replace(/\.(?:test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "");
}

function domainOf(path: string): string {
  const segments = normalizedSegments(path);
  const directories = segments.slice(0, -1).filter((segment) => !conventionalRoots.has(segment));
  return directories[0] ?? stemOf(path);
}

function relationshipScore(
  testFile: ChangedFile,
  implementationFiles: readonly ChangedFile[],
): number {
  const testStem = stemOf(testFile.path);
  const testDomain = domainOf(testFile.path);
  const testTokens = new Set(normalizedSegments(testFile.path));
  return implementationFiles.reduce((best, implementationFile) => {
    const implementationTokens = normalizedSegments(implementationFile.path);
    const sharedTokens = implementationTokens.filter((token) => testTokens.has(token)).length;
    const score =
      (stemOf(implementationFile.path) === testStem ? 20 : 0) +
      (domainOf(implementationFile.path) === testDomain ? 10 : 0) +
      sharedTokens;
    return Math.max(best, score);
  }, 0);
}

function fileChars(file: ChangedFile): number {
  return (
    (file.patch?.length ?? 0) +
    (file.headContent?.length ?? 0) +
    (file.baseContent?.length ?? 0) +
    file.path.length
  );
}

interface SliceBucket {
  scope: ReviewSliceScope;
  implementationFiles: ChangedFile[];
  testFiles: ChangedFile[];
  chars: number;
  truncated: boolean;
  criteria: SddCriterion[];
}

function truncateFile(file: ChangedFile, remaining: number): ChangedFile {
  const available = Math.max(0, remaining - file.path.length);
  const perField = Math.floor(available / 3);
  return {
    ...file,
    patch: file.patch?.slice(0, perField) ?? null,
    headContent: file.headContent?.slice(0, perField) ?? null,
    baseContent: file.baseContent?.slice(0, perField) ?? null,
    truncated: true,
  };
}

function appendWithinBudget(
  bucket: SliceBucket,
  file: ChangedFile,
  target: "implementationFiles" | "testFiles",
  maxCharsPerSlice: number,
): void {
  const chars = fileChars(file);
  if (bucket.chars + chars <= maxCharsPerSlice) {
    bucket[target].push(file);
    bucket.chars += chars;
    return;
  }
  bucket[target].push(truncateFile(file, maxCharsPerSlice - bucket.chars));
  bucket.chars = maxCharsPerSlice;
  bucket.truncated = true;
}

function mergeSmallestGroups(groups: ChangedFile[][], maxSlices: number): ChangedFile[][] {
  const output = groups.map((group) => [...group]);
  while (output.length > Math.max(1, maxSlices)) {
    output.sort(
      (left, right) =>
        left.reduce((sum, file) => sum + fileChars(file), 0) -
          right.reduce((sum, file) => sum + fileChars(file), 0) ||
        (left[0]?.path ?? "").localeCompare(right[0]?.path ?? ""),
    );
    const smallest = output.shift();
    if (smallest === undefined) break;
    const target = output.reduce((best, current) => {
      const bestScore = smallest.reduce(
        (score, file) => Math.max(score, relationshipScore(file, best)),
        0,
      );
      const currentScore = smallest.reduce(
        (score, file) => Math.max(score, relationshipScore(file, current)),
        0,
      );
      if (currentScore !== bestScore) return currentScore > bestScore ? current : best;
      const bestSize = best.reduce((sum, file) => sum + fileChars(file), 0);
      const currentSize = current.reduce((sum, file) => sum + fileChars(file), 0);
      return currentSize < bestSize ? current : best;
    });
    target.push(...smallest);
  }
  return output;
}

function groupedByDomain(files: readonly ChangedFile[], maxSlices: number): ChangedFile[][] {
  const grouped = new Map<string, ChangedFile[]>();
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const domain = domainOf(file.path);
    const group = grouped.get(domain) ?? [];
    group.push(file);
    grouped.set(domain, group);
  }
  return mergeSmallestGroups([...grouped.values()], maxSlices).sort(
    (left, right) =>
      right.reduce((sum, file) => sum + fileChars(file), 0) -
        left.reduce((sum, file) => sum + fileChars(file), 0) ||
      (left[0]?.path ?? "").localeCompare(right[0]?.path ?? ""),
  );
}

function criterionScore(criterion: SddCriterion, bucket: SliceBucket): number {
  const normalizeToken = (token: string): string => {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
      return token.slice(0, -1);
    }
    return token;
  };
  const tokens = (criterion.description.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((token) => token.length >= 4)
    .map(normalizeToken);
  const pathTokens = new Set(
    [...bucket.implementationFiles, ...bucket.testFiles].flatMap((file) =>
      (file.path.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map(normalizeToken),
    ),
  );
  return tokens.reduce((score, token) => score + (pathTokens.has(token) ? 1 : 0), 0);
}

export function createReviewSlices(
  files: readonly ChangedFile[],
  criteria: readonly SddCriterion[],
  maxSlices = 3,
  maxCharsPerSlice = 600_000,
): ReviewSlice[] {
  if (files.length === 0) return [];
  const implementationFiles = files.filter((file) => sliceKindOf(file.path) === "implementation");
  const testFiles = files.filter((file) => sliceKindOf(file.path) === "tests");
  const scope: ReviewSliceScope = implementationFiles.length === 0 ? "test_only" : "implementation";
  const primaryGroups = groupedByDomain(
    scope === "implementation" ? implementationFiles : testFiles,
    maxSlices,
  );
  const buckets: SliceBucket[] = primaryGroups.map(() => ({
    scope,
    implementationFiles: [],
    testFiles: [],
    chars: 0,
    truncated: false,
    criteria: [],
  }));
  for (const [index, group] of primaryGroups.entries()) {
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    for (const file of group) {
      appendWithinBudget(
        bucket,
        file,
        scope === "implementation" ? "implementationFiles" : "testFiles",
        maxCharsPerSlice,
      );
    }
  }
  if (scope === "implementation") {
    for (const testFile of [...testFiles].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const bucket = buckets.reduce((best, current) => {
        const bestScore = relationshipScore(testFile, best.implementationFiles);
        const currentScore = relationshipScore(testFile, current.implementationFiles);
        if (currentScore !== bestScore) return currentScore > bestScore ? current : best;
        return current.chars < best.chars ? current : best;
      });
      appendWithinBudget(bucket, testFile, "testFiles", maxCharsPerSlice);
    }
  }
  for (const criterion of criteria) {
    const bucket = buckets.reduce((best, current) => {
      const bestScore = criterionScore(criterion, best);
      const currentScore = criterionScore(criterion, current);
      if (currentScore !== bestScore) return currentScore > bestScore ? current : best;
      if (current.criteria.length !== best.criteria.length) {
        return current.criteria.length < best.criteria.length ? current : best;
      }
      return current.chars < best.chars ? current : best;
    });
    bucket.criteria.push(criterion);
  }
  return buckets.map((bucket, index) => ({
    id: `slice-${index + 1}`,
    scope: bucket.scope,
    criteria: bucket.criteria,
    implementationFiles: bucket.implementationFiles,
    testFiles: bucket.testFiles,
    truncated: bucket.truncated,
  }));
}
