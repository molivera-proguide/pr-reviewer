import { z } from "zod";
import { ReviewerError } from "../domain/errors.ts";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_PROJECT_DIR: z.string().min(1).optional(),
  SDD_REVIEWER_MODEL: z.string().min(1).default("claude-sonnet-5"),
  SDD_REVIEWER_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),
  SDD_REVIEWER_DEBUG: booleanString,
  SDD_REVIEWER_MAX_FILES: z.coerce.number().int().min(1).max(1_000).default(150),
  SDD_REVIEWER_MAX_DIFF_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(20 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  SDD_REVIEWER_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(5 * 1024 * 1024)
    .default(512 * 1024),
  SDD_REVIEWER_MAX_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(20 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  SDD_REVIEWER_MAX_AGENT_CALLS: z.coerce.number().int().min(1).max(30).default(8),
  SDD_REVIEWER_MAX_AGENT_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(200_000)
    .default(40_000),
  SDD_REVIEWER_REPORT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export interface ReviewerConfig {
  readonly anthropicApiKey?: string;
  readonly claudeProjectDir?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly debug: boolean;
  readonly maxFiles: number;
  readonly maxDiffBytes: number;
  readonly maxFileBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxAgentCalls: number;
  readonly maxAgentOutputTokens: number;
  readonly reportTtlHours: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ReviewerConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ReviewerError("CONFIGURATION_ERROR", "Invalid reviewer environment configuration.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const value = parsed.data;
  return {
    ...(value.ANTHROPIC_API_KEY === undefined ? {} : { anthropicApiKey: value.ANTHROPIC_API_KEY }),
    ...(value.CLAUDE_PROJECT_DIR === undefined
      ? {}
      : { claudeProjectDir: value.CLAUDE_PROJECT_DIR }),
    model: value.SDD_REVIEWER_MODEL,
    timeoutMs: value.SDD_REVIEWER_TIMEOUT_MS,
    debug: value.SDD_REVIEWER_DEBUG,
    maxFiles: value.SDD_REVIEWER_MAX_FILES,
    maxDiffBytes: value.SDD_REVIEWER_MAX_DIFF_BYTES,
    maxFileBytes: value.SDD_REVIEWER_MAX_FILE_BYTES,
    maxArtifactBytes: value.SDD_REVIEWER_MAX_ARTIFACT_BYTES,
    maxAgentCalls: value.SDD_REVIEWER_MAX_AGENT_CALLS,
    maxAgentOutputTokens: value.SDD_REVIEWER_MAX_AGENT_OUTPUT_TOKENS,
    reportTtlHours: value.SDD_REVIEWER_REPORT_TTL_HOURS,
  };
}
