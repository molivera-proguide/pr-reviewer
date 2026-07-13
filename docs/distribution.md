# Build and distribution

## Local artifact

```bash
bun install --frozen-lockfile
bun run check
```

`bun run build` compiles the current platform into `dist/pr-reviewer[.exe]`. `bun run verify:artifact` executes the standalone binary without invoking Bun, verifies `pr-reviewer --version`, and writes a SHA-256 sidecar.

Cross-compilation is available through the build script:

```bash
bun scripts/build.ts --target bun-windows-x64 --outfile dist/pr-reviewer-windows-x64.exe
bun scripts/build.ts --target bun-linux-x64-baseline --outfile dist/pr-reviewer-linux-x64
bun scripts/build.ts --target bun-darwin-arm64 --outfile dist/pr-reviewer-darwin-arm64
```

Release automation must publish the binary, SHA-256, dependency inventory/SBOM, changelog, and these installation instructions. Platform smoke tests should run on their native OS even when artifacts are cross-compiled.

## MCP registration

```json
{
  "mcpServers": {
    "sdd-pr-reviewer": {
      "type": "stdio",
      "command": "C:/tools/pr-reviewer.exe",
      "args": ["mcp"]
    }
  }
}
```

Inject `ANTHROPIC_API_KEY` through the managed process environment and keep it out of versioned JSON. Run `pr-reviewer doctor --repository-path <path>` from the same managed environment to diagnose credential stripping, provider authentication, paths, and report storage without displaying secrets.
