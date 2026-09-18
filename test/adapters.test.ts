import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HarnessAdapter } from "../src/adapters/harness.ts";

test("adapter preserves an actionable provider failure instead of reporting only malformed output", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-adapter-"));
  mkdirSync(join(root, ".mabs"));
  const completionPath = join(root, "completion.json");
  const raw = JSON.stringify({
    terminal_reason: "api_error",
    api_error_status: 429,
    modelUsage: {},
    result: "You've hit your session limit",
  });
  writeFileSync(completionPath, JSON.stringify({
    error: null,
    result: {
      exitCode: 1,
      timedOut: false,
      durationMs: 10,
      finalMessage: "You've hit your session limit",
      reportedModel: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      apiEquivalentEstimateUsd: 0,
      sessionId: "test",
      raw,
      stderr: "",
    },
  }));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const adapter = new HarnessAdapter("claude");
  const result = await adapter.collectResult({ attemptId: "attempt", pid: null, sessionId: null, completionPath }, root);
  assert.equal(result.failureClass, "QUOTA");
  assert.match(result.error ?? "", /session limit/);
  assert.equal(result.validation.ok, false);
});
