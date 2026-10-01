import { test } from "node:test";
import assert from "node:assert/strict";

import { claudeNumTurns, codexToolItems, observe, type AttemptRow } from "../bench/run.ts";

test("Claude num_turns and Codex tool items are recorded in separate fields", () => {
  const claude = observe("claude", JSON.stringify({ type: "result", num_turns: 7, permission_denials: [{}], total_cost_usd: 0.5 }));
  assert.equal(claude.claudeNumTurns, 7);
  assert.equal(claude.codexToolItems, null);
  assert.equal(claude.turns, 7, "legacy field is still written for older readers");

  const raw = [
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "agent_message" } },
    { type: "item.completed", item: { type: "file_change" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const codex = observe("codex", raw);
  assert.equal(codex.codexToolItems, 2);
  assert.equal(codex.claudeNumTurns, null);
});

test("historical rows with only the mixed turns field are read by their adapter", () => {
  const legacy = (adapter: string): AttemptRow => ({ adapter, turns: 4 } as unknown as AttemptRow);
  assert.equal(claudeNumTurns(legacy("claude")), 4);
  assert.equal(codexToolItems(legacy("claude")), null);
  assert.equal(codexToolItems(legacy("codex")), 4);
  assert.equal(claudeNumTurns(legacy("codex")), null);
  assert.equal(claudeNumTurns(undefined), null);
});
