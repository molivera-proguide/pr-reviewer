import { describe, expect, test } from "bun:test";
import type {
  AgentRequest,
  AgentResponse,
  StructuredAgentClient,
} from "../../src/anthropic/agent-client.ts";
import type { ChangeRequestSnapshot } from "../../src/domain/contracts.ts";
import { buildReviewContext } from "../../src/review/context-builder.ts";
import { runReviewPipeline } from "../../src/review/pipeline.ts";
import { calculateVerdict } from "../../src/review/verdict.ts";
import { UsageBudget } from "../../src/security/budget.ts";

const headSha = "aaaaaaaaaaaaaaaa";
const baseSha = "bbbbbbbbbbbbbbbb";

class FakeAgentClient implements StructuredAgentClient {
  readonly codePayloads: unknown[] = [];

  constructor(private readonly budget: UsageBudget) {}

  async run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>> {
    if (request.role === "code_explorer") this.codePayloads.push(request.payload);
    const reservationId = this.budget.reserveCall(request.maxTokens);
    this.budget.recordUsage(100, 50, reservationId);
    const evidence = {
      revision: headSha,
      path: "src/authorize.ts",
      startLine: 2,
      endLine: 2,
      excerpt: "return true;",
    };
    const values = {
      sdd_explorer: {
        objectives: ["Enforce authorization"],
        criteria: [
          {
            id: "AC-001",
            description: "Deny unauthorized users",
            required: true,
            sourcePath: "specs/001-auth/spec.md",
          },
        ],
        constraints: [],
        tasks: ["Implement authorization"],
        decisions: [],
        conflicts: [],
        sddApproved: true,
      },
      code_explorer: {
        findings: [
          {
            id: "F-001",
            severity: "high",
            category: "authorization",
            impact: "implementation",
            claim: "The implementation authorizes every caller.",
            evidence: [evidence],
            confidence: 0.99,
            suggestedAction: "Check the caller policy before returning true.",
            criterionIds: ["AC-001"],
          },
        ],
        coverage: [
          {
            criterionId: "AC-001",
            dimension: "implementation",
            description: "Deny unauthorized users",
            status: "covered",
            evidence: [evidence],
            notes: "Always allows.",
          },
        ],
        limitations: [],
      },
      semantic_verifier: {
        decisions: [
          {
            findingId:
              (request.payload as { findings?: { id: string }[] }).findings?.[0]?.id ?? "F-001",
            confirmed: true,
            rationale: "The cited implementation unconditionally returns true.",
            adjustedSeverity: "high",
            adjustedImpact: "implementation",
            testCoverageStatus: null,
            confirmedCriterionIds: ["AC-001"],
          },
        ],
      },
      synthesizer: {
        coverage: [
          {
            criterionId: "AC-001",
            description: "Deny unauthorized users",
            status: "missing",
            evidence: [evidence],
            notes: "The required denial path is absent.",
          },
        ],
        risks: ["Authorization bypass"],
        pendingDecisions: [],
      },
    } as const;
    return {
      data: request.schema.parse(values[request.role]),
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        baseInputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        thinkingTokens: 0,
      },
      requestId: `fake-${request.role}`,
      diagnostics: [
        {
          role: request.role,
          ...(request.sliceId === undefined ? {} : { sliceId: request.sliceId }),
          attempt: 1,
          status: "completed",
          stopReason: "end_turn",
          requestId: `fake-${request.role}`,
          statusCode: null,
          inputTokens: 100,
          outputTokens: 50,
          payloadBytes: 1_000,
          validationPaths: [],
        },
      ],
    };
  }
}

describe("complete review pipeline", () => {
  test("produces a deterministically verified blocking result without external access", async () => {
    const snapshot: ChangeRequestSnapshot = {
      number: 1,
      title: "feat(001): authorization",
      description: "",
      author: "dev",
      sourceBranch: "feature/001-auth",
      targetBranch: "main",
      headSha,
      baseSha,
      headRepository: "acme/repo",
      baseRepository: "acme/repo",
      diff: "@@\n+return true;",
      files: [
        {
          oldPath: "src/authorize.ts",
          path: "src/authorize.ts",
          status: "modified",
          patch: "@@\n+return true;",
          headContent: "export function authorize() {\n  return true;\n}\n",
          baseContent: null,
          binary: false,
          truncated: false,
          additions: 1,
          deletions: 0,
        },
        {
          oldPath: "specs/001-auth/spec.md",
          path: "specs/001-auth/spec.md",
          status: "modified",
          patch: "+approved",
          headContent: "AC-001: Deny unauthorized users\n/sdd-review APROBADO",
          baseContent: null,
          binary: false,
          truncated: false,
          additions: 1,
          deletions: 0,
        },
      ],
    };
    const context = buildReviewContext(
      snapshot,
      { number: "001", origin: "title_and_branch", directory: "specs/001-auth" },
      [
        {
          path: "specs/001-auth/spec.md",
          kind: "spec",
          revision: headSha,
          content: "AC-001: Deny unauthorized users\n/sdd-review APROBADO",
          status: "loaded",
          bytes: 60,
        },
      ],
    );
    const budget = new UsageBudget({
      maxCalls: 8,
      maxOutputTokens: 40_000,
      deadlineMs: 60_000,
    });
    const client = new FakeAgentClient(budget);
    const result = await runReviewPipeline({
      context,
      client,
      budget,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verified).toBeTrue();
    expect(result.findings[0]?.id).toMatch(/^finding-[a-f0-9]{16}$/);
    expect(result.coverage[0]?.status).toBe("missing");
    expect(result.testCoverage[0]?.status).toBe("not_verifiable");
    const codePayload = client.codePayloads[0] as {
      slice: { files: { path: string }[] };
      changedFileInventory: { path: string }[];
    };
    expect(codePayload.slice.files.map((file) => file.path)).toEqual(["src/authorize.ts"]);
    expect(codePayload.changedFileInventory.map((file) => file.path)).toEqual(["src/authorize.ts"]);
    expect(result.usage.calls).toBe(3);
    expect(result.slices).toEqual([
      expect.objectContaining({ id: "slice-1", status: "completed", attempts: 1 }),
    ]);
    expect(
      calculateVerdict({
        status: result.status,
        findings: result.findings,
        pendingDecisions: result.pendingDecisions,
        sddApproved: result.sdd.sddApproved,
      }),
    ).toBe("RIESGO_BLOQUEANTE");
  });
});
