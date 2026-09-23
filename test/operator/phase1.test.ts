import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PREFERENCES,
  preferencesPath,
  readPreferences,
  setOwnedSurface,
  updatePreferences,
} from "../../src/operator/preferences.ts";
import {
  PRESERVED_TOOL_KEYS,
  compactView,
  escapeControlSequences,
  fullOutputPath,
  plainText,
  renderExecution,
  shellFactsFromResult,
  withCompactRenderers,
} from "../../src/operator/rendering.ts";
import { recognizeReport, summarizeExecution, summarizeRecords } from "../../src/operator/summaries.ts";

function withState<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "mabs-op1-"));
  const previous = process.env.MABS_STATE_DIR;
  const previousConfig = process.env.MABS_OPERATOR_CONFIG;
  process.env.MABS_STATE_DIR = dir;
  delete process.env.MABS_OPERATOR_CONFIG;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previous;
    if (previousConfig !== undefined) process.env.MABS_OPERATOR_CONFIG = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a summary states only what the execution reported", () => {
  const success = summarizeExecution({ tool: "bash", command: "npm run build", exitCode: 0, durationMs: 2100, output: "done\n" });
  assert.equal(success.headline, "Completed: npm run build exited 0 in 2.1s");
  assert.equal(success.basis, "exit-status");

  // An unrecognized command never acquires a claim it did not make.
  const unknown = summarizeExecution({ tool: "bash", command: "./deploy.sh", exitCode: 0, output: "ok" });
  assert.equal(unknown.basis, "exit-status");
  assert.doesNotMatch(unknown.headline, /test|passed/i);

  const failure = summarizeExecution({ tool: "bash", command: "tsc --noEmit", exitCode: 2, durationMs: 900, output: "a.ts(3,4): error TS2345: bad\nb.ts(9,1): error TS1005: bad\n" });
  // Sub-second runs keep millisecond precision; seconds would round 900ms to 0.9s.
  assert.equal(failure.headline, "Failed: typecheck returned 2 errors in 900ms");
  assert.equal(failure.basis, "typecheck-report");
  assert.equal(failure.tone, "failure");
});

test("test counts are reported only when a test reporter confirmed them", () => {
  assert.equal(recognizeReport("some prose claiming 47 tests passed"), null);

  const nodeTest = recognizeReport("ℹ tests 81\nℹ pass 81\nℹ fail 0\n");
  assert.equal(nodeTest?.headline, "Tests: 81 passed");

  const jest = recognizeReport("Tests:       3 failed, 44 passed, 47 total");
  assert.equal(jest?.headline, "Tests: 3 failed, 44 passed");
  assert.equal(jest?.tone, "failure");

  const pytest = recognizeReport("============ 44 passed, 2 warnings in 1.20s ============");
  assert.equal(pytest?.headline, "Tests: 44 passed");
});

test("interrupted work is never summarized as successful", () => {
  const cancelled = summarizeExecution({ tool: "bash", command: "npm test", cancelled: true, durationMs: 4000, output: "ℹ pass 81\nℹ fail 0\n" });
  assert.match(cancelled.headline, /^Interrupted: npm test was cancelled in 4\.0s$/);
  assert.equal(cancelled.tone, "failure");

  const timedOut = summarizeExecution({ tool: "bash", command: "npm test", timedOut: true, output: "" });
  assert.match(timedOut.headline, /^Timed out: npm test$/);
  assert.equal(timedOut.tone, "failure");

  // A passing reporter line cannot override a failing exit status.
  const mixed = summarizeExecution({ tool: "bash", command: "npm test", exitCode: 1, output: "ℹ pass 81\nℹ fail 0\n" });
  assert.match(mixed.headline, /^Failed: npm test exited 1$/);
  assert.match(String(mixed.detail), /but the command still failed/);

  const running = summarizeExecution({ tool: "bash", command: "npm test", partial: true, durationMs: 1500 });
  assert.equal(running.headline, "Running: npm test in 1.5s");
  const waiting = summarizeExecution({ tool: "bash", command: "gh auth login", awaitingInput: true });
  assert.equal(waiting.headline, "Waiting for input: gh auth login");
});

test("Pi's shell result markers are read as execution facts, not prose", () => {
  const failed = shellFactsFromResult({ tool: "bash", command: "false", text: "oops\n\nCommand exited with code 7", isError: true });
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.cancelled, undefined);

  const aborted = shellFactsFromResult({ tool: "bash", command: "sleep 100", text: "partial\n\nCommand aborted", isError: true });
  assert.equal(aborted.cancelled, true);
  assert.equal(summarizeExecution(aborted).tone, "failure");

  const timedOut = shellFactsFromResult({ tool: "bash", command: "sleep 100", text: "partial\n\nCommand timed out after 30 seconds", isError: true });
  assert.equal(timedOut.timedOut, true);

  const truncated = shellFactsFromResult({
    tool: "bash", command: "cat big", isError: false,
    text: "a\nb\n\n[Showing lines 1-2 of 900. Full output: /tmp/pi-bash-1.log]",
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.exitCode, 0);
  assert.equal(fullOutputPath(truncated.output), "/tmp/pi-bash-1.log");
});

