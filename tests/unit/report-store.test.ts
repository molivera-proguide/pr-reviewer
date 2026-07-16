import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewReport } from "../../src/domain/contracts.ts";
import { NullLogger } from "../../src/observability/logger.ts";
import { ReportStore } from "../../src/report/report-store.ts";
import { FakeCommandExecutor, NEVER_ABORTED } from "../helpers/fakes.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const report: ReviewReport = {
  schemaVersion: "1.0",
  reviewScope: "implementation",
  reviewId: "review-ttl",
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-14T00:00:00.000Z",
  model: "claude-sonnet-5",
  provider: "github",
  host: "github.com",
  repository: "acme/repo",
  root: "C:/repo",
  changeRequestNumber: 9,
  changeRequestTitle: "feat(001): report",
  baseSha: "bbbbbbbbbbbbbbbb",
  headSha: "aaaaaaaaaaaaaaaa",
  feature: { number: "001", origin: "title", directory: "specs/001-report" },
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
  usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
};

describe("report store", () => {
  test("writes outside the repository and deletes only expired HTML", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdd-reviewer-reports-"));
    temporaryPaths.push(root);
    const runner = new FakeCommandExecutor(() => ({ exitCode: 0 }));
    const store = new ReportStore(runner, new NullLogger(), root);
    const reportPath = await store.write(report, NEVER_ABORTED, false);
    expect(reportPath.startsWith(root)).toBeTrue();
    expect(await readFile(reportPath, "utf8")).toContain("default-src 'none'");
    expect(runner.requests).toHaveLength(0);

    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(reportPath, old, old);
    await expect(store.cleanupExpired(24, NEVER_ABORTED)).resolves.toBe(1);
    await expect(access(reportPath)).rejects.toBeDefined();
  });
});
