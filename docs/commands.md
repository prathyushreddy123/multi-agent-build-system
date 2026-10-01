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
| `node src/cli.ts project readiness` | Governance decisions still needed, with the command to answer; nothing is defaulted |
| `node src/cli.ts task scorecard TASK_ID` | Review label (approved vs not required), quality, usage coverage, requested/configured/reported model and effort |
| `node src/cli.ts task timeline TASK_ID --limit=50` | Paged event history with evidence paths |
| `node src/cli.ts queue explain` | Why each waiting task is waiting |
| `node src/cli.ts scheduler explain TASK_ID` | The admission decision for one task under the current active work |
| `node src/cli.ts routing capabilities` | The versioned model/effort/quota-domain registry, with recorded entitlement proofs applied |
| `node src/cli.ts routing explain TASK_ID` | Recorded route decisions plus a launch-free dry selection |
| `node src/cli.ts obligation list TASK_ID` | Durable findings and decisions with their lifecycle |
| `node src/cli.ts improvements PROJECT` | Incidents, curator recommendations, experiments, and proposals |
| `node src/cli.ts telemetry status` | Optional export state; disabled unless configured |
| `node src/cli.ts plan list [--project=PROJECT_ID]` | Stored execution plans |
| `node src/cli.ts incident list [--project=PROJECT_ID]`, `incident show INCIDENT_ID` | Recorded systemic incidents and their lifecycle |
| `node src/cli.ts feedback list [--project=PROJECT_ID]` | Durable task and plan feedback |
| `node src/cli.ts brief list`, `brief show BRIEF_ID` | Product briefs from conversational intake |
| `node src/cli.ts ops runs PROJECT` | Recorded optional-operation attempts and recovery state |
| `node src/cli.ts curator list [PROJECT]`, `curator history PROJECT` | Configuration proposals and version history |

Inspection commands do not launch workers. Commands that open MABS records can initialize a new local database, but never migrate an existing one: a database behind this build's schema is refused with an instruction to run `maintenance migrate`. They are not a promise of zero filesystem writes.

## Control work

**These change state or start real execution.** Inspect pending work before starting a controller: it can dispatch any eligible task in its state directory.

| Command | Effect |
| --- | --- |
| `node src/cli.ts controller run --workers=1 --ui` | Run the loop and workbench, using policy-based routing |
| `node src/cli.ts controller run --adapter=codex --workers=1 --ui` | Prefer Codex through an explicit operator override; another provider may still run it, with the fallback recorded |
| `node src/cli.ts project recipes PROJECT [--set='[...]' \| --clear]` | List or replace the named commands workers may run to try the program (`name`, `description`, `command` argv, `maxArgs`, optional `cwd`, `timeoutMs`, `env`). A change is a new configuration version. Output is exploratory, never acceptance evidence |
| `node src/cli.ts controller run --pin-adapter=codex --workers=1 --ui` | Run implementation and repair only on Codex; when it cannot run, tasks wait or block instead of moving to Claude. Reviews are not pinned |
| `node src/cli.ts controller once` | Reconcile and dispatch one cycle; **not** a dry run |
| `node src/cli.ts controller run --ui --port=4318` | Serve the workbench on another port |

A second `controller run` or `controller once` refuses to start while a live controller holds the lease, and exits 0. `--force` overrides that check for recovery; the lease still allows only one controller to dispatch. `MABS_ADAPTER=claude|codex` sets the default for `--adapter`.

