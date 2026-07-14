# Security model

## Assets

- Corporate Anthropic credentials.
- Private source code and SDD artifacts.
- Integrity of the local worktree, Git metadata, and remote PR/MR.
- Trustworthiness of evidence and verdicts.
- Private local reports.

## Adversaries and untrusted inputs

Repository files, diffs, comments, titles, branch names, SDD artifacts, provider responses, and model outputs are untrusted. A malicious change may contain prompt injection, shell syntax, traversal paths, secrets, oversized payloads, invalid UTF-8, HTML, or invented citations.

## Invariants

1. Provider operations are GET/read-only and constructed by adapters, never by a model.
2. `Bun.spawn` receives argument arrays; no shell is used.
3. Only allowlisted Git/CLI operations can run. Fetch, checkout, install, test, build, hooks, comments, approvals, merge, and write APIs are rejected.
4. Snapshot data is addressed by base/HEAD SHA; mutable branch names are metadata only.
5. Agents receive no shell or write tool and no Claude Code conversation history.
6. Sensitive paths are excluded and known credential forms are redacted before prompts, logs, or reports.
7. Every material finding needs a valid revision, path, 1-based line range, and matching excerpt. Invalid evidence is discarded.
8. An incomplete, stale, cancelled, or failed execution cannot produce a green verdict.
9. Reports are static, escaped, CSP-constrained, user-local, and removed after their TTL.
10. `stdout` is exclusively MCP while the server is running. Diagnostics contain metadata only and go to `stderr`.
11. The optional Claude skill installer writes only static bundled instructions to the user's
    Claude configuration directory. It never writes credentials, repository data, or model output,
    and it does not replace an unrelated skill without explicit `--force` confirmation.
12. Invalid structured model output is held only in bounded memory for at most one contextual
    repair attempt. Logs and reports contain only allowlisted failure categories, counts,
    validation paths, HTTP status, stop reason, and syntactically safe request IDs.
13. A failed code slice cannot discard completed slices or SDD criteria, but it always marks the
    review incomplete and prevents `SIN_HALLAZGOS_BLOQUEANTES`.
14. Model routing is selected from validated configuration and fixed role policies. Models never
    receive command, repository-write, or provider-write tools.
15. Cost and usage telemetry contains only model identifiers and numeric counters. It never stores
    prompts, repository content, provider bodies, or complete model outputs.

## Residual risks

- Pattern redaction cannot identify every proprietary secret format; organizations should add approved patterns and repository policies.
- Provider and model services receive data permitted by their corporate configuration.
- GitHub/GitLab server-side diff limits can make a review incomplete.
- A locally privileged user can read another process's memory or files; OS account isolation remains required.
- Semantic review can miss defects. The output is advisory and the Tech Lead remains the decision maker.

Security fixtures cover prompt injection, traversal, mutating commands, secret patterns, malicious HTML, invalid evidence, invalid structured output, refusal, truncation, budget exhaustion, partial slices, and HEAD changes. Acceptance additionally compares `git status --porcelain` before and after a real review.
