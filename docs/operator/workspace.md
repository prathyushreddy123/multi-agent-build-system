# Operator workspace — workspace automation

[Documentation](../index.md) · [Operator workspace](index.md) · [Release acceptance](release-acceptance.md)

Create or recover the Agent, Code, Tasks, and Logs surfaces in one step.

```bash
node src/cli.ts workspace open [--project=PROJECT_ID] [--layout=tabs|split] [--focus=code]
node src/cli.ts workspace status
node src/cli.ts workspace close
```

From Pi: `/mabs-workspace [open|status|close]`.

| Surface | What runs there |
| --- | --- |
| Agent | your existing Pi session — this pane, reused, never recreated |
| Code | `viewer serve --surface=code` |
| Tasks | `task watch --project=…` |
| Logs | a shell, with the exact `logs` commands printed |

`--layout=tabs` is the default. `--layout=split` puts Code beside the Agent pane and gives Tasks and Logs their own tabs.

## Safe to run repeatedly

Running `workspace open` twice is a no-op on anything already there:

- **Ownership is proved by pane identity.** A surface is reused only when the pane ID the API returned still exists *and* still belongs to this workspace. A label is display only and is never accepted as proof, so renaming a tab changes nothing and a coincidentally named pane is never adopted.
- **A reused pane is left completely alone.** The surface command runs only in a pane this call created. Re-running it in a reused pane is exactly how duplicate watchers and viewer processes appear, so it does not happen. Verified live: a second `workspace open` created no panes and started no second viewer.
- **Surfaces recorded for a different workspace are not reused** and are never closed. They belong to someone else's window.
- **A closed pane is recreated**, and the note says why the old one was dropped.
- **Partial startup is reported.** If one surface cannot be created, the others stay and the failure carries the CLI command to run instead.

## Focus

Panes are created with `--no-focus`. Background work never steals focus.

Focus moves only when you ask for it — `--focus=code`, or an explicit file open. That is the rule the plan sets: a click or a picker selection may focus Code because the user requested it; a worker finishing may not.

## Environment

A new pane starts a fresh shell and does not see the caller's overrides, so `MABS_STATE_DIR`, `MABS_DB_PATH`, `MABS_WORKTREE_ROOT`, and `MABS_OPERATOR_CONFIG` are forwarded when the pane is created. Without this a surface would silently read a different MABS store than you are looking at. Nothing else from the environment is forwarded.

## Outside Herdr

Nothing fails. `workspace open` reports `degraded` and prints the equivalent command for each surface:

```
degraded  agent   Run pi in this terminal as usual.
degraded  code    Run `node src/cli.ts open <task> <path>`, or `viewer serve` in a second terminal.
degraded  tasks   Run `node src/cli.ts task watch` in a second terminal.
degraded  logs    Run `node src/cli.ts logs <task> --evidence=<id>` in a second terminal.
```

No pane is created or controlled, because driving a Herdr session from outside it would control another client's panes.

## Closing

`workspace close` closes **only** panes this feature created and still owns.

- The Agent pane is never closed. It is your session; this feature did not create it.
- A pane that moved to another workspace is forgotten, not closed.
- Closing a dashboard or a Code pane ends a view. It does not cancel a worker, change a task record, remove evidence, or touch a worktree. Verified live: task state was byte-identical before and after.

## Configuration and rollback

Workspace identity and preferences live in `~/.local/state/mabs/operator/preferences.json`, deliberately outside the SQLite task store. Nothing there can influence scheduling, task state, review policy, or approvals.

To roll the presentation layer back without touching task data:

```
/mabs-compact off
/reload
```

Or permanently: remove `./.pi/extensions/mabs-ux.ts` from `package.json` → `pi.extensions`. The original CLI, the MABS Pi tools, and the workbench keep working either way — that is [checked as part of release acceptance](release-acceptance.md).
