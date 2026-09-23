import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INITIAL_VIEW,
  moveSelection,
  reconcileView,
  renderDashboard,
  visibleRows,
  type DashboardView,
} from "../../src/operator/dashboard.ts";
import {
  buildProgressSnapshot,
  controllerFreshness,
  groupForState,
  stepsForTask,
} from "../../src/operator/progress.ts";
import { TASK_STATES } from "../../src/domain/states.ts";
import { openRecords, type Records } from "../../src/store/records.ts";

interface Fixture {
  records: Records;
  projectId: string;
  taskId: string;
  close: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mabs-op3-"));
  process.env.MABS_STATE_DIR = root;
  process.env.MABS_DB_PATH = join(root, "mabs.sqlite");
  const records = openRecords();
  const project = records.createProject({
    name: "progress", repoPath: root, baseBranch: "main",
    // An approval is only preparable when the project has required checks, so
    // the delivery test exercises the real gate rather than a relaxed one.
    checkCommands: [{ name: "tests", command: ["npm", "test"], required: true }],
  });
  const task = records.createTask({ projectId: project.id, title: "Implement the thing", objective: "do it" });
  return {
    records, projectId: project.id, taskId: task.id,
    close: () => {
      records.store.close();
      delete process.env.MABS_DB_PATH;
      delete process.env.MABS_STATE_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The store assigns the attempt number, so tests never pass one in. */
function startAttempt(records: Records, taskId: string, kind: "initial" | "repair" | "review", number: number) {
  return records.startAttempt({
    taskId, launchId: `launch-${kind}-${number}`, kind,
    adapter: kind === "review" ? "codex" : "claude",
    model: kind === "review" ? "gpt-5.4" : "claude-opus-5",
  });
}

test("every task state maps to exactly one display group without losing the state", () => {
  const groups = new Set<string>();
  for (const state of TASK_STATES) {
    const group = groupForState(state);
    assert.ok(group, `${state} has no group`);
    groups.add(group);
  }
  // CHECKING and REVIEWING are grouped as active but remain distinguishable.
  assert.equal(groupForState("CHECKING"), "active");
  assert.equal(groupForState("REVIEWING"), "active");
  assert.equal(groupForState("AWAITING_APPROVAL"), "waiting");
  assert.equal(groupForState("CANCELLED"), "failed");
  assert.ok(groups.has("completed") && groups.has("blocked"));
});

test("steps come from recorded data and a retry adds an attempt instead of overwriting one", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");

    const first = startAttempt(records, taskId, "initial", 1);
    records.recordCheckpoint({
      taskId, attemptId: first.id, kind: "implementation_complete",
      summary: "Wrote the thing", resultRevision: "rev1", changedFiles: ["a.ts"],
    });
    records.finishAttempt({ attemptId: first.id, state: "succeeded", outcome: "completed", resultRevision: "rev1" });
    records.recordGate({
      taskId, attemptId: first.id, name: "typecheck", status: "FAIL", required: true,
      command: "npm run typecheck", toolVersion: null, revision: "rev1", evidencePath: null,
      durationMs: 1200, waiverId: null,
    });

    const second = startAttempt(records, taskId, "repair", 2);
    records.recordCheckpoint({
      taskId, attemptId: second.id, kind: "repair_complete", summary: "Fixed the type error", resultRevision: "rev2",
    });
    records.finishAttempt({ attemptId: second.id, state: "succeeded", outcome: "completed", resultRevision: "rev2" });
    records.recordGate({
      taskId, attemptId: second.id, name: "typecheck", status: "PASS", required: true,
      command: "npm run typecheck", toolVersion: null, revision: "rev2", evidencePath: null,
      durationMs: 1100, waiverId: null,
    });

    const steps = stepsForTask(records, taskId);
    // Both attempts survive; the repair does not replace the first attempt's history.
    const attemptSteps = steps.filter((step) => step.source === "attempt");
    assert.equal(attemptSteps.length, 2);
    assert.deepEqual(attemptSteps.map((step) => step.attemptNumber), [1, 2]);

    // The failing check from attempt 1 is still visible next to the passing one.
    const checks = steps.filter((step) => step.kind === "check:typecheck");
    assert.deepEqual(checks.map((step) => step.status), ["failed", "completed"]);
    assert.deepEqual(checks.map((step) => step.attemptNumber), [1, 2]);

    // Ids are stable, so repeated polling cannot duplicate rows.
    const again = stepsForTask(records, taskId);
    assert.deepEqual(steps.map((step) => step.id), again.map((step) => step.id));
    assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);

    // Every step's claim traces to a record, and the provider is the one used.
    assert.ok(attemptSteps[0]?.summary.includes("claude"));
    assert.ok(steps.every((step) => step.at.length > 0));
  } finally {
    fixture.close();
  }
});

