import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Controller, ControllerLeaseHeldError } from "../src/controller/controller.ts";
import { launchGateJob } from "../src/gates/runner.ts";
import { controllerLiveness, processAlive } from "../src/operator/liveness.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

function records(): Records {
  return new Records(new Store(":memory:"));
}

/** A pid that cannot exist, so "dead owner" is testable without killing anything. */
const DEAD_PID = 2 ** 22;

function ageLease(db: Records, ms: number): void {
  db.store.run(
    "UPDATE controller_lease SET heartbeat_at = ? WHERE singleton = 1",
    new Date(Date.now() - ms).toISOString(),
  );
}

test("processAlive answers for the running process and a pid that cannot exist", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(DEAD_PID), false);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-1), false);
});

test("liveness reports not_running when no lease is held", (t) => {
  const db = records();
  t.after(() => db.store.close());

  const liveness = controllerLiveness(db);
  assert.equal(liveness.state, "not_running");
  assert.equal(liveness.startWouldContend, false);
  assert.equal(liveness.pid, null);
});

test("liveness reports healthy only while a live owner keeps renewing", (t) => {
  const db = records();
  t.after(() => db.store.close());

  db.acquireControllerLease("one", process.pid, 15_000);
  const healthy = controllerLiveness(db);
  assert.equal(healthy.state, "healthy");
  assert.equal(healthy.processAlive, true);
  // Another controller would only contend, so starting one must be refused.
  assert.equal(healthy.startWouldContend, true);
});

test("liveness separates a wedged owner from a crashed one", (t) => {
  const db = records();
  t.after(() => db.store.close());

  // Alive, but renewals stopped: the case the health row cannot express.
  db.acquireControllerLease("one", process.pid, 15_000);
  ageLease(db, 60_000);
  const wedged = controllerLiveness(db);
  assert.equal(wedged.state, "wedged");
  assert.equal(wedged.processAlive, true);
  assert.match(wedged.reason, /alive and not ticking/);
  // A stale lease is takeable, so a new controller is not blocked.
  assert.equal(wedged.startWouldContend, false);

  // Owner gone entirely: the lease is an orphan.
  db.store.run("UPDATE controller_lease SET pid = ? WHERE singleton = 1", DEAD_PID);
  const crashed = controllerLiveness(db);
  assert.equal(crashed.state, "crashed");
  assert.equal(crashed.processAlive, false);
  assert.equal(crashed.startWouldContend, false);
});

test("a fresh lease held by a live peer blocks a second controller's tick", async (t) => {
  const db = records();
  t.after(() => db.store.close());

  db.acquireControllerLease("peer", process.pid, 15_000);
  const controller = new Controller(db, { controllerId: "second" });

  await assert.rejects(() => controller.tick(), ControllerLeaseHeldError);
  assert.equal(controller.stepDownReason instanceof ControllerLeaseHeldError, true);
  assert.equal(controller.stepDownReason?.holderId, "peer");
});

test("standing down never overwrites the live holder's lease or health row", async (t) => {
  const db = records();
  t.after(() => db.store.close());

  db.acquireControllerLease("peer", process.pid, 15_000);
  const controller = new Controller(db, { controllerId: "second" });
  await assert.rejects(() => controller.tick(), ControllerLeaseHeldError);

  // Before: the loser must not have reported "degraded" on the holder's behalf.
  assert.equal(db.latestHealth(), undefined);

  await controller.stop();

  // After stopping, the peer still owns the lease and no health row was faked.
  assert.equal(db.currentControllerLease()?.controller_id, "peer");
  assert.equal(db.latestHealth(), undefined);
});

test("the loop stops itself and reports once when the lease belongs to a peer", async (t) => {
  const db = records();
  t.after(() => db.store.close());

  db.acquireControllerLease("peer", process.pid, 15_000);
  const controller = new Controller(db, { controllerId: "second", pollIntervalMs: 5 });

  const reasons: ControllerLeaseHeldError[] = [];
  controller.start({ onStepDown: (error) => reasons.push(error) });
  await new Promise((done) => setTimeout(done, 80));
  await controller.stop();

  // Without stepping down this would have fired on every 5ms interval.
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0]?.holderId, "peer");
  assert.equal(db.currentControllerLease()?.controller_id, "peer");
});

