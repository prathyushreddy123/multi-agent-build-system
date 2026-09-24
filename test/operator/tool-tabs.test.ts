/**
 * Tasks and Logs as separate on-click tabs.
 *
 * These tests cover what the tab route must never do: adopt a tab it does not
 * own by exact ID, restart a running view, split a pane, create a workspace,
 * reinject a shell command to change scope, render an internal navigation rail,
 * or touch a task record when a view closes.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openScopedToolTab,
  type HerdrSession,
  type OpenScopedToolTabOptions,
} from "../../src/operator/herdr.ts";
import {
  readToolViewRequest,
  renderToolView,
  requestToolView,
  serveToolView,
} from "../../src/operator/workspace/tool-view.ts";
import { openRecords, type Records } from "../../src/store/records.ts";

const LIVE: HerdrSession = {
  available: true,
  version: "herdr 0.9.1",
  inSession: true,
  workspaceId: "w1",
  tabId: "w1:t0",
  paneId: "w1:p0",
  reason: null,
};

interface Fixture {
  records: Records;
  root: string;
  close: () => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mabs-tool-tabs-"));
  const previous = { state: process.env.MABS_STATE_DIR, db: process.env.MABS_DB_PATH };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_DB_PATH = join(root, "state", "mabs.sqlite");
  const records = openRecords();
  return {
    records,
    root,
    close: () => {
      records.store.close();
      if (previous.state === undefined) delete process.env.MABS_STATE_DIR;
      else process.env.MABS_STATE_DIR = previous.state;
      if (previous.db === undefined) delete process.env.MABS_DB_PATH;
      else process.env.MABS_DB_PATH = previous.db;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface FakeHerdr {
  calls: () => string[][];
  panes: () => Record<string, { workspace_id: string; tab_id: string }>;
  setPanes: (value: Record<string, { workspace_id: string; tab_id: string }>) => void;
  restore: () => void;
}

/** A `herdr` on PATH that logs every invocation and answers from a pane table. */
function fakeHerdr(root: string, options: { failFocus?: boolean } = {}): FakeHerdr {
  const bin = join(root, "bin");
  const callLog = join(root, "calls.jsonl");
  const paneFile = join(root, "panes.json");
  const previousPath = process.env.PATH;
  mkdirSync(bin, { recursive: true });
  writeFileSync(callLog, "");
  writeFileSync(paneFile, JSON.stringify({}));
  const script = join(bin, "herdr");
  writeFileSync(script, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
const panes = JSON.parse(readFileSync(${JSON.stringify(paneFile)}, "utf8"));
const save = () => writeFileSync(${JSON.stringify(paneFile)}, JSON.stringify(panes));
const out = (value) => { writeFileSync(1, JSON.stringify(value)); process.exit(0); };
if (args[0] === "--version") { writeFileSync(1, "herdr 0.9.1\\n"); process.exit(0); }
if (args[0] === "tab" && args[1] === "create") {
  const created = readFileSync(${JSON.stringify(callLog)}, "utf8").split("\\n").filter(Boolean)
    .map(JSON.parse).filter((call) => call[0] === "tab" && call[1] === "create").length;
  const workspaceId = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : "w1";
  const paneId = workspaceId + ":p" + created;
  panes[paneId] = { workspace_id: workspaceId, tab_id: workspaceId + ":t" + created };
  save();
  out({ result: { tab: { tab_id: panes[paneId].tab_id }, root_pane: { pane_id: paneId } } });
}
if (args[0] === "pane" && args[1] === "get") {
  const pane = panes[args[2]];
  if (!pane) process.exit(1);
  out({ result: { pane: { pane_id: args[2], ...pane } } });
}
if (args[0] === "pane" && args[1] === "close") { delete panes[args[2]]; save(); process.exit(0); }
if (args[0] === "pane" && args[1] === "run") process.exit(0);
if (args[0] === "tab" && args[1] === "focus") process.exit(${options.failFocus ? "1" : "0"});
process.exit(2);
`);
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    calls: () => readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    panes: () => JSON.parse(readFileSync(paneFile, "utf8")) as Record<string, { workspace_id: string; tab_id: string }>,
    setPanes: (value) => writeFileSync(paneFile, JSON.stringify(value)),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

function tasksTab(root: string, projectId: string): OpenScopedToolTabOptions {
  return {
    surface: "tasks",
    scopeKey: `project:${projectId}`,
    repoPath: root,
    command: (workspaceId) => `node src/cli.ts workspace view --surface=tasks --workspace='${workspaceId}'`,
    selection: { projectId, taskId: null },
    cliAlternative: `\`node src/cli.ts task watch --project=${projectId}\``,
    session: LIVE,
  };
}

