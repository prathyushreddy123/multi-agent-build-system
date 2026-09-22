# Operator workspace — implementation progress

[Documentation](../index.md) · [Operator workspace](index.md) · [Phase 0 capabilities](phase-0-capabilities.md)

Resumable record for the MABS Operator Workspace Implementation Plan. After a context reset, read this file, inspect the current diff, and resume the first incomplete phase.

**Current position:** All phases complete. Next action: the manual checks below, which need a real provider run or a human attached to the Herdr TUI.

## Phase status

| Phase | Focus | Status |
| --- | --- | --- |
| 0 | Inspect and prove compatibility | Complete |
| 1 | Compact Agent output | Complete |
| 2 | Code browsing and reliable file opening | Complete |
| 3 | Tasks and recorded implementation steps | Complete |
| 4 | Logs and evidence following | Complete |
| 5 | Workspace automation and release checks | Complete |

## Phase 0 — inspect and prove compatibility

**Files changed**

- `src/operator/capabilities.ts` (new): capability probes and the two integration proofs.
- `src/cli.ts`: `operator probe [--json] [--repo=<path>]`.
- `test/operator/phase0.test.ts` (new): asserts both proofs and that every probe records evidence.
- `package.json`: test script now includes `test/operator/*.test.ts`.
- `docs/operator/phase-0-capabilities.md`, `docs/operator/index.md`, this note.

**Checks**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm test` | 81 passed, 0 failed |
| `node src/cli.ts operator probe` | Exit 0; OP0-10 and OP0-11 PASS |

**Recorded capability decisions**

- Compact output uses `ToolDefinition.renderResult`, which is presentation-only. Pi's `tool_result` event is model-facing and is not used for presentation.
- Built-in tools are re-registered by name with execution delegated to Pi's exported original executors, preserving parameters, streaming, result, timeout, and cancellation.
- Herdr 0.9.1 has no link-handler registration, so the picker, slash command, and CLI are the deterministic file-open routes.
- No editor remote-control channel exists here, so viewer reuse is implemented by a MABS-owned request channel.

**Blockers:** none.

## Phase 1 — compact Agent output

**Files changed**

- `src/operator/summaries.ts` (new): factual execution summaries and reporter recognition.
- `src/operator/rendering.ts` (new): compact/expanded line construction, shell-result fact extraction, control-sequence escaping, renderer replacement.
- `src/operator/preferences.ts` (new): persisted operator preferences, kept out of the task store.
- `.pi/extensions/mabs-ux.ts` (new): the Pi presentation layer, `/mabs-verbose`, `/mabs-compact`.
- `.pi/extensions/mabs.ts`: all thirteen MABS tools now register through the shared compact renderer.
- `scripts/link-pi.mjs`, `tsconfig.extensions.json`, `package.json`: optional dev link so the extension can be typechecked and load-tested.
- `test/operator/phase1.test.ts`, `test/operator/extension-load.test.ts` (new).
- `docs/operator/compact-output.md` (new); index and command reference updated.

**Checks**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run typecheck:extensions` | Clean (requires `npm run link-pi`) |
| `npm test` | 95 passed, 0 failed |
| Live extension load in a real Pi process | `pi --mode rpc` loaded both extensions and set their status lines; no model call |

**Decisions**

- Built-ins are re-registered from Pi's own definition object with only the two render functions replaced, so the executor, schema, and the user's configured shell path and command prefix are preserved. Re-creating the tools from defaults would have dropped those settings.
- `powershell` is not re-registered; this checkout targets WSL.
- `npm run link-pi` symlinks the globally installed Pi into `node_modules` for typechecking and the load test. It installs and upgrades nothing, and the base `npm run typecheck` does not need it.

**Blockers:** none.

## Phase 2 — Code browsing and reliable file opening

**Files changed**