test("a controller that owns its lease still records health and releases cleanly", async (t) => {
  const db = records();
  t.after(() => db.store.close());

  const controller = new Controller(db, { controllerId: "only" });
  await controller.tick();
  assert.equal(db.latestHealth()?.state, "running");
  assert.equal(controller.stepDownReason, null);

  await controller.stop();
  assert.equal(db.latestHealth()?.state, "stopped");
  assert.equal(db.currentControllerLease(), undefined);
});

function gateFingerprint(revision: string, index: number, spec: object): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ revision, index, spec })).digest("hex")}`;
}

test("a long detached check leaves controller liveness responsive and its completion is collected once", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "mabs-long-gate-"));
  const previousState = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = state;
  const db = records();
  t.after(() => {
    db.store.close();
    if (previousState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previousState;
    rmSync(state, { recursive: true, force: true });
  });
  const spec = {
    name: "slow-check",
    command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 600)"],
    required: true,
  };
  const project = db.createProject({
    projectType: "personal", reviewChoice: "off", name: "long-check", repoPath: process.cwd(),
    reviewPolicy: { mode: "none", skipTaskClasses: [] }, checkCommands: [spec],
  });
  const task = db.createTask({
    projectId: project.id, title: "detached check", objective: "prove liveness", taskClass: "mechanical",
  });
  const ready = db.transition(task.id, "READY");
  const episode = db.createExecutionEpisode({ taskId: task.id, expectedTaskVersion: ready.recordVersion });
  db.transition(task.id, "RUNNING");
  db.updateTaskFields(task.id, { worktree_path: process.cwd(), result_revision: "revision-for-check" });
  const current = db.getTask(task.id)!;
  const stage = db.reserveStage({
    taskId: task.id, episodeId: episode.id, stage: "check", ordinal: 1,
    launchKey: `${task.id}:slow-check`, inputFingerprint: gateFingerprint("revision-for-check", 0, spec),
    revision: "revision-for-check", engineRevision: "test", expectedTaskVersion: current.recordVersion,
  });
  const admission = db.reserveAdmission({ stageRunId: stage.id, controllerId: "test", resources: ["gate"] });
  db.activateAdmission(admission.id, admission.fencingToken);
  await launchGateJob({ taskId: task.id, stageRunId: stage.id, worktreePath: process.cwd(), spec });
  db.recordLaunchStarted(stage.id, stage.fencingToken);

  const controller = new Controller(db, { controllerId: "long-check-controller", workerLimit: 1 });
  const started = Date.now();
  await controller.tick();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 350, `controller tick waited ${elapsed}ms for a 600ms check`);
  assert.equal(db.latestHealth()?.state, "running");
  assert.equal(db.gatesForTask(task.id).length, 0, "running checks are not prematurely collected");

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
  await controller.tick();
  assert.equal(db.getTask(task.id)?.state, "DONE", JSON.stringify({
    task: db.getTask(task.id),
    continuation: db.getContinuation(task.id),
    gates: db.gatesForTask(task.id),
  }));
  assert.equal(db.gatesForTask(task.id).length, 1);
  await controller.tick();
  assert.equal(db.gatesForTask(task.id).length, 1, "reconciliation must not duplicate gate collection");
  await controller.stop();
});

test("an operational gate error preserves obligations and both retry budgets", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "mabs-operational-gate-"));
  const previousState = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = state;
  const db = records();
  t.after(() => {
    db.store.close();
    if (previousState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previousState;
    rmSync(state, { recursive: true, force: true });
  });
  const spec = { name: "missing-tool", command: ["mabs-tool-that-does-not-exist"], required: true };
  const project = db.createProject({
    projectType: "personal", reviewChoice: "off", name: "missing-check", repoPath: process.cwd(),
    reviewPolicy: { mode: "none", skipTaskClasses: [] }, checkCommands: [spec],
  });
  const task = db.createTask({ projectId: project.id, title: "missing", objective: "classify", repairLimit: 2 });
  const ready = db.transition(task.id, "READY");
  const episode = db.createExecutionEpisode({ taskId: task.id, expectedTaskVersion: ready.recordVersion, recoveryLimit: 2 });
  db.transition(task.id, "RUNNING");
  db.updateTaskFields(task.id, { worktree_path: process.cwd(), result_revision: "revision-for-error" });
  const stage = db.reserveStage({
    taskId: task.id, episodeId: episode.id, stage: "check", ordinal: 1,
    launchKey: `${task.id}:missing-tool`, inputFingerprint: gateFingerprint("revision-for-error", 0, spec),
    revision: "revision-for-error", engineRevision: "test", expectedTaskVersion: db.getTask(task.id)!.recordVersion,
  });
  const admission = db.reserveAdmission({ stageRunId: stage.id, controllerId: "test", resources: ["gate"] });
  db.activateAdmission(admission.id, admission.fencingToken);
  await launchGateJob({ taskId: task.id, stageRunId: stage.id, worktreePath: process.cwd(), spec });
  db.recordLaunchStarted(stage.id, stage.fencingToken);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

  const controller = new Controller(db, { controllerId: "operational-controller", workerLimit: 1 });
  await controller.tick();
  const after = db.getTask(task.id)!;
  const continuation = db.getContinuation(task.id);
  assert.equal(after.state, "BLOCKED");
  assert.equal(after.failureClass, "CONFIG");
  assert.equal(after.repairsUsed, 0);
  assert.equal(continuation.episode?.repairsConsumed, 0);
  assert.equal(continuation.episode?.recoveriesConsumed, 0);
  assert.ok(continuation.openObligations.some((item) => item.kind === "gate_failure" && item.blocking));
  assert.equal(db.gatesForTask(task.id)[0]?.failureDiagnosis?.category, "environment");
  await controller.stop();
});

test("dependency recovery clears only its typed obligation", async (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({
    projectType: "personal", reviewChoice: "off", name: "dependency", repoPath: process.cwd(),
    reviewPolicy: { mode: "none", skipTaskClasses: [] },
  });
  const dependency = db.createTask({ projectId: project.id, title: "dependency", objective: "recover" });
  const dependent = db.createTask({ projectId: project.id, title: "dependent", objective: "wait", dependsOn: [dependency.id] });
  db.transition(dependency.id, "READY");
  db.transition(dependency.id, "RUNNING");
  db.transition(dependency.id, "FAILED", { blocked_reason: "fixture failure" });
  const decision = db.recordObligation({
    taskId: dependent.id, kind: "decision_needed", severity: "blocking", blocking: true,
    sourceKey: "decision:fixture", summary: "An operator decision is still required.",
  });
  const controller = new Controller(db, {
    controllerId: "dependency-controller",
    workerLimit: 1,
    minFreeMemoryMb: Number.MAX_SAFE_INTEGER,
  });
  await controller.tick();
  assert.equal(db.getTask(dependent.id)?.state, "BLOCKED");
  assert.ok(db.getContinuation(dependent.id).openObligations.some((item) => item.sourceKey === `dependency:${dependency.id}`));

  db.retryTask(dependency.id, db.getTask(dependency.id)!.recordVersion);
  db.transition(dependency.id, "RUNNING");
  db.transition(dependency.id, "CHECKING");
  db.transition(dependency.id, "DONE", { result_revision: "recovered-revision" });
  await controller.tick();
  assert.equal(db.getTask(dependent.id)?.state, "BLOCKED", "the unrelated decision blocker must remain");
  assert.deepEqual(db.getContinuation(dependent.id).openObligations.map((item) => item.id), [decision.id]);

  db.resolveObligation({ obligationId: decision.id, state: "resolved" }, ["decision:operator-approved"]);
  await controller.tick();
  assert.equal(db.getTask(dependent.id)?.state, "READY");
  await controller.stop();
});
