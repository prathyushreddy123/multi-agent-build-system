import assert from "node:assert/strict";
import test from "node:test";

import { diffFeed, feedFrame, FEED_TASK_LIMIT, type FeedFrame, type FeedTask } from "../../src/operator/feed.ts";
import type { ProgressSnapshot, TaskRow } from "../../src/operator/progress.ts";

const frame = (tasks: Partial<FeedTask>[], controller = "running"): FeedFrame => {
  const full = tasks.map((task, index) => ({ id: `tsk_${index}`, title: `Task ${index}`, project: "p", state: "QUEUED", reason: null, ...task }));
  const count = (states: string[]) => full.filter((task) => states.includes(task.state)).length;
  return {
    version: "mabs.feed.v1", at: "now", controller: { state: controller, reason: `controller ${controller}` },
    counts: { active: count(["RUNNING", "CHECKING", "REVIEWING"]), waiting: count(["QUEUED", "READY"]), attention: count(["BLOCKED", "FAILED", "AWAITING_APPROVAL"]), done: count(["DONE"]) },
    tasks: full,
  };
};

test("UX-01: the first frame only sets the status line, so opening Pi never floods history", () => {
  const result = diffFeed(null, frame([{ state: "DONE" }, { state: "BLOCKED", reason: "x" }]));
  assert.deepEqual(result.notices, []);
  assert.match(result.statusLine, /^MABS 0 active · 1 attention$/);
});

test("UX-01: routine progress changes only the status line", () => {
  const before = frame([{ state: "QUEUED" }, { state: "READY" }]);
  const after = frame([{ state: "RUNNING" }, { state: "CHECKING" }]);
  const result = diffFeed(before, after);
  assert.deepEqual(result.notices, []);
  assert.equal(result.statusLine, "MABS 2 active · 0 attention");
});

test("UX-01: completions, problems, and decisions are coalesced into one notice per kind", () => {
  const before = frame([{ state: "RUNNING" }, { state: "RUNNING" }, { state: "CHECKING" }, { state: "RUNNING" }, { state: "REVIEWING" }]);
  const after = frame([
    { state: "DONE" }, { state: "DONE" }, { state: "DONE" },
    { state: "BLOCKED", reason: "Pinned provider claude cannot run this task now" },
    { state: "AWAITING_APPROVAL" },
  ]);
  const notices = diffFeed(before, after).notices;
  assert.deepEqual(notices.map((notice) => notice.kind), ["done", "attention", "decision"]);
  assert.match(notices[0]?.text ?? "", /^3 done: Task 0 \(tsk_0\), Task 1 \(tsk_1\), Task 2 \(tsk_2\)\. Not merged or deployed\.$/);
  assert.match(notices[1]?.text ?? "", /Task 3 \(tsk_3\) — Pinned provider claude cannot run this task now/);
  assert.equal(notices[1]?.level, "warning");
  assert.equal(diffFeed(after, after).notices.length, 0, "an unchanged frame says nothing again");
});

test("UX-01: a controller that stops with work pending is reported once", () => {
  const before = frame([{ state: "QUEUED" }], "running");
  const after = frame([{ state: "QUEUED" }], "stopped");
  const notices = diffFeed(before, after).notices;
  assert.deepEqual(notices.map((notice) => notice.kind), ["controller"]);
  assert.match(diffFeed(before, after).statusLine, /controller stopped/);
  assert.equal(diffFeed(after, after).notices.length, 0);
  assert.equal(diffFeed(frame([{ state: "DONE" }], "running"), frame([{ state: "DONE" }], "stopped")).notices.length, 0, "an idle stop is not news");
});

test("UX-01: a frame keeps unfinished and recently changed tasks only, within a bound", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const row = (index: number, state: string, minutesAgo: number) => ({
    taskId: `tsk_${index}`, title: `T${index}`, projectName: "p", state, blockedReason: state === "BLOCKED" ? "first line\nsecond line" : null,
    lastUpdate: new Date(now - minutesAgo * 60_000).toISOString(),
  }) as unknown as TaskRow;
  const snapshot = {
    generatedAt: new Date(now).toISOString(),
    controller: { state: "running", reason: "ok" },
    tasks: [row(1, "DONE", 5), row(2, "DONE", 600), row(3, "BLOCKED", 600), row(4, "RUNNING", 1), row(5, "CANCELLED", 900)],
  } as unknown as ProgressSnapshot;
  const built = feedFrame(snapshot, now);
  assert.deepEqual(built.tasks.map((task) => task.id), ["tsk_1", "tsk_3", "tsk_4"]);
  assert.equal(built.tasks[1]?.reason, "first line", "only the first line of a reason");
  assert.deepEqual(built.counts, { active: 1, waiting: 0, attention: 1, done: 2 });

  const many = { ...snapshot, tasks: Array.from({ length: FEED_TASK_LIMIT + 50 }, (_, index) => row(index, "QUEUED", 1)) } as unknown as ProgressSnapshot;
  assert.equal(feedFrame(many, now).tasks.length, FEED_TASK_LIMIT);
  assert.equal(feedFrame(many, now).counts.waiting, FEED_TASK_LIMIT + 50, "counts still cover every task");
});
