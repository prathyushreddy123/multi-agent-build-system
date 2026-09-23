import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeOperatorCapabilities, renderCapabilityReport } from "../../src/operator/capabilities.ts";

function withState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mabs-op-test-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = dir;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("the capability probe proves compact rendering and task-correct file opening against the installed tools", async () => {
  await withState(async () => {
    const capabilities = await probeOperatorCapabilities();
    const byId = new Map(capabilities.probes.map((probe) => [probe.id, probe]));

    // The two narrow integrations the plan requires before any UI work.
    const compact = byId.get("OP0-10");
    assert.equal(compact?.status, "PASS", String(compact?.detail));
    assert.match(String(compact?.data?.compact), /^Completed: command exited 0 in \d+\.\d+s$/);
    // An interrupted or failing execution is never summarized as success.
    assert.match(String(compact?.data?.compactFailure), /^Failed: command exited 3/);
    assert.ok(readFileSync(compact?.evidence as string, "utf8").includes("line 199"));

    const fileOpen = byId.get("OP0-11");
    assert.equal(fileOpen?.status, "PASS", String(fileOpen?.detail));
    const contents = fileOpen?.data?.contents as { task: string; text: string }[];
    assert.equal(contents.length, 2);
    assert.ok(contents.every((entry) => entry.text.includes(entry.task)));
    assert.equal(fileOpen?.data?.traversalRejected, true);

    // Every probe records what produced it, so an upgrade can be re-checked.
    for (const probe of capabilities.probes) {
      assert.ok(probe.evidence.length > 0, `${probe.id} has no evidence`);
      assert.ok(["PASS", "FAIL", "UNKNOWN", "SKIPPED"].includes(probe.status));
    }
  });
});

test("a missing capability is reported with its limitation rather than silently omitted", async () => {
  await withState(async () => {
    const capabilities = await probeOperatorCapabilities();
    const unavailable = capabilities.probes.filter((probe) => probe.status === "FAIL" || probe.status === "SKIPPED");
    for (const probe of unavailable) {
      // A failed integration proof is a real failure; an absent optional
      // capability must say what the operator layer does instead.
      if (probe.id === "OP0-10" || probe.id === "OP0-11") continue;
      assert.ok(probe.limitation || probe.status === "SKIPPED", `${probe.id} failed without recording a limitation`);
    }
    const report = renderCapabilityReport(capabilities);
    assert.match(report, /MABS operator workspace — capability probe/);
    assert.match(report, /OP0-12 Task, step, and evidence sources/);
  });
});
