import { describe, expect, test } from "bun:test";
import { type ReviewReport, reviewReportSchema } from "../../src/domain/contracts.ts";
import { escapeHtml, renderReportHtml } from "../../src/report/html-renderer.ts";

const report: ReviewReport = {
  schemaVersion: "1.0",
  reviewScope: "implementation",
  reviewId: "review-1",
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-14T00:00:00.000Z",
  model: "claude-sonnet-5",
  provider: "github",
  host: "github.com",
  repository: "acme/<script>alert(1)</script>",
  root: "C:/repo",
  changeRequestNumber: 7,
  changeRequestTitle: "<img src=x onerror=alert(1)>",
  baseSha: "bbbbbbbbbbbbbbbb",
  headSha: "aaaaaaaaaaaaaaaa",
  feature: { number: "001", origin: "title", directory: "specs/001-auth" },
  artifacts: [],
  coverage: [],
  testCoverage: [],
  findings: [],
  risks: [],
  pendingDecisions: [],
  limitations: [],
  stagesIncomplete: [],
  slices: [],
  attemptDiagnostics: [],
  status: "completed",
  verdict: "SIN_HALLAZGOS_BLOQUEANTES",
  usage: { inputTokens: 10, outputTokens: 5, calls: 2 },
};

describe("HTML report", () => {
  test("escapes every untrusted string", () => {
    expect(escapeHtml(`<script data-x="'">&`)).toBe("&lt;script data-x=&quot;&#39;&quot;&gt;&amp;");
    const html = renderReportHtml(report);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("uses a restrictive CSP and no JavaScript", () => {
    const html = renderReportHtml(report);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("frame-ancestors 'none'");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("keeps legacy 1.0 reports readable with empty diagnostics", () => {
    const {
      slices: _slices,
      attemptDiagnostics: _diagnostics,
      testCoverage: _testCoverage,
      reviewScope: _reviewScope,
      ...legacy
    } = report;
    const parsed = reviewReportSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.slices).toEqual([]);
    expect(parsed.attemptDiagnostics).toEqual([]);
    expect(parsed.testCoverage).toEqual([]);
  });

  test("makes incomplete zero-finding reviews visibly distinct", () => {
    const html = renderReportHtml({
      ...report,
      schemaVersion: "1.1",
      status: "incomplete",
      verdict: "REQUIERE_DECISION",
      stagesIncomplete: ["code_exploration:slice-2"],
      slices: [
        {
          id: "slice-2",
          status: "incomplete",
          failureKind: "refusal",
          attempts: 1,
          inputTokens: 10,
          outputTokens: 5,
          requestIds: ["req_safe123"],
        },
      ],
      attemptDiagnostics: [
        {
          role: "code_explorer",
          sliceId: "slice-2",
          attempt: 1,
          status: "failed",
          failureKind: "refusal",
          stopReason: "refusal",
          requestId: "req_safe123",
          statusCode: null,
          inputTokens: 10,
          outputTokens: 5,
          payloadBytes: 1_000,
          validationPaths: [],
        },
      ],
    });
    expect(html).toContain("0 hallazgos no equivale a 0 defectos");
    expect(html).toContain("slice-2");
    expect(html).toContain("refusal");
    expect(html).toContain("req_safe123");
  });

  test("shows multi-model usage, thinking, cache, and estimated failed-attempt cost", () => {
    const html = renderReportHtml({
      ...report,
      schemaVersion: "1.2",
      models: {
        explorer: "claude-haiku-4-5-20251001",
        orchestrator: "claude-sonnet-5",
      },
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        calls: 2,
        baseInputTokens: 15,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 5,
        thinkingTokens: 3,
      },
      costEstimate: {
        currency: "USD",
        amount: 0.1234,
        failedAttemptAmount: 0.05,
        pricingVersion: "test-pricing",
        complete: true,
      },
    });
    expect(html).toContain("claude-haiku-4-5-20251001 / claude-sonnet-5");
    expect(html).toContain("USD 0.1234");
    expect(html).toContain("USD 0.0500 en intentos fallidos");
    expect(html).toContain("3 thinking");
    expect(html).toContain("5 tokens");
  });

  test("separates implementation and test coverage and exposes the reviewer version", () => {
    const html = renderReportHtml({
      ...report,
      schemaVersion: "1.5",
      reviewerVersion: "0.5.0",
    });
    expect(html).toContain("Cobertura de implementación");
    expect(html).toContain("Cobertura de pruebas");
    expect(html).toContain("0.5.0 / 1.5");
  });

  test("labels test-only reports without presenting implementation as failed", () => {
    const html = renderReportHtml({
      ...report,
      schemaVersion: "1.5",
      reviewScope: "test_only",
      coverage: [
        {
          criterionId: "AC-001",
          description: "Behavior remains outside this change.",
          status: "not_verifiable",
          evidence: [],
          notes: "Implementation is outside the scope of this test-only change.",
        },
      ],
    });
    expect(html).toContain("PR test-only");
    expect(html).toContain("Implementación fuera de alcance");
    expect(html).toContain("Revisión de tests");
  });
});
