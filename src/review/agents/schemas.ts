import { z } from "zod";
import {
  coverageDimensionSchema,
  evidenceSchema,
  findingImpactSchema,
  reviewCoverageSchema,
  severitySchema,
} from "../../domain/contracts.ts";

const conciseText = z.string().min(1).max(1_000);
const agentEvidenceSchema = evidenceSchema.extend({
  excerpt: z.string().max(1_200),
});
const agentCoverageSchema = reviewCoverageSchema.extend({
  dimension: coverageDimensionSchema,
  description: conciseText,
  evidence: z.array(agentEvidenceSchema).max(3),
  notes: z.string().max(1_000),
});

export const sddCriterionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .describe("Stable acceptance-criterion identifier, for example AC-002."),
  description: conciseText.describe("Concise required behavior from the SDD."),
  required: z.boolean().describe("True only when the SDD makes the criterion mandatory."),
  sourcePath: z.string().min(1).max(500).describe("Repository-relative SDD artifact path."),
});
export type SddCriterion = z.infer<typeof sddCriterionSchema>;

export const sddAnalysisSchema = z.object({
  objectives: z.array(conciseText).max(50),
  criteria: z.array(sddCriterionSchema).max(200),
  constraints: z.array(conciseText).max(100),
  tasks: z.array(conciseText).max(100),
  decisions: z.array(conciseText).max(100),
  conflicts: z.array(conciseText).max(50),
  sddApproved: z.boolean(),
});
export type SddAnalysis = z.infer<typeof sddAnalysisSchema>;

const agentFindingFields = {
  id: z.string().min(1).max(100).describe("Unique finding identifier within this response."),
  severity: severitySchema,
  category: z.string().min(1).max(100),
  claim: z.string().min(1).max(500),
  evidence: z
    .array(agentEvidenceSchema)
    .min(1)
    .max(3)
    .describe("Exact 1-based inclusive locations copied from supplied full file content."),
  confidence: z.number().min(0).max(1),
  suggestedAction: z.string().min(1).max(600),
} as const;

const criterionIds = z
  .array(z.string())
  .max(10)
  .describe("Only SDD criterion IDs directly affected by this finding.");

export const agentFindingSchema = z.discriminatedUnion("impact", [
  z.object({ ...agentFindingFields, impact: z.literal("implementation"), criterionIds }),
  z.object({ ...agentFindingFields, impact: z.literal("test_coverage"), criterionIds }),
  z.object({
    ...agentFindingFields,
    impact: z.literal("maintainability"),
    criterionIds: z
      .array(z.string())
      .max(0)
      .describe("Maintainability suggestions cannot claim SDD criterion non-compliance."),
  }),
]);
export type AgentFinding = z.infer<typeof agentFindingSchema>;

export const codeAnalysisSchema = z.object({
  findings: z.array(agentFindingSchema).max(12),
  coverage: z
    .array(agentCoverageSchema)
    .max(50)
    .describe("Only coverage directly supported by this slice; omit empty rows."),
  limitations: z
    .array(
      z.object({
        scope: z.enum(["global_unavailability", "slice_isolation"]),
        description: conciseText,
      }),
    )
    .max(10),
});
export type CodeAnalysis = z.infer<typeof codeAnalysisSchema>;

export const semanticVerificationSchema = z.object({
  decisions: z
    .array(
      z.object({
        findingId: z.string().max(100),
        confirmed: z.boolean(),
        rationale: z.string().max(600),
        adjustedSeverity: severitySchema,
        adjustedImpact: findingImpactSchema,
        confirmedCriterionIds: z.array(z.string()).max(10),
      }),
    )
    .max(50),
});
export type SemanticVerification = z.infer<typeof semanticVerificationSchema>;

export const synthesisSchema = z.object({
  risks: z.array(conciseText).max(20),
  pendingDecisions: z
    .array(
      z.object({
        question: conciseText,
        conflictIndexes: z.array(z.number().int().nonnegative()).min(1).max(10),
      }),
    )
    .max(20),
});
export type Synthesis = z.infer<typeof synthesisSchema>;
