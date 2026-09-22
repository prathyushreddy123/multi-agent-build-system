# Troubleshooting

[Documentation](index.md) · [Command reference](commands.md) · [Failure scenarios](architecture/recovery-and-failures.md)

**Start with the recorded reason, not a blind retry.** Keep task state, worktrees, and evidence while investigating.

## Inspect first

From the MABS checkout, replace the example ID:

```bash
TASK_ID=replace-with-task-id
node src/cli.ts status
node src/cli.ts provider list
node src/cli.ts task show "$TASK_ID"
```

`task show` includes state, `blockedReason`, `failureClass`, attempts, routing decisions, checks, reviews, and diagnostics. The [workbench](getting-started.md#4-start-the-controller) shows the same kinds of records with evidence links.

## Find the likely cause

| Symptom | Check | Next step |
| --- | --- | --- |
| Task stays `QUEUED` | Project status and dependency states | Activate the intended project or resolve its dependencies. Failed/cancelled dependencies can block a task. |
| Task stays `READY` | Worker/provider limits, overlapping scopes, machine pressure | Wait for capacity or deliberately adjust limits. More workers do not bypass provider limits. |
| `AUTH` or `QUOTA` | Provider status and login | Follow [provider recovery](#provider-recovery). Do not add API keys. |
| `CONFIG` | Installed tools, selected model, declared checks | Fix the named configuration problem; repeating the same attempt will not fix an invalid model or missing tool. |
| `CODE` or failed gates | Check logs and the checked revision | Fix the actual code/test issue. Repairs are bounded, not unlimited. |
| Review pending | Review reason, provider availability | Under pending-capacity policy, the controller resumes review when capacity returns. Pending is not approved. |
| `CONTRACT` | Result format, allowed edit scope, reviewer edits | Inspect the attempt and diff. Do not relabel malformed or out-of-scope output as success. |
| `INFRA`, `TIMEOUT`, or stale heartbeat | Process state, timestamps, completion evidence | Follow [restart guidance](#controller-interrupted-or-lease-held); a stale heartbeat alone does not prove a worker is dead. |
| Approval rejected | Revision, target, current configuration, checks, review | Prepare a new exact approval only after resolving the mismatch or missing evidence. |

## Provider recovery

1. Check the selected provider with `codex login status` or `claude auth status`.
2. Fix login through that provider's normal subscription-login flow, or wait for quota recovery.
3. Inspect `provider list`. A quota cooldown can expire automatically; an authentication failure requires an explicit reset after the login problem is fixed.
4. Only then reset the affected provider if needed:

```bash
# Mutation: clears the recorded provider blocker; it does not log you in.
node src/cli.ts provider reset codex
```

Use `claude` instead when appropriate. Resetting does not replenish subscription quota. If the task is blocked, inspect it again before deciding whether to retry. A fallback already waiting in `READY` need not be resubmitted.

## Retry or cancel deliberately

Read the latest `task.recordVersion` with `task show`. This version prevents you from overwriting a decision based on stale state.

```bash
TASK_ID=replace-with-task-id
VERSION=replace-with-current-record-version

# Mutation: retry only after resolving the cause.
node src/cli.ts task retry "$TASK_ID" --version="$VERSION"
```

CLI retry accepts `BLOCKED` or `FAILED` and moves the task to `READY`. It does not reset the recorded repair count. A running controller may dispatch it immediately. If state changed, read it again; do not keep guessing versions.

To cancel instead, fetch the current version and run:

```bash
# Mutation: cancels the task and terminates its worker process group.
node src/cli.ts task cancel "$TASK_ID" --version="$VERSION"
```

Do not execute retry and cancel as a single recovery recipe. They are different decisions.

## Checks fail or coverage is missing

- Open the gate's evidence log. It records the command, working directory, exit result, and revision.
- Check dependencies **inside the task worktree**. Git does not copy ignored dependencies from the original checkout.
- Use `profile inspect` to see supported project checks. Registration discovers checks; it is not a package installer.
- `not_configured` means no required checks were configured. It is not a passing test result. Configure appropriate checks through a reviewed project configuration change rather than weakening policy to hide the gap.
- A task can have advisory review findings without needing repair. Read the resolved policy and blocking findings before intervening.

See [configuration changes](curator.md) and [quality/review behavior](architecture/task-execution.md).

## Controller interrupted or lease held

- Stop duplicate controller processes normally. Do not delete the database or force-clear a lease to compete with a live controller.
- Restart using the **same state-path overrides**. Recovery collects existing completion files or tracks surviving workers before dispatching new work.
- `Ctrl+C` stops the controller loop, not necessarily its detached workers. Use task cancellation when you intend to stop work.
- Missing process plus missing completion evidence blocks the task for investigation. Preserve the worktree; retry only after understanding the cause.

See the [restart diagram](architecture/recovery-and-failures.md#controller-restart).

## Workbench will not open or shows unexpected data

- Ensure the UI is running. `node src/cli.ts ui` opens it without starting controller dispatch.
- Use the printed localhost URL; the default is `http://127.0.0.1:4317`.
- If the port is occupied, use `node src/cli.ts ui --port=4318` rather than killing an unknown process.
- Confirm the UI and controller use the same state directory and database path. Different overrides mean different records.
- The current UI refreshes the overview every ten seconds and can replace a detail view. Use `task show` for uninterrupted inspection; stable task URLs are not implemented.
- Do not expose the workbench publicly. Its capability token is a local control mechanism, not a multi-user login system.

## MABS tools missing in pi, or every first turn fails

Symptoms, on pi 0.86 or newer with `pi-claude-agent-sdk` 0.8.6:

- The first message of each pi session fails with `No conversation found with session ID: ...`, and a `Session file issue: file missing after save` warning precedes it. A second message usually succeeds.
- No `mabs_*` tool ever runs. The model describes calling one and reports task counts it invented, because pi's prompt advertises tools the bridge never registered.

The second symptom is the dangerous one: fabricated task state is exactly what MABS exists to prevent. Treat any run that shows it as unverified.

pi 0.86 changed the provider contract the bridge reads. Apply the shim and re-verify:

```bash
.pi/patches/apply.sh
# Mutation: edits the installed pi extension, not this repository.
```

See [`.pi/patches/README.md`](../.pi/patches/README.md) for the cause, the verification command, and when to drop the patch. Re-run it after every `pi update` — an update restores the stock package and both symptoms return.

## Asking for help

Share the MABS Git revision, Node version, exact command, task state/failure class, and a short sanitized error excerpt. Include a minimal reproduction if possible.

**Do not publish** provider credentials, workbench tokens, the SQLite database, or entire worker transcripts. Evidence may contain private repository content and local paths. Historical evidence paths in phase summaries belong to the original verification machine; they are not files installed with MABS.
