# Command reference

[Documentation](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

Run commands from the MABS checkout. This is a curated reference; `node src/cli.ts help` lists all commands. Replace `TASK_ID`, `PROJECT_ID`, `PROJECT`, and other uppercase placeholders before using an example. `PROJECT` is a registered name or ID; `--project=PROJECT_ID` filters require the actual ID.

## Inspect without starting workers

| Command | Shows |
| --- | --- |
| `node src/cli.ts status` | Queue, controller health, and provider state |
| `node src/cli.ts project list` | Registered projects, IDs, checks, and policies |
| `node src/cli.ts task list --project=PROJECT_ID` | Tasks for one project |
| `node src/cli.ts task show TASK_ID` | Attempts, routing, gates, reviews, and diagnostics |
| `node src/cli.ts plan show PLAN_ID` | A stored plan and its task dependencies |
| `node src/cli.ts provider list` | Provider availability and configured capacity |
| `node src/cli.ts project review PROJECT` | The resolved review policy |
| `node src/cli.ts review decide TASK_ID` | Why a task does or does not need review |
| `node src/cli.ts profile inspect /absolute/path/to/repo` | Detected components, checks, and setup needs |
| `node src/cli.ts ui` | Localhost workbench; does not start dispatch, but its controls can mutate records |
| `node src/cli.ts operator probe` | Pi, Herdr, viewer, and worktree capabilities of the installed tools ([details](operator/phase-0-capabilities.md)) |

Inspection commands do not launch workers. Commands that open MABS records can initialize or migrate the local database; they are not a promise of zero filesystem writes.

## Control work

**These change state or start real execution.** Inspect pending work before starting a controller: it can dispatch any eligible task in its state directory.

| Command | Effect |
| --- | --- |
| `node src/cli.ts controller run --workers=1 --ui` | Run the loop and workbench, using policy-based routing |
| `node src/cli.ts controller run --adapter=codex --workers=1 --ui` | Prefer Codex through an explicit operator override |
| `node src/cli.ts controller once` | Reconcile and dispatch one cycle; **not** a dry run |
| `node src/cli.ts project status PROJECT paused` | Prevent new dispatch for this project; does not cancel existing workers |
| `node src/cli.ts project status PROJECT active` | Allow the project to progress |
| `node src/cli.ts task retry TASK_ID --version=N` | Retry a blocked/failed task using its latest record version |
| `node src/cli.ts task cancel TASK_ID --version=N` | Cancel the task and its worker process group |
| `node src/cli.ts provider reset codex` | Clear recorded provider unavailability after fixing the cause |

For submission, use the scoped example in [Getting started](getting-started.md#3-register-the-project-and-task). For retry/cancel decisions, use [Troubleshooting](troubleshooting.md#retry-or-cancel-deliberately).

### Concurrency controls

Flags on `controller run` or `controller once`:

| Flag | Controls |
| --- | --- |
| `--workers=N` | Global worker limit |
| `--active-projects=N` | Active-project limit |
| `--per-project-workers=N` | Per-project worker limit |
| `--codex-limit=N`, `--claude-limit=N` | Provider capacity limits |
| `--min-free-memory-mb=N` | Pause dispatch below a free-memory threshold |
| `--max-load-per-cpu=N` | Pause dispatch above a load threshold |

Parallel tasks also need compatible execution modes and disjoint edit scopes. More slots cannot bypass that rule or a provider's actual subscription limits.

## Plans, review, and optional operations

| Command | Effect |
| --- | --- |
| `node src/cli.ts plan validate plan.json` | Validate a local execution-plan file; does not apply it |
| `node src/cli.ts plan apply PROJECT plan.json` | Create plan/task records from a valid file; a running controller can dispatch them |
| `node src/cli.ts review request TASK_ID` | Record a manual review request; does not itself prove review happened |
| `node src/cli.ts product show BRIEF_ID` | Show the brief, pending decisions, work, and next actions |
| `node src/cli.ts ops status PROJECT` | Inspect effective optional-operation settings |
| `node src/cli.ts ops prepare PROJECT ci` | Prepare a dry-run plan; does not write provider config or enable CI |
| `node src/cli.ts optimization routing PROJECT` | Inspect recorded routing outcomes, not remaining quota or actual spend |

`ops prepare` also accepts `deployment`, `monitoring`, `scheduling`, `delivery`, and `costs`. None of these preparations executes an external action.

Use the [curator guide](curator.md) for configuration proposal, approval, activation, and revert commands. Review changes can weaken safeguards: inspect the resolved policy and required acknowledgment rather than turning review off to clear a blocker.

## Maintenance

| Command | Effect |
| --- | --- |
| `node src/cli.ts maintenance policy` | Show retention defaults |
| `node src/cli.ts maintenance backup` | Create a consistent SQLite copy; rotate old backups beyond the newest 14 |
| `node src/cli.ts maintenance prune` | Preview eligible artifact deletion; dry-run by default |
| `node src/cli.ts maintenance prune --apply` | **Delete** eligible artifact files after you have reviewed the preview |

Database records are retained indefinitely. Attempt artifacts become eligible after 30 days for successful tasks or 90 days for failed/cancelled tasks. Active and blocked task artifacts are not eligible under this policy. A SQLite backup does not back up all artifact files or task worktrees.

See [state locations and overrides](getting-started.md#where-things-live) and the [retention implementation](../src/maintenance/retention.ts).

## Verification is not all the same

- `npm test` and `npm run typecheck`: local repository checks.
- `node src/cli.ts verify --quick`: checks both provider logins and paid-API environment scrubbing; writes local evidence.
- `node src/cli.ts verify`: includes real provider probes and consumes subscription capacity.
- `node src/cli.ts baseline`: runs model-backed comparison tasks; not a lightweight health check.

Do not use the full verification or baseline commands as a routine documentation check.
