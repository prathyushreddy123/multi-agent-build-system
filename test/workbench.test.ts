import assert from "node:assert/strict";
import test from "node:test";

import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";
import { createWorkbench } from "../src/workbench/server.ts";

test("workbench binds locally, serves controller state, and protects mutations", async (t) => {
  const records = new Records(new Store(":memory:"));
  const project = records.createProject({
    name: "demo", repoPath: "/tmp/demo", reviewPolicy: { mode: "none", skipTaskClasses: [] },
  });
  const task = records.createTask({ projectId: project.id, title: "task", objective: "do work" });
  records.updateTaskFields(task.id, { result_revision: "abc" });
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

  const prepared = await fetch(`${origin}/api/approvals`, {
    method: "POST",
    headers: { "x-mabs-token": workbench.token, "content-type": "application/json" },
    body: JSON.stringify({ taskId: task.id, action: "deploy", target: "local-test", reason: "Prepared only; no executor." }),
  });
  assert.equal(prepared.status, 200);
  const preparedBody = await prepared.json() as { required: boolean; approval: { state: string } };
  assert.equal(preparedBody.required, true);
  assert.equal(preparedBody.approval.state, "pending");

  const details = await fetch(`${origin}/api/tasks/${task.id}`);
  assert.equal(details.status, 200);
  const detailBody = await details.json() as { diagnostics: { taskId: string }; reviews: unknown[]; feedback: unknown[] };
  assert.equal(detailBody.diagnostics.taskId, task.id);
  assert.deepEqual(detailBody.reviews, []);

  const question = await fetch(`${origin}/api/feedback`, {
    method: "POST",
    headers: { "x-mabs-token": workbench.token, "content-type": "application/json" },
    body: JSON.stringify({
      targetType: "task", targetId: task.id, projectId: project.id, kind: "question",
      body: "What happens next?", expectedVersion: records.getTask(task.id)?.recordVersion,
    }),
  });
  assert.equal(question.status, 200);
  const feedback = await question.json() as { id: string; state: string };
  assert.equal(feedback.state, "pending");
  const answer = await fetch(`${origin}/api/feedback/${feedback.id}/answer`, {
    method: "POST",
    headers: { "x-mabs-token": workbench.token, "content-type": "application/json" },
    body: JSON.stringify({ response: "The task remains queued." }),
  });
  assert.equal(answer.status, 200);
  assert.equal(records.getFeedback(feedback.id)?.state, "answered");

  const escapedArtifact = await fetch(`${origin}/api/artifact?path=${encodeURIComponent("/etc/passwd")}`);
  assert.equal(escapedArtifact.status, 400);
});

test("workbench refuses non-local bind addresses", () => {
  const records = new Records(new Store(":memory:"));
  assert.throws(() => createWorkbench(records, { host: "0.0.0.0" }), /only bind to localhost/);
  records.store.close();
});
