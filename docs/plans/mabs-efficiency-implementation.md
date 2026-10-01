# MABS efficiency implementation ledger (v5)

Source: *MABS efficiency implementation brief*, v1, 1 October 2026, reviewed against main `b1a2578`.
Branch: `mabs/efficiency-v5`, worktree `~/worktrees/mabs-v5`, based on `b89e7ce` (`b1a2578` plus the docs alignment commit).
Live progress: [mabs-efficiency-progress.md](mabs-efficiency-progress.md). Cleanup findings: [cleanup-audit.md](cleanup-audit.md).

Status vocabulary: **needed**, **partial**, **satisfied**, **contradicted**, **done** (implemented on this branch), **unverified** (built, but live proof not run).

## Authorized scope (2026-10-01)
- Phase 0 and Phase 1; then Phase 2 (approved the same day after the Phase 1 report); then the two Phase 2 live checks and Phase 3 (approved together). Stop with a report before Phase 4.
- Offline validation only: no subscription-consuming worker or benchmark runs. A live envelope is proposed at the end of Phase 2.
- ROUTE-01 decision: `--adapter` stays a *preference*, with any fallback recorded. A new strict `--pin-adapter` never substitutes a provider.
- Uncommitted v4 docs alignment on main was reviewed and committed as `b89e7ce`.

## Phase 0 environment
| Item | Value |
|---|---|
| Base commit | `b89e7ce` (brief baseline `b1a2578` + docs alignment) |
| Node | v24.20.0 (package.json requires >= 24) |
| TypeScript | 7.0.2 (native, no JS compiler API; see CLEAN-01) |
| Pi | 0.86.1 (claude-bridge hand-patched locally for 0.86, outside this repo) |
| Claude Code CLI | 2.1.283 |
| Codex CLI | 0.157.1 |
| Pi linkage | `npm run link-pi` symlinks the global `@earendil-works/*` packages; nothing is installed |

Evidence: `docs/plans/evidence/phase0-*.{txt,log,json}`.

