import { mkdir } from "node:fs/promises";
import { join } from "node:path";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const target = argument("--target");
const outputArgument = argument("--outfile");
const windows = target?.includes("windows") ?? process.platform === "win32";
const output = outputArgument ?? join("dist", `pr-reviewer${windows ? ".exe" : ""}`);
await mkdir("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  minify: true,
  sourcemap: "none",
  compile:
    target === undefined
      ? { outfile: output, autoloadDotenv: false }
      : {
          target: target as Bun.Build.CompileTarget,
          outfile: output,
          autoloadDotenv: false,
        },
});

if (!result.success) {
  for (const message of result.logs) {
    Bun.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
} else {
  Bun.stdout.write(`${output}\n`);
}
