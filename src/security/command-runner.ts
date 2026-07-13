import { ReviewerError } from "../domain/errors.ts";
import { redactSecrets } from "./redaction.ts";

export type AllowedExecutable = "git" | "gh" | "glab" | "explorer" | "open" | "xdg-open";

export interface CommandRequest {
  readonly executable: AllowedExecutable;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly throwOnNonZero?: boolean;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CommandExecutor {
  run(request: CommandRequest): Promise<CommandResult>;
}

const GIT_OPERATIONS = new Set(["--version", "remote", "rev-parse", "status"]);
const GH_OPERATIONS = new Set(["--version", "auth", "repo", "pr", "api"]);
const GLAB_OPERATIONS = new Set(["--version", "auth", "repo", "mr", "api"]);

function assertAllowedSubcommand(
  executable: string,
  operation: string,
  subcommand: string | undefined,
  allowed: readonly (string | undefined)[],
): void {
  if (!allowed.includes(subcommand)) {
    throw new ReviewerError(
      "INVALID_INPUT",
      `Disallowed ${executable} operation: ${operation} ${subcommand ?? "<none>"}`,
    );
  }
}

function assertReadOnlyCommand(executable: AllowedExecutable, args: readonly string[]): void {
  const operation = args[0];
  if (operation === undefined && !["open", "xdg-open", "explorer"].includes(executable)) {
    throw new ReviewerError("INVALID_INPUT", "A command operation is required.");
  }
  if (executable === "git" && !GIT_OPERATIONS.has(operation ?? "")) {
    throw new ReviewerError("INVALID_INPUT", `Disallowed git operation: ${operation ?? "<none>"}`);
  }
  if (executable === "gh" && !GH_OPERATIONS.has(operation ?? "")) {
    throw new ReviewerError("INVALID_INPUT", `Disallowed gh operation: ${operation ?? "<none>"}`);
  }
  if (executable === "glab" && !GLAB_OPERATIONS.has(operation ?? "")) {
    throw new ReviewerError("INVALID_INPUT", `Disallowed glab operation: ${operation ?? "<none>"}`);
  }
  if (executable === "git" && operation === "remote") {
    assertAllowedSubcommand("git", "remote", args[1], [undefined, "get-url"]);
  }
  if (executable === "gh" && operation === "auth") {
    assertAllowedSubcommand("gh", "auth", args[1], ["status"]);
  }
  if (executable === "gh" && operation === "repo") {
    assertAllowedSubcommand("gh", "repo", args[1], ["view"]);
  }
  if (executable === "gh" && operation === "pr") {
    assertAllowedSubcommand("gh", "pr", args[1], ["list", "view", "diff"]);
  }
  if (executable === "glab" && operation === "auth") {
    assertAllowedSubcommand("glab", "auth", args[1], ["status"]);
  }
  if (executable === "glab" && operation === "repo") {
    assertAllowedSubcommand("glab", "repo", args[1], ["view"]);
  }
  if (executable === "glab" && operation === "mr") {
    assertAllowedSubcommand("glab", "mr", args[1], ["list", "view", "diff"]);
  }
  if ((executable === "gh" || executable === "glab") && operation === "api") {
    const methodIndex = args.findIndex((arg) => arg === "--method" || arg === "-X");
    const method = methodIndex >= 0 ? args[methodIndex + 1]?.toUpperCase() : "GET";
    if (method !== "GET") {
      throw new ReviewerError("INVALID_INPUT", `Only GET provider API operations are allowed.`);
    }
    if (args.some((arg) => arg === "-f" || arg === "-F" || arg.startsWith("--field"))) {
      throw new ReviewerError("INVALID_INPUT", "Provider API request fields are not allowed.");
    }
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      total += item.value.byteLength;
      if (total > maxBytes) {
        onLimit();
        throw new ReviewerError(
          "CONTENT_LIMIT_EXCEEDED",
          "Command output exceeded its byte limit.",
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

export class CommandRunner implements CommandExecutor {
  async run(request: CommandRequest): Promise<CommandResult> {
    assertReadOnlyCommand(request.executable, request.args);
    const executable = Bun.which(request.executable);
    if (executable === null) {
      return this.handleUnavailable(request);
    }
    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? 30_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);
    const processHandle = Bun.spawn([executable, ...request.args], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
      env: process.env,
      windowsHide: true,
    });
    const maxBytes = request.maxOutputBytes ?? 8 * 1024 * 1024;
    const terminate = () => processHandle.kill();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readLimited(processHandle.stdout, maxBytes, terminate),
        readLimited(processHandle.stderr, Math.min(maxBytes, 512 * 1024), terminate),
        processHandle.exited,
      ]);
      const result = {
        exitCode,
        stdout,
        stderr: redactSecrets(stderr),
        durationMs: Date.now() - startedAt,
      };
      if (exitCode !== 0 && (request.throwOnNonZero ?? true)) {
        throw new ReviewerError(
          "COMMAND_FAILED",
          `${request.executable} command failed with exit code ${exitCode}: ${result.stderr.slice(0, 1_000)}`,
          { executable: request.executable, exitCode },
        );
      }
      return result;
    } catch (error) {
      processHandle.kill();
      if (timeoutSignal.aborted) {
        throw new ReviewerError("TIMEOUT", `${request.executable} command timed out.`);
      }
      if (request.signal.aborted) {
        throw new ReviewerError("CANCELLED", `${request.executable} command was cancelled.`);
      }
      throw error;
    }
  }

  private handleUnavailable(request: CommandRequest): CommandResult {
    const result = {
      exitCode: 127,
      stdout: "",
      stderr: `${request.executable} is not installed or is not on PATH.`,
      durationMs: 0,
    };
    if (request.throwOnNonZero ?? true) {
      throw new ReviewerError("COMMAND_FAILED", result.stderr, {
        executable: request.executable,
        exitCode: result.exitCode,
      });
    }
    return result;
  }
}
