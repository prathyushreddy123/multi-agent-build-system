import assert from "node:assert/strict";
import test from "node:test";

import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

function records(): Records {
  return new Records(new Store(":memory:"));
}

test("project, task, transition, and event state are stored together", (t) => {
  const db = records();
  t.after(() => db.store.close());

  const project = db.createProject({ name: "demo", repoPath: "/tmp/demo" });
  db.addRequirement(project.id, "REQ-1", "The result must be durable.");
  const task = db.createTask({
    projectId: project.id,
    title: "Implement durability",
    objective: "Persist state",
    acceptanceCriteria: ["restart-safe"],
  });

  assert.equal(task.state, "QUEUED");
  assert.deepEqual(db.listRequirements(project.id), [
    { id: "REQ-1", text: "The result must be durable.", mandatory: true },
  ]);

  const ready = db.transition(task.id, "READY");
  assert.equal(ready.state, "READY");
  const claimed = db.claimTask(task.id, "launch-1");
  assert.equal(claimed?.claimedBy, "launch-1");
  assert.equal(db.claimTask(task.id, "launch-2"), null);

  const running = db.transition(task.id, "RUNNING", { branch: "mabs/task", base_revision: "abc" });
  assert.equal(running.branch, "mabs/task");
  assert.throws(() => db.transition(task.id, "DONE"), /Invalid task transition/);
  assert.throws(() => db.updateTaskFields(task.id, { state: "DONE" }), /Invalid task field/);

  const stateEvents = db.listEvents(task.id).filter((event) => event.kind === "task.state");
  assert.equal(stateEvents.length, 2);
});

test("dependencies must exist in the same project", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const one = db.createProject({ name: "one", repoPath: "/tmp/one" });
  const two = db.createProject({ name: "two", repoPath: "/tmp/two" });
  const upstream = db.createTask({ projectId: one.id, title: "upstream", objective: "first" });

  assert.throws(
    () => db.createTask({ projectId: two.id, title: "downstream", objective: "second", dependsOn: [upstream.id] }),
    /belongs to another project/,
  );
  assert.throws(
    () => db.createTask({ projectId: one.id, title: "bad", objective: "bad", dependsOn: ["missing"] }),
    /Unknown dependency/,
  );
});

test("explicit retries require the current task version", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ name: "retry-demo", repoPath: "/tmp/retry" });
  const task = db.createTask({ projectId: project.id, title: "retry", objective: "recover" });
  const blocked = db.transition(task.id, "BLOCKED", { blocked_reason: "provider unavailable" });
  assert.throws(() => db.retryTask(task.id, task.recordVersion), /changed since/);
  const ready = db.retryTask(task.id, blocked.recordVersion);
  assert.equal(ready.state, "READY");
  assert.equal(ready.blockedReason, null);
  assert.equal(db.listEvents(task.id)[0]?.kind, "task.retry_requested");
});

test("controller lease excludes peers until released or stale", (t) => {
  const db = records();
  t.after(() => db.store.close());
  assert.equal(db.acquireControllerLease("one", 100, 15_000), true);
  assert.equal(db.acquireControllerLease("two", 200, 15_000), false);
  db.store.run("UPDATE controller_lease SET heartbeat_at = ? WHERE singleton = 1", new Date(Date.now() - 60_000).toISOString());
  assert.equal(db.acquireControllerLease("two", 200, 15_000), true);
  assert.equal(db.currentControllerLease()?.controller_id, "two");
  db.releaseControllerLease("two");
  assert.equal(db.currentControllerLease(), undefined);
});

test("attempts, gates, and revision-bound approvals retain evidence", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ name: "demo", repoPath: "/tmp/demo" });
  const task = db.createTask({ projectId: project.id, title: "change", objective: "change code" });
  db.transition(task.id, "READY");
  db.claimTask(task.id, "launch-1");
  db.transition(task.id, "RUNNING");

  const attempt = db.startAttempt({
    taskId: task.id,
    launchId: "launch-1",
    kind: "initial",
    adapter: "codex",
    model: "gpt-test",
  });
  db.finishAttempt({ attemptId: attempt.id, state: "succeeded", outcome: "completed", exitStatus: 0 });
  assert.equal(db.getAttempt(attempt.id)?.state, "succeeded");

  const gate = db.recordGate({
    taskId: task.id,
    attemptId: attempt.id,
    name: "test",
    status: "PASS",
    required: true,
    command: "npm test",
    toolVersion: "node test",
    revision: "rev-1",
    evidencePath: "/tmp/test.log",
    durationMs: 10,
    waiverId: null,
  });
  assert.equal(gate.required, true);
  assert.equal(gate.status, "PASS");
  assert.equal(db.gatesForRevision(task.id, "rev-1").length, 1);

  const binding = { action: "merge" as const, target: "main", revision: "rev-1", configVersion: project.configVersion };
  const approval = db.requestApproval({ projectId: project.id, taskId: task.id, binding, reason: "ready" });
  assert.throws(() => db.markApprovalConsumed(approval.id), /only an approved decision/);
  db.decideApproval(approval.id, "approved", "owner");
  assert.equal(db.findApprovalFor(task.id, binding)?.id, approval.id);
  db.markApprovalConsumed(approval.id);
  assert.equal(db.getApproval(approval.id)?.state, "consumed");
});
