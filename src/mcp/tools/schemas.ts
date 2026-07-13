import { z } from "zod";

export const repositoryPathField = z.string().min(1).max(32_768).optional();

export const doctorInputShape = {
  repository_path: repositoryPathField.describe("Optional explicit path to the Git repository."),
};

export const doctorOutputShape = {
  version: z.string(),
  platform: z.string(),
  root: z.string().nullable(),
  provider: z.enum(["github", "gitlab"]).nullable(),
  repository: z.string().nullable(),
  overall: z.enum(["ok", "warning", "error"]),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["ok", "warning", "error"]),
      detail: z.string(),
    }),
  ),
};

export const listInputShape = {
  repository_path: repositoryPathField.describe("Optional explicit path to the Git repository."),
  limit: z.number().int().min(1).max(100).default(50),
};

export const listOutputShape = {
  provider: z.enum(["github", "gitlab"]),
  repository: z.string(),
  root: z.string(),
  change_requests: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      author: z.string(),
      source_branch: z.string(),
      target_branch: z.string(),
      draft: z.boolean(),
      head_sha: z.string(),
      updated_at: z.string(),
    }),
  ),
};

export const reviewInputShape = {
  repository_path: repositoryPathField.describe("Optional explicit path to the Git repository."),
  tl_confirmed: z
    .literal(true)
    .describe("Must only be true after the Tech Lead explicitly selected the displayed PR/MR."),
  selections: z
    .array(
      z.object({
        number: z.number().int().positive(),
        expected_head_sha: z.string().min(7).max(128),
      }),
    )
    .min(1)
    .max(1),
};

export const reviewOutputShape = {
  review_id: z.string(),
  status: z.enum(["completed", "incomplete", "stale", "cancelled", "failed"]),
  verdict: z.enum(["RIESGO_BLOQUEANTE", "REQUIERE_DECISION", "SIN_HALLAZGOS_BLOQUEANTES"]),
  provider: z.enum(["github", "gitlab"]),
  repository: z.string(),
  root: z.string(),
  change_request_number: z.number().int().positive(),
  expected_head_sha: z.string(),
  reviewed_head_sha: z.string().nullable(),
  current_head_sha: z.string(),
  report_path: z.string().nullable(),
  finding_count: z.number().int().nonnegative(),
  blocking_finding_count: z.number().int().nonnegative(),
  top_findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low"]),
      category: z.string(),
      claim: z.string(),
      path: z.string(),
      line: z.number().int().positive(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  coverage_summary: z.object({
    covered: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    not_verifiable: z.number().int().nonnegative(),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
  }),
  message: z.string(),
};
