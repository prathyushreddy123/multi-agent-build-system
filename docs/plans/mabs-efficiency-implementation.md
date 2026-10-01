# MABS efficiency implementation ledger (v5)

Source: *MABS efficiency implementation brief*, v1, 1 October 2026, reviewed against main `b1a2578`.
Branch: `mabs/efficiency-v5`, worktree `~/worktrees/mabs-v5`, based on `b89e7ce` (`b1a2578` plus the docs alignment commit).
Live progress: [mabs-efficiency-progress.md](mabs-efficiency-progress.md). Cleanup findings: [cleanup-audit.md](cleanup-audit.md).

Status vocabulary: **needed**, **partial**, **satisfied**, **contradicted**, **done** (implemented on this branch), **unverified** (built, but live proof not run).

## Authorized scope (2026-10-01)
- Phase 0 and Phase 1 only. Stop with a report before Phase 2.
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
| PLAN-01 | needed | no fragmentation diagnostics in `src/domain/plan.ts`; `ownedRequirements` exists in the domain (11 refs) but not in the Pi task schema | 2 |
| EXEC-01 | needed | `src/worker-tools/checks-mcp.ts` serves registered checks only; no named recipes | 2 |
| ROUTE-01 | needed | `src/routing/router.ts:173` only sorts by `preferredAdapter`; there is no pinned mode | 2 |
| CTX-01 | needed | `src/context/packet.ts:374` measures `workerInputBytes` on `JSON.stringify(…, null, 2)`, while the sent prompt is compact | 2 |
| GOV-01 | needed | no standing delivery-mode preference with provenance | 3 |
| UX-01 | partial | status bar exists (`mabs.ts:39`); no coalesced controller progress | 3 |
| CTX-02 | needed | `packet.ts:113` loads every project requirement into each packet | 3 |
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
