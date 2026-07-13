import { describe, expect, test } from "bun:test";
import type { ReviewReport } from "../../src/domain/contracts.ts";
import { escapeHtml, renderReportHtml } from "../../src/report/html-renderer.ts";

const report: ReviewReport = {
  schemaVersion: "1.0",
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
  findings: [],
  risks: [],
  pendingDecisions: [],
  limitations: [],
  stagesIncomplete: [],
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
});