- `src/operator/context.ts` (new): task/attempt/worktree/revision selection, with candidates instead of a guess.
- `src/operator/files.ts` (new): path resolution and containment, all-files and changed-files listings, revision reads, diffs.
- `src/operator/links.ts` (new): `mabs://` encoding and dispatch, OSC-8, and the equivalent command.
- `src/operator/viewer.ts` (new): the owned viewer, its request channel, and the optional external editor plan.
- `src/operator/code.ts` (new): one entry point per action, shared by the CLI and Pi.
- `src/cli.ts`: `files`, `changes`, `open`, `diff`, `dispatch`, `viewer serve`, `viewer status`.
- `.pi/extensions/mabs.ts`: `/mabs-files`, `/mabs-changes`, `/mabs-open`, `/mabs-diff`, `/mabs-viewer`, with a picker on ambiguity.
- `test/operator/phase2.test.ts`, `test/operator/viewer.test.ts` (new).
- `docs/operator/code-surface.md` (new); index and command reference updated.

**Checks**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run typecheck:extensions` | Clean |
| `npm test` | 115 passed, 0 failed |
| Live CLI against real worktrees | `changes`, `open`, `diff`, `dispatch` returned the task's own content; traversal and `file://` were refused |
| Live extension load | `pi --mode rpc` loaded both extensions; no model call |

**Validation covered**

Two task worktrees holding different content at the same relative path; filenames with spaces, non-ASCII characters, quotes, leading hyphens, and nested paths; line numbers; symlinks inside and outside the worktree; rename and delete diffs; a removed worktree falling back to its recorded revision; a path absent from that revision; a task with neither worktree nor revision; a file changing during inspection; viewer reuse, read-only replacement, and edit-mode queueing.

**Decisions**

- Rename diffs resolve the rename pair first and pass both paths, because a single-path pathspec makes git report a rename as an unrelated new file.
- A removed worktree never falls back to the base checkout. Unavailable content says so explicitly.
- Viewer reuse is a MABS-owned process reading its own request file, since no editor remote-control channel exists here.
- A read-only buffer is replaced on a new selection; an editable one is queued instead.

**Blockers:** none.

## Phase 3 — Tasks and recorded implementation steps

**Files changed**

- `src/operator/progress.ts` (new): read-only snapshot, step assembly, freshness, delivery, provider availability.
- `src/operator/dashboard.ts` (new): the Tasks surface, its pure renderer, and the bounded polling loop.
- `src/cli.ts`: `task watch [--project] [--interval] [--once|--json]`, `task steps <task>`.
- `.pi/extensions/mabs.ts`: `/mabs-progress`, `/mabs-steps`.
- `test/operator/phase3.test.ts` (new).
- `docs/operator/tasks-surface.md` (new); index and command reference updated.

**Checks**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run typecheck:extensions` | Clean |
| `npm test` | 126 passed, 0 failed |
| Live `task watch` against real records | Rendered two queued tasks, an unknown controller, and the missing-step note |

**Finding: step instrumentation already exists**

The plan allowed for adding an event contract if step events were absent. They are not. The controller records a checkpoint at every boundary it owns (`implementation_complete`, `repair_complete`, `checks_passed`, `checks_failed`, `review_*`, `worker_blocked`, `attempt_failed`, `quality_not_configured`), and gates and reviews are recorded separately. Steps are therefore derived from existing records, with no parallel step table and no controller change.

The real gap is progress *inside* a running attempt: the worker reports only at the end. That is labelled unavailable everywhere it matters, and the shape a future executor-side contract would need (stable execution ID plus monotonic sequence, persisted by the controller) is documented rather than faked.

**Decisions**

- Grouping never replaces the state machine; the authoritative state travels with every row.
- Selection follows the task ID across refreshes, and the scroll offset is clamped rather than reset.
- Delivery is tracked from outward-action approvals and stays separate from task completion and from check and review outcomes.
- Provider availability is `unknown` without a capacity or health record.

**Blockers:** none.

## Phase 4 — Logs and evidence following

**Files changed**

- `src/operator/logs.ts` (new): evidence listing per task and attempt, artifacts containment, bounded chunk reads, tail, and following with rotation handling.
- `src/operator/progress.ts`: every step now carries `evidenceRefs` pointing at openable evidence records.
- `src/cli.ts`: `logs <task> [--attempt] [--evidence] [--tail|--from] [--follow]`.
- `.pi/extensions/mabs.ts`: `/mabs-logs`.
- `test/operator/phase4.test.ts` (new).
- `docs/operator/logs-surface.md` (new); index and command reference updated.

**Checks**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run typecheck:extensions` | Clean |
| `npm test` | 137 passed, 0 failed |
| Live follow with rotation | Appends and a mid-follow file replacement produced no duplicate lines; Ctrl+C left the task `RUNNING` |

