# Operator workspace — release acceptance

[Documentation](../index.md) · [Operator workspace](index.md) · [Progress note](progress.md)

Results of the release acceptance matrix, recorded on 22 September 2026 against Pi 0.86.1, Herdr 0.9.1, Node v24.20.0, on WSL2 (`Ubuntu-24.04`).

**Read this honestly:** rows marked *automated* are asserted by the test suite. Rows marked *live* were executed against the real Herdr session and real records on this machine. Rows marked *not verified* need a real provider run or a human attached to the TUI, and are listed as manual checks rather than claimed as passing.

## Matrix

| Scenario | Required result | Verified how | Result |
| --- | --- | --- | --- |
| Two concurrent tasks | The same relative filename opens from the selected task and attempt | automated (`phase2`) | Each task's own bytes, for filenames with spaces, non-ASCII, quotes, leading hyphens, and nested paths; the base checkout is never returned |
| Worker fails or is cancelled | Compact output and Tasks show the real outcome; evidence is retained | automated (`acceptance`, `phase1`) | A cancelled attempt renders as `Interrupted:`, its step status is `failed`, and its partial transcript is still readable |
| Pi reload or controller restart | No duplicate watchers; UI reconnects or reports stale state | automated (`phase3`, `phase5`) + live | A second `workspace open` created no panes and started no second viewer; with no health record the dashboard reports `controller unknown` and `STALE` rather than serving old figures as current |
| Workspace open twice | Existing owned surfaces are reused; unrelated panes are untouched | live | Pane count unchanged (4 → 4), all four surfaces `reused`, one `viewer serve` process |
| Worktree removed | Retained revision/evidence opens, or an explicit unavailable message appears | automated (`phase2`, `acceptance`) + live | Content came from the recorded revision with the reason stated; a path absent from that revision reported unavailable and explicitly *not* the base checkout's copy |
| Headless worker execution | No terminal-only renderer requirement changes worker behavior | automated (`phase1`, `extension-load`) | Rendering is `renderResult` only, which runs where a terminal renderer exists; the executor object is identical to Pi's, asserted field by field |
| Feature disabled | Original CLI, Pi integration, and workbench still function | live | With the presentation layer disabled: `pi --mode rpc` started, `mabs status` and `mabs task list` ran, the workbench bound a port |
| Closing a surface | A worker is not cancelled | live | Task state byte-identical before and after `workspace close`; the Agent pane survived with its Pi session |
| Read-only guarantee | The surfaces never schedule work or mutate task state | automated (`phase3`, `acceptance`) | Repeated snapshots, evidence listings, change listings, and file opens left the task record, its events, its attempts, and its approvals unchanged |

## End-to-end run

One lifecycle — implementation → failing required check → repair → passing check → review → delivery approval — recorded exactly as the controller records it, then read back through all four surfaces (`test/operator/acceptance.test.ts`).

What it establishes:

- the eleven recorded steps appear in order, and **the retry hides nothing**: attempt 1's failing `typecheck` sits next to attempt 2's passing one, each tagged with its attempt number;
- the review's different provider (`codex`) is reported rather than smoothed into the implementation's;
- a `DONE`, checked, and approved task still reports `delivery: not requested`;
- every step's evidence reference opens a real record in the Logs surface, and the failing check's output still contains `error TS2322`;
- the Agent's compact summary of that check is derived from the recorded output and reads `Failed: typecheck returned 1 error`;
- selecting the earlier attempt inspects that attempt, not the latest.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run typecheck:extensions` | Clean |
| `npm test` | 154 passed, 0 failed |
| `node src/cli.ts operator probe` | Exit 0; both integration proofs PASS |

## Not verified here

These need a real provider run or a human attached to the Herdr TUI. They are stated as unverified rather than claimed.

| Check | How to run it |
| --- | --- |
| A real worker run end to end | Register a project, submit a task, run the controller, and watch all four surfaces during dispatch |
| Following a live provider transcript | Follow an attempt during a real run and confirm output appears without duplication |
| Clicking a file reference | Attach to Herdr and click a path in the Agent pane. **Expected to do nothing:** Herdr 0.9.1 exposes no link handler, so use the picker, the slash command, or the CLI |
| `ctrl+e` expansion in the TUI | Run a command in an interactive Pi session and toggle the row |
| Split layout ergonomics | `workspace open --layout=split` and confirm Agent and Code are both readable |
| Focus during background work | Start a worker, keep typing in the Agent pane, confirm focus does not move |

## Known limitations

| Limitation | Consequence |
| --- | --- |
| Herdr 0.9.1 has no link-handler registration | Clicking an OSC-8 hyperlink cannot route back into MABS. The picker, slash command, and CLI are the routes |
| No editor remote-control channel here (no Neovim, vim built `-clientserver`) | Viewer reuse is a MABS-owned process reading its own request file |
| Progress inside a running attempt is not instrumented | The Tasks surface shows the attempt's start and heartbeat and labels the rest unavailable |
| Raw provider transcripts have no recorded command boundaries | Per-command navigation inside a transcript is unavailable and labelled |
| Evidence contents are not redacted | Existing behaviour, unchanged. A transcript contains whatever the worker printed |
| `powershell` is not re-registered for compact rendering | This checkout targets WSL |
