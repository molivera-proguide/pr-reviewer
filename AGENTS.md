# Local development rules

- Keep the reviewer strictly read-only with respect to repositories and providers.
- Never add shell execution. Child processes must use argument arrays and the command allowlist.
- `stdout` belongs exclusively to MCP while running `mcp`; diagnostics go through the logger on `stderr`.
- Never persist or log API keys, prompts, repository contents, provider response bodies, or complete model outputs.
- Snapshot reads must use immutable SHAs. Do not add checkout, fetch, install, test, build, hook, commit, comment, approval, merge, or write endpoints.
- Every untrusted boundary is validated with Zod. Domain modules do not import MCP, Anthropic, GitHub, or GitLab SDK details.
- Preserve cancellation, byte budgets, token budgets, and path confinement in every new flow.
- An incomplete, cancelled, stale, or failed review can never receive a green verdict.
- Run `bun run typecheck`, `bun run lint`, and the relevant tests before considering a change complete.
