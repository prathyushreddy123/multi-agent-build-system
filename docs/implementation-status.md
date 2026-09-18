# Implementation status

Updated: 18 September 2026

## Phase publication policy

At the user's direction, completion of each phase is followed by a phase summary, a normal Git commit, and a push to `https://github.com/prathyushreddy123/multi-agent-build-system`. This is standing authorization for non-force pushes of phase-completion commits to this repository only; it does not authorize force-pushes, merges, releases, or deployments. All six plan phases (0–5) and the plan's pre-routine-use acceptance-checklist closeout are complete; this document is part of that publication checkpoint.

## Continuation point recovered

The prior run completed the full Phase 0 access proof, then stopped during the task-class baseline after Claude returned a subscription session-limit (HTTP 429). The missing final `complex / codex` cell was resumed and passed in 77 seconds with a valid worker contract. The Claude diagnosis and complex cells are provider-unavailable observations, not coding-quality failures.

Evidence remains outside Git under `~/.local/state/mabs`:

- Full access proof: `phase0/2026-09-18T03-27-48-134Z` — 9/9 probes passed.
- Original baseline: `baseline/2026-09-18T03-31-48-077Z`.
- Resumed complex Codex cell: `baseline/2026-09-18T03-45-13-035Z`.

## Phase 0 — access proof

- [x] Claude Pro authentication verified as first-party `claude.ai` subscription.
- [x] Codex authentication verified as ChatGPT subscription with no stored API key.
- [x] Paid API environment routes are stripped and launches fail closed.
- [x] Both harnesses can edit, test, and emit a valid structured result.
- [x] Cancellation leaves no observed orphan process.
- [x] Claude aliases resolved against installed versions.
- [x] Invalid-model failures do not consume code-repair budget.
- [x] Representative bug fix, feature, diagnosis, and complex tasks exercised.
- [x] Pi execution decision recorded in ADR 0001.
- [x] A real Claude session-limit event was captured by the controller as `QUOTA`; it blocked without consuming repair budget or dispatching a duplicate.

## Phase 1 — reliable local task

Implemented:

- [x] SQLite projects, requirements, tasks, dependencies, attempts, events, gates, approvals, routing decisions, context manifests, and controller health.
- [x] Transactional task-state/event writes and atomic READY-task claims.
- [x] Strict worker output validation; malformed output becomes `CONTRACT`, never success.
- [x] Code/auth/quota/infrastructure/config/contract/timeout failure classes.
- [x] Isolated task branches and Git worktrees; final checks bind to a local commit revision.
- [x] Deterministic context packet with stable requirements and dependency summaries.
- [x] Detached Claude/Codex adapter runner with start, status, cancel, and collect-result operations.
- [x] Restart reconciliation from SQLite and completion envelopes; missing processes block rather than duplicate work.
- [x] Registered deterministic gates with evidence files and final-revision binding.
- [x] At most two code-repair cycles by default; provider failures do not spend the budget.
- [x] Revision/config/action/target-bound approvals and stale-approval invalidation primitives.
- [x] Local controller health records and a SQLite lease preventing competing controller generations.
- [x] Minimal localhost workbench with overview, pending approvals, cancellation, and mutation token.
- [x] CLI for project onboarding, requirements, tasks, controller operation, status, approvals, verification, baseline, and workbench.
- [x] Automated restart test proves an existing launch is collected without duplicate dispatch.
- [x] Explicit retry and cancellation controls use optimistic record-version checks.
- [x] Retention defaults, dry-run-first pruning, and consistent SQLite backups with 14-copy rotation.
- [x] Thin project-local Pi extension for status, project/task commands, controller/workbench startup, backup, status tooling, and scoped task submission.

Exit evidence:

- [x] A real controller-managed Codex task reached `DONE`; registered tests passed against revision `f0ce9fb2030653798b7554d7f274b42bd4a6b92b`. Evidence: `~/.local/state/mabs/acceptance/2026-09-18T04-00-31Z`.
- [x] A real controller process was killed with a Claude worker active. The worker survived, a fresh controller acquired the stale lease and collected the same launch, and the attempt count remained exactly one. The provider returned a genuine session-limit, so the recovered task correctly became `BLOCKED/QUOTA`. Evidence: `~/.local/state/mabs/acceptance/restart-2026-09-18T04-15-35Z`.

Deliberately deferred:

