import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { APP_VERSION, CLI_NAME } from "../src/version.ts";

function artifactArgument(): string {
  const explicit = process.argv[2];
  if (explicit !== undefined) return explicit;
  return join("dist", `pr-reviewer${process.platform === "win32" ? ".exe" : ""}`);
}

const artifact = resolve(artifactArgument());
await access(artifact);
const processHandle = Bun.spawn([artifact, "--version"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  windowsHide: true,
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(processHandle.stdout).text(),
  new Response(processHandle.stderr).text(),
  processHandle.exited,
]);
const expected = `${CLI_NAME} ${APP_VERSION}`;
if (exitCode !== 0 || stdout.trim() !== expected) {
  Bun.stderr.write(
    `Artifact smoke test failed: exit=${exitCode}, stdout=${JSON.stringify(stdout.trim())}, stderr=${JSON.stringify(stderr.trim())}\n`,
  );
  process.exitCode = 1;
} else {
  const temporaryState = await mkdtemp(join(tmpdir(), "sdd-reviewer-artifact-"));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      LOCALAPPDATA: temporaryState,
      XDG_STATE_HOME: temporaryState,
      HOME: temporaryState,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.ANTHROPIC_API_KEY;
  const fakeDotenvKey = ["sk", "ant", "must", "not", "be", "autoloaded"].join("-");
  await Bun.write(join(temporaryState, ".env"), `ANTHROPIC_API_KEY=${fakeDotenvKey}\n`);
  const doctor = Bun.spawn([artifact, "doctor"], {
    cwd: temporaryState,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [doctorOutput] = await Promise.all([
    new Response(doctor.stdout).text(),
    new Response(doctor.stderr).text(),
    doctor.exited,
  ]);
  const doctorResult = JSON.parse(doctorOutput) as {
    checks?: { name?: string; status?: string }[];
  };
  const keyCheck = doctorResult.checks?.find((check) => check.name === "anthropic_api_key");
  if (keyCheck?.status !== "error") {
    throw new Error("Compiled artifact loaded ANTHROPIC_API_KEY from a local .env file.");
  }
  const transport = new StdioClientTransport({
    command: artifact,
    args: ["mcp"],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "artifact-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    const expectedNames = [
      "list_open_change_requests",
      "review_change_requests",
      "reviewer_doctor",
    ];
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error(`Compiled MCP tool list mismatch: ${JSON.stringify(names)}`);
    }
  } finally {
    await client.close();
    await rm(temporaryState, { recursive: true, force: true });
  }
  const bytes = await Bun.file(artifact).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const sha256 = hasher.digest("hex");
  await Bun.write(`${artifact}.sha256`, `${sha256}  ${artifact.split(/[\\/]/).at(-1)}\n`);
  Bun.stdout.write(`${expected}\nSHA-256 ${sha256}\n`);
}