| Command | Effect |
| --- | --- |
| `node src/cli.ts project status PROJECT paused` | Prevent new dispatch for this project; does not cancel existing workers |
| `node src/cli.ts project status PROJECT active` | Allow the project to progress |
| `node src/cli.ts project status PROJECT archived` | Archive a project |
| `node src/cli.ts project base PROJECT BRANCH` | Change the target branch and invalidate open approvals |
| `node src/cli.ts project preset PROJECT experiment\|personal\|client [--acknowledge-weakening]` | Apply a review preset; weakening review needs the acknowledgment flag |
| `node src/cli.ts approval request TASK_ID ACTION TARGET --reason=...` | Request a revision-bound approval |
| `node src/cli.ts approval approve\|reject APPROVAL_ID --by=NAME` | Decide an approval; approving does not execute anything |
| `node src/cli.ts feedback add task\|plan ID KIND --body=... --version=N` | Record durable feedback; `feedback answer ID --response=...` answers it |
| `node src/cli.ts task retry TASK_ID --version=N` | Retry a blocked/failed task using its latest record version; refused while a worker attempt is unresolved |
| `node src/cli.ts task cancel TASK_ID --version=N` | Cancel the task and its worker process group |
| `node src/cli.ts provider reset codex` | Clear recorded provider unavailability after fixing the cause |
| `node src/cli.ts routing verify-entitlement codex gpt-5.6-sol` | **One real provider call** on that exact registered route; only a clean answer records entitlement, making its routes eligible |
| `node src/cli.ts obligation decide OBLIGATION_ID --answer=... --by=NAME` | Answer a blocking review decision; resuming is a separate `task retry` |
| `node src/cli.ts incident import-history --dry-run` | Project systemic incidents from history; drop `--dry-run` to record them (idempotent) |
| `node src/cli.ts incident verify INCIDENT_ID --cause=... --fix=REF --test=REF --by=NAME` | Mark a lesson verified; requires fix and test evidence |
| `node src/cli.ts incident hypothesize INCIDENT_ID --text=... --confidence=low\|medium\|high --by=NAME` | Record a hypothesis about a cause |
| `node src/cli.ts incident supersede INCIDENT_ID --reason=... --by=NAME` | Retire an incident in favor of a newer understanding |

