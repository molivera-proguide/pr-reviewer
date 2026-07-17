import type { StructuredAgentClient } from "../anthropic/agent-client.ts";
import type { AttemptSummary, ChangedFile, SlicePlanningSummary } from "../domain/contracts.ts";
import { classifyAgentFailure } from "./agent-failure.ts";
import { PROMPTS } from "./agents/prompts.ts";
import {
  type SddCriterion,
  type SlicePlanProposal,
  slicePlanProposalSchema,
} from "./agents/schemas.ts";
import { createReviewSlices, type ReviewSlice, sliceKindOf } from "./slicer.ts";

const SINGLE_SLICE_MAX_FILES = 20;
const SINGLE_SLICE_MAX_CHARS = 150_000;
const SINGLE_SLICE_MAX_CRITERIA = 30;
const PLANNED_SLICE_MAX_CHARS = 250_000;
const MAX_SLICES = 3;
const MAX_PATH_DUPLICATION = 2;

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function fileChars(file: ChangedFile): number {
  return (
    file.path.length +
    (file.patch?.length ?? 0) +
    (file.headContent?.length ?? 0) +
    (file.baseContent?.length ?? 0)
  );
}

export function shouldUseSingleSlice(
  files: readonly ChangedFile[],
  criteria: readonly SddCriterion[],
): boolean {
  return (
    files.length <= SINGLE_SLICE_MAX_FILES &&
    criteria.length <= SINGLE_SLICE_MAX_CRITERIA &&
    files.reduce((sum, file) => sum + fileChars(file), 0) <= SINGLE_SLICE_MAX_CHARS
  );
}

export type SlicePlanValidation =
  | { readonly success: true; readonly slices: readonly ReviewSlice[] }
  | { readonly success: false; readonly reason: string };

export function validateSlicePlan(options: {
  proposal: SlicePlanProposal;
  files: readonly ChangedFile[];
  criteria: readonly SddCriterion[];
}): SlicePlanValidation {
  if (options.proposal.slices.length > MAX_SLICES) {
    return { success: false, reason: "too_many_slices" };
  }
  const filesByPath = new Map(options.files.map((file) => [normalizedPath(file.path), file]));
  const criteriaById = new Map(options.criteria.map((criterion) => [criterion.id, criterion]));
  const criterionCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const materialized: Array<Omit<ReviewSlice, "id">> = [];

  for (const proposed of options.proposal.slices) {
    if (new Set(proposed.criterionIds).size !== proposed.criterionIds.length) {
      return { success: false, reason: "duplicate_criterion_in_slice" };
    }
    const implementationKeys = proposed.implementationPaths.map(normalizedPath);
    const testKeys = proposed.testPaths.map(normalizedPath);
    const pathKeys = [...implementationKeys, ...testKeys];
    if (new Set(pathKeys).size !== pathKeys.length) {
      return { success: false, reason: "duplicate_path_in_slice" };
    }
    const criteria: SddCriterion[] = [];
    for (const criterionId of proposed.criterionIds) {
      const criterion = criteriaById.get(criterionId);
      if (criterion === undefined) return { success: false, reason: "unknown_criterion" };
      criterionCounts.set(criterionId, (criterionCounts.get(criterionId) ?? 0) + 1);
      criteria.push(criterion);
    }
    const implementationFiles: ChangedFile[] = [];
    for (const key of implementationKeys) {
      const file = filesByPath.get(key);
      if (file === undefined) return { success: false, reason: "unknown_path" };
      if (sliceKindOf(file.path) !== "implementation") {
        return { success: false, reason: "wrong_path_dimension" };
      }
      pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1);
      implementationFiles.push(file);
    }
    const testFiles: ChangedFile[] = [];
    for (const key of testKeys) {
      const file = filesByPath.get(key);
      if (file === undefined) return { success: false, reason: "unknown_path" };
      if (sliceKindOf(file.path) !== "tests") {
        return { success: false, reason: "wrong_path_dimension" };
      }
      pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1);
      testFiles.push(file);
    }
    const hasImplementation = options.files.some(
      (file) => sliceKindOf(file.path) === "implementation",
    );
    if (hasImplementation && implementationFiles.length === 0) {
      return { success: false, reason: "implementation_missing" };
    }
    const chars = [...implementationFiles, ...testFiles].reduce(
      (sum, file) => sum + fileChars(file),
      0,
    );
    if (chars > PLANNED_SLICE_MAX_CHARS) {
      return { success: false, reason: "slice_budget_exceeded" };
    }
    materialized.push({
      scope: hasImplementation ? "implementation" : "test_only",
      criteria: criteria.sort((left, right) => left.id.localeCompare(right.id)),
      implementationFiles: implementationFiles.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      testFiles: testFiles.sort((left, right) => left.path.localeCompare(right.path)),
      truncated: [...implementationFiles, ...testFiles].some((file) => file.truncated),
    });
  }
  if (options.criteria.some((criterion) => criterionCounts.get(criterion.id) !== 1)) {
    return { success: false, reason: "criterion_coverage_invalid" };
  }
  if (options.files.some((file) => (pathCounts.get(normalizedPath(file.path)) ?? 0) === 0)) {
    return { success: false, reason: "file_coverage_invalid" };
  }
  if ([...pathCounts.values()].some((count) => count > MAX_PATH_DUPLICATION)) {
    return { success: false, reason: "path_duplication_exceeded" };
  }
  const slices = materialized
    .sort(
      (left, right) =>
        (left.criteria[0]?.id ?? "").localeCompare(right.criteria[0]?.id ?? "") ||
        (left.implementationFiles[0]?.path ?? left.testFiles[0]?.path ?? "").localeCompare(
          right.implementationFiles[0]?.path ?? right.testFiles[0]?.path ?? "",
        ),
    )
    .map((slice, index) => ({ ...slice, id: `slice-${index + 1}` }));
  return { success: true, slices };
}

