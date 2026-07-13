import { ReviewerError } from "../domain/errors.ts";

export interface CliArguments {
  readonly command: "mcp" | "doctor" | "version";
  readonly repositoryPath?: string;
}

export function parseArguments(args: readonly string[]): CliArguments {
  const firstArgument = args[0] ?? "mcp";
  const command = firstArgument === "--version" ? "version" : firstArgument;
  if (command !== "mcp" && command !== "doctor" && command !== "version") {
    throw new ReviewerError("INVALID_INPUT", `Unknown command: ${command}`);
  }
  let repositoryPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--repository-path") {
      repositoryPath = args[index + 1];
      index += 1;
      if (repositoryPath === undefined) {
        throw new ReviewerError("INVALID_INPUT", "--repository-path requires a value.");
      }
      continue;
    }
    throw new ReviewerError("INVALID_INPUT", `Unknown argument: ${value ?? "<empty>"}`);
  }
  return {
    command,
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
  };
}
