import assert from "node:assert/strict";
import test from "node:test";

import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";
import { createWorkbench } from "../src/workbench/server.ts";

test("workbench binds locally, serves controller state, and protects mutations", async (t) => {
  const records = new Records(new Store(":memory:"));
  const project = records.createProject({ name: "demo", repoPath: "/tmp/demo" });
  const task = records.createTask({ projectId: project.id, title: "task", objective: "do work" });
  const approval = records.requestApproval({
    projectId: project.id,
    taskId: task.id,
    binding: { action: "merge", target: "main", revision: "abc", configVersion: project.configVersion },
    reason: "ready",
  });
  const workbench = createWorkbench(records, { port: 0 });
  const address = await workbench.listen();
  t.after(async () => {
    await new Promise<void>((resolvePromise) => workbench.server.close(() => resolvePromise()));
    records.store.close();
  });
  const origin = `http://${address.host}:${address.port}`;

  const overview = await fetch(`${origin}/api/overview`);
  assert.equal(overview.status, 200);
  const body = await overview.json() as { taskCounts: Record<string, number>; approvals: { id: string }[] };
  assert.equal(body.taskCounts.QUEUED, 1);
  assert.equal(body.approvals[0]?.id, approval.id);

  const denied = await fetch(`${origin}/api/approvals/${approval.id}/approve`, { method: "POST" });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${origin}/api/approvals/${approval.id}/approve`, {
    method: "POST",
    headers: { "x-mabs-token": workbench.token },
  });
  assert.equal(allowed.status, 200);
  assert.equal(records.getApproval(approval.id)?.state, "approved");
});

test("workbench refuses non-local bind addresses", () => {
  const records = new Records(new Store(":memory:"));
  assert.throws(() => createWorkbench(records, { host: "0.0.0.0" }), /only bind to localhost/);
  records.store.close();
});
