# Architecture

SDD PR Reviewer is a local MCP server. Claude Code is the conversational host; the reviewer owns deterministic orchestration and never prompts on a terminal.

```text
Claude Code ──JSON-RPC/stdin+stdout──> MCP tools
                                         │
                         root + provider + immutable SHA
                                         │
                    gh/glab GET calls ────┤
                                         │
                       SDD resolution + bounded snapshot
                                         │
                   isolated Anthropic Messages sessions
                                         │
               deterministic evidence verification + verdict
                                         │
                    structured MCP result + private HTML
```

## Boundaries

- `src/domain` contains provider-agnostic contracts and typed errors.
- `src/security` owns command allowlists, path confinement, secret redaction, budgets, cancellation, and timeouts.
- `src/providers` maps GitHub and GitLab read responses into domain contracts. All content reads use immutable SHAs, including fork/source projects.
- `src/sdd` resolves one exact `specs/NNN-*` directory and loads bounded artifacts.
- `src/review` slices context, orchestrates roles, verifies evidence, and computes a conservative verdict.
- `src/anthropic` opens a fresh Messages API request for every role and validates structured output.
- `src/report` writes escaped, static, expiring HTML outside the repository.
- `src/mcp` adapts application services to three read-only MCP tools. Production `stdout` is owned by its stdio transport.

The domain never imports MCP, Anthropic, or provider CLI response types. The application composes those adapters at the outer boundary.

## Long-running behavior

The MVP call is synchronous and accepts exactly one selection. It uses the MCP cancellation signal, a global deadline, progress notifications when supported, at most two concurrent Anthropic requests, and a maximum of eight model calls. A future job/task transport can wrap the same coordinator without changing domain contracts.
