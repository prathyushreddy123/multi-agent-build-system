# Local patches for pi extensions

[Repository home](../../README.md) · [Troubleshooting](../../docs/troubleshooting.md)

MABS drives pi through the [`pi-claude-agent-sdk`](https://github.com/pi-pod/pi-claude-agent-sdk)
bridge, which runs Claude models on a subscription instead of a metered API key. Patches here
keep that bridge working against the installed pi until upstream catches up. They are not part
of the MABS build and nothing in `src/` depends on them.

## `pi-claude-agent-sdk-0.8.6-pi086-contract.patch`

**Problem.** pi 0.86.0 changed the provider contract. `normalizeContext()` folds the system
prompt and the tool list into a leading `system`-role message and stops passing
`context.systemPrompt` and `context.tools`:

```js
function normalizeContext(context) {
  let initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
  return { messages: initialMessage ? [initialMessage, ...context.messages] : context.messages };
}
```

Bridge 0.8.6 still reads both fields, so on pi 0.86+ two things break:

1. **No tools.** `context.tools` is `undefined`, so no MCP tools are registered. The model is
   told by pi's prompt that `read`/`bash`/`edit`/`write` and the MABS tools exist, cannot call
   any of them, and emits tool calls as prose with invented results. For MABS that means
   fabricated task state — the failure this repository exists to prevent.
2. **Every first turn dies.** The leading system message counts as a prior message that
   `convertPiMessages` has no branch for, so the rebuilt Claude Code session contains zero
   records. `Session.save()` writes no file for an empty record set, and the turn then
   `--resume`s a session id that is not on disk:
   `No conversation found with session ID: ...`

**Fix.** `shimPi086Context()` undoes the fold at the provider entry point, reproducing pi's own
accessors (`getCurrentTools` / `getCurrentSystemMessage` / `getSystemMessageText`) so the
reconstructed system prompt is byte-identical to what pi assembled. Everything downstream then
sees the 0.85 shape it was written against.

The shim no-ops when `systemPrompt` or `tools` are already populated, so it goes dormant on a
pi that still uses the old contract and on any future bridge that handles the new one.

**Applies to:** pi >= 0.86.0 with pi-claude-agent-sdk 0.8.6. Submitted upstream; drop this
patch once a release includes the fix.

## Applying

```bash
.pi/patches/apply.sh                 # default: ~/.pi/agent/npm/node_modules/pi-claude-agent-sdk
.pi/patches/apply.sh /other/path     # or point it somewhere else
```

The script refuses a version it was not written against, skips work if the shim is already
present, and saves the stock file next to the patched one. **Re-run it after every `pi update`,
`npm update`, or extension reinstall** — those restore the stock package and both bugs return.

## Verifying

```bash
CLAUDE_BRIDGE_DEBUG=1 pi -p -t read --provider claude-bridge \
  --model claude-haiku-4-5 'read package.json and name the project'
grep shimPi086Context "${PI_AGENT_DIR:-$HOME/.pi/agent}"/claude-bridge.log
```

A `shimPi086Context: unfolded system message → ... tools=N` line with **N > 0** means the shim
is live and tools are reaching the model. No line at all means the stock package is installed.

Checked on 2026-09-22 against pi 0.86.1: first turn succeeds, `tools=17` in this repository
(4 built-in + 13 MABS), `mabs_status` returns the same counts as `node src/cli.ts status`, and
a resumed second turn recalls prior context without re-reading.