function logsTab(root: string, projectId: string, taskId: string): OpenScopedToolTabOptions {
  return {
    surface: "logs",
    scopeKey: `task:${taskId}`,
    repoPath: root,
    command: (workspaceId) => `node src/cli.ts workspace view --surface=logs --workspace='${workspaceId}'`,
    selection: { projectId, taskId },
    cliAlternative: `\`node src/cli.ts logs ${taskId}\``,
    session: LIVE,
  };
}

/** A non-TTY stand-in, so the loop under test never touches the real terminal. */
function detachedInput(): NodeJS.ReadStream {
  return { isTTY: false } as unknown as NodeJS.ReadStream;
}

test("Tasks and Logs occupy two tabs in one workspace, with no split and no new workspace", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const tasks = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    const logs = await openScopedToolTab(logsTab(value.root, "prj_one", "tsk_one"));
    assert.equal(tasks.action, "created");
    assert.equal(logs.action, "created");
    assert.notEqual(tasks.tabId, logs.tabId);
    assert.notEqual(tasks.paneId, logs.paneId);
    assert.equal(fake.panes()[tasks.paneId as string]?.workspace_id, "w1");
    assert.equal(fake.panes()[logs.paneId as string]?.workspace_id, "w1");

    const calls = fake.calls();
    assert.equal(calls.filter((call) => call[0] === "pane" && call[1] === "split").length, 0);
    assert.equal(calls.filter((call) => call[0] === "workspace").length, 0);
    assert.equal(calls.filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
    // Every created tab is a background tab; only the explicit focus moves the user.
    assert.ok(calls.filter((call) => call[0] === "tab" && call[1] === "create")
      .every((call) => call.includes("--no-focus")));
    assert.deepEqual(
      calls.filter((call) => call[0] === "tab" && call[1] === "focus").map((call) => call[2]),
      [tasks.tabId, logs.tabId],
    );
    assert.equal(tasks.focused, true);
    assert.equal(logs.focused, true);
  } finally {
    fake.restore();
    value.close();
  }
});

test("repeated opens of both surfaces focus the owned tabs without starting a second process", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const first = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    const firstLogs = await openScopedToolTab(logsTab(value.root, "prj_one", "tsk_one"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tasks = await openScopedToolTab(tasksTab(value.root, "prj_one"));
      const logs = await openScopedToolTab(logsTab(value.root, "prj_one", "tsk_one"));
      assert.equal(tasks.action, "reused");
      assert.equal(logs.action, "reused");
      assert.equal(tasks.paneId, first.paneId);
      assert.equal(logs.paneId, firstLogs.paneId);
    }
    const calls = fake.calls();
    assert.equal(calls.filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
    assert.equal(calls.filter((call) => call[0] === "pane" && call[1] === "run").length, 2);
    assert.equal(calls.filter((call) => call[0] === "pane" && call[1] === "close").length, 0);
    // Every repeat still focuses, which is the whole point of clicking again.
    assert.equal(calls.filter((call) => call[0] === "tab" && call[1] === "focus").length, 8);
  } finally {
    fake.restore();
    value.close();
  }
});

