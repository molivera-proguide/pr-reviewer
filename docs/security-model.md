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

## Residual risks

- Pattern redaction cannot identify every proprietary secret format; organizations should add approved patterns and repository policies.
- Provider and model services receive data permitted by their corporate configuration.
- GitHub/GitLab server-side diff limits can make a review incomplete.
- A locally privileged user can read another process's memory or files; OS account isolation remains required.
- Semantic review can miss defects. The output is advisory and the Tech Lead remains the decision maker.

Security fixtures cover prompt injection, traversal, mutating commands, secret patterns, malicious HTML, invalid evidence, budget exhaustion, and HEAD changes. Acceptance additionally compares `git status --porcelain` before and after a real review.
