import { z } from "zod";
import {
  evidenceSchema,
  findingImpactSchema,
  severitySchema,
  testCoverageStatusSchema,
} from "../../domain/contracts.ts";

const conciseText = z.string().min(1).max(1_000);
const agentEvidenceSchema = evidenceSchema.extend({
  excerpt: z.string().max(1_200),
});
const agentLimitationSchema = z.object({
  scope: z.enum(["global_unavailability", "slice_isolation"]),
  description: conciseText,
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
  .array(z.string().min(1).max(100))
  .max(1)
  .describe(
    "Zero or one existing SDD criterion ID directly affected by this criterion-specific finding. Return separate findings when the same evidence violates different criteria.",
  );

export const agentFindingSchema = z.discriminatedUnion("impact", [
  z.object({ ...agentFindingFields, impact: z.literal("implementation"), criterionIds }),
  z.object({
    ...agentFindingFields,
    impact: z.literal("test_coverage"),
    criterionIds,
    testCoverageStatus: testCoverageStatusSchema.describe(
      "Use partial when relevant assertions exist but scenarios or boundaries are incomplete; use missing only when no relevant assertion exists.",
    ),
  }),
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

const implementationFindingSchema = z.object({
  id: agentFindingFields.id,
  severity: severitySchema,
  category: agentFindingFields.category,
  claim: agentFindingFields.claim,
  evidence: agentFindingFields.evidence,
  confidence: agentFindingFields.confidence,
  suggestedAction: agentFindingFields.suggestedAction,
});

const maintainabilityFindingSchema = z.object({
  ...agentFindingFields,
  impact: z.literal("maintainability"),
  severity: z.literal("low"),
  criterionIds: z.array(z.string()).max(0),
});

const testObservationFields = {
  evidence: z.array(agentEvidenceSchema).min(1).max(3),
  notes: z.string().min(1).max(1_000),
} as const;

export const testObservationSchema = z.discriminatedUnion("status", [
  z.object({ ...testObservationFields, status: z.literal("covered") }),
  z.object({
    ...testObservationFields,
    status: z.literal("partial"),
    claim: z.string().min(1).max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
    suggestedAction: z.string().min(1).max(600).optional(),
  }),
  z.object({
    ...testObservationFields,
    status: z.literal("missing"),
    claim: z.string().min(1).max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
    suggestedAction: z.string().min(1).max(600).optional(),
  }),
  z.object({
    status: z.literal("not_verifiable"),
    notes: z.string().min(1).max(1_000),
  }),
]);
export type TestObservation = z.infer<typeof testObservationSchema>;

const criterionReviewSchema = z.object({
  criterionId: z.string().min(1).max(100),
  implementation: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("covered"),
      evidence: z.array(agentEvidenceSchema).min(1).max(3),
      notes: z.string().min(1).max(1_000),
    }),
    z.object({
      status: z.literal("defect"),
      finding: implementationFindingSchema,
    }),
  ]),
  tests: testObservationSchema.optional(),
});

export const codeAnalysisSchema = z.object({
  reviews: z
    .array(criterionReviewSchema)
    .max(200)
    .describe("Exactly one implementation-first review for every criterion assigned to the slice."),
  maintainabilityFindings: z.array(maintainabilityFindingSchema).max(6),
  limitations: z.array(agentLimitationSchema).max(10),
});
export type CodeAnalysis = z.infer<typeof codeAnalysisSchema>;

export const testOnlyAnalysisSchema = z.object({
  assessments: z
    .array(
      z.object({
        criterionId: z.string().min(1).max(100),
        observation: testObservationSchema,
      }),
    )
    .max(200)
    .describe("Exactly one test-only assessment for every criterion assigned to the slice."),
  maintainabilityFindings: z.array(maintainabilityFindingSchema).max(8),
  limitations: z.array(agentLimitationSchema).max(10),
});
export type TestOnlyAnalysis = z.infer<typeof testOnlyAnalysisSchema>;

const coverageRepairFields = {
  criterionId: z.string().min(1).max(100),
  evidence: z
    .array(agentEvidenceSchema)
    .min(1)
    .max(3)
    .describe("Exact implementation evidence for this requested criterion."),
  notes: z.string().min(1).max(1_000),
} as const;

export const coverageRepairSchema = z.object({
  assessments: z
    .array(
      z.discriminatedUnion("outcome", [
        z.object({
          ...coverageRepairFields,
          outcome: z.literal("covered"),
        }),
        z.object({
          ...coverageRepairFields,
          outcome: z.literal("defect"),
          severity: severitySchema,
          category: z.string().min(1).max(100),
          claim: z.string().min(1).max(500),
          confidence: z.number().min(0).max(1),
          suggestedAction: z.string().min(1).max(600),
        }),
      ]),
    )
    .min(1)
    .max(50)
    .describe(
      "Exactly one covered or defect assessment for each requested criterion, and no other criteria.",
    ),
});
export type CoverageRepair = z.infer<typeof coverageRepairSchema>;

export const semanticVerificationSchema = z.object({
  decisions: z
    .array(
      z.object({
        findingId: z.string().max(100),
        confirmed: z.boolean(),
        rationale: z.string().max(600),
        adjustedSeverity: severitySchema,
        adjustedImpact: findingImpactSchema,
        testCoverageStatus: testCoverageStatusSchema
          .nullable()
          .describe("Non-null only for test_coverage impact; classify partial versus missing."),
        confirmedCriterionIds: z
          .array(z.string().min(1).max(100))
          .max(1)
          .describe("Zero or one existing SDD criterion ID specifically violated by the claim."),
      }),
    )
    .max(50),
});
export type SemanticVerification = z.infer<typeof semanticVerificationSchema>;