test("ownership is recorded as exact IDs, so a lookalike tab is neither adopted nor closed", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const owned = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    const record = JSON.parse(
      readFileSync(join(value.root, "state", "operator", "launcher-tabs.json"), "utf8"),
    ) as { workspaces: Record<string, { surfaces: Record<string, Record<string, unknown>> }> };
    const stored = record.workspaces.w1?.surfaces.tasks as Record<string, unknown>;
    assert.equal(stored.paneId, owned.paneId);
    assert.equal(stored.tabId, owned.tabId);
    assert.equal(stored.workspaceId, "w1");
    // A label is display only, so it is not even stored; it can never be matched on.
    assert.deepEqual(Object.keys(stored).sort(), ["command", "paneId", "scopeKey", "tabId", "workspaceId"]);

    // The owned pane disappears and an unrelated pane takes its place. Only the
    // recorded pane ID counted, so the newcomer is not treated as ours.
    const lookalike = { "w1:p-user": { workspace_id: "w1", tab_id: "w1:t-user" } };
    fake.setPanes(lookalike);
    const replacement = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    assert.equal(replacement.action, "created");
    assert.notEqual(replacement.paneId, "w1:p-user");
    assert.equal(fake.calls().filter((call) => call[1] === "close").length, 0);
    assert.equal(fake.panes()["w1:p-user"]?.tab_id, "w1:t-user");
  } finally {
    fake.restore();
    value.close();
  }
});

test("a pane moved into another tab is left alone and explains the replacement", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const owned = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    const moved = fake.panes();
    moved[owned.paneId as string]!.tab_id = "w1:t-moved";
    fake.setPanes(moved);

    const replacement = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    assert.equal(replacement.action, "created");
    assert.notEqual(replacement.paneId, owned.paneId);
    assert.match(replacement.reason, /left untouched/);
    assert.equal(fake.calls().filter((call) => call[1] === "close").length, 0);
    assert.equal(fake.panes()[owned.paneId as string]?.tab_id, "w1:t-moved");
  } finally {
    fake.restore();
    value.close();
  }
});

test("a focus failure still reports the tab that opened rather than a failed open", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root, { failFocus: true });
  try {
    const created = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    assert.equal(created.action, "created");
    assert.equal(created.focused, false);
    assert.match(created.reason, /switch to it by hand/);
    assert.equal(fake.calls().filter((call) => call[1] === "close").length, 0);

    // The tab is still owned, so the next open reuses it instead of piling up tabs.
    const reused = await openScopedToolTab(tasksTab(value.root, "prj_one"));
    assert.equal(reused.action, "reused");
    assert.equal(reused.focused, false);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 1);
  } finally {
    fake.restore();
    value.close();
  }
});

test("a running view follows the control channel without any command being reinjected", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const one = value.records.createProject({ name: "one", repoPath: join(value.root, "one") });
    const two = value.records.createProject({ name: "two", repoPath: join(value.root, "two") });
    value.records.createTask({ projectId: one.id, title: "only in one", objective: "test" });
    value.records.createTask({ projectId: two.id, title: "only in two", objective: "test" });
    requestToolView("w1", "tasks", { projectId: one.id, taskId: null });
    const herdrCallsBefore = fake.calls().length;

    const stop = new AbortController();
    const frames: string[] = [];
    await serveToolView(value.records, {
      workspaceId: "w1",
      surface: "tasks",
      intervalMs: 250,
      signal: stop.signal,
      input: detachedInput(),
      write: (frame) => {
        frames.push(frame);
        if (frames.length === 1) requestToolView("w1", "tasks", { projectId: two.id, taskId: null });
        else stop.abort();
      },
    });

    assert.equal(frames.length, 2);
    assert.ok(frames[0]?.includes("only in one"), frames[0]);
    assert.ok(!frames[0]?.includes("only in two"), frames[0]);
    assert.ok(frames[1]?.includes("only in two"), frames[1]);
    assert.ok(!frames[1]?.includes("only in one"), frames[1]);
    // Scope changed through the channel alone: no herdr call, no shell command.
    assert.equal(fake.calls().length, herdrCallsBefore);
    assert.equal(readToolViewRequest("w1", "tasks")?.sequence, 2);
  } finally {
    fake.restore();
    value.close();
  }
});

