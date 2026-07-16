import type { StructuredAgentClient } from "../anthropic/agent-client.ts";
import type { AgentFailureKind, AttemptSummary, ChangedFile } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";
import { classifyAgentFailure, safeStageLimitation, stopsNewSlices } from "./agent-failure.ts";
import { PROMPTS } from "./agents/prompts.ts";
import { codeAnalysisSchema, type SddAnalysis, testOnlyAnalysisSchema } from "./agents/schemas.ts";
import type { ReviewContext } from "./context-builder.ts";
import {
  codeFirstAnalysisToSliceAnalysis,
  type SliceAnalysis,
  testOnlyAnalysisToSliceAnalysis,
} from "./slice-analysis.ts";
import type { ReviewSlice, ReviewSliceScope } from "./slicer.ts";

export type CodeSliceResult =
  | {
      readonly status: "completed";
      readonly sliceId: string;
      readonly sliceScope: ReviewSliceScope;
      readonly analysis: SliceAnalysis;
      readonly diagnostics: readonly AttemptSummary[];
    }
  | {
      readonly status: "incomplete";
      readonly sliceId: string;
      readonly sliceScope: ReviewSliceScope;
      readonly failureKind: AgentFailureKind;
      readonly limitation: string;
      readonly diagnostics: readonly AttemptSummary[];
      readonly analysis?: SliceAnalysis;
    };