test("compact and expanded views describe the same execution and keep the original output", () => {
  const output = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
  const facts = { tool: "bash", command: "npm run build", exitCode: 0, durationMs: 2100, output };

  const collapsed = plainText(renderExecution(facts, { expanded: false }));
  const expanded = plainText(renderExecution(facts, { expanded: true, maxExpandedLines: 100 }));

  // The same headline in both views: expansion adds evidence, it does not
  // change the claim.
  assert.equal(collapsed.split("\n")[0], expanded.split("\n")[0]);
  assert.ok(collapsed.length < expanded.length);
  // Every original line is recoverable by expanding.
  for (const line of output.split("\n")) assert.ok(expanded.includes(line));

  const limited = plainText(renderExecution(facts, { expanded: true, maxExpandedLines: 10 }));
  assert.match(limited, /… 50 more lines/);
});

test("a failure stays visible in the collapsed view", () => {
  const summary = summarizeExecution({ tool: "bash", command: "tsc", exitCode: 2, output: "a.ts(1,1): error TS1005: bad\n" });
  const collapsed = plainText(compactView(summary, { expanded: false, output: "a.ts(1,1): error TS1005: bad\n" }));
  assert.match(collapsed, /Failed: typecheck returned 1 error/);
  assert.match(collapsed, /\[expand for details\]/);
});

test("control sequences from captured output are escaped when drawn", () => {
  const raw = "before\u001b[2J\u0007after";
  const escaped = escapeControlSequences(raw);
  assert.ok(!escaped.includes("\u001b"));
  assert.ok(!escaped.includes("\u0007"));
  assert.match(escaped, /before/);
  assert.match(escaped, /after/);

  // The fact identity is preserved: the original string is untouched.
  assert.equal(raw, "before\u001b[2J\u0007after");
});

test("re-registering a tool preserves everything except the two render functions", () => {
  const execute = async () => ({ content: [{ type: "text", text: "ok" }], details: undefined });
  const original = {
    name: "bash",
    label: "bash",
    description: "Execute a bash command",
    parameters: { type: "object" },
    promptSnippet: "Run a shell command",
    promptGuidelines: ["Prefer the dedicated tools"],
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    prepareArguments: (args: unknown) => args,
    execute,
    renderCall: () => "original call",
    renderResult: () => "original result",
  };

  const replaced = withCompactRenderers(original, {
    renderCall: () => "compact call",
    renderResult: () => "compact result",
  });

  for (const key of PRESERVED_TOOL_KEYS) {
    assert.deepEqual(
      (replaced as Record<string, unknown>)[key],
      (original as Record<string, unknown>)[key],
      `${key} changed during re-registration`,
    );
  }
  // The identical executor object is reused, so execution cannot drift.
  assert.equal(replaced.execute, execute);
  assert.equal(replaced.renderCall(), "compact call");
  assert.equal(replaced.renderResult(), "compact result");
});

test("MABS record output is summarized by counting the response, not reading prose", () => {
  const list = summarizeRecords({ tool: "mabs_status", exitCode: 0, output: JSON.stringify([{ id: 1 }, { id: 2 }]), noun: "task" });
  assert.equal(list.headline, "mabs_status: 2 tasks");
  assert.equal(list.basis, "record-count");

  const notJson = summarizeRecords({ tool: "mabs_status", exitCode: 0, output: "plain text" });
  assert.equal(notJson.basis, "exit-status");

  const failing = summarizeRecords({ tool: "mabs_status", exitCode: 1, output: "Unknown project" });
  assert.equal(failing.tone, "failure");
});

test("the verbose preference persists and never touches task state", () => {
  withState(() => {
    assert.equal(readPreferences().verbose, DEFAULT_PREFERENCES.verbose);

    const stored = updatePreferences({ verbose: true });
    assert.equal(stored.verbose, true);
    assert.equal(readPreferences().verbose, true);
    assert.match(preferencesPath(), /operator[/\\]preferences\.json$/);

    // Surfaces are tracked by returned ID, and a label is display only.
    setOwnedSurface("code", { paneId: "w1:p2", tabId: "w1:t2", label: "Code", createdAt: new Date().toISOString() });
    assert.equal(readPreferences().workspace.surfaces.code?.paneId, "w1:p2");
    // Updating an unrelated preference does not drop an owned surface.
    updatePreferences({ viewer: "vim" });
    assert.equal(readPreferences().workspace.surfaces.code?.paneId, "w1:p2");
    setOwnedSurface("code", null);
    assert.equal(readPreferences().workspace.surfaces.code, undefined);

    // A corrupt file degrades to defaults rather than failing the session.
    writeFileSync(preferencesPath(), "{ not json");
    assert.equal(readPreferences().verbose, DEFAULT_PREFERENCES.verbose);
  });
});