export interface SlicePlanningResult {
  readonly slices: readonly ReviewSlice[];
  readonly diagnostics: readonly AttemptSummary[];
  readonly summary: SlicePlanningSummary;
}

function deterministicFallback(options: {
  files: readonly ChangedFile[];
  criteria: readonly SddCriterion[];
  proposedSlices: number;
  reason: string;
  diagnostics?: readonly AttemptSummary[];
}): SlicePlanningResult {
  const slices = createReviewSlices(
    options.files,
    options.criteria,
    MAX_SLICES,
    PLANNED_SLICE_MAX_CHARS,
  );
  return {
    slices,
    diagnostics: options.diagnostics ?? [],
    summary: {
      mode: "deterministic_fallback",
      proposedSlices: options.proposedSlices,
      acceptedSlices: slices.length,
      fallbackReason: options.reason,
    },
  };
}

export async function planReviewSlices(options: {
  files: readonly ChangedFile[];
  criteria: readonly SddCriterion[];
  client: StructuredAgentClient;
  signal: AbortSignal;
}): Promise<SlicePlanningResult> {
  if (options.files.length === 0) {
    return {
      slices: [],
      diagnostics: [],
      summary: { mode: "single", proposedSlices: 0, acceptedSlices: 0 },
    };
  }
  if (shouldUseSingleSlice(options.files, options.criteria)) {
    const slices = createReviewSlices(options.files, options.criteria, 1, SINGLE_SLICE_MAX_CHARS);
    return {
      slices,
      diagnostics: [],
      summary: { mode: "single", proposedSlices: slices.length, acceptedSlices: slices.length },
    };
  }
  if (options.criteria.length === 0) {
    return deterministicFallback({
      files: options.files,
      criteria: options.criteria,
      proposedSlices: 0,
      reason: "no_criteria",
    });
  }
  try {
    const response = await options.client.run({
      role: "slice_planner",
      system: PROMPTS.slicePlanner,
      payload: {
        criteria: options.criteria,
        files: options.files.map((file) => ({
          path: file.path,
          kind: sliceKindOf(file.path),
          status: file.status,
          chars: fileChars(file),
          binary: file.binary,
          truncated: file.truncated,
        })),
        limits: {
          maxSlices: MAX_SLICES,
          maxCharsPerSlice: PLANNED_SLICE_MAX_CHARS,
          maxPathDuplication: MAX_PATH_DUPLICATION,
        },
      },
      schema: slicePlanProposalSchema,
      maxTokens: 1_200,
      signal: options.signal,
    });
    const validated = validateSlicePlan({
      proposal: response.data,
      files: options.files,
      criteria: options.criteria,
    });
    if (!validated.success) {
      return deterministicFallback({
        files: options.files,
        criteria: options.criteria,
        proposedSlices: response.data.slices.length,
        reason: validated.reason,
        diagnostics: response.diagnostics,
      });
    }
    return {
      slices: validated.slices,
      diagnostics: response.diagnostics,
      summary: {
        mode: "model",
        proposedSlices: response.data.slices.length,
        acceptedSlices: validated.slices.length,
      },
    };
  } catch (error) {
    if (options.signal.aborted) throw error;
    const failure = classifyAgentFailure(error);
    return deterministicFallback({
      files: options.files,
      criteria: options.criteria,
      proposedSlices: 0,
      reason: `planner_${failure.kind}`,
      diagnostics: failure.diagnostics,
    });
  }
}
