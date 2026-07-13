import { z } from "zod";
import {
  coverageStatusSchema,
  evidenceSchema,
  reviewCoverageSchema,
  severitySchema,
} from "../../domain/contracts.ts";

export const sddCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
  sourcePath: z.string().min(1),
});
export type SddCriterion = z.infer<typeof sddCriterionSchema>;

export const sddAnalysisSchema = z.object({
  objectives: z.array(z.string()),
  criteria: z.array(sddCriterionSchema),
  constraints: z.array(z.string()),
  tasks: z.array(z.string()),
  decisions: z.array(z.string()),
  conflicts: z.array(z.string()),
  sddApproved: z.boolean(),
});
export type SddAnalysis = z.infer<typeof sddAnalysisSchema>;

export const agentFindingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  category: z.string().min(1),
  claim: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  confidence: z.number().min(0).max(1),
  suggestedAction: z.string().min(1),
  criterionIds: z.array(z.string()),
});
export type AgentFinding = z.infer<typeof agentFindingSchema>;

export const codeAnalysisSchema = z.object({
  findings: z.array(agentFindingSchema),
  coverage: z.array(reviewCoverageSchema),
  limitations: z.array(z.string()),
});
export type CodeAnalysis = z.infer<typeof codeAnalysisSchema>;

export const semanticVerificationSchema = z.object({
  decisions: z.array(
    z.object({
      findingId: z.string(),
      confirmed: z.boolean(),
      rationale: z.string(),
      adjustedSeverity: severitySchema,
    }),
  ),
});
export type SemanticVerification = z.infer<typeof semanticVerificationSchema>;

export const synthesisSchema = z.object({
  coverage: z.array(
    z.object({
      criterionId: z.string(),
      description: z.string(),
      status: coverageStatusSchema,
      evidence: z.array(evidenceSchema),
      notes: z.string(),
    }),
  ),
  risks: z.array(z.string()),
  pendingDecisions: z.array(z.string()),
});
export type Synthesis = z.infer<typeof synthesisSchema>;
