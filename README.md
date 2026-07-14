# SDD PR Reviewer

Local, read-only MCP server that reviews one GitHub pull request or GitLab merge request against its SDD feature artifacts. It retrieves an immutable remote snapshot, delegates bounded analysis to isolated Anthropic sessions, verifies evidence deterministically, and writes a private self-contained HTML report outside the reviewed repository.

## Requirements

- The compiled binary, or Bun 1.3+ for development.
- `git` plus the authenticated provider CLI (`gh` or `glab`).
- A corporate `ANTHROPIC_API_KEY` injected into the MCP process environment.

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
pr-reviewer install-claude-skill
pr-reviewer doctor --repository-path <path>
pr-reviewer mcp
```

## Claude Code setup

Install the bundled personal skill. It is embedded in the binary and is written to
`~/.claude/skills/pr-reviewer/SKILL.md` (or under `CLAUDE_CONFIG_DIR`):

```bash
pr-reviewer install-claude-skill
```

The skill is available across projects as `/pr-reviewer` and teaches Claude to diagnose the
server, display immutable PR/MR HEAD SHAs, require explicit Tech Lead selection, and interpret
non-green outcomes safely.

Register the MCP server at user scope:

```powershell
claude mcp add --scope user pr-reviewer `
  --env ANTHROPIC_API_KEY=your_api_key `
  -- pr-reviewer mcp
```

Equivalent JSON configuration:

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

Start a review with `/pr-reviewer`, or ask Claude to review a PR/MR against its SDD artifacts.

Do not place `ANTHROPIC_API_KEY` in a versioned configuration file. The bundled skill contains
static workflow instructions only and never contains credentials. See
[distribution](docs/distribution.md) and the [security model](docs/security-model.md).
