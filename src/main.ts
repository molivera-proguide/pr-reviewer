#!/usr/bin/env -S bun --no-env-file
import { ReviewerService } from "./application/reviewer-service.ts";
import { parseArguments } from "./cli/arguments.ts";
import { loadConfig } from "./config/config.ts";
import { toReviewerError } from "./domain/errors.ts";
import { startMcpServer } from "./mcp/server.ts";
import { StderrLogger } from "./observability/logger.ts";
import { CommandRunner } from "./security/command-runner.ts";
import { APP_VERSION, CLI_NAME } from "./version.ts";

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "version") {
    Bun.stdout.write(`${CLI_NAME} ${APP_VERSION}\n`);
    return;
  }
  const config = loadConfig();
  const logger = new StderrLogger(config.debug);
  const runner = new CommandRunner();
  const service = new ReviewerService(config, runner, logger);
  if (args.command === "doctor") {
    const result = await service.doctor(
      args.repositoryPath === undefined ? {} : { repositoryPath: args.repositoryPath },
      AbortSignal.timeout(60_000),
    );
    Bun.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.overall === "error") process.exitCode = 1;
    return;
  }
  await startMcpServer(service, config, logger);
}

try {
  await main();
} catch (error) {
  const reviewerError = toReviewerError(error);
  Bun.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "process_failed",
      code: reviewerError.code,
      message: reviewerError.message,
    })}\n`,
  );
  process.exitCode = 1;
}
