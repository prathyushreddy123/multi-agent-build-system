# Phase 1 completion summary — reliable local task

Completed: 18 September 2026

## Implemented

- Authoritative SQLite records for projects, stable requirements, tasks, dependencies, attempts, events, quality gates, approvals, routing, context manifests, health, and controller lease.
- Transactional state/event updates, atomic task claims, optimistic record versions, and explicit retry/cancel controls.
- Isolated Git branches and worktrees with controller-owned local commits.
- Provider-independent handoff packets containing requirements, acceptance criteria, dependency summaries, revisions, scope, and execution selection.
- Detached Claude and Codex adapters implementing start, status, cancel, and result collection.
- Restart reconciliation through persisted process IDs and atomic completion envelopes.
- Strict worker contracts and separate code, authentication, quota, infrastructure, configuration, contract, cancellation, and timeout failures.
- Two-cycle default repair bound; only code failures consume it.
- Deterministic registered checks with PASS/FAIL/ERROR/SKIPPED records, logs, tool versions where configured, and final-revision binding.
- Action/target/revision/configuration-bound approval records and stale-approval invalidation primitives.
- Worker/project limits, dependency promotion, basic cross-project fairness, health heartbeat, queue age, and worker utilization.
- Localhost-only web workbench with overview, task details API, approval controls, cancellation, safe rendering, and mutation token.
- CLI for onboarding, requirements, tasks, controller operation, approvals, workbench, verification, baseline, backup, and retention.
- Retention policy: database summaries indefinitely, completed artifacts 30 days, failed/cancelled artifacts 90 days, active/blocked artifacts indefinitely; pruning is dry-run by default.
- Consistent SQLite backup command retaining the newest 14 copies.
- Thin Pi extension exposing status, project/task commands, controller/workbench startup, backup, and scoped status/task tools.
- Single-controller SQLite lease with stale-generation takeover.

## Exit evidence

### Real accepted task

Task `tsk_01M2SARKTF7G65KSZWXNJ6VWPE` was executed through the Codex subscription adapter and reached `DONE`.

- Final revision: `f0ce9fb2030653798b7554d7f274b42bd4a6b92b`
- Registered test gate: `PASS`
- Evidence: `~/.local/state/mabs/acceptance/2026-09-18T04-00-31Z`

The first attempt exposed that a sandboxed worker cannot update linked-worktree Git metadata. Commit ownership was moved to the controller, an optimistic-version retry was issued, and the same preserved worktree completed successfully.

### Real crash/restart recovery

A controller process was killed while a real Claude worker was active.

- The detached worker remained alive.
- A fresh controller generation took over the stale lease.
- It collected the original completion envelope.
- Attempt count remained exactly one; no duplicate was dispatched.
- Claude returned a genuine subscription session limit, correctly producing `BLOCKED` with failure class `QUOTA` and no repair-budget charge.
- Evidence: `~/.local/state/mabs/acceptance/restart-2026-09-18T04-15-35Z`

## Verification

- `npm test`: 16 passing tests.
- `npm run typecheck`: passing.
- Phase 0 quick authentication and paid-fallback checks: 3/3 passing.
- Pi RPC extension-load check: all six MABS slash commands registered.

## Deferred by plan

Independent AI review and the complete dashboard feedback workflow remain Phase 3 work. No Phase 1 result should be represented as independently reviewed.
