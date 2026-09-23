# Operator workspace — compact Agent output

[Documentation](../index.md) · [Operator workspace](index.md) · [Phase 0 capabilities](phase-0-capabilities.md)

The Agent surface shows what an execution did, not everything it printed. Expanding a row shows the original output unchanged.

```
$ npm run build
Completed: npm run build exited 0 in 2.1s

$ npm test
Tests: 81 passed in 4.3s

$ npm run typecheck
Failed: typecheck returned 3 errors in 0.9s    [expand for details]
```

## Commands

| Command | Effect |
| --- | --- |
| `/mabs-verbose` | Report the current setting |
| `/mabs-verbose on` | Always show original output; also sets Pi's own expansion state |
| `/mabs-verbose off` | Show compact summaries; expand a row for the original |
| `/mabs-compact off` | Disable the whole presentation layer, then `/reload` |
| `/mabs-compact on` | Re-enable it, then `/reload` |

`ctrl+e` still toggles Pi's expansion, and the compact view honours it. The `/mabs-verbose` setting persists across sessions in `~/.local/state/mabs/operator/preferences.json`; nothing about it reaches the task store.

## What a summary is allowed to say

Every headline comes from execution metadata or from a reporter format that was actually matched in the output. No model call is made to summarize a tool, and model prose is never read as a result.

| Basis | Used when | Example |
| --- | --- | --- |
| `exit-status` | Always available, and the default | `Completed: npm run build exited 0 in 2.1s` |
| `test-report` | node:test, Jest/Vitest, or pytest counters matched | `Tests: 81 passed` |
| `typecheck-report` | `error TS####:` lines matched | `Failed: typecheck returned 3 errors` |
| `lint-report` | an ESLint problem summary matched | `Failed: lint reported 5 errors` |
| `diff-stat` | a `git diff --stat` summary matched | `Changed: 7 files (+120 / -14)` |
| `record-count` | a MABS command returned JSON | `mabs_status: 4 tasks` |
| `cancelled` / `timeout` | Pi reported abort or timeout | `Interrupted: npm test was cancelled in 4.0s` |
| `running` | execution has not finished | `Running: npm test in 1.5s` |

Rules that hold in every case:

- An unrecognized command gets the neutral exit-status summary. It never acquires a test count it did not report.
- Interrupted, cancelled, and timed-out work is reported as such, never as success, even when a passing reporter line was printed before the interruption.
- A passing reporter line cannot override a failing exit status. The summary says the command failed and adds the reporter fact as a detail.
- A failure stays visible while collapsed; only the evidence is behind the expansion.
- Elapsed time is measured from Pi's `tool_execution_start` and `tool_execution_end` events. When no timing was observed, no time is shown.

## How rendering stays presentation-only

Phase 0 established that `ToolDefinition.renderResult` receives a finished result and cannot change it, while Pi's `tool_result` event *can* replace result content. The extension therefore uses the renderer and never the event.

Built-in tools have no separate renderer registration, so each is re-registered under its own name using **Pi's own definition object**, with only `renderCall` and `renderResult` replaced. That keeps:

- the identical `execute` function, so streaming, the abort signal, timeouts, and error behaviour are unchanged;
- the parameter schema, description, prompt snippet and guidelines, constrained-sampling request, execution mode, and argument preparation;
- the user's configured shell path and command prefix, which Pi passes into its shell tool from settings — re-creating the tool from defaults would have silently ignored them.

Covered tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, and all thirteen MABS tools, which are how worker output, check results, and controller state reach the transcript.

`test/operator/extension-load.test.ts` loads the real extension against the installed Pi and asserts that every re-registered tool keeps its executor, schema, and description, and that only the two render functions changed.

## Limitations

- Terminal control sequences in captured output are escaped when drawn, so a log cannot repaint the terminal. The bytes on disk are untouched.
- Expansion shows the first 40 lines by default and points at Pi's full-output file when Pi truncated the result. Pi's existing truncation rules are unchanged.
- `powershell` is not re-registered; this checkout targets WSL.
- Headless and RPC workers are unaffected: rendering only runs where a terminal renderer exists.

## Turning it off

```
/mabs-compact off
/reload
```

Pi's own tool rendering returns immediately. The preference file is the only state involved; tasks, attempts, and evidence are untouched. Removing `./.pi/extensions/mabs-ux.ts` from `package.json` → `pi.extensions` has the same effect permanently.
