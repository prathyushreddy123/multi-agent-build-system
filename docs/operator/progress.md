# Operator workspace — implementation progress

[Documentation](../index.md) · [Operator workspace](index.md) · [Phase 0 capabilities](phase-0-capabilities.md)

Resumable record for the MABS Operator Workspace Implementation Plan. After a context reset, read this file, inspect the current diff, and resume the first incomplete phase.

**Current position:** Phase 0 complete. Next action: Phase 1 (compact Agent output).

## Phase status

| Phase | Focus | Status |
| --- | --- | --- |
| 0 | Inspect and prove compatibility | Complete |
| 1 | Compact Agent output | Not started |
| 2 | Code browsing and reliable file opening | Not started |
| 3 | Tasks and recorded implementation steps | Not started |
| 4 | Logs and evidence following | Not started |
| 5 | Workspace automation and release checks | Not started |

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

## Manual checks not executable here

These need a human attached to the Herdr TUI. They are unverified until then, and are not claimed as passing.

| Check | How to run it |
| --- | --- |
| Clicking a file reference opens the Code surface | Attach to Herdr, run a task, click a path in the Agent pane |
| Focus is preserved during background execution | Start a worker, keep typing in the Agent pane, confirm focus does not move |
| Split layout remains usable | Open the workspace, confirm Agent and Code are readable side by side |
