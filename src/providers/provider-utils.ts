import type { z } from "zod";
import type { SnapshotFile } from "../domain/contracts.ts";
import { ReviewerError } from "../domain/errors.ts";

export function parseJson<T>(text: string, schema: z.ZodType<T>, source: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReviewerError("COMMAND_FAILED", `${source} returned invalid JSON.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ReviewerError("COMMAND_FAILED", `${source} returned an unexpected response shape.`, {
      issues: parsed.error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function encodeRepositoryPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function bytesToSnapshotContent(
  bytes: Uint8Array,
  maxBytes: number,
): { content: string | null; binary: boolean; truncated: boolean; bytes: number } {
  const originalBytes = bytes.byteLength;
  const limited = bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  const sample = limited.subarray(0, Math.min(limited.byteLength, 8_192));
  const binary = sample.includes(0);
  return {
    content: binary ? null : new TextDecoder("utf-8", { fatal: false }).decode(limited),
    binary,
    truncated: originalBytes > maxBytes,
    bytes: originalBytes,
  };
}

export function joinFileDiffs(
  files: readonly { oldPath: string | null; path: string; patch: string | null }[],
): string {
  return files
    .map((file) => {
      const oldPath = file.oldPath ?? file.path;
      return `diff --git a/${oldPath} b/${file.path}\n--- a/${oldPath}\n+++ b/${file.path}\n${file.patch ?? "[diff unavailable]"}`;
    })
    .join("\n");
}

export async function readOptionalSnapshotFile(
  read: () => Promise<SnapshotFile>,
): Promise<SnapshotFile | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ReviewerError && error.code === "COMMAND_FAILED") {
      return null;
    }
    throw error;
  }
}

export function assertTextWithinByteLimit(value: string, maxBytes: number, message: string): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ReviewerError("CONTENT_LIMIT_EXCEEDED", message);
  }
}