- Independent AI review and the complete feedback/approval dashboard flow are Phase 3 deliverables. Phase 1 does not claim that substantive changes received independent review.

## Phase 2 — parallel projects and task routing

Implemented:

- [x] Versioned, provisional task-class routing for mechanical, implementation, complex coding, diagnosis, planning, research, review, troubleshooting, and curation work.
- [x] Explicit language/domain, complexity, ambiguity, context-size, change-risk, tool, allowed-scope, urgency, execution-mode, and execution-rationale inputs on durable tasks and context packets.
- [x] Configurable global, active-project, per-project, and per-provider concurrency limits, plus optional memory/load backpressure thresholds.
- [x] Persisted provider availability, quota cooldowns, authentication-unavailable state, capacity utilization, error counts, and operator reset controls.
- [x] Attempt-boundary subscription fallback on `AUTH`/`QUOTA`, with no repair-budget charge and no paid API route.
- [x] Starvation-resistant cross-project scheduling using durable dispatch counts while preserving task priority within projects.
- [x] Execution-plan validation for missing acceptance criteria, unknown dependencies, cycles, unjustified modes, and overlapping parallel edit scopes; valid plans apply atomically in topological order.
- [x] Parallel edit safety through execution-mode checks, per-project limits, disjoint scope checks, isolated worktrees, downstream dependency-revision materialization, and post-worker rejection of edits outside declared scopes.
- [x] Deterministic execution of mechanical tasks without a model worker.
- [x] Expanded controller/provider/operational health: queue age, claim age, utilization, uptime, provider state, restart counts, provider errors, invalid plans, and planning/routing counters.
- [x] Stage-level task latency data and provider/operations visibility in the CLI and localhost workbench.
- [x] Tests cover routing policy, global/provider limits, project fairness, mechanical execution, scope enforcement, plan validation/application, provider cooldown/reset, and quota rerouting.

Exit evidence:

- [x] Two independent real Git projects entered `RUNNING` in the same controller cycle under a global worker limit of 2 and Codex provider limit of 2.
- [x] Both authenticated subscription attempts completed without repair and reached `DONE`; required npm gates passed against revisions `3b9ac1433dced2ffa9d047f1ebaa87498e81e4c3` and `279c16581a52bd089aece9d1fa0710df38b75ab8`.
- [x] Durable evidence: `~/.local/state/mabs/acceptance/phase2-2026-09-18T13-12-59Z`.

Deliberately deferred:

- Independent review, feedback loops, approval action executors, bounded replanning through an LLM orchestrator, and delivery workflows remain Phase 3+ work.
- Resource-pressure admission controls and cost-equivalent telemetry remain later optimizations; Phase 2 capacity control is slot/provider based.

## Phase 3 — independent review and workbench feedback

Implemented:

- [x] Project-level `required`, `substantive`, and `none` review policies; new CLI projects default to substantive review while mechanical, planning, and research tasks can be explicitly skipped.
- [x] Revision-bound independent review attempts run only after required gates pass, use a fresh context, prefer an eligible provider different from the implementer, and are detected if they modify tracked worktree content.
- [x] Durable review verdicts, requirement coverage, severity-prefixed findings, and bounded review-to-repair-to-recheck-to-rereview loops.
- [x] Failed or missing required gates prevent review and completion; their commands, exit status, revision, and retained evidence logs are visible.
- [x] Persisted execution plans with assumptions, milestones, dependency items, execution rationale, routing history, and plan/task feedback.
- [x] Durable comments, questions/answers, priority changes, and requested-change follow-up tasks with optimistic target-version checks; unanswered questions queue on-demand research response tasks and never create a permanent model loop.
- [x] Context diagnostics for mandatory requirement coverage, stale revisions, missing manifests, omitted records, and missing evidence; raw worker transcripts, completion envelopes, outputs, gate logs, review diffs, and manifests are safely linked.
- [x] Expanded localhost workbench views for projects, plans, active workers, tasks, routing, attempts, reported usage, quality evidence, reviews, feedback, approvals, health, and troubleshooting timelines.
- [x] Workbench controls for feedback, answering questions, retry, cancellation, and approval preparation/decisions; all mutations require the localhost capability token.
- [x] Approval preparation refuses unchecked or unreviewed revisions, and exact target/revision/configuration drift durably invalidates pending or approved decisions.
- [x] Gate-waiver application requires and consumes an exact approved waiver binding. Push, merge, release, and deployment executors remain absent.
- [x] Pi commands expose feedback and approval flows through the same SQLite/controller records.

