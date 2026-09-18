# Phase 5 summary — measured context and routing optimization

Completed: 18 September 2026

## Outcome

Phase 5 targets the measured gap left open by earlier phases: context packets preserved requirements and artifacts, but the relevant-file manifest (`context.files`) was consistently empty and there was no bounded, auditable context budget. Phase 5 adds deterministic, rules-first relevant-file retrieval bounded by a per-project token budget, structured task checkpoints for cross-provider continuity, context-health diagnostics, an optimization-experiment registry that requires a completed fixed-suite comparison before any improvement claim, and outcome-aware routing telemetry. No embeddings, vector databases, local-model serving, LiteLLM, remote workers, or dedicated tracing infrastructure were introduced.

## Delivered

### Deterministic relevant-file selection

`src/context/retrieval.ts` selects tracked repository files using:

- explicit path references in the task/requirement text;
- files changed by completed dependency tasks;
- files inside the task's declared allowed scope;
- repository manifests (`package.json`, `README.md`, `tsconfig.json`, CI workflows, and similar);
- bounded keyword matching against the file path and, when at least two distinct terms match, file content.

Known credential/secret paths (`.env*`, `credentials*`, `auth.json`, key/cert files) are never read. Common programming syntax tokens (`return`, `function`, `const`, `import`, and similar) and path-fragment noise (`src`, `lib`, `test`, and similar) are excluded from keyword extraction so generic vocabulary cannot pull in unrelated files. Every included and omitted file carries an explicit, retained reason.

### Bounded context budgets

Each project has a `controllerSettings.contextBudgetTokens` (default 12,000, validated 1,000–100,000). Context packets estimate size deterministically (`derived_utf8_bytes_divided_by_four`, explicitly labelled as a derived estimate, never presented as provider-reported usage). Mandatory requirements and retained checkpoint context are always preserved; optional file context is dropped deterministically, lowest score first, once the budget is exhausted, and every omission is recorded with its reason.

### Structured checkpoints and cross-provider handoffs

`task_checkpoints` durably records, at every controller decision point (implementation complete, repair complete, checks passed/failed, review approved/changes-requested/blocked, attempt failed, worker blocked), a summary, base/result revision, changed files, findings, unresolved items, next action, and evidence paths. When a task is rerouted to a different provider, the next context packet is built fresh from the latest checkpoint plus dependency and requirement records — never from another provider's chat history — and a `context.refetched` event records the provider transition and the files rebuilt.

### Context-health diagnostics

`src/diagnostics/task.ts` now reports, in addition to existing requirement-coverage checks: stale configuration references, context packets that exceeded their budget, repeated unresolved findings across checkpoints, repeated project questions, and `context.compressed` / `context.refetched` events. Diagnostics report observable warnings; they do not fabricate a context-loss score.

### Optimization experiment registry

`src/optimization/experiments.ts` persists experiments (hypothesis, dimension, fixed suite version, baseline/candidate configuration) and per-case measurements (accepted, requirement violations, repairs, interventions, duration, reported input/output tokens — null when not reported, relevant-file count, warnings). `compareExperiment` requires exactly one baseline and one candidate measurement per fixed-suite case before it will compute a result, and only reports `improved` or `limitation_resolved` when accepted work does not regress and requirement violations and interventions do not increase. Completed experiments are immutable and retain comparison evidence outside Git.

### Outcome-aware routing telemetry

`src/optimization/routing.ts` aggregates observed attempts by task class, role, and route (adapter/model/effort): accepted tasks, repairs, review change requests, failures, execution time, and reported usage (null unless every aggregated attempt reported it). This is read-only telemetry; any resulting routing change still requires a curator proposal, evaluation, and approval — Phase 5 does not add a second routing-change path.

### Interfaces

- CLI: `optimization create|record|list|show|complete|routing`.
- Pi: `/mabs-optimize` over the same CLI and SQLite records.
- Workbench: context packets show provider, token estimate vs. budget, included files with reasons, and omissions; task pages show checkpoints and continuity diagnostics; the overview shows optimization experiments (with a comparison view) and routing outcomes.
- Worker contract v1.1.0 adds `file_context`, `checkpoint`, `derived_token_estimate`, `context_budget_tokens`, and `omissions` to the context a worker receives, alongside the existing `files` path list.

## Verification

```text
npm test                         40 passing
npm run typecheck                passing
git diff --check                 passing
node src/cli.ts verify --quick   3/3 passing
Pi RPC extension load            passing
```

Phase 5 tests cover:

- deterministic retrieval selecting scoped/explicit files, excluding secrets, and recording omissions under a tight budget;
- a full controller run producing a non-empty relevant-file manifest, checkpoints, and clean continuity diagnostics;
- optimization experiments requiring a complete fixed suite, rejecting regressions, and detecting limitation resolution;
- routing-outcome aggregation without inventing missing usage measurements;
- context-budget validation bounds.

## Real acceptance

A real project and task were registered against a fixture repository with a deliberate bug (`invoiceTotal` always returning 0), an unrelated file, and a registered requirement. The task ran against the real Codex and Claude subscription CLIs end to end:

1. The initial Codex attempt failed with a real `QUOTA` classification.
2. The controller rerouted to Claude at the attempt boundary without spending repair budget (`repairsUsed` stayed `0`).
3. The context packet built for the fallback provider was freshly assembled from the latest checkpoint and retained records, not carried over; a `context.refetched` event recorded the provider transition.
4. The task completed (`DONE`) with `resultRevision` `42b4df8fc63ac4847de4db286ed61cf9d1feb30a`, and the worker changed only the in-scope file.
5. Both context packets had non-empty, correctly scoped relevant-file manifests (`README.md`, `package.json`, `src/billing/invoice.js`, `src/billing/invoice.test.js`); the unrelated file was excluded.
6. Three checkpoints were recorded (`attempt_failed`, `implementation_complete`, `checks_passed`); continuity diagnostics reported no repeated findings or questions.
7. An optimization experiment (`phase5-real-fixture-v1`, case `invoice-fix-fixture`) compared the historical empty-manifest baseline against this real candidate run and completed with result `limitation_resolved` and `safeguardsPassed: true`.
8. The localhost workbench served the real checkpoints, context packets, relevant files, experiment, and routing outcomes for this run.

Durable evidence: `~/.local/state/mabs/acceptance/phase5-2026-09-18T15-52-03Z`

No paid API, push, merge, release, deployment, or destructive-action executor was used.
