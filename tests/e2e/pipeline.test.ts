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
  constructor(private readonly budget: UsageBudget) {}

  async run<T>(request: AgentRequest<T>): Promise<AgentResponse<T>> {
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
            description: "Deny unauthorized users",
            status: "missing",
            evidence: [evidence],
            notes: "Always allows.",
          },
        ],
        limitations: [],
      },
      semantic_verifier: {
        decisions: [
          {
            findingId: "F-001",
            confirmed: true,
            rationale: "The cited implementation unconditionally returns true.",
            adjustedSeverity: "high",
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
      usage: { inputTokens: 100, outputTokens: 50 },
      requestId: `fake-${request.role}`,
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
    const result = await runReviewPipeline({
      context,
      client: new FakeAgentClient(budget),
      budget,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verified).toBeTrue();
    expect(result.usage.calls).toBe(4);
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
