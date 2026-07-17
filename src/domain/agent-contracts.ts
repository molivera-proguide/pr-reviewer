import { z } from "zod";

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  baseInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

export const runtimeAgentRoleSchema = z.enum([
  "sdd_explorer",
  "slice_planner",
  "code_explorer",
  "semantic_verifier",
]);
export type RuntimeAgentRole = z.infer<typeof runtimeAgentRoleSchema>;

// Persisted reports may contain the legacy synthesizer role. Runtime requests cannot use it.
export const agentRoleSchema = z.enum([
  "sdd_explorer",
  "slice_planner",
  "code_explorer",
  "semantic_verifier",
  "synthesizer",
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentFailureKindSchema = z.enum([
  "max_tokens",
  "refusal",
  "schema_validation",
  "transient_api",
  "permanent_api",
  "budget",
  "cancelled",
]);
export type AgentFailureKind = z.infer<typeof agentFailureKindSchema>;

const safeDiagnosticIdentifierSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_.$:\\/-]+$/);
const safeRequestIdSchema = z
  .string()
  .max(256)
  .regex(/^req[_-][A-Za-z0-9_.:-]+$/);

export const attemptSummarySchema = z.object({
  role: agentRoleSchema,
  model: safeDiagnosticIdentifierSchema.optional(),
  sliceId: safeDiagnosticIdentifierSchema.optional(),
  attempt: z.number().int().min(1).max(2),
  status: z.enum(["completed", "failed"]),
  failureKind: agentFailureKindSchema.optional(),
  stopReason: z
    .enum(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"])
    .nullable(),
  requestId: safeRequestIdSchema.nullable(),
  statusCode: z.number().int().min(100).max(599).nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  baseInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(),
  payloadBytes: z.number().int().nonnegative(),
  validationPaths: z.array(safeDiagnosticIdentifierSchema).max(50),
});
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;

export const codeSliceSummarySchema = z.object({
  id: safeDiagnosticIdentifierSchema,
  kind: z.enum(["implementation", "tests"]).optional(),
  scope: z.enum(["implementation", "test_only"]).optional(),
  status: z.enum(["completed", "incomplete"]),
  assessmentStatus: z.enum(["complete", "gapped"]).optional(),
  assignedCriteria: z.number().int().nonnegative().optional(),
  acceptedCriteria: z.number().int().nonnegative().optional(),
  failureKind: agentFailureKindSchema.optional(),
  attempts: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  requestIds: z.array(safeRequestIdSchema).max(2),
});
export type CodeSliceSummary = z.infer<typeof codeSliceSummarySchema>;

export const slicePlanningSummarySchema = z.object({
  mode: z.enum(["single", "model", "deterministic_fallback"]),
  proposedSlices: z.number().int().nonnegative(),
  acceptedSlices: z.number().int().nonnegative(),
  fallbackReason: safeDiagnosticIdentifierSchema.optional(),
});
export type SlicePlanningSummary = z.infer<typeof slicePlanningSummarySchema>;
