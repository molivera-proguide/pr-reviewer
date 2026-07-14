import type { ChangedFile, CoverageDimension } from "../domain/contracts.ts";
import type { SddCriterion } from "./agents/schemas.ts";

export interface ReviewSlice {
  readonly id: string;
  readonly kind: CoverageDimension;
  readonly criteria: readonly SddCriterion[];
  readonly files: readonly ChangedFile[];
  readonly truncated: boolean;
}

export function sliceKindOf(path: string): CoverageDimension {
  const normalized = `/${path.replaceAll("\\", "/").toLowerCase()}`;
  return /\/(?:tests?|__tests__)\//.test(normalized) || /\.(?:test|spec)\.[^/]+$/.test(normalized)
    ? "tests"
    : "implementation";
}

function domainOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.length > 1 ? (segments[0] ?? "root") : "root";
}

function fileChars(file: ChangedFile): number {
  return (
    (file.patch?.length ?? 0) +
    (file.headContent?.length ?? 0) +
    (file.baseContent?.length ?? 0) +
    file.path.length
  );
}

export function createReviewSlices(
  files: readonly ChangedFile[],
  criteria: readonly SddCriterion[],
  maxSlices = 3,
  maxCharsPerSlice = 600_000,
): ReviewSlice[] {
  const grouped = new Map<string, { kind: CoverageDimension; files: ChangedFile[] }>();
  for (const file of files) {
    const kind = sliceKindOf(file.path);
    const key = `${kind}:${domainOf(file.path)}`;
    const group = grouped.get(key) ?? { kind, files: [] };
    group.files.push(file);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()];
  const kinds = [...new Set(groups.map((group) => group.kind))];
  const targetCount = Math.min(maxSlices, groups.length);
  const allocations = new Map(kinds.map((kind) => [kind, 1]));
  while ([...allocations.values()].reduce((sum, value) => sum + value, 0) < targetCount) {
    const kind = kinds.reduce((largest, current) => {
      const load = groups
        .filter((group) => group.kind === current)
        .reduce((sum, group) => sum + group.files.reduce((n, file) => n + fileChars(file), 0), 0);
      const largestLoad = groups
        .filter((group) => group.kind === largest)
        .reduce((sum, group) => sum + group.files.reduce((n, file) => n + fileChars(file), 0), 0);
      return load / (allocations.get(current) ?? 1) > largestLoad / (allocations.get(largest) ?? 1)
        ? current
        : largest;
    });
    allocations.set(kind, (allocations.get(kind) ?? 0) + 1);
  }
  const buckets = kinds.flatMap((kind) =>
    Array.from({ length: allocations.get(kind) ?? 1 }, () => ({
      kind,
      files: [] as ChangedFile[],
      chars: 0,
      truncated: false,
    })),
  );
  const orderedGroups = groups.sort(
    (left, right) =>
      right.files.reduce((sum, file) => sum + fileChars(file), 0) -
      left.files.reduce((sum, file) => sum + fileChars(file), 0),
  );
  for (const group of orderedGroups) {
    const eligible = buckets.filter((bucket) => bucket.kind === group.kind);
    const bucket = eligible.reduce((smallest, current) =>
      current.chars < smallest.chars ? current : smallest,
    );
    for (const file of group.files) {
      const chars = fileChars(file);
      if (bucket.chars + chars > maxCharsPerSlice) {
        const remaining = Math.max(0, maxCharsPerSlice - bucket.chars);
        const patch = file.patch?.slice(0, Math.floor(remaining / 3)) ?? null;
        const headContent = file.headContent?.slice(0, Math.floor(remaining / 3)) ?? null;
        const baseContent = file.baseContent?.slice(0, Math.floor(remaining / 3)) ?? null;
        bucket.files.push({ ...file, patch, headContent, baseContent, truncated: true });
        bucket.chars = maxCharsPerSlice;
        bucket.truncated = true;
      } else {
        bucket.files.push(file);
        bucket.chars += chars;
      }
    }
  }
  return buckets
    .filter((bucket) => bucket.files.length > 0)
    .map((bucket, index) => ({
      id: `slice-${index + 1}`,
      kind: bucket.kind,
      criteria,
      files: bucket.files,
      truncated: bucket.truncated,
    }));
}
