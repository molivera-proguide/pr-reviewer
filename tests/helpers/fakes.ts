import type {
  CommandExecutor,
  CommandRequest,
  CommandResult,
} from "../../src/security/command-runner.ts";

export class FakeCommandExecutor implements CommandExecutor {
  readonly requests: CommandRequest[] = [];

  constructor(
    private readonly handler: (
      request: CommandRequest,
    ) => Partial<CommandResult> | Promise<Partial<CommandResult>>,
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const result = await this.handler(request);
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: result.durationMs ?? 1,
    };
  }
}

export const NEVER_ABORTED = new AbortController().signal;
