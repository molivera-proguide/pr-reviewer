# Specification

## User story

As a Tech Lead using Claude Code, I can list open PRs/MRs, explicitly select one displayed HEAD SHA, and receive a private SDD-aware review without changing local or remote repository state.

## Acceptance criteria

- AC-001: The compiled stdio server exposes `reviewer_doctor`, `list_open_change_requests`, and `review_change_requests` with validated structured contracts.
- AC-002: GitHub and GitLab list open changes and retrieve metadata, diffs, renames, forks/source projects, and file content exclusively through read operations addressed by SHA.
- AC-003: Review input contains exactly one selection, explicit TL confirmation, and the expected HEAD SHA; changed HEADs return `stale`.
- AC-004: The reviewer resolves exactly one `specs/NNN-*` directory from title/branch and remote HEAD or stops with an explicit traceability error.
- AC-005: Isolated Anthropic roles receive no shell, write access, or Claude Code conversation history; structured outputs get one repair attempt.
- AC-006: Every retained material finding has deterministically valid path, SHA, line range, and matching excerpt.
- AC-007: Budget, timeout, truncation, missing mandatory roles, cancellation, and stale state cannot result in `SIN_HALLAZGOS_BLOQUEANTES`.
- AC-008: The HTML report is escaped, static, CSP-constrained, stored outside the repository, user-private where supported, and expires after 24 hours.
- AC-009: In MCP mode no application output contaminates `stdout`; progress and cancellation follow protocol capabilities.
- AC-010: Unit, provider contract, MCP integration, security, E2E pipeline, typecheck, lint, compiled build, and artifact smoke gates pass.

## Out of scope

Comments, approvals, rejections, merges, commits, checkout/fetch, execution of reviewed code, CI integration, concurrent multi-PR reviews, remote MCP transport, and arbitrary agent tools.

/sdd-review APROBADO