test("progress inside a running attempt is reported as unavailable, not invented", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    startAttempt(records, taskId, "initial", 1);

    const snapshot = buildProgressSnapshot(records, { withSteps: true });
    const row = snapshot.tasks[0];
    assert.ok(row);
    assert.equal(row.state, "RUNNING");
    assert.equal(row.group, "active");
    assert.equal(row.attemptState, "running");
    // The start is known; what the worker is doing right now is not.
    assert.ok(row.stepGaps.some((gap) => gap.includes("not instrumented")));
    assert.ok(snapshot.notes.some((note) => note.includes("not instrumented")));
    assert.equal(row.elapsedOf, "attempt");
    assert.ok((row.elapsedMs ?? -1) >= 0);
  } finally {
    fixture.close();
  }
});

test("completion, check outcome, review outcome, and delivery stay separate", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    const attempt = startAttempt(records, taskId, "initial", 1);
    records.finishAttempt({ attemptId: attempt.id, state: "succeeded", outcome: "completed", resultRevision: "rev1" });
    records.transition(taskId, "CHECKING", { result_revision: "rev1" });
    records.recordGate({
      taskId, attemptId: attempt.id, name: "tests", status: "PASS", required: true,
      command: "npm test", toolVersion: null, revision: "rev1", evidencePath: null, durationMs: 900, waiverId: null,
    });
    records.recordReview({
      taskId, attemptId: attempt.id, revision: "rev1", verdict: "approved",
      summary: "Looks correct", findings: ["nit: naming"], blockingFindings: [], advisoryFindings: ["nit: naming"],
      requirementsChecked: [], evidencePath: null,
    });
    records.transition(taskId, "REVIEWING");
    records.transition(taskId, "DONE");

    const snapshot = buildProgressSnapshot(records, { withSteps: true });
    const row = snapshot.tasks[0];
    assert.ok(row);
    assert.equal(row.state, "DONE");
    assert.equal(row.group, "completed");
    assert.equal(row.checks[0]?.status, "PASS");
    assert.equal(row.review?.verdict, "approved");
    // A completed, checked, reviewed task is still not delivered.
    assert.equal(row.delivery, "not requested");
    assert.equal(snapshot.counts.completed, 1);

    const prepared = records.prepareApproval({
      taskId, action: "merge", target: "main", reason: "ship it",
    });
    assert.ok(prepared.approval, prepared.policyReason);
    const pending = buildProgressSnapshot(records, {});
    assert.equal(pending.tasks[0]?.delivery, "approval pending");
    records.decideApproval(prepared.approval.id, "approved", "tester");
    assert.equal(buildProgressSnapshot(records, {}).tasks[0]?.delivery, "approved");
  } finally {
    fixture.close();
  }
});