Exit evidence:

- [x] Real Codex implementation and Claude Sonnet 5 independent review completed against revision `9b2e8b57a34c516d85fe534557f6eb59eb5694fa`; the required npm gate passed before review, the review checked `REQ-ADD`, and the task reached `DONE` with zero repairs.
- [x] A prepared deployment approval was invalidated by changing the fixture target branch; a later approval attempt failed closed. No external action was executed.
- [x] Durable evidence: `~/.local/state/mabs/acceptance/phase3-2026-09-18T14-29-29Z`.

Deliberately deferred:

- The Phase 4 curator, configuration evaluation/activation history, and revert workflow.
- Push, pull-request, merge, release, deployment, or destructive-action executors. Approvals are durable authorization records, not execution authority by themselves.

## Phase 4 — approval-gated configuration curator

Implemented:

- [x] Complete versioned project configuration snapshots for routing overrides, approval/review policy, quality commands, bounded prompt addenda, and default repair limits.
- [x] Deterministic schema validation rejects unknown fields, unverified provider/model routes, unsafe quality commands, weakened consequential-action approval policy, unsafe prompt instructions, and repair limits above two.
- [x] On-demand analysis of durable failures, repairs, review findings, routing overrides, provider events, repeated questions, and previously rejected fingerprints; explicit rules can derive bounded suggestions from recurring evidence, with no permanent curator loop.
- [x] Config proposals materialize as config-only commits in isolated local Git branches/worktrees with retained diff evidence. The configured target branch is not changed.
- [x] `policy-replay-v1` evaluation records safety results and compares observable historical task, repair, review, gate, routing, prompt-size, and reported-usage metrics without presenting them as candidate product quality or subscription spend.
- [x] Exact `activate_config_change` approvals bind proposal ID, proposal Git revision, evaluation evidence, and current project config version.
- [x] Activation requires an inactive-task safe checkpoint, then atomically consumes its approval, updates effective routing/prompt/controller configuration, records actor/reason/history, invalidates other open approvals, and supersedes competing proposals.
- [x] Revert is independently approval-gated and restores a historical payload as a new auditable configuration version with its source version retained.
- [x] Candidate/evidence fingerprints suppress equivalent rejected or already-open suggestions until observable evidence changes.
- [x] Workbench, CLI, and Pi surfaces expose analysis, snapshots, proposal/evaluation details, diff evidence, rejection, activation approval, activation, history, and revert controls.
- [x] Schema v8 migration safely upgrades the pre-curator `config_versions` table before creating its project-history index.

Exit evidence:

- [x] A real local proposal was created on isolated branch `mabs/curator/prp_01m2thhdnbtg3pmd392xgzh9e1` at revision `b023eb4e53b41e605438c1f3b769ea56457c63a5`; the registered target branch remained unchanged.
- [x] Activation failed before evaluation and failed again before owner approval. After `policy-replay-v1` passed and the exact approval was granted, activation succeeded and consumed the approval.
- [x] A separately approved revert restored the initial payload as a new configuration version; activation history contains both operations and their source versions.
- [x] Durable evidence: `~/.local/state/mabs/acceptance/phase4-2026-09-18T15-18-10Z`.

Deliberately deferred:

- Phase 5 measured optimization experiments. Policy replay validates configuration safety and compares historical observations, but does not claim that a candidate improves product-task outcomes without a targeted experiment.
- Push, pull-request, merge, release, deployment, or destructive-action executors remain absent.

## Phase 5 — measured context and routing optimization

Implemented:

