# MABS Herdr popup

This adapter uses Herdr's stock custom-command popup. Opening or dismissing the
popup only starts or exits the launcher process: it does not create a tab, send
an agent prompt, or modify the current session. A tab or editor opens only after
the user chooses an action and stable project/task IDs.

## Prerequisites and activation

- Node.js 24 or newer and an initialized MABS state database.
- Herdr with `[[keys.command]]` and `type = "popup"` support (verified against
  0.9.1). Older/unsupported environments can use the CLI alternatives below.
- `code` on `PATH` for Code. A Windows-hosted VS Code under WSL also needs
  `WSL_DISTRO_NAME`; the launcher supplies `--remote wsl+<distribution>`.

Make `mabs-launcher` executable, copy the block from `config.example.toml` into
Herdr's config, replace its command with the script's absolute path, and run
`herdr server reload-config`. No config is changed by this repository.

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

## Rollback

Remove the `[[keys.command]]` block and run `herdr server reload-config`. This
does not touch tasks, workers, evidence, worktrees, manual tabs, or the Agent
pane. Tabs previously opened by an explicit Tasks or Logs action remain normal
user-closeable Herdr tabs.

## Manual GUI acceptance

These checks require a human attached to Herdr and are not implied by automated
tests:

1. Open and dismiss the popup by keyboard and by clicking outside/pressing Esc;
   confirm no tab appears and the Agent prompt is unchanged.
2. In a store with two projects and repeated labels, confirm project and task
   ID choices appear before dispatch.
3. Activate each action once by Enter and once by mouse. Confirm both routes use
   the same scope, Tasks and Logs focus their own tab, and a repeated action does
   not start a duplicate process.
4. Rename an opened tab, then repeat the action. Confirm ownership follows its
   pane ID, not the label. Move or close it, then confirm it is not adopted.
5. Under WSL, confirm Code opens the selected live worktree in VS Code. Confirm
   a missing worktree/editor gives an explicit error rather than opening the
   base checkout or a snapshot.
