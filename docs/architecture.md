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

## Model routing

The deterministic TypeScript pipeline remains the control plane. It schedules all stages, enforces
budgets, and computes coverage and the verdict; no model can execute a command or choose a provider
operation. Haiku 4.5 handles the isolated `sdd_explorer` and `code_explorer` roles. Sonnet 5 handles
`semantic_verifier` and the final semantic `synthesizer`/orchestrator at explicitly bounded effort.

Implementation and test coverage are aggregated separately and verified deterministically before
synthesis. Code slices never mix production and test files, every explorer receives a bounded
global changed-file inventory, and SDD artifacts are excluded from code exploration. A verified
implementation or test-coverage finding overrides optimistic coverage for the affected criterion.
Stable finding IDs and evidence-based deduplication keep cross-slice synthesis consistent. The Sonnet orchestrator
receives compact evidence references and returns only cross-cutting risks and Tech Lead decisions.
This prevents a failed synthesis from discarding verified findings or turning an incomplete review
green.

Semantic verification may correct severity, impact, and criterion associations for every finding
included in a material review. A partial implementation coverage row without a verified defect is
normalized to covered when its evidence is valid; partial test coverage is never promoted
automatically because some test evidence does not prove every obligation is asserted. Missing
behavior must be represented by a verified finding. Agent limitations are scoped, and expected isolation between completed slices is
not promoted to a report-level limitation. Synthesized pending decisions are accepted only when
they reference an extracted SDD conflict.

## Structured-output resilience

Agent responses are parsed locally after usage, stop reason, request ID, and HTTP status have been
captured. Diagnostics retain only bounded metadata: role, model, slice ID, failure category, base,
cache, output and thinking token counts, validation paths, and safe request IDs. Invalid output remains in memory only for one contextual
schema-repair attempt and is never logged or persisted.

`max_tokens` recovery is role-aware. SDD extraction may retry once with a compact payload. A
multi-file code slice is divided into bounded child slices, while an indivisible truncated slice is
marked incomplete. Semantic verification and synthesis do not repeat a truncated request;
synthesis falls back immediately to deterministic coverage. Reports include a local USD estimate
based on the bundled, dated public Anthropic price table and label whether all model rates were
known.

Code exploration is aggregated per slice. A refusal, truncation, schema failure, or exhausted API
failure leaves that slice `incomplete` while completed slices, extracted SDD criteria, verified
findings, and partial coverage are retained. All workers already in flight are awaited before the
report is assembled. Any incomplete slice makes the global review incomplete and prevents a green
verdict.

## Long-running behavior

The MVP call is synchronous and accepts exactly one selection. It uses the MCP cancellation signal, a global deadline, progress notifications when supported, at most two concurrent Anthropic requests, and a maximum of eight model calls including application-level repair attempts. A future job/task transport can wrap the same coordinator without changing domain contracts.
