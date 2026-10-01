# MABS efficiency v5: live validation checklist

Checks that the offline test suite cannot prove: provider permission behaviour, real routing outcomes, model behaviour, and usage. Offline tests still run after every phase. This file tracks only checks that need a real provider, a real Pi session, or a benchmark.

Rules (from the brief): subscription routes only, no paid API or extra-usage activation, stop at the first quota signal, historical benchmark rows are never rewritten, and a savings claim needs comparable runs. Every check runs against an isolated scratch state (`MABS_DB_PATH`, `MABS_STATE_DIR`, `MABS_WORKTREE_ROOT`), never the live database.

Status: `pending`, `passed`, `failed`, `skipped` (with reason). Evidence lives in `docs/plans/evidence/` unless noted.

## Schedule

| When | Checks | Approved budget |
|---|---|---|
| After Phase 2 | V2-ROUTE, V2-EXEC | ≤ 1 worker attempt (2026-10-01) |
| After Phase 3 | V3-PARITY, V3-PLAN, V3-INTAKE, V3-GOV, V3-FEED | ≤ 5 attempts plus one Pi planning session; propose before running |
| After Phase 4 | V4-REVIEW | propose before running |

## Checks

| ID | Requirement | Procedure | Expected | Cost | Status | Evidence | Commit |
|---|---|---|---|---|---|---|---|
| V2-ROUTE | ROUTE-01 | Scratch project with one small task; mark Codex in cooldown; `controller once --pin-adapter=codex` with both real adapters configured | No attempt starts on any provider; the task is `BLOCKED` with `QUOTA`, and the reason says no other provider is substituted | 0 provider calls | passed (2026-10-01): 0 attempts in the whole scratch DB. Pinned Claude in cooldown → `BLOCKED/QUOTA`. Pinned Codex without a verified entitlement → `BLOCKED/CONFIG` (the real state of this machine). Neither substituted a provider. | [v2-route.json](evidence/v2-route.json) | `792de94` |
| V2-EXEC | EXEC-01, CTX-01 | Bootstrap a scratch JavaScript project (registers checks and a `run` recipe); one small implementation task whose acceptance needs running the CLI; `controller run --pin-adapter=claude --effort=low`, review off | The worker finishes; `permission_denials` = 0; the checks log shows `run_recipe` and/or `run_checks` calls; the controller's checks pass on the result revision; `attempt.prompt_prepared` matches the sent prompt | 1 Claude worker attempt | passed (2026-10-01): 1 Claude attempt, 11 turns, **0 denials, 0 tool errors**. The worker called `run_recipe run greet Ada` (exit 0) and then `run_checks` (both PASS). Controller gates PASS on `73527f8`. Packet bytes = launch bytes (6,928). | [v2-exec.json](evidence/v2-exec.json) | `792de94` |
| V3-PARITY | BENCH-01..03, all efficiency items | Habit-tracker fixture, FAST lane: MABS + Claude vs direct Claude, same accepted spec, model, effort, starting repo and checks, no AI review; full lifecycle including repairs | Hidden checks pass on both; usage reported per stage with unknowns kept unknown; n=1 result reported as such, not as a savings claim | about 3–4 attempts plus Pi planning | passed with findings (2026-10-01): the lifecycle completed after a mid-run scope fix; MABS 17/18 hidden, direct 18/18. Cache-inclusive input: Pi 221K (v4 405K), workers 577K for 2 model tasks plus 294K for the scope-bug attempt; lifecycle 1.50× direct excluding the bug attempt, 2.05× including it (v4 1.88×). n=1, within run-to-run variation; not a savings claim. | [v3-parity.json](evidence/v3-parity.json) | `8dd8b3d`/`6fca9f0` |
| V3-PLAN | PLAN-01 | In the V3-PARITY Pi conversation, observe the proposed plan | The small habit tracker is one task with tests, or the split states a concrete reason | included in V3-PARITY | **failed** (2026-10-01): Pi proposed 3 tasks (implement → tests → README). The README task drew a fragmentation warning that Pi neither acted on nor mentioned; the tests task was not flagged because its scope included package.json. | [v3-parity.json](evidence/v3-parity.json) | `8dd8b3d` |
| V3-INTAKE | INT-01..04, OUT-01 | In the V3-PARITY Pi conversation, count intake tool calls and errors | No guessed clarification IDs; answers batched through `mabs_resolve_intake`; work started with one `mabs_start_work`; no truncated tool output | included in V3-PARITY | partial (2026-10-01): 11 model calls, **0 tool errors** (v4: 9 failed calls), real clarification IDs, no truncation. But Pi used 4 single-answer calls instead of `mabs_resolve_intake` (one model call, so no extra turn) and used bootstrap + submit instead of `mabs_start_work`. | [v3-parity.json](evidence/v3-parity.json) | `8dd8b3d` |
| V3-GOV | GOV-01 | After the merge and migration, set `preferences set-delivery fast`; start a personal idea in Pi | Pi never asks the review question; the plan summary includes the one-line VERIFIED offer | included in V3-PARITY | pending | | |
| V3-FEED | UX-01 | During V3-PARITY, watch the Pi status line and notices while the controller runs | The status line updates without a model turn; one notice when the task finishes | 0 extra | not observable in print mode; found and fixed a crash (stale extension context after session compaction made Pi exit 1, `8dd8b3d`). Check the status line in your next interactive Pi session. | — | `8dd8b3d` |
| V4-REVIEW | REV-01..03 | Independent review of a completed revision, with one forced reviewer outage | To be specified with Phase 4 | to be proposed | pending | | |

## Findings from live checks

- **Codex is not entitlement-verified on this machine** (`capability-entitlements.json` is absent). Codex routes are ineligible, so `--pin-adapter=codex` blocks as `CONFIG`, and any project needing an `independent_provider` reviewer has no second provider. `routing verify-entitlement codex gpt-5.6-sol` (one real Codex call) would fix this; it is the user's decision.
- **Claude loads MCP tools lazily:** the worker spent one turn on `ToolSearch` before calling `run_recipe`/`run_checks`. This was not a denial. Telling the worker the exact tool names, or preloading them if Claude Code allows it, could save that turn. Recorded for later and not acted on.
- **Scope globs (fixed `6fca9f0`):** Pi wrote `allowedScope: ["src/**"]`. Validation accepted it and enforcement treated it literally, so the first worker's in-scope change was rejected as CONTRACT.
- **Recovery after a CONTRACT scope failure needs an operator:** the worktree keeps the rejected change, and a retry refuses to start until someone cleans it. This is safe, but manual.
- **False completion of "mechanical" tasks (open, high):** the README task was classed `mechanical`, ran registered checks without a model, and became DONE with the README still the bootstrap stub. Any authoring task Pi labels mechanical is "completed" without the work.
- **Advisory guidance is not followed:** Pi ignored the fragmentation warning, and it preferred the older fine-grained tools (`mabs_answer_clarification`, `mabs_bootstrap_project` + `mabs_submit_plan`) over the new composite ones.
- **Standing preference applied to an inferred project type:** see V3-GOV.