test("each rendered surface is rail-free and offers only closing itself", () => {
  const value = fixture();
  try {
    const project = value.records.createProject({ name: "project", repoPath: value.root });
    const task = value.records.createTask({ projectId: project.id, title: "selected", objective: "test" });
    const tasksFrame = renderToolView(
      value.records,
      requestToolView("w1", "tasks", { projectId: project.id, taskId: null }).request,
    );
    const logsFrame = renderToolView(
      value.records,
      requestToolView("w1", "logs", { projectId: project.id, taskId: task.id }).request,
    );

    for (const frame of [tasksFrame, logsFrame]) {
      assert.doesNotMatch(frame, /↑\/↓/);
      assert.doesNotMatch(frame, /enter steps/);
      assert.doesNotMatch(frame, /f filter/);
      assert.doesNotMatch(frame, /r refresh/);
      assert.equal(frame.trimEnd().split("\n").filter((line) => line.includes("q quit")).length, 1);
      assert.match(frame.trimEnd(), /q quit \(closes this view only\)$/);
    }
    // Neither surface is a route into the other.
    assert.ok(tasksFrame.startsWith("MABS tasks"));
    assert.ok(logsFrame.startsWith("MABS logs"));
    assert.doesNotMatch(tasksFrame, /MABS logs/);
    assert.doesNotMatch(logsFrame, /MABS tasks/);
  } finally {
    value.close();
  }
});

test("stale channel data renders an explanation instead of another project's records", () => {
  const value = fixture();
  try {
    const one = value.records.createProject({ name: "one", repoPath: join(value.root, "one") });
    const two = value.records.createProject({ name: "two", repoPath: join(value.root, "two") });
    const privateTask = value.records.createTask({ projectId: two.id, title: "private", objective: "test" });

    const goneProject = renderToolView(value.records, {
      version: 1, sequence: 1, requestedAt: new Date().toISOString(), workspaceId: "w1",
      surface: "tasks", projectId: "prj_gone", taskId: null,
    });
    assert.match(goneProject, /stale/);
    assert.doesNotMatch(goneProject, /STATE\s+TASK/);

    const crossProject = renderToolView(
      value.records,
      requestToolView("w1", "logs", { projectId: one.id, taskId: privateTask.id }).request,
    );
    assert.match(crossProject, /does not belong/);
    assert.doesNotMatch(crossProject, /No evidence has been recorded/);

    const noTask = renderToolView(value.records, {
      version: 1, sequence: 1, requestedAt: new Date().toISOString(), workspaceId: "w1",
      surface: "logs", projectId: one.id, taskId: null,
    });
    assert.match(noTask, /No task is selected/);
  } finally {
    value.close();
  }
});

test("opening, following, and closing a tool view changes no task record", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const project = value.records.createProject({ name: "project", repoPath: value.root });
    const task = value.records.createTask({ projectId: project.id, title: "worker task", objective: "test" });
    const before = JSON.stringify({
      task: value.records.getTask(task.id),
      events: value.records.listEvents(task.id),
      tasks: value.records.listTasks({ projectId: project.id }),
    });

    await openScopedToolTab(logsTab(value.root, project.id, task.id));
    const stop = new AbortController();
    await serveToolView(value.records, {
      workspaceId: "w1",
      surface: "logs",
      intervalMs: 250,
      signal: stop.signal,
      input: detachedInput(),
      write: () => stop.abort(),
    });

    assert.equal(JSON.stringify({
      task: value.records.getTask(task.id),
      events: value.records.listEvents(task.id),
      tasks: value.records.listTasks({ projectId: project.id }),
    }), before);
    // Closing a view is not a cancellation: nothing was asked of any worker.
    assert.equal(fake.calls().filter((call) => call[0] === "pane" && call[1] === "close").length, 0);
  } finally {
    fake.restore();
    value.close();
  }
});

test("quitting a view does not wait out its refresh interval", async () => {
  const value = fixture();
  try {
    requestToolView("w1", "tasks", { projectId: "prj_gone", taskId: null });
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 20);
    await serveToolView(value.records, {
      workspaceId: "w1",
      surface: "tasks",
      intervalMs: 3_600_000,
      signal: stop.signal,
      input: detachedInput(),
      write: () => {},
    });
    assert.ok(Date.now() - started < 5_000, `serve took ${Date.now() - started}ms`);
  } finally {
    value.close();
  }
});
