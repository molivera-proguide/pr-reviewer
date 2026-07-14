# Build and distribution

## Local artifact

```bash
bun install --frozen-lockfile
bun run check
```

`bun run build` compiles the current platform into `dist/pr-reviewer[.exe]`. `bun run verify:artifact` executes the standalone binary without invoking Bun, verifies `pr-reviewer --version`, and writes a SHA-256 sidecar.

The Claude Code skill is embedded into every compiled binary. Install or update it independently
with `pr-reviewer install-claude-skill`. The command refuses to replace an unrelated personal skill
unless `--force` is explicitly supplied.

On Windows, the user installer copies the binary to `%LOCALAPPDATA%\Programs\pr-reviewer`, adds
that directory to the user `PATH`, and installs the embedded Claude skill:

```powershell
bun run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```

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
    "pr-reviewer": {
      "type": "stdio",
      "command": "pr-reviewer",
      "args": ["mcp"]
    }
  }
}
```

For Claude Code, install both pieces and register the MCP process:

```powershell
pr-reviewer install-claude-skill
claude mcp add --scope user pr-reviewer `
  --env ANTHROPIC_API_KEY=your_api_key `
  -- pr-reviewer mcp
```

Inject `ANTHROPIC_API_KEY` through the managed process environment and keep it out of versioned
JSON. Run diagnostics through the registered MCP server so it receives the same environment.
