import { z } from "zod";
import { attemptSummarySchema, codeSliceSummarySchema, usageSchema } from "./agent-contracts.ts";

export * from "./agent-contracts.ts";

export const providerKindSchema = z.enum(["github", "gitlab"]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const repositoryIdentitySchema = z.object({
  provider: providerKindSchema,
  host: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  remote: z.string().min(1),
  projectId: z.union([z.string(), z.number().int().positive()]).optional(),
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

export const changeRequestSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  draft: z.boolean(),
  headSha: z.string().min(7),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ChangeRequestSummary = z.infer<typeof changeRequestSummarySchema>;

export const changedFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "unknown",
]);

export const changedFileSchema = z.object({
  oldPath: z.string().nullable(),
  path: z.string(),
  status: changedFileStatusSchema,
  patch: z.string().nullable(),
  headContent: z.string().nullable(),
  baseContent: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const changeRequestSnapshotSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  author: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  headSha: z.string().min(7),
  baseSha: z.string().min(7),
  headRepository: z.string().min(1),
  baseRepository: z.string().min(1),
  diff: z.string(),
  files: z.array(changedFileSchema),
});
export type ChangeRequestSnapshot = z.infer<typeof changeRequestSnapshotSchema>;

export const treeEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["blob", "tree"]),
  sha: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});
export type TreeEntry = z.infer<typeof treeEntrySchema>;

export const snapshotFileSchema = z.object({
  path: z.string(),
  revision: z.string(),
  content: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  sha: z.string().optional(),
});
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;

export const featureReferenceSchema = z.object({
  number: z.string().regex(/^\d{3}$/),
  origin: z.enum(["title", "branch", "title_and_branch"]),
  directory: z.string(),
});
export type FeatureReference = z.infer<typeof featureReferenceSchema>;

export const artifactSchema = z.object({
  path: z.string(),
  kind: z.string(),
  revision: z.string(),
  sha: z.string().optional(),
  content: z.string().nullable(),
  status: z.enum(["loaded", "missing", "excluded", "truncated", "binary"]),
  bytes: z.number().int().nonnegative(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const evidenceSchema = z.object({
  revision: z.string().min(7),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof severitySchema>;

export const findingImpactSchema = z.enum(["implementation", "test_coverage", "maintainability"]);
export type FindingImpact = z.infer<typeof findingImpactSchema>;

export const testCoverageStatusSchema = z.enum(["partial", "missing"]);
export type TestCoverageStatus = z.infer<typeof testCoverageStatusSchema>;

export const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  category: z.string().min(1),
  impact: findingImpactSchema.optional(),
  testCoverageStatus: testCoverageStatusSchema.optional(),
  claim: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  confidence: z.number().min(0).max(1),
  suggestedAction: z.string().min(1),
  criterionIds: z.array(z.string()),
  verified: z.boolean(),
});
export type Finding = z.infer<typeof findingSchema>;

export const coverageStatusSchema = z.enum(["covered", "partial", "missing", "not_verifiable"]);
export const coverageDimensionSchema = z.enum(["implementation", "tests"]);
export type CoverageDimension = z.infer<typeof coverageDimensionSchema>;
export const reviewScopeSchema = z.enum(["implementation", "test_only"]);
export type ReviewScope = z.infer<typeof reviewScopeSchema>;

export const reviewCoverageSchema = z.object({
  criterionId: z.string(),
  description: z.string(),
  status: coverageStatusSchema,
  evidence: z.array(evidenceSchema),
  notes: z.string(),
});
export type ReviewCoverage = z.infer<typeof reviewCoverageSchema>;

export const reviewStatusSchema = z.enum([
  "completed",
  "incomplete",
  "stale",
  "cancelled",
  "failed",
]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const verdictSchema = z.enum([
  "RIESGO_BLOQUEANTE",
  "REQUIERE_DECISION",
  "SIN_HALLAZGOS_BLOQUEANTES",
]);
export type Verdict = z.infer<typeof verdictSchema>;

export const reviewReportSchema = z.object({
  schemaVersion: z.enum(["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"]),
  reviewerVersion: z.string().min(1).optional(),
  reviewId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  model: z.string(),
  models: z
    .object({
      explorer: z.string(),
      orchestrator: z.string(),
    })
    .optional(),
  provider: providerKindSchema,
  host: z.string(),
  repository: z.string(),
  root: z.string(),
  changeRequestNumber: z.number().int().positive(),
  changeRequestTitle: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  feature: featureReferenceSchema.nullable(),
  artifacts: z.array(artifactSchema),
  reviewScope: reviewScopeSchema.default("implementation"),
  coverage: z.array(reviewCoverageSchema),
  testCoverage: z.array(reviewCoverageSchema).default([]),
  findings: z.array(findingSchema),
  risks: z.array(z.string()),
  pendingDecisions: z.array(z.string()),
  limitations: z.array(z.string()),
  stagesIncomplete: z.array(z.string()),
  slices: z.array(codeSliceSummarySchema).default([]),
  attemptDiagnostics: z.array(attemptSummarySchema).default([]),
  costEstimate: z
    .object({
      currency: z.literal("USD"),
      amount: z.number().nonnegative(),
      failedAttemptAmount: z.number().nonnegative(),
      pricingVersion: z.string().min(1),
      complete: z.boolean(),
    })
    .optional(),
  status: reviewStatusSchema,
  verdict: verdictSchema,
  usage: usageSchema,
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export const authStatusSchema = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  detail: z.string(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;
