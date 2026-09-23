# Operator workspace — Tasks and recorded steps

[Documentation](../index.md) · [Operator workspace](index.md) · [State reference](../architecture/state-reference.md)

A read-only view of what the controller has recorded: tasks, attempts, steps, dependencies, blocked reasons, and freshness.

```bash
node src/cli.ts task watch                     # live dashboard
node src/cli.ts task watch --project=PROJECT_ID
node src/cli.ts task watch --once              # one frame, for a non-TTY caller
node src/cli.ts task watch --json              # the whole snapshot
node src/cli.ts task steps TASK_ID             # recorded steps for one task
```

From Pi: `/mabs-progress` and `/mabs-steps <task>`.

| Key | Effect |
| --- | --- |
| `↑` `↓` / `k` `j` | Move the selection |
| `PgUp` `PgDn` | Page |
| `Enter` | Show or hide the selected task's recorded steps |
| `f` | Toggle a filter down to active, blocked, and failed |
| `q` / `Esc` / `Ctrl+C` | Quit **this dashboard only** |

## It is read-only

The dashboard reads `tasks`, `attempts`, `task_checkpoints`, `gate_results`, `review_results`, `events`, `approvals`, and `controller_health`. It never dispatches, claims, transitions, retries, or cancels anything, and it adds no second store or scheduler. A test asserts that building a snapshot repeatedly leaves the task record, its events, and its attempts byte-identical.

`Ctrl+C` closes the view. Workers keep running.

## Groups keep the real state

Tasks are grouped for display, and the authoritative state is always carried alongside. Grouping is not a replacement for the [state machine](../architecture/state-reference.md).

| Group | States |
| --- | --- |
| `active` | `RUNNING`, `CHECKING`, `REVIEWING` |
| `ready` | `READY` |
| `waiting` | `QUEUED`, `AWAITING_APPROVAL` |
| `blocked` | `BLOCKED` |
| `failed` | `FAILED`, `CANCELLED` |
| `completed` | `DONE` |

## Steps

Steps are assembled from records the controller already writes:

| Source | Step |
| --- | --- |
| `attempts` | one per attempt, with the provider and model actually selected, its state and duration |
| `task_checkpoints` | `implementation_complete`, `repair_complete`, `checks_passed`, `checks_failed`, `review_approved`, `review_request_changes`, `review_blocked`, `review_pending`, `review_failed`, `worker_blocked`, `attempt_failed`, `quality_not_configured` |
| `gate_results` | one per recorded check, with its status, revision, and duration |
| `review_results` | one per review, with its verdict and blocking-finding count |

Each step has a stable ID, so polling the same task repeatedly can never duplicate or reorder history. **A retry adds a new attempt's steps; it never overwrites the previous attempt's.** Attempt 1's failing check stays visible next to attempt 2's passing one.

Steps reference evidence by path. A path that is no longer on disk is listed under `missingEvidence` and surfaced as a note, rather than shown as if it were readable.

## What is not instrumented

The controller records a checkpoint at every boundary it owns, so the gap is not "no steps". The gap is **progress inside a running attempt**: the worker reports its result at the end, so while it runs only the attempt's start and its heartbeat are known.

The dashboard says so:

```
unavailable: Progress inside the running attempt is not instrumented. The worker
reports its result at the end, so only the attempt's start and heartbeat are known
while it runs.
```

No step is inferred from a worker's prose, and no completion is estimated. Closing this gap would need an executor-side contract emitting progress with a stable execution ID (the attempt ID) and a monotonic sequence, persisted by the controller so it stays the owner of accepted transitions. That is not implemented; it is described so a future change has a shape to follow.

## Honest reporting

- **Counts, not progress.** `12 completed` is a count of recorded completions. The dashboard never renders a percentage, an estimate, or "work remaining".
- **Completion is not delivery.** A task can be `DONE`, checked, and reviewed and still be `delivery: not requested`. Delivery tracks approvals for `merge`, `push_branch`, `deploy`, `publish`, and `release`, and reports `approval pending`, `approved`, `rejected`, or `consumed`.
- **Check and review outcomes stay separate** from both. A passing check does not imply an approved review.
- **Provider availability is `unknown`** unless a capacity or health record supports a claim. A provider seen only in an attempt's routing is reported as unknown, not as available.
- **A stale heartbeat is not proof of failure.** It is flagged with the age, and the note says to inspect the worktree and evidence before retrying.
- **Controller freshness is explicit.** With no health record the state is `unknown` and marked stale, with the reason that the figures are the last thing written to the store. After a restart or disconnection the heartbeat age says how far behind the view is.

## Refresh behaviour

Polling is bounded, once per second by default (`--interval`), and only while the dashboard is running. Across a refresh:

- the selection follows the **task ID**, not the row index, so inserted, removed, or reordered rows leave the highlighted task where it was;
- the scroll offset is clamped rather than reset, and adjusted only enough to keep the selection on screen;
- if the selected task disappears, the selection falls to the nearest row rather than jumping to the top.
