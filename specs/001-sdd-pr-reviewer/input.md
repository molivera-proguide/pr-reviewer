# Input: SDD PR Reviewer

Build the independent `pr-reviewer` product described by `PLAN_IMPLEMENTACION.md`: a local, read-only MCP server that lists GitHub PRs/GitLab MRs, reviews exactly one explicit Tech Lead selection against one exact SDD feature, validates evidence, and returns a bounded summary plus private expiring HTML.

Hard constraints: TypeScript strict, Bun, MCP stdio, official `gh`/`glab`, corporate `ANTHROPIC_API_KEY`, immutable SHA reads, isolated agents, no repository/provider writes, no execution of reviewed code, and no false-green incomplete results.
