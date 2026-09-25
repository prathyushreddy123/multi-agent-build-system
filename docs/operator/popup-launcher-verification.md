# Popup launcher verification — 24 September 2026

[Operator workspace](index.md) · [Herdr popup setup](../../plugins/herdr/README.md)

This is the verification record for the Code/Tasks/Logs popup adapter at
`1e1489563901f35e9709535034cb5e053f230a7b`. No plugin was installed, no Herdr
or VS Code configuration was changed, and no live pane was opened, focused,
split, reused, or closed while producing this record.

## Repository checks

The checks ran with Node v24.20.0 and npm 12.0.2 in the restricted MABS worker
environment.

| Check | Result |
| --- | --- |
| `npm run typecheck` | **Passed** (exit 0). |
| `npm run typecheck:extensions` | **Not passed** (exit 1). The optional installed-Pi link was absent, so TypeScript could not resolve `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, or `@earendil-works/pi-tui`; the unresolved contextual types also produced `TS7006` errors. The documented prerequisite is `npm run link-pi`, which installs or upgrades nothing, followed by this check. It was deliberately not run here, so the missing prerequisite remains explicit. |
| `npm test` | **Not passed** (exit 1): 16 of 31 top-level test-file entries passed and 15 failed. This worker sandbox denied operations used by repository fixtures, including `spawnSync git` (`EPERM`) and binding `127.0.0.1` (`listen EPERM`); the phase-0 integration proof also failed in this restricted environment. This result is not a green full-suite claim and needs a rerun in a repository test environment that permits those operations. |
| `node --test test/operator/launcher.test.ts test/operator/tool-tabs.test.ts test/operator/vscode.test.ts` | **Passed** (exit 0): 3 test files passed, 0 failed. |

No dependency install or optional Pi link was performed to turn a missing
prerequisite into an apparent pass. Historical green results in
[release acceptance](release-acceptance.md) describe their recorded machine and
do not replace the results above.

## Adapter evidence

The focused passing suite verifies that:

- Tasks and Logs create distinct rail-free tabs in the invoking workspace,
  never request a pane split or a new workspace, and leave unrelated panes
  alone.
- Repeated and simultaneous opens reuse the exact recorded pane/tab IDs, focus
  the owned tab, and keep one view process per surface. Labels and moved or
  lookalike panes are not treated as ownership proof.
- Scope changes use the control request file rather than reinjecting a shell
  command. Requests and ownership remain isolated between workspaces.
- Opening, following, and quitting a view leave task, event, attempt, and worker
  state unchanged.
- Ambiguous Code selection presents stable project/task IDs and launches only
  the chosen live worktree. The tests reject project-checkout substitution,
  path escape, missing worktrees/editors, and unsafe cross-project routing.
- Windows-hosted VS Code receives the selected WSL remote authority, while a
  successful CLI exit is reported only as an unverified GUI launch request.

## Activation and rollback

Activation is an operator procedure, not part of this verification. The
[Herdr popup setup](../../plugins/herdr/README.md#prerequisites-and-activation)
lists the Node, Herdr, VS Code CLI, Remote - WSL, and `WSL_DISTRO_NAME`
prerequisites and the explicit config block/reload steps. It also requires the
operator to check that the proposed key binding does not replace an existing
one.

Rollback removes only the MABS key-command block the operator added. A tool tab
may be closed only after its current pane ID still proves MABS ownership.
Cleaning up an unwanted pane from an older layout is a separate explicit
choice, with ownership revalidated at that time; labels and old layout position
are insufficient. Manual/chat tabs, the Agent pane, workers, tasks, evidence,
and worktrees are outside rollback scope.

## Manual GUI acceptance

**Status: not performed.** Automated adapter tests cannot establish GUI display,
mouse behavior, editor refresh, or preservation of real session tabs. A human
attached to Herdr and VS Code must still verify all of the following:

1. Open the popup by keyboard; use mouse clicks through Code, Tasks, and Logs;
   dismiss via outside click and Esc; confirm dismissal creates no tab and does
   not change the Agent prompt.
2. With ambiguous projects/tasks, confirm stable project and task choices are
   required before dispatch.
3. Open Tasks and Logs and confirm separate rail-free tabs, preserved chat,
   Agent, and manual tabs, no split, and idempotent focus without duplicate
   processes.
4. Rename, move, and close a tool tab in turn; confirm labels are not ownership,
   moved panes are untouched, and a closed tab is recreated only by another
   explicit open.
5. Under WSL, confirm Code opens the real selected live task worktree in VS Code
   and that missing-editor/worktree cases show an error rather than a project
   checkout or snapshot.
6. Let a worker update a clean file and confirm VS Code refreshes the file and
   shows the Git change. Repeat with an unsaved buffer and confirm the editor
   preserves it or reports a conflict instead of MABS overwriting it.

VS Code Source Control normally compares the selected worktree's index and
working tree with its current `HEAD`. MABS `changes` and `diff` also report
committed task work against the task's recorded base revision (`base...HEAD`),
which may differ from both the current project branch tip and VS Code's normal
comparison. Concurrent worker/editor use can therefore involve both a stale or
conflicting unsaved buffer and two intentionally different Git comparison
bases; inspect both before saving or accepting a task diff.
