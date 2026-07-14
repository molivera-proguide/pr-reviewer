---
name: pr-reviewer
description: Run the read-only pr-reviewer MCP workflow for GitHub pull requests or GitLab merge requests against SDD artifacts. Use when the user asks to diagnose the reviewer, list open PRs/MRs, review a change against specs or acceptance criteria, inspect SDD coverage, or interpret a pr-reviewer verdict or HTML report.
---

<!-- managed-by: pr-reviewer -->

# Review a PR or MR against its SDD

Use only the tools exposed by the `pr-reviewer` MCP server for this workflow. Keep repository and provider access read-only.

## Workflow

1. Run `reviewer_doctor` for the target repository before listing or reviewing changes.
2. If a required check fails, report the failing checks and stop. Do not bypass authentication, path, repository, or configuration errors.
3. Run `list_open_change_requests` and show the user each candidate's number, title, author, draft state, branches, and exact `head_sha`.
4. Stop and request an explicit Tech Lead selection. Never choose a PR/MR for the user and never infer confirmation.
5. After the user explicitly confirms one displayed PR/MR, call `review_change_requests` with:
   - `tl_confirmed: true`
   - exactly one selection
   - the selected number
   - the unchanged `head_sha` from the latest list result as `expected_head_sha`
6. Do not substitute a branch name, shortened guess, or newly discovered SHA. If the HEAD is stale, list the open changes again and ask for confirmation again.
7. Present the returned status, verdict, finding counts, coverage summary, top findings, limitations, and `report_path`.

## Verdict rules

- Treat `RIESGO_BLOQUEANTE` as blocking.
- Treat `REQUIERE_DECISION` as requiring explicit human judgment.
- Describe `SIN_HALLAZGOS_BLOQUEANTES` only as an absence of verified blocking findings, never as automatic approval.
- Never describe an `incomplete`, `stale`, `cancelled`, or `failed` review as green or approved.
- Leave approval, comments, merges, code changes, and all other write actions to the user.

## Repository selection

Use the current repository root when it is unambiguous. Otherwise pass an explicit absolute `repository_path` or ask the user which repository to inspect. Do not scan unrelated directories.
