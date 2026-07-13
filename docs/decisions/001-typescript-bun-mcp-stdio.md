# ADR 001: TypeScript, Bun, and local MCP stdio

- Status: accepted
- Date: 2026-07-13

## Context

The reviewer must be a portable local executable used by Claude Code, with strict contracts, bounded child processes, and no remote server administration. The same codebase needs a package manager, tests, type checking, and standalone artifacts.

## Decision

Use strict TypeScript with Bun as runtime, package manager, test runner, and standalone compiler. Expose the product through Model Context Protocol over local `stdio`, using the stable `@modelcontextprotocol/sdk` v1 line. Use official Anthropic, GitHub CLI, and GitLab CLI boundaries.

`stdout` is protocol-only in MCP mode. All diagnostics use the single redacted `stderr` logger. The domain remains independent from SDK and CLI response types.

## Consequences

- One toolchain covers development and distribution.
- Claude Code can supervise explicit TL selection without a second interactive UI.
- Platform artifacts require native smoke testing because compiled Bun behavior may differ from source execution.
- Long reviews remain synchronous in the MVP; MCP Tasks/jobs are deferred until stable support is available.
- SDK versions are pinned and upgrades require contract/conformance tests.
