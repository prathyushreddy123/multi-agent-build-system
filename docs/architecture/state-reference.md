# Task state reference

[Visual guide](index.md) · [Task execution](task-execution.md) · [Recovery and failures](recovery-and-failures.md)

**Developer reference:** this table lists the allowed state changes in [`src/domain/states.ts`](../../src/domain/states.ts). It is not a promise that every transition is exposed as a CLI command. The controller and records layer apply additional conditions.

For the normal path, read [Task execution](task-execution.md) instead of tracing every possible transition.

## State meanings

| State | Meaning |
| --- | --- |
| `QUEUED` | Waiting for prerequisites or an active project. |
| `READY` | Eligible for dispatch when resources and a route are available. |
| `RUNNING` | Implementation or repair is in progress. |
| `CHECKING` | Quality checks are being applied to a revision. |
| `REVIEWING` | The revision is being independently reviewed. |
| `AWAITING_APPROVAL` | Waiting for a decision at an approval boundary. |
| `BLOCKED` | Cannot proceed; inspect the recorded reason. Some pending reviews resume automatically. |
| `DONE` | This task's completion path finished. Not a merge or deployment. |
| `FAILED` | The run failed, for example after exhausting its repair budget. |
| `CANCELLED` | The task was cancelled. |

## Complete transition table

The order within each cell follows the source matrix. `—` means no outgoing transition.

| From | Allowed next states |
| --- | --- |
| `QUEUED` | `READY`, `BLOCKED`, `CANCELLED` |
| `READY` | `RUNNING`, `BLOCKED`, `QUEUED`, `CANCELLED` |
| `RUNNING` | `CHECKING`, `AWAITING_APPROVAL`, `BLOCKED`, `FAILED`, `CANCELLED`, `READY` |
| `CHECKING` | `REVIEWING`, `RUNNING`, `AWAITING_APPROVAL`, `BLOCKED`, `FAILED`, `CANCELLED`, `DONE` |
| `REVIEWING` | `RUNNING`, `AWAITING_APPROVAL`, `DONE`, `BLOCKED`, `FAILED`, `CANCELLED` |
| `AWAITING_APPROVAL` | `RUNNING`, `CHECKING`, `REVIEWING`, `READY`, `BLOCKED`, `DONE`, `FAILED`, `CANCELLED` |
| `BLOCKED` | `READY`, `QUEUED`, `RUNNING`, `REVIEWING`, `FAILED`, `CANCELLED` |
| `DONE` | — |
| `FAILED` | `QUEUED`, `READY`, `CANCELLED` |
| `CANCELLED` | `QUEUED` |

## Important distinctions

- The source classifies `DONE`, `FAILED`, and `CANCELLED` as **terminal for the current run**. Explicit recovery can still leave `FAILED` or `CANCELLED` through the listed transitions. `DONE` has no outgoing transition.
- `RUNNING`, `CHECKING`, and `REVIEWING` are the domain's **slot-holding states**. Actual dispatch also checks live attempts, project/provider limits, scope overlap, and machine pressure.
- Cancellation is allowed from every non-terminal state. Stopping the controller is not the same as cancelling a task.
- Approval boundaries can occur in `RUNNING`, `CHECKING`, or `REVIEWING`; approval handling must preserve the requesting context rather than always assuming `RUNNING`.
- State alone does not tell you whether quality coverage exists. Inspect gates, review records, and the result revision as well.

**Maintaining this page:** whenever `TASK_STATES` or `TRANSITIONS` changes, compare every row with the source. Keep scenario diagrams intentionally smaller than this complete reference.