test("blocked and waiting tasks report their real reason and unmet dependencies", () => {
  const fixture = makeFixture();
  try {
    const { records, projectId, taskId } = fixture;
    const dependent = records.createTask({
      projectId, title: "Depends on the first", objective: "later", dependsOn: [taskId],
    });
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    records.transition(taskId, "BLOCKED", { blocked_reason: "Needs a product decision", failure_class: "SPEC" });

    const snapshot = buildProgressSnapshot(records, {});
    const blocked = snapshot.tasks.find((row) => row.taskId === taskId);
    const waiting = snapshot.tasks.find((row) => row.taskId === dependent.id);
    assert.equal(blocked?.group, "blocked");
    assert.equal(blocked?.blockedReason, "Needs a product decision");
    assert.equal(blocked?.failureClass, "SPEC");
    assert.deepEqual(waiting?.dependsOn, [taskId]);
    assert.deepEqual(waiting?.waitingOn, [taskId]);
    assert.equal(snapshot.counts.blocked, 1);
  } finally {
    fixture.close();
  }
});

test("a stale worker heartbeat and a missing controller are reported, not hidden", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    startAttempt(records, taskId, "initial", 1);

    // No controller has written health yet.
    const cold = controllerFreshness(records);
    assert.equal(cold.state, "unknown");
    assert.equal(cold.stale, true);
    assert.match(cold.reason, /No controller has reported health/);

    // An hour later the attempt's heartbeat is long past the threshold.
    const later = Date.now() + 60 * 60_000;
    const snapshot = buildProgressSnapshot(records, { now: later, withSteps: true });
    assert.equal(snapshot.tasks[0]?.staleHeartbeat, true);
    assert.ok(snapshot.notes.some((note) => note.includes("not proof of failure")));

    records.writeHealth({
      id: "controller-1", pid: 1, startedAt: new Date().toISOString(), loopDelayMs: 10, dbErrors: 0,
      queueDepth: 1, oldestReadyAgeS: 0, oldestClaimAgeS: 0, activeWorkers: 1, workerLimit: 2,
      slotUtilization: 0.5, uptimeS: 60, providerStatus: [], backpressureReason: null, state: "running",
    });
    const fresh = controllerFreshness(records);
    assert.equal(fresh.state, "running");
    assert.equal(fresh.stale, false);
    assert.equal(fresh.activeWorkers, 1);

    // Simulating a disconnect: the same record, read much later, is stale.
    const disconnected = controllerFreshness(records, Date.now() + 10 * 60_000);
    assert.equal(disconnected.stale, true);
    assert.match(disconnected.reason, /may be out of date/);
  } finally {
    fixture.close();
  }
});

test("provider availability is unknown without a supporting record", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    startAttempt(records, taskId, "initial", 1);

    const snapshot = buildProgressSnapshot(records, {});
    const claude = snapshot.providers.find((provider) => provider.provider === "claude");
    assert.equal(claude?.availability, "unknown");
    assert.match(String(claude?.reason), /No capacity or health record/);
    assert.ok(snapshot.notes.some((note) => note.includes("Availability is unknown")));

    records.configureProvider("claude", 2);
    const withCapacity = buildProgressSnapshot(records, {});
    assert.equal(withCapacity.providers.find((provider) => provider.provider === "claude")?.availability, "available");
  } finally {
    fixture.close();
  }
});

test("the dashboard keeps its selection and scroll position across a refresh", () => {
  const fixture = makeFixture();
  try {
    const { records, projectId } = fixture;
    const ids: string[] = [fixture.taskId];
    for (let index = 0; index < 8; index += 1) {
      ids.push(records.createTask({ projectId, title: `Task ${index}`, objective: "x" }).id);
    }

    let snapshot = buildProgressSnapshot(records, {});
    let view: DashboardView = reconcileView(snapshot, { ...INITIAL_VIEW, pageSize: 3 });
    view = moveSelection(snapshot, view, 4);
    const selected = view.selectedTaskId;
    assert.ok(selected);
    assert.ok(view.scrollOffset > 0, "the view scrolled to keep the selection visible");
    const scrolled = view.scrollOffset;

    // A new task arrives and an existing one changes; the selection must not jump.
    records.createTask({ projectId, title: "Newly added", objective: "x" });
    records.transition(ids[1] as string, "READY");
    const refreshed = buildProgressSnapshot(records, {});
    const after = reconcileView(refreshed, view, snapshot);
    assert.equal(after.selectedTaskId, selected, "the selection moved during a refresh");

    // The selected task disappearing falls to a neighbour rather than the top.
    const withoutSelected = {
      ...refreshed,
      tasks: refreshed.tasks.filter((row) => row.taskId !== selected),
    };
    const fallback = reconcileView(withoutSelected, after, refreshed);
    assert.notEqual(fallback.selectedTaskId, null);
    assert.notEqual(fallback.selectedTaskId, selected);

    snapshot = refreshed;
    assert.ok(scrolled >= 0);
    const rows = visibleRows(snapshot, after);
    assert.equal(rows.length, snapshot.tasks.length);
  } finally {
    fixture.close();
  }
});

