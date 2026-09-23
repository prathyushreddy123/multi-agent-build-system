import assert from "node:assert/strict";
import test from "node:test";

import { Controller, ControllerLeaseHeldError } from "../src/controller/controller.ts";
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
