# MABS Herdr popup

This adapter uses Herdr's stock custom-command popup. Opening or dismissing the
popup only starts or exits the launcher process: it does not create a tab, send
an agent prompt, or modify the current session. A tab or editor opens only after
the user chooses an action and stable project/task IDs.

## Prerequisites and activation

- Node.js 24 or newer and an initialized MABS state database.
- Herdr with `[[keys.command]]` and `type = "popup"` support (verified against
  0.9.1). Older/unsupported environments can use the CLI alternatives below.
- The VS Code command-line launcher (`code`) on `PATH`, or its executable path
  in `MABS_VSCODE_EXECUTABLE`. A Windows-hosted VS Code used from WSL also
  needs the Remote - WSL extension and a valid `WSL_DISTRO_NAME`; the launcher
  supplies `--remote wsl+<distribution>`. Run `code --version` in the same WSL
  shell first if you are unsure. A successful CLI request is not proof that a
  GUI window appeared, so verify the window and folder manually.

Activation is an explicit operator action; this repository does not perform
these steps:

1. Make `plugins/herdr/mabs-launcher` executable.
2. Copy the block from `plugins/herdr/config.example.toml` into
   `~/.config/herdr/config.toml` and replace the placeholder with the launcher's
   absolute path.
3. Validate that the chosen binding does not replace an existing one, then run
   `herdr server reload-config`.

These instructions neither install a plugin nor edit or reload user
configuration automatically. Activation does not open, close, split, or reuse
any existing pane.

The example binding is `prefix+m`. Arrow keys or `j`/`k` move, Enter activates,
mouse clicks activate the same choice path, and Esc or `q` dismisses.

## CLI alternatives

The launcher reports these commands when it is outside a supported Herdr
session:

```bash
node src/cli.ts task watch --project=PROJECT_ID
node src/cli.ts logs TASK_ID
node src/cli.ts launcher --action=code --project=PROJECT_ID --task=TASK_ID --dispatch
```

Use `node src/cli.ts launcher --json` to inspect the first selection screen in a
non-interactive terminal. Project names and task titles are display-only; CLI
scope flags take stable IDs.

## Tab and editor behavior

- Tasks and Logs each use one separate, rail-free tab in the Herdr workspace
  that invoked the popup. They never split a pane or create another workspace.
- Repeating an action focuses the exact recorded tab and updates its scope over
  a control file. It does not restart the view process. A label match is never
  ownership proof, so a similarly named manual tab is not adopted.
- Closing a tool view stops only that view. It does not cancel, pause, retry, or
  otherwise mutate a task, attempt, controller, or worker.
- Code always requests a new VS Code window for the explicitly selected live
  task/attempt worktree. It never substitutes the project checkout or a
  revision snapshot when that worktree is unavailable.

VS Code and a worker may observe or edit the same live worktree concurrently.
File watchers normally refresh clean files, but an open editor can briefly show
stale content and an unsaved buffer can conflict with a worker write. MABS does
not overwrite or dismiss VS Code buffers. Before saving after a worker update,
review VS Code's conflict prompt or compare the buffer with the file on disk;
do not assume the editor copy is current.

VS Code's Source Control view normally compares the selected worktree's index,
working tree, and current `HEAD`. MABS `changes` and `diff` additionally measure
committed task work against the task's recorded base revision (`base...HEAD`),
which can differ from the current project branch tip or VS Code's default
comparison. Use the MABS view when checking accepted task scope and VS Code's
view when resolving current staged, unstaged, or unsaved editing work.

## Rollback

Remove only the MABS `[[keys.command]]` block you added and run
`herdr server reload-config`. This disables future popup launches and does not
touch tasks, workers, evidence, worktrees, manual/chat tabs, or the Agent pane.

Tabs opened by an explicit Tasks or Logs action remain normal user-closeable
Herdr tabs. Close one only after checking the current pane ID against MABS's
recorded ownership (the same validation used by the adapter); a title or old
layout is not sufficient evidence. Cleanup of an unwanted pane from an older
layout or earlier setup is a separate, explicit operator choice. Revalidate its
current ownership first and close it manually if ownership cannot be proved.
Rollback must never bulk-close panes or infer ownership from a label.

## Manual GUI acceptance

Status for this repository check: **not performed**. These checks require a
human attached to Herdr and VS Code and are not implied by automated tests:

1. Open the popup by keyboard, click each choice through to its ready screen,
   and dismiss once by clicking outside and once with Esc. Confirm dismissal
   creates no tab and the Agent prompt is unchanged.
2. In a store with two projects and repeated labels, confirm project and task
   ID choices appear before dispatch.
3. Activate each action once by Enter and once by mouse. Confirm both routes use
   the same scope; Tasks and Logs open as separate rail-free tabs; chat, Agent,
   and unrelated manual tabs remain present; and a repeated action focuses the
   same tab without starting a duplicate process or creating a split.
4. Rename an opened tab, then repeat the action. Confirm ownership follows its
   pane ID, not the label. Move or close it, then confirm it is not adopted.
5. Under WSL, confirm Code opens the selected live worktree in VS Code. Confirm
   a missing worktree/editor gives an explicit error rather than opening the
   base checkout or a snapshot.
6. With that worktree open, let a worker change a clean file and confirm VS Code
   refreshes it and Source Control shows the Git change. Repeat with an unsaved
   buffer and confirm VS Code preserves or reports the conflict instead of MABS
   replacing the buffer. Compare the VS Code view with `mabs changes`/`diff`
   while remembering their different comparison bases described above.
