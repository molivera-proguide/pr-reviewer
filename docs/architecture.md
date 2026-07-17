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

## Internal review stages

`src/review/pipeline.ts` is the bounded coordinator rather than the owner of every review policy.
Agent output projection, slice execution, finding identity, deterministic coverage, coverage repair,
and semantic verification live in dedicated modules. Each stage returns domain data plus safe
diagnostics; model output never bypasses evidence validation or the deterministic final projection.

`src/application/reviewer-service.ts` remains the application facade. Report construction and MCP
result summarization are pure modules, while provider, agent-client, clock, ID, and pipeline
dependencies have production defaults and may be replaced in tests without changing runtime setup.

## Model routing

The deterministic TypeScript pipeline remains the control plane. It schedules all stages, enforces
budgets, and computes coverage and the verdict; no model can execute a command or choose a provider
operation. Haiku 4.5 handles the isolated `sdd_explorer` and `code_explorer` roles. Bounded changes
use one holistic code slice. For larger changes, Sonnet 5 proposes up to three slices through
`slice_planner`; the control plane rejects invented paths, omitted or duplicated criteria, excessive
path duplication, and oversized slices before execution, then falls back deterministically when
needed. Sonnet also handles material implementation findings and ambiguous contractual claims in
`semantic_verifier` at explicitly bounded effort. Test gaps do not enter that expensive semantic call because their
severity and verdict effect are deterministic.

Implementation and test coverage are aggregated separately and verified deterministically before
the final projection. Implementation slices carry primary implementation files and related tests as
secondary evidence in one code-first request. Every explorer receives a bounded global changed-file
inventory, and SDD artifacts are excluded from code exploration. A verified
implementation or test-coverage finding overrides optimistic coverage for the affected criterion.
Stable finding IDs and evidence-based deduplication keep the cross-slice projection consistent. The
Sonnet verifier receives only compact evidence for findings that can block or may be contractually
misclassified. Risks are stable verified finding claims and pending decisions are extracted SDD
conflicts, so no final model synthesis call can add cost or turn an incomplete review green.

Semantic verification runs before omitted-criterion repair, so a rejected provisional finding
cannot suppress the one bounded repair opportunity. It may correct severity, impact, and criterion associations for every finding
included in a material review. A partial implementation coverage row without a verified defect is
kept `not_verifiable` and becomes eligible for the single repair; partial test coverage is never
promoted to covered because some test evidence does not prove every obligation is asserted. Missing
behavior must be represented by a verified finding. Agent limitations are scoped, and expected isolation between completed slices is
not promoted to a report-level limitation. Pending decisions come only from extracted SDD conflicts.

Each contractual finding is associated with at most one extracted criterion. Severity is capped
deterministically by impact after semantic verification: test coverage at `medium` and
maintainability at `low`. Only verified implementation findings can block. If every implementation
slice completed but required criteria were omitted, one bounded `coverage-repair-1` explorer call
receives only those criteria and implementation files. Its evidence and criterion IDs are verified
before aggregation; any incomplete repair keeps the review non-green without discarding completed
slices.

Contractual finding IDs use immutable revision, impact, and criterion as their canonical identity,
so wording, category, confidence, and evidence-range variation do not rename the same defect.
Test-coverage findings carry an explicit `partial` or `missing` status: partial means relevant
assertions exist but do not cover every required scenario, while missing means no relevant
assertion exists.

The pipeline normalizes a confirmed test gap to `partial` only when assertion-bearing evidence also
shares criterion-specific terms with its claim; unrelated assertions do not convert true absence
to partial. Implementation coverage is positive only when a slice returns one
coherent `covered` assessment or a verified criterion-specific finding explains the defect.
Ambiguous, duplicate, or unsupported partial assessments become `not_verifiable` and are eligible
for the single directed repair. That repair uses a dedicated compact schema with exactly one
criterion-keyed outcome: `covered` with evidence or `defect` with evidence and finding metadata.
Accepted repair outcomes supersede earlier `not_verifiable` or unsupported partial candidates only
for the explicitly requested criteria; verified defects remain authoritative.

The normal structured-output contract is criterion-keyed: every assigned criterion contains one
mandatory implementation `covered` or `defect` outcome and one optional test observation. Test-gap
claim, action, and confidence are optional and receive conservative local defaults, eliminating
schema retries for metadata that does not affect acceptance or safety. Missing, contradictory, or
invalid functional assessments remain unassessed and are eligible for the single directed repair.

When no implementation files changed, explicit `test_only` slices use the compact test-only prompt
and contract. They review assertions, false positives, intent, and boundaries without projecting
implementation coverage. The persisted report scope keeps implementation outside the completeness
calculation while still showing it as outside the change.

## Structured-output resilience

Agent responses are parsed locally after usage, stop reason, request ID, and HTTP status have been
captured. Diagnostics retain only bounded metadata: role, model, slice ID, failure category, base,
cache, output and thinking token counts, validation paths, and safe request IDs. Invalid output remains in memory only for one contextual
schema-repair attempt and is never logged or persisted.

`max_tokens` recovery is role-aware. SDD extraction may retry once with a compact payload. A
multi-file code slice is divided into bounded child slices, while an indivisible truncated slice is
marked incomplete. Semantic verification does not repeat a truncated request, and final projection
is always local and deterministic. Reports include a local USD estimate
based on the bundled, dated public Anthropic price table and label whether all model rates were
known.

Code exploration is aggregated per slice. Execution status and assessment completeness are
reported separately: a valid response can complete execution while leaving assigned criteria
gapped. A refusal, truncation, schema failure, or exhausted API failure leaves that slice `incomplete` while completed slices, extracted SDD criteria, verified
findings, and partial coverage are retained. All workers already in flight are awaited before the
report is assembled. Any incomplete slice makes the global review incomplete and prevents a green
verdict.

## Long-running behavior

The MVP call is synchronous and accepts exactly one selection. It uses the MCP cancellation signal, a global deadline, progress notifications when supported, at most two concurrent Anthropic requests, and a maximum of ten model calls including slice planning and application-level repair attempts. A future job/task transport can wrap the same coordinator without changing domain contracts.