**Bug found and fixed during the phase**

The first reader treated "reached end of file" as "the line is complete" and emitted a half-written line. A file mid-write is indistinguishable from one with no final newline, so a trailing fragment is now held back while the run is live and flushed only once the attempt is no longer running.

**Decisions**

- Raw transcripts are kept as written; per-command navigation inside them is labelled unavailable rather than reconstructed from output MABS never recorded as events.
- Rotation is detected by device and inode, in-place truncation by size against the saved offset.
- Retention and redaction behaviour is reused unchanged. Evidence files are not content-redacted, and the docs say so.

**Blockers:** none.

## Phase 5 — workspace automation and release checks

**Files changed**

- `src/operator/herdr.ts` (new): session discovery, ownership verification, idempotent surface creation, scoped close.
- `src/cli.ts`: `workspace open|status|close`.
- `.pi/extensions/mabs.ts`: `/mabs-workspace`.
- `test/operator/phase5.test.ts`, `test/operator/acceptance.test.ts` (new).
- `docs/operator/workspace.md`, `docs/operator/release-acceptance.md` (new); index and command reference updated.

**Checks**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run typecheck:extensions` | Clean |
| `npm test` | 154 passed, 0 failed |
| Live Herdr acceptance | See [release acceptance](release-acceptance.md) |

**Bug found and fixed during the phase**

A created pane starts a fresh shell and did not inherit the caller's `MABS_STATE_DIR`, so the Code and Tasks surfaces silently read the default store instead of the one the operator was looking at. The MABS environment overrides are now forwarded on pane creation, and a test asserts that only those keys are forwarded. The live run confirmed the viewer then registered in the caller's state directory.

A second, smaller fix: `herdr pane run` exits 0 with no output, and the first helper required JSON from every command, so successful pane commands were reported as failures. The fake `herdr` in the tests was corrected to behave the same way, so the tests exercise the real path.

**Decisions**

- Ownership is proved by returned pane ID plus current workspace membership. A label is display only.
- A surface command runs only in a pane this call created; a reused pane is left untouched, which is what prevents duplicate watchers and viewers.
- The Agent pane is never created or closed. It is the user's session.
- Outside Herdr the plan degrades to CLI commands rather than failing.

**Blockers:** none.

## Manual checks not executable here

These need a human attached to the Herdr TUI. They are unverified until then, and are not claimed as passing.

| Check | How to run it |
| --- | --- |
| Clicking a file reference opens the Code surface | Attach to Herdr, run a task, click a path in the Agent pane |
| Focus is preserved during background execution | Start a worker, keep typing in the Agent pane, confirm focus does not move |
| Split layout remains usable | Open the workspace, confirm Agent and Code are readable side by side |
| Compact rows expand with `ctrl+e` | Run a command in an interactive Pi session and toggle the row |
| `/mabs-verbose on` survives a restart | Toggle it, quit Pi, start it again |
| A picker appears for an ambiguous task | Run `/mabs-open` with two active tasks and confirm the selector lists both |
| The viewer opens in its own pane | Run `viewer serve` in a second pane, then `/mabs-open` from the Agent pane |
| Opening a file does not steal focus from a background worker | Start a worker, open a file, confirm focus follows the explicit action only |
| Selection survives a live refresh | Run `task watch` during real dispatch, select a row, confirm it stays selected as rows change |
| The dashboard reports a controller restart | Stop and restart the controller while `task watch` is open; confirm it shows stale, then recovers |
| Following a live provider transcript | Follow an attempt during a real worker run and confirm output appears without duplication |
| A real worker run end to end | Register a project, submit a task, run the controller, and watch all four surfaces during dispatch |
| Split layout ergonomics | `workspace open --layout=split` and confirm Agent and Code are both readable |

These are recorded with their expected results in [release acceptance](release-acceptance.md).