## Baseline (BASE-01..03)
| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run typecheck:extensions` | pass |
| `npm test` (3 consecutive runs) | 414/414 pass, 0 skipped, about 19 s per run |
| PID probe | Node `pid` = `/proc/self`, child PID = `/proc/<pid>/stat` PID, PPID is consistent |

**Correction to the brief §2:** the seven gate/process-recovery/repair failures did **not** reproduce on WSL. The PID probe shows Node and `/proc` agree here. That fits the brief's own note that its execution environment reported inconsistent PIDs (a PID-namespaced sandbox), and liveness/fencing checks compare those identities. No product defect is open for those tests. If they fail again in another environment, record that environment's PID namespace before debugging.

BASE-03: historical rows in `bench/results/*.jsonl` are untouched. New fields are additive.

## Requirement ledger

| ID | Status at baseline | Evidence | Phase |
|---|---|---|---|
| BND-01..10 | constraints | carried as acceptance conditions on every change | all |
| INT-01 | **done** (`3211ae1`) — was: needed | `src/intake/service.ts:95` `askClarifications` returns `{brief, open}` and drops the `addClarification` records; `mabs_answer_clarification` needs `clarificationId` | 1 |
| INT-02 | **done** (`91cd69c`) — was: needed | only single-answer `resolveClarification` (`store.ts:565`); no request-ID idempotency table exists | 1 |
| INT-03 | **done** (`2e8a946`) — was: partial | brief governance already exists via `mabs_update_brief` (`projectType`/`reviewChoice`); `mabs_set_project_governance` requires a registered project, and its error does not point to the brief operation | 1 |
| INT-04 | **done** (`e5fde13`) — was: partial | the parts exist: `bootstrapProject`/`resumeBootstrap` with `resumableBootstrapRun`, and `submitAcceptedPlan` idempotent via `planSubmissions`. The single resumable start operation is missing | 1 |
| OUT-01 | **done** (`a1b46b5`, `9823a88`) — was: needed | `.pi/extensions/mabs.ts:13,24` slices the CLI output at 12,000 chars, possibly mid-record; `mabs-ux.ts` changes display only | 1 |
| PLAN-01 | **done** (`05c2e78`) — was: needed | no fragmentation diagnostics in `src/domain/plan.ts`; `ownedRequirements` exists in the domain (11 refs) but not in the Pi task schema | 2 |
| EXEC-01 | **done, live proof unverified** (`ee94831`) — was: needed | `src/worker-tools/checks-mcp.ts` serves registered checks only; no named recipes | 2 |
| ROUTE-01 | **done, live proof unverified** (`791ce08`) — was: needed | `src/routing/router.ts:173` only sorts by `preferredAdapter`; there is no pinned mode | 2 |
| CTX-01 | **done** (`cd71616`) — was: needed | `src/context/packet.ts:374` measures `workerInputBytes` on `JSON.stringify(…, null, 2)`, while the sent prompt is compact | 2 |
| GOV-01 | **done** (`c860a58`) — was: needed | no standing delivery-mode preference with provenance | 3 |
| UX-01 | **done** (`bfac07b`) — was: partial | status bar exists (`mabs.ts:39`); no coalesced controller progress | 3 |
| CTX-02 | **done** (`2e1d72c`) — was: needed | `packet.ts:113` loads every project requirement into each packet | 3 |
| CTX-03 | satisfied (repair resume) | `controller.resumableSession` (`controller.ts:565`) + `assembleResumePrompt`; cross-task reuse stays deferred | 3 (optional) |
| REV-01..03 | needed | `review request` only records an event (`cli.ts` help: "Record an explicit manual review request"); the review packet replaces `acceptance_criteria` (`packet.ts:214`) | 4 |
| DOC-01 correction | **satisfied** | `docs/architecture/task-execution.md` now matches `controller.selectReviewRoute` (`controller.ts:533-537`): no same-provider substitution under `independent_provider` (commit `b89e7ce`) | 0 |
| DOC-01 ownership map | needed | — | every phase |
| CLEAN-01 | report done | [cleanup-audit.md](cleanup-audit.md); nothing deleted | every phase |
| BENCH-02 turns label | **done** | `19a9b80`: `claudeNumTurns` / `codexToolItems` are separate fields; legacy `turns` is read by adapter | 0 |
| BENCH-01/02 (rest), BENCH-03 | needed | live runs need an authorized envelope | after Phase 2 |

## Decisions and corrections to the brief
1. **Seven baseline failures**: an environment artifact, not reproduced (see above).
2. **DOC-01 correction**: already satisfied by the v4 docs alignment.
3. **Pi turns** in `bench/lifecycle-exec.ts` count Pi assistant turns. That is a third observation, already in its own `pi.turns` field, and is not mixed with worker figures.
4. **dependency-cruiser and TypeScript 7**: depcruise cannot parse `.ts` with TS 7's native compiler. The audit used a TS 5.9.3 parser in a temporary `npx` environment. Nothing was added to the repo.

## Per-requirement records (filled as implemented)

### BENCH-02 (turns label)
- Files: `bench/run.ts`, `bench/report.ts`, `test/bench-observe.test.ts`.
- Design: the new optional fields `claudeNumTurns` and `codexToolItems` are written alongside the legacy `turns`. The readers `claudeNumTurns()` / `codexToolItems()` fall back to the legacy field through the recorded adapter. The report column is split in two.
- Validation: unit tests for both adapters and the legacy rows. The report rendered from all historical labels to a scratch path has 18 columns, and legacy Claude and Codex rows land in the right columns.
- Docs: the report header explains the two observations. `docs/benchmarks/efficiency-v4.md` is not regenerated because it is historical.
- Rollback: revert `19a9b80`. Rows written meanwhile still carry `turns`.

### INT-01: usable clarification records
- Files: `src/intake/service.ts` (`askClarifications`, `requireClarification`, `answerClarification`), `src/intake/errors.ts`, `src/cli.ts`, `.pi/extensions/mabs.ts`.
- Design: an additive result. `brief` and `open` stay. New fields: `briefId`, `briefVersion`, `requested` (exactly this call's records, deduplicated, with reused same-field records flagged `reused`) and `openQuestions` (every open question). `brief answer --brief=` and the tool's `brief` parameter refuse cross-brief IDs. Refusals are `IntakeError`s that the CLI prints as JSON on stderr, with the brief's open IDs.
- Validation: `test/intake-v5.test.ts` INT-01 (4 tests: immediate answer, same-field reuse, unknown/cross-brief refusal with no state change, CLI JSON refusal).
- Rollback: revert the commit. The callers of the old output fields are unaffected either way.

### INT-02: batch answers and explicit updates
- Files: `src/intake/service.ts` (`resolveIntake`), `src/intake/requests.ts`, `src/store/migrations/019_intake_requests.sql`, `src/store/db.ts` (schema 19), `src/cli.ts` (`brief resolve`), `.pi/extensions/mabs.ts` (`mabs_resolve_intake`, plus a shared `briefPatchSchema`).
- Design: one `BEGIN IMMEDIATE` transaction. It validates the version, each ID's ownership, exactly one of answer/assumption, duplicates, withdrawn items and already-resolved conflicts before writing. Then it reuses `resolveClarification` and `updateBrief` (savepoints), so acceptance invalidation, task cancellation and governance decisions behave exactly as before. The request row (sha256 of canonical JSON) commits with the effects. An identical retry gets the stored result (`replayed: true`); a different payload under the same ID gets `request_conflict`. Restating the same answer is a no-op. A different answer needs `revise: true`.
- Compatibility: `brief answer` / `mabs_answer_clarification` are unchanged wrappers and still overwrite on re-answer, as before. The new path enforces `revise`.
- Validation: INT-02 (8 tests), including all-or-nothing across five invalid shapes, no duplicate events on retry, stale version, revise, governance invalidation and an 18→19 upgrade. Also a `maintenance migrate` rehearsal on a `VACUUM INTO` copy of the live schema-18 database: backup integrity ok, upgraded to 19, restore rehearsal rows preserved. The live database is **not** migrated.
- Rollback: revert, then restore the pre-migration backup that `maintenance migrate` writes. Schema 19 only adds a table, so a schema-18 build refuses a schema-19 database (`UnsupportedSchemaVersionError`) instead of corrupting it.

### INT-03: discoverable governance
- Files: `src/intake/service.ts` (`wrongGovernanceSubject`), `src/cli.ts`, `.pi/extensions/mabs.ts` (descriptions for `mabs_set_project_governance` / `mabs_update_brief`).
- Design: `project governance` with a brief ID returns `wrong_subject` with `briefId`, `briefVersion`, `operation: mabs_update_brief` and a command template. With an unknown name it returns `wrong_subject` (`subject: unknown`). Nothing is inferred from names. The existing `syncGovernanceClarifications` already asks about an unknown project type once. Its question ID now comes back through INT-01.
- Validation: INT-03 test (CLI, both subjects); `governance.test.ts` unchanged and passing.

### INT-04: start accepted work in one operation
- Files: `src/intake/start.ts`, `src/cli.ts` (`brief start`), `.pi/extensions/mabs.ts` (`mabs_start_work`), `.pi/skills/product-discovery/SKILL.md`.
- Finding: `bootstrapProject` already ends with `plan_linkage` → `submitAcceptedPlan`, and it checkpoints every step in `bootstrap_runs`. So *start* is a gate plus a durable record, not a new pipeline.
- Design: it requires the active acceptance to match the exact `proposalId` and `fingerprint`, and never accepts. It takes one explicit destination: `new_directory` (bootstrap) or `registered_project` (submit). The `intake_requests` row records the governance decision ID/version it was validated against, and the checkpoints `validated → bootstrapped → submitted`. A retry re-checks acceptance and governance and then resumes. Bootstrap skips its finished steps, and submission is idempotent through `planSubmissions`. A failure returns `status: interrupted, resumable: true` with the bootstrap ID instead of throwing away state. Test-only `interruptAt` mirrors the existing `interruptAfterStep`.
- Validation: INT-04 (8 tests). Interruptions before bootstrap, during it (after `check_registration`, before plan linkage) and after it each end with exactly one project, one task set and one bootstrap run, and user files written in between are preserved. Stale fingerprint and unaccepted proposal refuse without scaffolding. A governance change between attempts refuses. The registered-project path and the CLI are covered.
- Rollback: revert. `brief bootstrap` / `brief submit` remain and are unchanged.

### OUT-01: model-facing responses
- Files: `src/intake/projection.ts`, `src/cli.ts` (`emitView`, `--view=conversation`, `brief show --section --page`), `.pi/extensions/mabs.ts`, `src/intake/service.ts` (bounded warning and next action).
- Measured bytes returned to the model (CLI output, fixture `30 questions / 8 tasks` → `200 / 50`):

| Response | Before | After (`--view=conversation`) |
|---|---|---|
| `brief ask` (all questions in one call) | 18.6K → 118K | 4.7K → 30.8K (grows only with the questions in *that* call; every requested ID must come back) |
| `brief resolve` (1 answer) | 8.7K → 56K | 1.7K → 1.7K |
| `brief propose` | 11.0K → 61K | 1.5K → 2.2K |
| `brief accept` | 9.3K → 47K | 0.3K → 0.3K |
| `brief start` | 1.3K → 5.9K | 1.1K → 2.0K |
| `product show` | 9.3K → 51K | 2.6K → 2.6K |
| `product show`, real briefs (live-DB copy) | 3.0K-30.9K | 0.9K-6.0K |

- Design: page sizes are questions 10, tasks 20, other lists 10. Each `Page` reports `total`, `omitted` and the exact `more` command. Records are never cut. The 12K slice remains only for other tools and now says it truncated. The full JSON default is unchanged.
- This is a **response-size** measurement, not a token or subscription-usage claim (BND-10). Its effect on lifecycle usage is unmeasured until a live run is authorized.
- Validation: OUT-01 (3 tests). Bounded growth (< 4 KB and < 2× from 20→200 questions), required IDs and fingerprints survive, the pages union to every item exactly once, and the CLI defaults to full output with compact output on request.
- Rollback: revert. Pi then receives the full JSON again.

## Phase 1 summary
- Tests: 440/440 (`npm test`), core and extension typechecks clean, and the extension-load contract test covers the new tools.
- Not verified: a live Pi conversation using the new tools, which needs a model session. Tool selection by the model is untested; the descriptions and skill text are the only steering.
- Merging this branch needs `node src/cli.ts maintenance migrate` (controller stopped) on the live database. It was rehearsed on a copy and has not been run on the live database.

## Phase 2

### CTX-01: prompt accounting
- Files: `src/context/packet.ts`, `src/prompts/roles.ts` (`pruneForWorker`, `renderedBytes`), `src/controller/controller.ts`, `bench/run.ts`.
- Finding: across 73 real stored packets, the old `worker_input` (pretty-printed stored packet) overstated the rendered worker input by a median 10%, and understated `instructions` by the same amount. No historical row had negative instructions.
- Design: sections are measured on the rendered strings. `instructions + worker_input = promptBytes`, and the parts plus `worker_input_other = worker_input`, all exactly. The estimator becomes `utf8-bytes-div4.v2`, so old rows stay distinguishable. A resumed repair sends the resume brief, so `attempt.prompt_prepared` records `coldPromptBytes` and `resumePromptBytes` at launch, and the bench counts the prompt actually used (`completion.result.resume.used`). Bytes/4 remains an estimate, not a tokenizer or billing count.
- Validation: `context-budget.test.ts` CTX-02 checks the rendered line against `worker_input`, nonnegative sections, exact sums and Unicode. `session-resume.test.ts` checks both sizes for a resumed repair.

### ROUTE-01: preference vs pin
- Files: `src/routing/router.ts` (`pinnedAdapter`, `routeMode`), `src/controller/controller.ts`, `src/cli.ts`, docs.
- Decision (user): `--adapter` / `MABS_ADAPTER` stay a preference. The new `--pin-adapter` is strict.
- Design: under a pin, other providers' routes are rejected before eligibility, so any "fallback" is only between the pinned provider's own routes. An unavailable pin blocks with `QUOTA` during a cooldown (`CONFIG` if ineligible), and a busy pin waits even with `--capacity-fallback=allow`. Review routing is never pinned, so `independent_provider` still finds the other provider. An experiment trial on another provider is refused under a pin. The pin also selects the provider that `--model`/`--effort` apply to, and those values are capability-validated as before. Route mode is recorded on `routing.override`. No new probes: existing capability evidence is reused.
- Validation: `model-routing.test.ts` ROUTE-01 (5 tests): pin selection, cooldown/busy/no-route with zero substitution, an observable preference fallback, a controller that never starts the other provider, the independent reviewer under a pin, and the recorded mode.
- Live proof: **unverified** (needs a provider in an actual cooldown or signed out).

### PLAN-01: task sizing
- Files: `src/domain/plan.ts` (`fragmentationWarnings`, `requirementOwnershipErrors`), `src/intake/service.ts`, `.pi/extensions/mabs.ts` (guidance; `requirements` on plan tasks), `.pi/skills/product-discovery`, `.pi/skills/automation-design`.
- Design: the guidance prefers one cohesive task that includes its tests and docs, with a stated reason for any split. Advisory warnings are structural only and never reject: a tests/docs-only task depending on another task, and three or more small tasks in a strict chain. Fan-out, high complexity and independent audits are not flagged. Requirement ownership is exposed deliberately (one field). Once any task declares it, unknown IDs and unowned mandatory requirements fail the proposal.
- Validation: PLAN-01 (3 tests). Whether a model now proposes one task for the habit tracker is **unverified** until a live conversation runs.

### EXEC-01: registered execution recipes
- Files: `src/domain/recipes.ts`, `src/worker-tools/checks-mcp.ts` (`run_recipe`), `src/verify/launch.ts`, `src/adapters/*`, `src/store/{db,records}.ts`, `src/store/migrations/020_worker_recipes.sql`, `src/domain/config.ts`, `src/domain/contract.ts` (1.4.0), `src/prompts/roles.ts` (v5), `src/context/packet.ts`, `src/bootstrap/service.ts`, `src/cli.ts` (`project recipes`).
- Target: v4 finding 5.6, where workers were denied running their own program (4–5 denials per lifecycle task).
- Design: a recipe = a fixed argv prefix plus up to `maxArgs` validated arguments. There is no shell. Path-like arguments must stay in the worktree (`..`, absolute, `~`, and `--x=../` are refused). `{tmp}` names a per-run scratch directory that is removed afterwards. Runs have a timeout, a bounded tail and a log entry, and are labelled exploratory. Recipe `env` cannot set PATH, NODE_OPTIONS, LD_*/DYLD_* or PYTHONSTARTUP. Codex gets the commands as text (its sandbox runs them), and Claude gets the exact-name `mcp__mabs__run_recipe`. Bootstrap registers one `run` recipe only when the profile's entry point is a concrete file. Controller checks still re-run on the resulting revision, and recipe output never feeds acceptance.
- Storage: schema 20 adds `projects.worker_recipes` (default `[]`). Recipes are versioned with the project config. Snapshots include `workerRecipes` only when non-empty, so existing config fingerprints are unchanged. Config activation and rollback restore the version's recipes.
- Validation: `worker-checks.test.ts` EXEC-01 (7 tests: permission, execution and scratch, refusals that never run, timeout, bounded output, MCP list/log, validation, prompt). `intake-v5.test.ts` (bootstrap registers a working Python `run` recipe that executes; snapshot stability; 19→20 upgrade). `model-routing.test.ts` (implementation launch and packet carry recipes).
- Live proof: **unverified**. Whether Claude Code honours `mcp__mabs__run_recipe` without a prompt is the provider-permission behaviour the brief says needs a small live smoke.