For submission, use the scoped example in [Getting started](getting-started.md#3-register-the-project-and-task).

### Registration and submission flags

`project add NAME REPO`:

| Flag | Meaning |
| --- | --- |
| `--type=personal\|client\|other` | Required before dispatch; never defaulted |
| `--delivery=fast\|standard\|verified` or `--review=off\|risk\|required` | Required before dispatch (a `client` project defaults to `required`); a conflicting pair is refused |
| `--base=BRANCH` | Target branch; defaults to the repository's current branch |
| `--goal=...` | Project goal recorded with the project |
| `--no-checks` | Skip check discovery |
| `--by=NAME` | Who made the governance decision (default `local-cli`) |

`task add PROJECT TITLE --objective=...`:

| Flag | Meaning |
| --- | --- |
| `--accept="A;B;C"` | Acceptance criteria, separated by `;` |
| `--scope=a,b` | Allowed edit scope; edits outside it are a `CONTRACT` failure |
| `--class=...` | `mechanical`, `small_implementation`, `complex_coding`, `diagnosis`, `planning`, `research`, `review`, `troubleshooting`, or `curation` |
| `--complexity=`, `--ambiguity=`, `--risk=`, `--context-size=` | `low\|medium\|high`; high complexity, risk, or context escalates a small implementation to the complex-coding route |
| `--depends=ID,ID` | Prerequisite task IDs; their results are integrated into this task's worktree |
| `--tools=a,b` | Required tools; routes without them are rejected |
| `--mode=single`, `--mode-reason=...` | Execution mode and why |
| `--priority=N` | Dispatch priority (default 100) |
| `--repair-limit=N` | Code-repair budget (default 2) |
| `--language=`, `--domain=`, `--role=` | Recorded context; not used to claim provider expertise |
 For retry/cancel decisions, use [Troubleshooting](troubleshooting.md#retry-or-cancel-deliberately).

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
| `--gate-limit=N` | Concurrent check jobs, capped separately from model workers |
| `--capacity-fallback=allow\|wait` | Whether a busy preferred route may move to a free provider (`allow`, the default, records the fallback) |
| `--adaptive` | Opt-in: lower the model-worker target under pressure, raise it after a healthy streak |
| `--model=`, `--effort=low\|medium\|high` | Explicit per-attempt settings; rejected before launch when not in the capability registry |
| `--export=file:/abs/path` or `--export=https://collector` | Optional redacted telemetry export; off by default |

`--workers` defaults to 1, the production setting. One admission authority applies every cap to initial work, repairs, reroutes, reviews, and checks; refused in-flight work waits as `Admission pending:` and resumes first. Parallel tasks also need compatible execution modes, disjoint edit scopes, and distinct named `resources`; two projects on one repository share its lock. More slots cannot bypass those rules or a provider's actual subscription limits.

## Plans, review, and optional operations

| Command | Effect |
| --- | --- |
| `node src/cli.ts plan validate plan.json` | Validate a local execution-plan file; does not apply it |
| `node src/cli.ts plan apply PROJECT plan.json` | Create plan/task records from a valid file; a running controller can dispatch them |
| `node src/cli.ts project governance PROJECT --type=personal --delivery=standard --version=N` | Set the project's rigor: `fast` (checks only), `standard` (checks plus risk-triggered review), or `verified` (checks plus required independent review that blocks when no reviewer can run). Each is exactly `--review=off\|risk\|required`; `project add` accepts the same flag |
| `node src/cli.ts review request TASK_ID` | Record a manual review request; does not itself prove review happened |
| `node src/cli.ts product show BRIEF_ID` | Show the brief, pending decisions, work, and next actions |
| `node src/cli.ts brief ask BRIEF_ID --payload='{"questions":[...]}'` | Record material questions; returns each question's id (`requested`) and all open questions |
| `node src/cli.ts brief resolve BRIEF_ID --version=N --request=ID --payload='{"resolutions":[...],"patch":{...},"summary":"..."}'` | Record several answers or assumptions, plus an optional explicit brief change, all or nothing. Retrying the same `--request` returns the recorded result; a different request under that id is refused. A recorded answer changes only with `"revise":true` |
| `node src/cli.ts brief start BRIEF_ID PROPOSAL_ID --fingerprint=... --request=ID --target=DIR` (or `--project=PROJECT`) | Start the *accepted* plan in one resumable step: bootstrap a new directory and link the plan, or submit it to a registered project. Never accepts a plan; a retry with the same `--request` continues from recorded progress and refuses work whose acceptance or governance changed |
| `node src/cli.ts brief show BRIEF_ID --section=open-questions\|proposal-tasks\|tasks\|outputs\|assumptions --page=N` | One page of a long list that a conversation view omitted |
| `node src/cli.ts ops status PROJECT` | Inspect effective optional-operation settings |
| `node src/cli.ts ops prepare PROJECT ci` | Prepare a dry-run plan; does not write provider config or enable CI |
| `node src/cli.ts optimization routing PROJECT` | Inspect recorded routing outcomes, not remaining quota or actual spend |
| `node src/cli.ts optimization prepare-run EXPERIMENT_ID --dry-run` | Counterbalanced trial manifest, budget, and eligibility; zero provider calls |
| `node src/cli.ts optimization authorize EXPERIMENT_ID --fingerprint=... --by=NAME` | Bind live trials to that exact manifest |
| `node src/cli.ts optimization start-trial EXPERIMENT_ID VARIANT CASE --repeat=N` | Create the next manifest slot's trial task, pinned to the case revision and the variant's route; the controller runs it |
| `node src/cli.ts optimization record-trial EXPERIMENT_ID VARIANT CASE TASK_ID --repeat=N` | Record the bound trial task for that slot once it is at rest, including failed ones |
| `node src/cli.ts optimization budget EXPERIMENT_ID` | Elapsed time, reported usage, and attempts against the authorized budget |
| `node src/cli.ts curator recommend PROJECT` | Evidence-backed remedies for recurring incidents; proposal only |

`ops prepare` also accepts `deployment`, `monitoring`, `scheduling`, `delivery`, and `costs`. None of these preparations executes an external action.

A re-review after a repair checks the repair delta against the open findings rather than the whole change again, while the reviewed context is unchanged. Small changes that are neither high-risk nor highly complex are reviewed at medium effort; an explicit project review route is never overridden.

Use the [curator guide](curator.md) for configuration proposal, approval, activation, and revert commands. Review changes can weaken safeguards: inspect the resolved policy and required acknowledgment rather than turning review off to clear a blocker.

## Maintenance

| Command | Effect |
| --- | --- |
| `node src/cli.ts maintenance policy` | Show retention defaults |
| `node src/cli.ts maintenance backup` | Create a consistent SQLite copy of the database as it is, without migrating it; rotate old backups beyond the newest 14 |
| `node src/cli.ts maintenance migrate` | With the controller stopped: take and verify a pre-migration backup, then upgrade the schema; prints the restore command |
| `node src/cli.ts maintenance prune` | Preview eligible artifact **and task-worktree** deletion; dry-run by default |
| `node src/cli.ts maintenance prune --only=artifacts\|worktrees` | Limit the preview (or `--apply`) to one kind |
| `node src/cli.ts maintenance prune --apply` | **Delete** eligible artifact files and worktree directories after you have reviewed the preview |

Database records are retained indefinitely. Attempt artifacts become eligible after 30 days for successful tasks or 90 days for failed/cancelled tasks. Task worktree directories follow the same 30/90-day ages. Active and blocked tasks are not eligible under this policy. A worktree is **refused**, and listed with the reason, if it has uncommitted changes; if it has no recorded result revision and its branch is not merged into the base branch; or if its project is no longer registered. Only the directory is removed: **branches are never deleted**, so every commit stays reachable, and the removal is recorded as a `worktree.pruned` event. A SQLite backup does not back up all artifact files or task worktrees.

See [state locations and overrides](getting-started.md#where-things-live) and the [retention implementation](../src/maintenance/retention.ts).

Before activating a new engine version on a real database, rehearse it on copies:

```bash
node scripts/validate-execution-upgrade.ts --source /explicit/path/mabs.sqlite --work /new/empty/dir
```

The source is opened read-only; the upgrade and a restore run on copies in the work directory. It exits 0 only when every pre-existing value survives, the copy reaches the supported schema, and the restore matches.

## Operator workspace (Pi slash commands)

These affect presentation only. None of them starts work, changes task state, or reaches a provider. See the [operator workspace](operator/index.md).

| Command | Effect |
| --- | --- |
| `/mabs-display [status\|verbose\|compact\|on\|off]` | `verbose`/`compact`: original tool output or compact summaries. `on`/`off`: enable or disable the presentation layer, then `/reload`. Persists across sessions |
| `/mabs-files [TASK]` | Browse every file in a task worktree |
| `/mabs-changes [TASK]` | Changed files with their categories, renames, and deletions |
| `/mabs-open TASK PATH --line=N` | Open a file in the Code surface |
| `/mabs-diff TASK PATH` | Diff a file against the task's recorded base revision |
| `/mabs-progress` | Read-only task, attempt, and recorded-step view |
| `/mabs-steps TASK` | Recorded implementation steps for one task |
| `/mabs-logs TASK [--evidence=ID]` | List or open the original evidence for a task |
| `/mabs-workspace [open\|status\|close]` | Create or recover the Agent, Code, Tasks, and Logs surfaces |

Omitting the task opens a picker when more than one task is plausible; nothing is guessed.

## Pi conversational and control commands

The [Pi extension](../.pi/extensions/mabs.ts) also wraps the CLI. These **can** change records or start work, as their CLI equivalents do.

| Command | Effect |
| --- | --- |
| `/mabs-new IDEA` | Start conversational intake: record a brief, ask material questions, propose a plan. Nothing is built until you accept |
| `/mabs-assess IDEA` | Weigh an idea first (assumptions, prior art, cost of being wrong, cheapest disconfirming test). No verdict, and no brief is recorded |
| `/mabs-product BRIEF`, `/mabs-brief ...`, `/mabs-bootstrap BRIEF TARGET` | `product show`, `brief ...`, `brief bootstrap` |
| `/mabs-status` | `status` |
| `/mabs-start [policy\|codex\|claude]` | Start a detached controller with the workbench, logging to `controller.log` in the checkout. Refuses if a controller is already live or wedged |
| `/mabs-ui [PORT]` | Start the workbench (default 4317) and open it |
| `/mabs-project`, `/mabs-task`, `/mabs-plan`, `/mabs-feedback`, `/mabs-approval`, `/mabs-provider`, `/mabs-ops` | The matching CLI command group, e.g. `/mabs-task list --state=BLOCKED` |
| `/mabs-curate ...`, `/mabs-optimize ...` | `curator ...` and `optimization ...` |
| `/mabs-backup` | `maintenance backup` |

Model-facing tools the extension registers: `mabs_status`, `mabs_create_brief`, `mabs_update_brief`, `mabs_set_project_governance`, `mabs_ask_clarifications`, `mabs_answer_clarification`, `mabs_resolve_intake`, `mabs_propose_plan`, `mabs_accept_plan`, `mabs_start_work`, `mabs_submit_plan`, `mabs_submit_task`, `mabs_bootstrap_project`, `mabs_get_product`, `mabs_get_operations`, and `mabs_prepare_operation`. Governance is never answered for you: the model must ask, and `mabs_accept_plan` binds your explicit acceptance to the exact proposal fingerprint. A brief's project type and review choice are set with `mabs_update_brief` (or `mabs_resolve_intake`); `mabs_set_project_governance` is only for a registered project and otherwise answers `wrong_subject`.

The intake and product tools ask the CLI for `--view=conversation`: compact JSON that keeps ids, versions, fingerprints, states, warnings, and next actions, and pages long lists with an `omitted` count and the `brief show --section=... --page=N` command that returns the rest. The CLI's default output is still the full record. Refusals the conversation can act on (`unknown_clarification`, `stale_version`, `already_resolved`, `request_conflict`, `wrong_subject`, `stale_start`) are printed as JSON on stderr.

### Code surface from the CLI

Read-only inspection of one task worktree. These do not start workers or change task state. See the [Code surface guide](operator/code-surface.md).

| Command | Shows |
| --- | --- |
| `node src/cli.ts files [TASK] [--filter=src]` | Every file in the task worktree |
| `node src/cli.ts changes [TASK] [--attempt=ID]` | Changed files, one entry per path, with categories |
| `node src/cli.ts open TASK PATH [--line=N] [--view] [--edit]` | One file, from the worktree or a recorded revision; `--edit` opens it in the viewer in edit mode instead of read-only |
| `node src/cli.ts diff TASK PATH [--view]` | A diff against the task's recorded base revision |
| `node src/cli.ts dispatch 'mabs://open/...'` | The same, from a link; other schemes are refused |
| `node src/cli.ts viewer serve [--surface=code]` | Run the owned read-only viewer; Ctrl+C stops only the viewer |
| `node src/cli.ts viewer status` | Whether a viewer owns a surface |

### Tasks surface from the CLI

Read-only. These never schedule work or change task state, and `Ctrl+C` stops only the dashboard. See the [Tasks surface guide](operator/tasks-surface.md).

| Command | Shows |
| --- | --- |
| `node src/cli.ts task watch [--project=PROJECT_ID]` | Live dashboard of tasks, attempts, steps, and freshness |
| `node src/cli.ts task watch --once` | One frame, for a non-interactive caller |
| `node src/cli.ts task watch --json` | The whole snapshot as JSON |
| `node src/cli.ts task steps TASK_ID` | Recorded steps, gaps, and delivery state for one task |

### Logs surface from the CLI

Original evidence only, read from the MABS artifacts directory. Closing or interrupting these never stops a worker. See the [Logs surface guide](operator/logs-surface.md).

| Command | Shows |
| --- | --- |
| `node src/cli.ts logs TASK_ID` | Evidence records for a task and its attempts |
| `node src/cli.ts logs TASK_ID --attempt=ATTEMPT_ID` | Narrowed to one attempt; earlier attempts stay available |
| `node src/cli.ts logs TASK_ID --evidence=ID [--tail=200]` | One evidence record's tail |
| `node src/cli.ts logs TASK_ID --evidence=ID --follow` | Bounded following that survives appends and rotation |

### Workspace from the CLI

Creates only missing surfaces and closes only what it owns. See [workspace automation](operator/workspace.md).

| Command | Effect |
| --- | --- |
| `node src/cli.ts workspace open [--project=PROJECT_ID] [--layout=tabs\|split] [--focus=code]` | Create or recover the four surfaces; safe to repeat |
| `node src/cli.ts workspace status` | Which surfaces this feature still owns |
| `node src/cli.ts workspace close` | Close only operator-owned panes; never the Agent pane, never a worker |
| `node src/cli.ts workspace view --surface=tasks\|logs --workspace=ID` | One rail-free surface in its own tab. The popup launcher starts this; its scope arrives over the workspace's control file |

### Herdr popup launcher

A stock Herdr popup (default binding `prefix+m`) that opens Code in VS Code on the selected task's live worktree, and Tasks or Logs in separate reusable tabs. Activation is a manual operator step; see [Herdr popup setup](../plugins/herdr/README.md) and its [verification record](operator/popup-launcher-verification.md).

| Command | Effect |
| --- | --- |
| `node src/cli.ts launcher` | Interactive selection screen (stable project and task IDs before any dispatch) |
| `node src/cli.ts launcher --json` | The first selection screen as JSON, for non-interactive callers |
| `node src/cli.ts launcher --action=code\|tasks\|logs --project=ID --task=ID [--attempt=ID] --dispatch` | Run one action directly |
| `... --action=code --path=REL --line=N --column=N [--vscode=EXECUTABLE]` | Open a specific file and position; `MABS_VSCODE_EXECUTABLE` also sets the editor |

Code never substitutes the project checkout or a snapshot when the live worktree is missing; it reports an error. Under WSL with a Windows-hosted VS Code, the launcher adds `--remote wsl+<distribution>`.

## Verification is not all the same

- `npm test` and `npm run typecheck`: local repository checks.
- `node src/cli.ts verify --quick`: checks both provider logins and paid-API environment scrubbing; writes local evidence.
- `node src/cli.ts verify`: includes real provider probes and consumes subscription capacity.
- `node src/cli.ts baseline`: runs model-backed comparison tasks; not a lightweight health check.

Do not use the full verification or baseline commands as a routine documentation check.