export async function runCodeSlices(options: {
  slices: readonly ReviewSlice[];
  context: ReviewContext;
  sdd: SddAnalysis;
  changedFileInventory: readonly {
    path: string;
    status: string;
    binary: boolean;
    truncated: boolean;
  }[];
  client: StructuredAgentClient;
  signal: AbortSignal;
}): Promise<CodeSliceResult[]> {
  const output: Array<CodeSliceResult[] | undefined> = new Array(options.slices.length);
  let cursor = 0;
  let stopKind: AgentFailureKind | undefined;

  async function execute(slice: ReviewSlice): Promise<CodeSliceResult> {
    try {
      const payload = {
        repository: options.context.snapshot.baseRepository,
        headSha: options.context.snapshot.headSha,
        baseSha: options.context.snapshot.baseSha,
        slice,
        changedFileInventory: options.changedFileInventory,
        constraints: options.sdd.constraints,
        decisions: options.sdd.decisions,
      };
      if (slice.scope === "test_only") {
        const response = await options.client.run({
          role: "code_explorer",
          sliceId: slice.id,
          system: PROMPTS.testOnlyExplorer,
          payload,
          schema: testOnlyAnalysisSchema,
          maxTokens: 3_000,
          signal: options.signal,
        });
        const converted = testOnlyAnalysisToSliceAnalysis({
          analysis: response.data,
          slice,
          snapshot: options.context.snapshot,
        });
        return converted.complete
          ? {
              status: "completed",
              sliceId: slice.id,
              sliceScope: slice.scope,
              analysis: converted.analysis,
              diagnostics: response.diagnostics,
            }
          : {
              status: "incomplete",
              sliceId: slice.id,
              sliceScope: slice.scope,
              failureKind: "schema_validation",
              limitation: converted.limitation,
              analysis: converted.analysis,
              diagnostics: response.diagnostics,
            };
      }
      const response = await options.client.run({
        role: "code_explorer",
        sliceId: slice.id,
        system: PROMPTS.codeExplorer,
        payload,
        schema: codeAnalysisSchema,
        maxTokens: 4_000,
        signal: options.signal,
      });
      const converted = codeFirstAnalysisToSliceAnalysis({
        analysis: response.data,
        slice,
        snapshot: options.context.snapshot,
      });
      return converted.complete
        ? {
            status: "completed",
            sliceId: slice.id,
            sliceScope: slice.scope,
            analysis: converted.analysis,
            diagnostics: response.diagnostics,
          }
        : {
            status: "incomplete",
            sliceId: slice.id,
            sliceScope: slice.scope,
            failureKind: "schema_validation",
            limitation: converted.limitation,
            analysis: converted.analysis,
            diagnostics: response.diagnostics,
          };
    } catch (error) {
      const failure = classifyAgentFailure(error);
      return {
        status: "incomplete",
        sliceId: slice.id,
        sliceScope: slice.scope,
        failureKind: failure.kind,
        limitation: safeStageLimitation("Code exploration", failure.kind, slice.id),
        diagnostics: failure.diagnostics,
      };
    }
  }

  function split(slice: ReviewSlice): [ReviewSlice, ReviewSlice] | null {
    const primaryFiles =
      slice.scope === "implementation" ? slice.implementationFiles : slice.testFiles;
    if (primaryFiles.length < 2) return null;
    const midpoint = Math.ceil(primaryFiles.length / 2);
    const leftPrimary = primaryFiles.slice(0, midpoint);
    const rightPrimary = primaryFiles.slice(midpoint);
    const leftTests: ChangedFile[] = [];
    const rightTests: ChangedFile[] = [];
    if (slice.scope === "implementation") {
      for (const file of slice.testFiles) {
        const leftLoad = leftTests.reduce((sum, item) => sum + (item.headContent?.length ?? 0), 0);
        const rightLoad = rightTests.reduce(
          (sum, item) => sum + (item.headContent?.length ?? 0),
          0,
        );
        (leftLoad <= rightLoad ? leftTests : rightTests).push(file);
      }
    }
    return [
      {
        ...slice,
        id: `${slice.id}.1`,
        implementationFiles: slice.scope === "implementation" ? leftPrimary : [],
        testFiles: slice.scope === "implementation" ? leftTests : leftPrimary,
      },
      {
        ...slice,
        id: `${slice.id}.2`,
        implementationFiles: slice.scope === "implementation" ? rightPrimary : [],
        testFiles: slice.scope === "implementation" ? rightTests : rightPrimary,
      },
    ];
  }

  async function worker(): Promise<void> {
    while (cursor < options.slices.length && stopKind === undefined) {
      const index = cursor;
      cursor += 1;
      const slice = options.slices[index];
      if (slice === undefined) continue;
      const result = await execute(slice);
      const children =
        result.status === "incomplete" && result.failureKind === "max_tokens" ? split(slice) : null;
      if (children === null) {
        output[index] = [result];
        if (result.status === "incomplete" && stopsNewSlices(result.failureKind)) {
          stopKind = result.failureKind;
        }
        continue;
      }
      const childResults: CodeSliceResult[] = [];
      for (const child of children) {
        const childResult = await execute(child);
        childResults.push(childResult);
        if (childResult.status === "incomplete" && stopsNewSlices(childResult.failureKind)) {
          stopKind = childResult.failureKind;
          break;
        }
      }
      if (stopKind !== undefined && childResults.length < children.length) {
        for (const child of children.slice(childResults.length)) {
          childResults.push({
            status: "incomplete",
            sliceId: child.id,
            sliceScope: child.scope,
            failureKind: stopKind,
            limitation: safeStageLimitation("Code exploration", stopKind, child.id),
            diagnostics: [],
          });
        }
      }
      if (childResults[0] !== undefined) {
        childResults[0] = {
          ...childResults[0],
          diagnostics: [...result.diagnostics, ...childResults[0].diagnostics],
        };
      }
      output[index] = childResults;
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, options.slices.length) }, () => worker()));
  if (options.signal.aborted) {
    throw new ReviewerError("CANCELLED", "Code exploration was cancelled.");
  }
  for (let index = 0; index < options.slices.length; index += 1) {
    if (output[index] !== undefined) continue;
    const slice = options.slices[index];
    if (slice === undefined) continue;
    const kind = stopKind ?? "permanent_api";
    output[index] = [
      {
        status: "incomplete",
        sliceId: slice.id,
        sliceScope: slice.scope,
        failureKind: kind,
        limitation: safeStageLimitation("Code exploration", kind, slice.id),
        diagnostics: [],
      },
    ];
  }
  return output.flatMap((items) => items ?? []);
}
