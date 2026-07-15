# SDD PR Reviewer

Local, read-only MCP server that reviews one GitHub pull request or GitLab merge request against its SDD feature artifacts. It retrieves an immutable remote snapshot, delegates bounded analysis to isolated Anthropic sessions, verifies evidence deterministically, and writes a private self-contained HTML report outside the reviewed repository.

Structured agent failures are isolated per code slice. Completed slices and SDD criteria remain in
the report, while truncation, refusal, schema, API, or budget failures are represented only by safe
diagnostic metadata and force an incomplete, non-green result.

Implementation coverage and test coverage are computed and reported separately. Verified
implementation findings deterministically mark their affected SDD criteria as missing, even when
an exploratory coverage row claimed otherwise. SDD artifacts are analyzed only by the SDD role and
are excluded from code slices.

Contractual findings are criterion-specific: one finding can reference at most one SDD criterion.
Test-coverage findings are capped at `medium`, maintainability findings at `low`, and only verified
implementation findings can block. When a completed explorer omits required implementation
criteria, the pipeline may issue one bounded, implementation-only coverage repair before the
deterministic final projection.
Contractual finding IDs are derived from immutable revision, impact, and criterion rather than
model wording. Test findings distinguish partial assertions from complete absence of assertions.
Assertion-bearing evidence deterministically prevents a confirmed test gap from being classified
as completely missing. Ambiguous or conflicting implementation coverage is never promoted to
covered; it is repaired once through a criterion-keyed `covered`/`defect` contract.
Only blocking implementation candidates and ambiguous contractual maintainability claims reach
the Sonnet semantic verifier. Risks and SDD-conflict decisions are projected locally, removing the
final model synthesis call; a normal review with repair therefore uses at most five calls.
Test slices use a compact criterion-keyed contract that binds `covered`, `partial`, `missing`, or
`not_verifiable` to its evidence and, for gaps, its finding metadata. An accepted repair supersedes
only earlier ambiguous assessments for the criteria it explicitly repaired.

Partial implementation coverage requires a matching verified defect or an objectively
incomplete/conflicting slice; test coverage remains partial unless its complete assertions are
directly supported. Test visibility cannot downgrade implementation coverage. Expected slice isolation and
missing optional root artifacts stay out of global limitations, while Tech Lead decisions come
only from extracted SDD conflicts.

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

The default model routing uses `claude-haiku-4-5-20251001` for SDD and code exploration, and
`claude-sonnet-5` at medium effort for semantic verification and orchestration. Override the roles
independently with `SDD_REVIEWER_EXPLORER_MODEL`, `SDD_REVIEWER_ORCHESTRATOR_MODEL`, and
`SDD_REVIEWER_ORCHESTRATOR_EFFORT`. The legacy `SDD_REVIEWER_MODEL` remains a compatibility
override for every role.

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
