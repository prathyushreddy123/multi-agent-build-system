# Closeout summary — pre-routine-use acceptance checklist

Completed: 18 September 2026

## Why this exists

The source plan's phase table (`docs/requirements/source-plan.txt`) defines exactly six phases, 0 through 5. All six are complete and published as of Phase 5 (`7516bd6`). This closeout is not a new numbered phase; it closes the three remaining items from the plan's own "Acceptance scenarios before routine use" and "Additional acceptance checks" sections that had not yet been explicitly demonstrated with dedicated evidence.

## Delivered

### Stale-heartbeat investigation before declaring failure

- `Records.staleHeartbeatAttempts(thresholdMs)` reports running attempts whose heartbeat is older than a configurable threshold (controller default 10 minutes), independent of whether the controller is actively ticking.
- `taskDiagnostics` surfaces a stale heartbeat as an explicit, actionable warning; it never auto-fails or auto-blocks a task on heartbeat age alone, matching "a long tool run may still be active."
- The controller reports a deduplicated `worker.heartbeat_stale` event and a `stale_heartbeat_workers` count in `controller_health` (schema v10); an attempt is reported once, not on every tick.
- CLI `status`, the Pi status line, and the workbench "Active workers" table all surface the count/flag.

### Many inactive projects alongside active ones

- Paused projects (`project status <id> paused`) are excluded from task promotion; their tasks remain `QUEUED` indefinitely and are never dispatched, confirmed with both a synthetic multi-project test and a real CLI run against five paused projects.
- The existing active-project limit and fair scheduler continue to guarantee that active projects do not starve each other; this was already covered by Phase 2 tests and is unaffected by the number of paused registrations.

### Database/lease error visibility

- A tick that cannot confirm controller ownership (simulated SQLite/lease failure) increments a durable `db_errors` counter, writes `state: "degraded"` to `controller_health`, and does not dispatch a duplicate attempt or lose task ownership.
- The counter remains visible after recovery so an operator can see that an outage occurred even once the controller is healthy again.

## Verification

```text
npm test                         44 passing
npm run typecheck                passing
git diff --check                 passing
node src/cli.ts verify --quick   3/3 passing
```

New tests (`test/closeout.test.ts`):

- a stale heartbeat is surfaced as a warning without auto-failing the task;
- a controller tick reports and deduplicates stale-heartbeat health across ticks;
- many registered inactive projects consume no model calls while two active projects both complete without starving;
- a simulated database/lease error is counted, surfaces as degraded, and does not lose task ownership or duplicate dispatch.

## Real acceptance

Six real projects were registered via the CLI against real Git repositories: five set to `paused`, one left `active` with a real bug-fix task. The active task ran against the real Codex subscription CLI to completion (`resultRevision c10a00479942490953fec35bfbe29a66eab00a41`, correct in-scope fix). All five paused-project tasks remained `QUEUED` with zero attempts throughout, confirming no model call was made for any inactive project. `mabs status` correctly reported `staleHeartbeatWorkers: 0` and `controller_health.stale_heartbeat_workers: 0` on the real on-disk database, confirming the schema v10 migration applied cleanly outside the test suite.

Durable evidence: `~/.local/state/mabs/acceptance/closeout-2026-09-18T16-06-17Z`

No paid API, push, merge, release, deployment, or destructive-action executor was used.

## Status

All six phases (0–5) defined by the source plan and every item on its pre-routine-use acceptance checklist are now complete and demonstrated with evidence. No further numbered phases are defined in the plan. Any future work would be a new, explicitly scoped request rather than a continuation of this plan.
