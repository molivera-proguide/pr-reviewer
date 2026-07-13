import type { ChangedFile } from "../domain/contracts.ts";
import type { SddCriterion } from "./agents/schemas.ts";

export interface ReviewSlice {
  readonly id: string;
  readonly criteria: readonly SddCriterion[];
  readonly files: readonly ChangedFile[];
  readonly truncated: boolean;
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
  const grouped = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const key = domainOf(file.path);
    const group = grouped.get(key) ?? [];
    group.push(file);
    grouped.set(key, group);
  }
  const buckets = Array.from({ length: Math.min(maxSlices, Math.max(1, grouped.size)) }, () => ({
    files: [] as ChangedFile[],
    chars: 0,
    truncated: false,
  }));
  const orderedGroups = [...grouped.values()].sort(
    (left, right) =>
      right.reduce((sum, file) => sum + fileChars(file), 0) -
      left.reduce((sum, file) => sum + fileChars(file), 0),
  );
  for (const group of orderedGroups) {
    const bucket = buckets.reduce((smallest, current) =>
      current.chars < smallest.chars ? current : smallest,
    );
    for (const file of group) {
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
      criteria,
      files: bucket.files,
      truncated: bucket.truncated,
    }));
}