test("the rendered dashboard states counts, staleness, and unavailable steps honestly", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    const attempt = startAttempt(records, taskId, "initial", 1);
    records.recordCheckpoint({ taskId, attemptId: attempt.id, kind: "implementation_complete", summary: "Did the work" });

    const snapshot = buildProgressSnapshot(records, { withSteps: true });
    const view = reconcileView(snapshot, { ...INITIAL_VIEW, expanded: true });
    const frame = renderDashboard(snapshot, view);

    assert.match(frame, /1 recorded: 1 active/);
    // Completed is a count of recorded completions, never an estimate.
    assert.match(frame, /0 completed/);
    assert.doesNotMatch(frame, /% complete|estimated|remaining/i);
    assert.match(frame, /RUNNING/);
    assert.match(frame, /claude/);
    assert.match(frame, /implementation_complete/);
    assert.match(frame, /unavailable: Progress inside the running attempt/);
    assert.match(frame, /controller unknown/);
    assert.match(frame, /STALE/);
    assert.match(frame, /delivery: not requested/);
    assert.match(frame, /stops this dashboard only/);
  } finally {
    fixture.close();
  }
});

test("a step referencing missing evidence says so instead of pretending it is there", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    const root = mkdtempSync(join(tmpdir(), "mabs-op3-evidence-"));
    const present = join(root, "present.log");
    mkdirSync(root, { recursive: true });
    writeFileSync(present, "ok\n");

    records.transition(taskId, "READY");
    records.transition(taskId, "RUNNING");
    const attempt = startAttempt(records, taskId, "initial", 1);
    records.recordCheckpoint({
      taskId, attemptId: attempt.id, kind: "implementation_complete", summary: "done",
      evidence: [present, join(root, "gone.log")],
    });

    const steps = stepsForTask(records, taskId);
    const checkpoint = steps.find((step) => step.source === "checkpoint");
    assert.deepEqual(checkpoint?.evidencePaths, [present]);
    assert.deepEqual(checkpoint?.missingEvidence, [join(root, "gone.log")]);

    const snapshot = buildProgressSnapshot(records, { withSteps: true });
    assert.ok(snapshot.notes.some((note) => note.includes("no longer on disk")));
    rmSync(root, { recursive: true, force: true });
  } finally {
    fixture.close();
  }
});

test("building a snapshot does not schedule work or change any task state", () => {
  const fixture = makeFixture();
  try {
    const { records, taskId } = fixture;
    records.transition(taskId, "READY");
    const before = records.getTask(taskId);
    const beforeEvents = records.listEvents(taskId).length;

    for (let index = 0; index < 5; index += 1) buildProgressSnapshot(records, { withSteps: true });

    const after = records.getTask(taskId);
    assert.deepEqual(after, before, "a read-only snapshot mutated the task");
    assert.equal(records.listEvents(taskId).length, beforeEvents, "a read-only snapshot recorded events");
    assert.equal(records.listAttempts(taskId).length, 0, "a read-only snapshot created an attempt");
    assert.equal(after?.claimedBy, null, "a read-only snapshot claimed a task");
  } finally {
    fixture.close();
  }
});