- [x] Deterministic, rules-first relevant-file retrieval (`src/context/retrieval.ts`) using explicit references, dependency-changed files, declared scope, repository manifests, and bounded keyword matching; secret/credential paths are never read, and generic programming/path-fragment vocabulary is excluded from matching.
- [x] Per-project `controllerSettings.contextBudgetTokens` (default 12,000, validated 1,000–100,000). Context packets carry a clearly labelled derived token estimate, preserve mandatory requirements and checkpoint context, and deterministically drop and record optional omissions once the budget is exhausted.
- [x] Durable `task_checkpoints` recorded at every controller decision point; a rerouted attempt builds its next context packet fresh from the latest checkpoint and retained records rather than another provider's history, and records a `context.refetched` event.
- [x] Context-health diagnostics extended with stale configuration references, budget-exceeded packets, repeated unresolved findings, repeated questions, and compression/refetch events; diagnostics report observable warnings only.
- [x] Optimization experiment registry (`src/optimization/experiments.ts`) requiring exactly one baseline and one candidate measurement per fixed-suite case before computing a result; completed experiments are immutable and only report improvement or limitation resolution without an accepted-work, requirement-violation, or intervention regression.
- [x] Outcome-aware routing telemetry (`src/optimization/routing.ts`) aggregating accepted work, repairs, review findings, duration, and reported usage by task class/role/route; routing changes still require the existing curator proposal/evaluation/approval path.
- [x] CLI `optimization create|record|list|show|complete|routing`, Pi `/mabs-optimize`, and workbench views for context packets, relevant files, checkpoints, continuity, experiments, and routing outcomes.
- [x] Worker contract v1.1.0 carries `file_context`, `checkpoint`, `derived_token_estimate`, `context_budget_tokens`, and `omissions`.

Exit evidence:

- [x] A real fixture task ran end to end against the real Codex and Claude subscription CLIs. Codex failed with a real `QUOTA` classification; the controller rerouted to Claude at the attempt boundary without spending repair budget (`repairsUsed` stayed `0`).
- [x] Both context packets had non-empty, correctly scoped relevant-file manifests; the deliberately unrelated fixture file was excluded from both.
- [x] Three checkpoints were recorded across the run; continuity diagnostics reported no repeated findings or questions.
- [x] An optimization experiment compared the historical empty-manifest baseline against the real candidate run and completed with result `limitation_resolved` and `safeguardsPassed: true`.
- [x] The localhost workbench served the real checkpoints, context packets, relevant files, experiment, and routing outcomes for this run.
- [x] Durable evidence: `~/.local/state/mabs/acceptance/phase5-2026-09-18T15-52-03Z`.

Deliberately deferred:

- Embeddings, vector databases, local-model serving, LiteLLM, remote workers, and dedicated tracing infrastructure remain out of scope until a measured need justifies them.
- Push, pull-request, merge, release, deployment, or destructive-action executors remain absent.

## Closeout — pre-routine-use acceptance checklist

The source plan's phase table defines exactly Phases 0–5; all six are complete. The plan also lists an "Acceptance scenarios before routine use" checklist that is not a numbered phase. Three items on it had not yet been explicitly demonstrated with dedicated evidence and are now closed:

- [x] Stale-heartbeat investigation before declaring failure: `Records.staleHeartbeatAttempts()`, a deduplicated `worker.heartbeat_stale` event, a `controller_health.stale_heartbeat_workers` count (schema v10), and a task-diagnostics warning that never auto-fails a task on heartbeat age alone.
- [x] Many registered inactive (paused) projects alongside active ones: paused-project tasks are never promoted past `QUEUED` and are never dispatched; confirmed with a synthetic five-paused/two-active test and a real CLI run against five real paused projects and one real active task.
- [x] Database/lease error visibility: a simulated SQLite/lease failure increments a durable `db_errors` counter, writes `controller_health.state = "degraded"`, and does not dispatch a duplicate attempt or lose task ownership; the counter remains visible after recovery.

See `docs/phases/closeout-summary.md`. Real evidence: `~/.local/state/mabs/acceptance/closeout-2026-09-18T16-06-17Z`.

No further numbered phases are defined in the source plan.

## Verification

```text
npm test          44 passing
npm run typecheck passing
mabs verify --quick 3/3 passing
Pi RPC extension   passing
```

The test suite includes strict contracts, lifecycle rules, approval binding and invalidation, environment scrubbing, durable records, dependency isolation, gate evidence, controller restart/no-duplicate behavior, execution-plan safety, routing, fairness, concurrency limits, provider cooldown/fallback, deterministic mechanical work, allowed-scope enforcement, independent review/repair loops, context/evidence diagnostics, feedback, plan persistence, workbench controls, gate-before-review enforcement, schema migration, curator safety validation, proposal isolation, evaluation gating, duplicate suppression, stale activation rejection, applied config behavior, approved revert history, deterministic relevant-file retrieval, checkpoint/continuity diagnostics, optimization-experiment safeguards, and routing-outcome aggregation.
