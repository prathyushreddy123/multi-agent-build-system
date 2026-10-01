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
| INT-01 | needed | `src/intake/service.ts:95` `askClarifications` returns `{brief, open}` and drops the `addClarification` records; `mabs_answer_clarification` needs `clarificationId` | 1 |
| INT-02 | needed | only single-answer `resolveClarification` (`store.ts:565`); no request-ID idempotency table exists | 1 |
| INT-03 | partial | brief governance already exists via `mabs_update_brief` (`projectType`/`reviewChoice`); `mabs_set_project_governance` requires a registered project, and its error does not point to the brief operation | 1 |
| INT-04 | partial | the parts exist: `bootstrapProject`/`resumeBootstrap` with `resumableBootstrapRun`, and `submitAcceptedPlan` idempotent via `planSubmissions`. The single resumable start operation is missing | 1 |
| OUT-01 | needed | `.pi/extensions/mabs.ts:13,24` slices the CLI output at 12,000 chars, possibly mid-record; `mabs-ux.ts` changes display only | 1 |
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
