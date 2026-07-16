import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerService } from "../../src/application/reviewer-service.ts";
import { loadConfig } from "../../src/config/config.ts";
import { NullLogger } from "../../src/observability/logger.ts";
import type { RepositoryProvider } from "../../src/providers/provider.ts";
import { ReportStore } from "../../src/report/report-store.ts";
import { FakeCommandExecutor, NEVER_ABORTED } from "../helpers/fakes.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("reviewer service dependency injection", () => {
  test("uses the injected provider factory in the doctor flow", async () => {
    const reportRoot = await mkdtemp(join(tmpdir(), "reviewer-doctor-"));
    temporaryPaths.push(reportRoot);
    const runner = new FakeCommandExecutor((request) => ({
      stdout: `${request.executable} test-version`,
    }));
    const logger = new NullLogger();
    const reports = new ReportStore(runner, logger, reportRoot);
    const provider: RepositoryProvider = {
      kind: "github",
      async checkAuthentication() {
        return { available: true, authenticated: true, detail: "Authenticated." };
      },
      async identifyRepository() {
        return {
          provider: "github",
          host: "github.example.test",
          owner: "acme",
          name: "reviewer",
          remote: "git@github.example.test:acme/reviewer.git",
        };
      },
      async listOpenChangeRequests() {
        return [];
      },
      async getChangeRequest() {
        throw new Error("not called");
      },
      async getCurrentHeadSha() {
        throw new Error("not called");
      },
      async listTree() {
        return [];
      },
      async readTextFile() {
        throw new Error("not called");
      },
    };
    let factoryCalls = 0;
    const service = new ReviewerService(
      loadConfig({ ANTHROPIC_API_KEY: "test-key" }),
      runner,
      logger,
      reports,
      {
        createProvider: async () => {
          factoryCalls += 1;
          return provider;
        },
      },
    );

    const result = await service.doctor(
      { repositoryPath: process.cwd(), clientRoots: [process.cwd()] },
      NEVER_ABORTED,
    );

    expect(factoryCalls).toBe(1);
    expect(result.provider).toBe("github");
    expect(result.repository).toBe("acme/reviewer");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "github_authentication", status: "ok" }),
    );
  });
});
