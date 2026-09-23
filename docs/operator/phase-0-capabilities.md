# Operator workspace — Phase 0 capability proof

[Documentation](../index.md) · [Operator workspace](index.md) · [Progress note](progress.md)

Phase 0 of the operator workspace plan inspects the actual checkout and the actually installed tools before any UI work begins. Nothing here is assumed from a public branch or a published API reference.

Reproduce it at any time:

```bash
node src/cli.ts operator probe          # readable report
node src/cli.ts operator probe --json   # machine-readable capabilities
```

Evidence is written to `~/.local/state/mabs/operator/phase0/<timestamp>/`, including `capabilities.json`, the compact-rendering round trip, and the worktree file-open proof. Re-run the probe after upgrading Pi or Herdr and compare against the recorded versions.

The probe exits non-zero only when one of the two narrow integration proofs (OP0-10, OP0-11) fails. A missing optional capability is reported with the limitation it imposes, not treated as a failure.

## Installed versions at the time of writing

| Component | Version |
| --- | --- |
| Node | v24.20.0 |
| npm | 12.0.2 |
| Git | 2.43.0 |
| Pi | 0.86.1 |
| Herdr | 0.9.1 (client), 0.9.0 (server) |
| Platform | WSL2 (`Ubuntu-24.04`), Linux 6.6.87.2 |

No upgrade was performed. The plan forbids a broad upgrade merely to begin UI work, and every capability below was checked against these versions.

## Repository facts the operator layer builds on

| Concern | Where it lives |
| --- | --- |
| CLI entrypoint | `src/cli.ts` (`node src/cli.ts <command>`; `mabs` is the `bin` name, `npm run mabs` the script) |
| Pi extension | `.pi/extensions/mabs.ts`, registered through `package.json` → `pi.extensions` |
| Checks | `npm run typecheck` (`tsc --noEmit`), `npm test` (`node --test test/*.test.ts test/operator/*.test.ts`) |
| Authoritative task state | SQLite `tasks.state` (`src/domain/states.ts`) |
| Recorded implementation steps | `task_checkpoints` (`Records.recordCheckpoint` / `checkpointsForTask`) |
| Attempt identity | `attempts` (`attempt_number`, `kind`, `adapter`, `model`, `state`, `heartbeat_at`) |
| Worker transcript | `attempts.output_path` |
| Check output | `gate_results.evidence_path` |
| Review detail | `review_results.evidence_path` |
| Worktrees | `MABS_WORKTREE_ROOT` or `~/worktrees/<projectId>/<taskId>` (`src/core/paths.ts`) |
| Read APIs to reuse | `src/store/records.ts`, `src/diagnostics/task.ts`, `src/workbench/server.ts` |

The controller remains the scheduler and the only writer of task transitions. Everything the operator workspace adds reads these records.

## Capability findings

### Available

| ID | Capability | What the probe established |
| --- | --- | --- |
| OP0-03 | Presentation-only tool rendering | `ToolDefinition.renderResult(result, { expanded, isPartial }, theme, ctx)` receives the finished result and cannot change it, so compact rendering is presentation-only by construction. `ctx.ui.getToolsExpanded()` / `setToolsExpanded()` provide a shared expansion preference. |
| OP0-03 | Original executors for built-ins | Pi exports `createBashTool`, `createReadTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`, so a built-in re-registered by name can delegate execution unchanged. |
| OP0-05 | Herdr workspace/tab/pane API | `herdr workspace list`, `tab create`, `pane split`, `pane run`, `pane read`, `pane close` return JSON with opaque IDs (`w1`, `w1:t1`, `w1:p1`). Caller context arrives as `$HERDR_WORKSPACE_ID`, `$HERDR_TAB_ID`, `$HERDR_PANE_ID`, and `HERDR_ENV=1`. |
| OP0-07 | Internal viewer | `vim` 9.1 (`-R` read-only, `+syntax`, `+diff`) and `less` 590. |
| OP0-09 | External editor (optional) | `cursor` is reachable, but as a Windows binary under `/mnt/c`, so it needs `--remote wsl+Ubuntu-24.04` to address this filesystem. |

### Missing, with the consequence recorded

| ID | Gap | What the operator layer does instead |
| --- | --- | --- |
| OP0-06 | Herdr 0.9.1 exposes no link, hyperlink, or URL handler registration. OSC-8 formatting alone cannot open a file. | File opening is driven by the picker, the slash command, and the CLI. OSC-8 sequences may still be emitted for terminals that handle them, but are never the only route. |
| OP0-08 | `vim` is built `-clientserver` and Neovim is not installed, so no editor remote-control channel exists. | A MABS-owned viewer process reads selections from its own request channel. Shell commands are never typed into a pane that may be running an editor or an agent. |
| OP0-07 | Neovim, which the plan prefers, is not installed. | `vim -R` supplies browsing, search, syntax highlighting, and diff. `less` stays a degraded fallback, not a substitute for browsing. |
| — | Pi's `tool_result` event can replace result content, so it is a model-facing hook. | It is not used for presentation. Built-ins are re-registered by name with execution delegated to the exported original executor. |

## Proof 1 — compact result with expandable original output (OP0-10)

Two real executions are run through `src/core/exec.ts`. The compact form is derived only from execution facts:

```
Completed: command exited 0 in 0.0s      # replaces 201 lines, recoverable byte-for-byte
Failed: command exited 3 in 0.0s         # a non-zero exit is never rendered as success
```

The original output is written to the evidence directory and compared back, so expansion cannot lose it. This establishes the route; Phase 1 generalizes it across tools and output sources.

## Proof 2 — file open into the correct task worktree (OP0-11)

The probe builds a temporary repository with two worktrees holding different content at the same relative path, then resolves `shared.ts` for each task. The proof requires all three:

- each selection returns its own worktree's bytes, not the base checkout's;
- the two results are distinct;
- `../../repo/shared.ts` is rejected because it canonicalizes outside the selected worktree root.

This is the resolver contract every later surface reuses: a click, a picker, a slash command, and a CLI command must never select different worktrees for the same task.

## Launch commands verified in this checkout

```bash
node src/cli.ts help              # command list
node src/cli.ts operator probe    # this report
npm run typecheck                 # tsc --noEmit
npm test                          # node --test
```

`node` cannot be assumed to run `src/cli.ts` on every Node version; it works here because Node 24 executes TypeScript directly and the repository's `tsconfig.json` uses `allowImportingTsExtensions` with `rewriteRelativeImportExtensions`.

## What Phase 0 did not verify

- Interactive Herdr behavior (focus, splits, click targets) was exercised through the socket API, not through a human attaching to the TUI. Manual checks are listed in the [progress note](progress.md).
- No provider, model, or authentication route was touched. The operator workspace adds no model calls.
