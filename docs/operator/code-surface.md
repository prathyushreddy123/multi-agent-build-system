# Operator workspace — Code browsing and file opening

[Documentation](../index.md) · [Operator workspace](index.md) · [Phase 0 capabilities](phase-0-capabilities.md)

Select a file and inspect it in the Code surface while the agent keeps working. Inspection is read-only by default and always bound to a specific task, attempt, worktree, and revision.

## Commands

| Route | Command |
| --- | --- |
| CLI | `node src/cli.ts files [TASK] [--filter=src]` |
| CLI | `node src/cli.ts changes [TASK] [--attempt=ID]` |
| CLI | `node src/cli.ts open TASK PATH [--line=N] [--view] [--edit]` |
| CLI | `node src/cli.ts diff TASK PATH [--view]` |
| CLI | `node src/cli.ts dispatch 'mabs://open/PROJECT/TASK?path=...'` |
| CLI | `node src/cli.ts viewer serve [--surface=code] [--viewer=vim]` |
| CLI | `node src/cli.ts viewer status [--surface=code]` |
| Pi | `/mabs-files`, `/mabs-changes`, `/mabs-open`, `/mabs-diff`, `/mabs-viewer` |

`--view` sends the selection to the owned viewer. Without it the command prints the content and the link, which is what a headless or scripted caller wants.

Omitting the task opens a picker when more than one task is plausible. The command never guesses.

## One resolver for every route

A click, a picker selection, a slash command, and a CLI command all resolve through `src/operator/context.ts` and `src/operator/files.ts`. That is the only place where "which file does this refer to" is decided, so the four routes cannot select different worktrees for the same task.

A selection always carries the project, task, attempt, worktree root, relative path, and optionally a line and a revision. An attempt's own worktree and revisions take precedence over the task's, so inspecting attempt 1 after a retry shows attempt 1's work rather than the latest.

The Code surface always states what it is showing:

```
smoke · tsk_01M35… · attempt 2 (repair) · mabs/tsk_01M35… · live worktree /home/you/worktrees/…
smoke · tsk_01M35… · attempt 1 (initial) · mabs/tsk_01M35… · revision 8f2c1ab
```

## Changed files

`changes` lists one entry per path, tagged with every category it belongs to, so nothing is counted twice:

| Category | Source |
| --- | --- |
| `committed` | `base...HEAD` in the task worktree, measured against the task's **recorded base revision**, not the project's current branch tip |
| `staged` | the index |
| `unstaged` | the working tree against the index |
| `untracked` | new files, respecting `.gitignore` |

Renames and copies carry `oldPath` alongside `path`. Deletions are listed with `present: false`. Binary files are marked and are never rendered as text. Files over 2 MB are flagged `oversize`.

`diff` compares against the recorded base revision. Rename detection needs the whole diff, so the diff for a renamed path is resolved by finding the rename pair first and then asking git for both paths — otherwise git reports a rename as an unrelated new file.

## When the worktree is gone

Cleanup is never silently papered over:

| Situation | What happens |
| --- | --- |
| Worktree removed, result revision recorded | Content is read from that revision, and the surface says so |
| Path absent from that revision | Reported as unavailable, with an explicit note that this is **not** the base checkout's copy |
| Neither worktree nor revision | The command reports that no content is available |

The base checkout is never used as a fallback. Showing `main`'s copy of a file while labelling it as a task's work would be worse than showing nothing.

## Path safety

- Paths are canonicalized and required to stay inside the selected worktree. Traversal, absolute paths outside the root, and any URI scheme are refused.
- A symlink that leaves the worktree is refused, because reading through it would show another task's or the base checkout's content. A symlink that stays inside is fine.
- Arguments are always passed to git and to the viewer as arrays, never interpolated into a shell command, and `--` separates options from paths so a leading hyphen cannot be read as a flag.
- Only `mabs://` links are dispatched. `http`, `file`, `ssh`, and everything else are refused rather than coerced.

Verified against filenames with spaces, non-ASCII characters, quotes, leading hyphens, and nested paths.

## The viewer

Phase 0 found no editor remote-control channel on this machine: Neovim is absent and the installed vim is built without `clientserver`. Reuse is therefore implemented by a MABS-owned process that reads selections from its own request file. Nothing is ever typed into a pane that might be running an editor or an agent.

```bash
node src/cli.ts viewer serve --surface=code
```

- One owned viewer per surface. Repeated selections reuse it; a second `viewer serve` on the same surface refuses rather than taking it over.
- A read-only buffer is replaced when a new selection arrives, because a read-only buffer has nothing unsaved to lose.
- An editable buffer is never replaced. The selection is queued and the reason is reported.
- `Ctrl+C` stops the viewer only. It holds no task state and touches no records; workers are unaffected.
- Revision content and diffs are staged under the viewer's own directory, never written into a worktree.
- Preference order is `nvim`, then `vim -R`, then `less`. `less` is a degraded fallback, not a substitute for browsing.

### Optional external editor

`code` or `cursor` can be configured as a backend. A Windows-hosted editor reached from WSL needs `--remote wsl+$WSL_DISTRO_NAME` to address this filesystem. It opens a separate GUI window; it is not embedded in a terminal pane, and MABS does not describe it as though it were.

## Links

`mabs://open/<project>/<task>?path=…&line=…&attempt=…&revision=…` encodes the whole selection, so it survives being copied into any route.

Herdr 0.9.1 exposes no link-handler registration, so clicking a hyperlink cannot be routed back into MABS on this version. OSC-8 sequences are still emitted for terminals that handle them, and every result prints the equivalent `node src/cli.ts …` command, which is the deterministic route. Control characters in a link label are stripped so a label cannot break out of the escape sequence.
