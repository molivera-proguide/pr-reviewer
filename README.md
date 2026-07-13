# SDD PR Reviewer

Local, read-only MCP server that reviews one GitHub pull request or GitLab merge request against its SDD feature artifacts. It retrieves an immutable remote snapshot, delegates bounded analysis to isolated Anthropic sessions, verifies evidence deterministically, and writes a private self-contained HTML report outside the reviewed repository.

## Requirements

- The compiled binary, or Bun 1.3+ for development.
- `git` plus the authenticated provider CLI (`gh` or `glab`).
- A corporate `ANTHROPIC_API_KEY` in the process environment.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run test:integration
bun run build
```

Run diagnostics with `bun run doctor -- --repository-path <path>`, or start the MCP transport with `bun run mcp`. The MCP process writes protocol frames only to `stdout`; operational diagnostics use `stderr`. Automatic `.env` loading is disabled; inject credentials through the managed process environment.

The standalone CLI is named `pr-reviewer`:

```bash
pr-reviewer --version
pr-reviewer doctor --repository-path <path>
pr-reviewer mcp
```

## Claude Code configuration

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

Do not place `ANTHROPIC_API_KEY` in a versioned configuration file. See [distribution](docs/distribution.md) and the [security model](docs/security-model.md).