### Phase 2 migration rehearsal
- A fresh `VACUUM INTO` copy of the live schema-18 database, run through `maintenance migrate`: 18 → 20, backup integrity ok, restore rehearsal at schema 20 with rows preserved, and existing projects get `workerRecipes: []`.
- Config fingerprints: `ai-engineering-study-assistant` is unchanged. `multi-agent-build-system` already differs between its active stored snapshot and its current snapshot **on main before this work** (checked with main's code on an un-migrated copy). This is a pre-existing discrepancy, not caused by v5, and is recorded for a later look.

### Phase 2 summary
- Tests: 459/459, both typechecks clean.
- Unverified live: the permission behaviour of `run_recipe`, pinned routing under a real provider cooldown, and model task sizing in a real conversation.

## Proposed live validation envelope (needs approval)
A bounded, subscription-only plan. No paid API, no extra-usage activation, and historical rows kept.

| # | Run | Provider calls | Purpose |
|---|---|---|---|
| 1 | Claude worker smoke on a scratch JS project with a `run` recipe: one small implementation task, `reviewChoice=off` | 1 Claude worker attempt (`claude-sonnet-5`, low effort) | `run_recipe` and `run_checks` are used without denials (`permission_denials` = 0) |
| 2 | Pinned-route smoke: `--pin-adapter=codex` with Codex marked in cooldown | 0 provider calls (the controller blocks before launch) | No substitution; the task blocks with QUOTA |
| 3 | One FAST parity pair on the habit-tracker fixture, MABS + Claude vs direct Claude, same spec/model/effort, no AI review | about 1 Pi planning session + 1–2 MABS worker attempts + 1 direct run | First comparable lifecycle usage after v5; reported as n=1, not a savings claim |

Ceiling: at most 6 provider attempts in total, stopping at the first quota signal. Rows are added under new labels (`v5-smoke`, `v5-parity`).

## Phase 3

### GOV-01: standing FAST preference
- Files: `src/governance/standing.ts`, `src/store/migrations/021_standing_preferences.sql` (schema 21), `src/intake/store.ts` (create/update hooks), `src/intake/service.ts` and `projection.ts` (delivery summary), `src/cli.ts` (`preferences …`, `project add` hook), `.pi/extensions/mabs.ts` (relay the offer), `docs/architecture/task-execution.md`, `docs/commands.md`.
- Design: one active, person-owned preference per key with history. Agents cannot set it. It fills only a **missing** review choice on a **new** brief or project whose type is **explicitly** one of the eligible types (default `personal`; `client` is rejected). It records an ordinary governance decision (`source: standing-preference`, `source_ref`: preference ID, actor: the person), so existing decisions win, unknown types are still asked, and the proposal fingerprint covers it. Proposal and product results carry `delivery` with a one-line VERIFIED offer, and Pi includes it in the plan summary without a separate question. Switching to verified re-fingerprints the plan.
- Not done on the live database: recording your own FAST preference (`preferences set-delivery fast --by=… --reason=…`) waits until after the merge and migration.
- Validation: GOV-01 (5 tests).

### UX-01: direct progress
- Files: `src/operator/feed.ts`, `src/cli.ts` (`progress feed`), `.pi/extensions/mabs.ts` (poller), `docs/commands.md`.
- Design: a bounded frame (unfinished tasks plus those changed in the last hour, at most 200) built from `buildProgressSnapshot`. `diffFeed` notifies only for done, blocked/failed, awaiting approval and controller-stopped-with-work, coalesced per poll, and never on the first frame. The extension polls every 15 s (`MABS_FEED_INTERVAL_MS`, `0` = off), uses Pi's `setStatus`/`notify`, stops on `session_shutdown`, and never calls `sendUserMessage`. The real-data frame on the live copy is 2.5 KB (2,493 bytes), read by the extension and not the model.
- Validation: `test/operator/feed.test.ts` (5) plus an extension test that drives `session_start` twice and asserts the status lines, one coalesced notice and zero model messages.

### CTX-02: scoped requirements and dependency evidence
- Files: `src/context/packet.ts` (`scopedRequirements`, `acceptedDependencyEvidence`), `src/store/records.ts` (`scope`, `ownedRequirementIds`), `src/store/migrations/022_requirement_scope.sql` (schema 22), `src/domain/plan.ts`, `src/intake/service.ts`, Pi propose schema (`global`), automation-design skill.
- Design: a task with ownership carries owned + global + unowned-mandatory requirements. Legacy tasks without ownership keep everything (all 30 live tasks are legacy, so their behaviour is unchanged). Dependencies contribute only the attempt behind the accepted revision, and superseded attempts are counted and named as retrievable. The review-context fingerprint gains a `global` marker only when set.
- Validation: v5 CTX-02 (3 tests in `context-budget.test.ts` plus 1 in `intake-v5.test.ts`). The size effect is unmeasured; the brief calls it a larger-project optimization, not the cause of the small-benchmark gap.

### CTX-03
- Not started, by design: compatible repair resume already exists, and cross-task continuation stays deferred until evidence supports it.

### Phase 3 migration rehearsal
- A fresh copy of the live schema-18 database through `maintenance migrate`: 18 → 22, backup integrity ok, restore rehearsal at 22 with rows preserved. Config fingerprints are as before (the same single pre-existing difference).

### Phase 3 summary
- Tests 474/474, both typechecks clean.
- Unverified live: V3-PARITY, V3-PLAN and V3-INTAKE (see the validation checklist).
