import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exec } from "../../src/core/exec.ts";
import {
  activateLauncherChoice,
  buildLauncherScreen,
  codeOpenInvocation,
  dispatchLauncherAction,
} from "../../src/operator/launcher.ts";
import { openScopedToolTab, type HerdrSession } from "../../src/operator/herdr.ts";
import {
  readToolViewRequest,
  renderToolView,
  requestToolView,
  toolViewRequestPath,
} from "../../src/operator/workspace/tool-view.ts";
import { openRecords, type Records } from "../../src/store/records.ts";

interface Fixture {
  records: Records;
  root: string;
  close: () => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mabs-launcher-"));
  const oldState = process.env.MABS_STATE_DIR;
  const oldDb = process.env.MABS_DB_PATH;
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_DB_PATH = join(root, "state", "mabs.sqlite");
  const records = openRecords();
  return {
    records,
    root,
    close: () => {
      records.store.close();
      if (oldState === undefined) delete process.env.MABS_STATE_DIR;
      else process.env.MABS_STATE_DIR = oldState;
      if (oldDb === undefined) delete process.env.MABS_DB_PATH;
      else process.env.MABS_DB_PATH = oldDb;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fakeHerdr(root: string, options: { failRun?: boolean } = {}): {
  calls: () => string[][];
  panes: () => Record<string, { workspace_id: string; tab_id: string }>;
  setPanes: (value: Record<string, { workspace_id: string; tab_id: string }>) => void;
  restore: () => void;
} {
  const bin = join(root, "bin");
  const calls = join(root, "herdr-calls.jsonl");
  const panes = join(root, "herdr-panes.json");
  const previousPath = process.env.PATH;
  writeFileSync(calls, "");
  writeFileSync(panes, JSON.stringify({}));
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "herdr");
  writeFileSync(script, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const panes = JSON.parse(readFileSync(${JSON.stringify(panes)}, "utf8"));
const output = value => writeFileSync(1, JSON.stringify(value));
if (args[0] === "--version") {
  writeFileSync(1, "herdr 0.9.1\\n");
  process.exit(0);
}
if (args[0] === "tab" && args[1] === "create") {
  const n = readFileSync(${JSON.stringify(calls)}, "utf8").split("\\n").filter(Boolean).map(JSON.parse)
    .filter(call => call[0] === "tab" && call[1] === "create").length;
  const workspaceId = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : "w1";
  const paneId = workspaceId + ":p" + n;
  panes[paneId] = { workspace_id: workspaceId, tab_id: workspaceId + ":t" + n };
  writeFileSync(${JSON.stringify(panes)}, JSON.stringify(panes));
  output({ result: { tab: { tab_id: workspaceId + ":t" + n }, root_pane: { pane_id: paneId } } });
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "get") {
  const pane = panes[args[2]];
  if (!pane) process.exit(1);
  output({ result: { pane: { pane_id: args[2], ...pane } } });
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "close") {
  delete panes[args[2]];
  writeFileSync(${JSON.stringify(panes)}, JSON.stringify(panes));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "run") process.exit(${options.failRun ? "1" : "0"});
if (args[0] === "tab" && args[1] === "focus") process.exit(0);
process.exit(2);
`);
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    calls: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    panes: () => JSON.parse(readFileSync(panes, "utf8")) as Record<string, { workspace_id: string; tab_id: string }>,
    setPanes: (value) => writeFileSync(panes, JSON.stringify(value)),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

const LIVE: HerdrSession = {
  available: true,
  version: "herdr 0.9.1",
  inSession: true,
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  reason: null,
};

async function firstToolFrame(command: string, cwd: string): Promise<string> {
  assert.match(command, /^node '[^']+' workspace view /);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const outputPath = join(cwd, "tool-view-frame.txt");
  const quotedOutput = `'${outputPath.replaceAll("'", "'\\''")}'`;
  const result = await exec("bash", ["-c", `${command} --once > ${quotedOutput}`], {
    cwd, env, timeoutMs: 5_000,
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return readFileSync(outputPath, "utf8");
}

test("empty stores explain that no scope is available without dispatching anything", () => {
  const value = fixture();
  try {
    const actions = buildLauncherScreen(value.records);
    assert.equal(actions.step, "action");
    const project = buildLauncherScreen(value.records, { action: "tasks" });
    assert.equal(project.step, "empty");
    assert.match(project.message, /No MABS projects/);
    assert.deepEqual(value.records.listProjects(), []);
    assert.deepEqual(value.records.recentEvents(), []);
  } finally {
    value.close();
  }
});

test("building, clicking through, and dismissing popup screens never calls Herdr", () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const project = value.records.createProject({ name: "project", repoPath: join(value.root, "repo") });
    const task = value.records.createTask({ projectId: project.id, title: "task", objective: "test" });
    const actions = buildLauncherScreen(value.records);
    const projects = activateLauncherChoice(value.records, actions, "action:logs", "mouse").screen;
    const tasks = activateLauncherChoice(value.records, projects, `project:${project.id}`, "keyboard").screen;
    const ready = activateLauncherChoice(value.records, tasks, `task:${task.id}`, "mouse").screen;
    assert.equal(ready.step, "ready");
    assert.deepEqual(fake.calls(), []);
  } finally {
    fake.restore();
    value.close();
  }
});

test("multi-project scope is an explicit stable-ID choice rather than a label inference", () => {
  const value = fixture();
  try {
    const one = value.records.createProject({ name: "same label one", repoPath: join(value.root, "one") });
    const two = value.records.createProject({ name: "same label two", repoPath: join(value.root, "two") });
    const screen = buildLauncherScreen(value.records, { action: "tasks" });
    assert.equal(screen.step, "project");
    assert.deepEqual(screen.choices.map((choice) => choice.id).sort(), [`project:${one.id}`, `project:${two.id}`].sort());
    assert.ok(screen.choices.every((choice) => choice.label.includes("same label") && choice.label.includes("prj_")));
  } finally {
    value.close();
  }
});

test("stale project and task context returns to explicit choices", () => {
  const value = fixture();
  try {
    const project = value.records.createProject({ name: "live", repoPath: join(value.root, "repo") });
    const task = value.records.createTask({ projectId: project.id, title: "duplicate title", objective: "test" });

    const staleProject = buildLauncherScreen(value.records, { action: "logs", projectId: "prj_stale", taskId: task.id });
    assert.equal(staleProject.step, "project");
    assert.match(staleProject.message, /stale or unknown/);

    const staleTask = buildLauncherScreen(value.records, { action: "logs", projectId: project.id, taskId: "tsk_stale" });
    assert.equal(staleTask.step, "task");
    assert.match(staleTask.message, /stale/);
    assert.deepEqual(staleTask.choices.map((choice) => choice.id), [`task:${task.id}`]);
  } finally {
    value.close();
  }
});

test("mouse and keyboard activation produce identical scoped actions", () => {
  const value = fixture();
  try {
    const project = value.records.createProject({ name: "project", repoPath: join(value.root, "repo") });
    const task = value.records.createTask({ projectId: project.id, title: "task", objective: "test" });
    const actionScreen = buildLauncherScreen(value.records);

    const keyboardAction = activateLauncherChoice(value.records, actionScreen, "action:logs", "keyboard");
    const mouseAction = activateLauncherChoice(value.records, actionScreen, "action:logs", "mouse");
    assert.deepEqual(keyboardAction.screen, mouseAction.screen);

    const keyboardProject = activateLauncherChoice(value.records, keyboardAction.screen, `project:${project.id}`, "keyboard");
    const mouseProject = activateLauncherChoice(value.records, mouseAction.screen, `project:${project.id}`, "mouse");
    assert.deepEqual(keyboardProject.screen, mouseProject.screen);

    const keyboardTask = activateLauncherChoice(value.records, keyboardProject.screen, `task:${task.id}`, "keyboard");
    const mouseTask = activateLauncherChoice(value.records, mouseProject.screen, `task:${task.id}`, "mouse");
    assert.deepEqual(keyboardTask.screen, mouseTask.screen);
    assert.deepEqual(keyboardTask.screen.selection, {
      action: "logs", projectId: project.id, taskId: task.id,
    });

    const keyboardDispatch = activateLauncherChoice(value.records, keyboardTask.screen, "dispatch:logs", "keyboard");
    const mouseDispatch = activateLauncherChoice(value.records, mouseTask.screen, "dispatch:logs", "mouse");
    assert.deepEqual(keyboardDispatch.screen, mouseDispatch.screen);
  } finally {
    value.close();
  }
});

test("a task from another project is never inferred from its title or stale ID", () => {
  const value = fixture();
  try {
    const one = value.records.createProject({ name: "one", repoPath: join(value.root, "one") });
    const two = value.records.createProject({ name: "two", repoPath: join(value.root, "two") });
    const oneTask = value.records.createTask({ projectId: one.id, title: "same", objective: "one" });
    const twoTask = value.records.createTask({ projectId: two.id, title: "same", objective: "two" });

    const screen = buildLauncherScreen(value.records, { action: "code", projectId: one.id, taskId: twoTask.id });
    assert.equal(screen.step, "task");
    assert.match(screen.message, /does not belong/);
    assert.deepEqual(screen.choices.map((choice) => choice.id), [`task:${oneTask.id}`]);
  } finally {
    value.close();
  }
});

test("explicit scoped tab dispatch reuses the verified pane without restarting its process", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const options = {
      surface: "tasks" as const,
      scopeKey: "project:prj_exact",
      repoPath: value.root,
      command: () => "node src/cli.ts task watch --project=prj_exact",
      selection: { projectId: "prj_exact", taskId: null },
      cliAlternative: "`node src/cli.ts task watch --project=prj_exact`",
      session: LIVE,
    };
    const first = await openScopedToolTab(options);
    const firstRequest = readToolViewRequest("w1", "tasks");
    const runCount = fake.calls().filter((call) => call[1] === "run").length;
    const second = await openScopedToolTab(options);
    assert.equal(first.action, "created");
    assert.equal(second.action, "reused");
    assert.equal(second.paneId, first.paneId);
    assert.deepEqual(readToolViewRequest("w1", "tasks"), firstRequest);
    assert.equal(fake.calls().filter((call) => call[1] === "run").length, runCount);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 1);
    assert.deepEqual(fake.calls().filter((call) => call[0] === "tab" && call[1] === "focus").at(-1), [
      "tab", "focus", first.tabId,
    ]);

    const changed = await openScopedToolTab({
      ...options,
      scopeKey: "project:prj_other",
      selection: { projectId: "prj_other", taskId: null },
    });
    assert.equal(changed.action, "reused");
    assert.equal(changed.paneId, first.paneId);
    assert.equal(fake.calls().filter((call) => call[1] === "close").length, 0);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 1);
    assert.equal(readToolViewRequest("w1", "tasks")?.projectId, "prj_other");
  } finally {
    fake.restore();
    value.close();
  }
});

test("Tasks and Logs own separate rail-free tabs in the invoking workspace", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  const previousHerdr = {
    env: process.env.HERDR_ENV,
    workspace: process.env.HERDR_WORKSPACE_ID,
    tab: process.env.HERDR_TAB_ID,
    pane: process.env.HERDR_PANE_ID,
  };
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_TAB_ID = "w1:t0";
    process.env.HERDR_PANE_ID = "w1:p0";
    const project = value.records.createProject({ name: "project", repoPath: value.root });
    const task = value.records.createTask({ projectId: project.id, title: "selected", objective: "test" });
    const before = JSON.stringify({ task: value.records.getTask(task.id), events: value.records.listEvents(task.id) });
    const tasks = await dispatchLauncherAction(
      value.records,
      buildLauncherScreen(value.records, { action: "tasks", projectId: project.id }),
    );
    const logs = await dispatchLauncherAction(
      value.records,
      buildLauncherScreen(value.records, { action: "logs", projectId: project.id, taskId: task.id }),
    );

    assert.equal(tasks.tab?.action, "created");
    assert.equal(logs.tab?.action, "created");
    assert.notEqual(tasks.tab?.tabId, logs.tab?.tabId);
    assert.notEqual(tasks.tab?.paneId, logs.tab?.paneId);
    assert.equal(fake.calls().filter((call) => call[0] === "pane" && call[1] === "split").length, 0);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
    // Neither tab may be told to work out its own workspace: an unset variable
    // in the new pane's shell would silently serve the wrong scope or none.
    const runs = fake.calls().filter((call) => call[0] === "pane" && call[1] === "run").map((call) => call[3] as string);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((run) => run.includes("--workspace='w1'")), runs.join(" | "));
    assert.ok(runs.every((run) => !run.includes("HERDR_WORKSPACE_ID")), runs.join(" | "));
    assert.deepEqual(runs.map((run) => /--surface=(\w+)/.exec(run)?.[1]).sort(), ["logs", "tasks"]);

    const tasksFrame = renderToolView(value.records, readToolViewRequest("w1", "tasks")!);
    const logsFrame = renderToolView(value.records, readToolViewRequest("w1", "logs")!);
    assert.match(tasksFrame, /^MABS tasks/);
    assert.doesNotMatch(tasksFrame, /MABS logs/);
    assert.match(logsFrame, /^MABS logs/);
    assert.doesNotMatch(logsFrame, /MABS tasks/);
    // Rail-free: each frame offers no in-view navigation, filtering, or a route
    // to the other surface. Its only key closes the view.
    for (const frame of [tasksFrame, logsFrame]) {
      assert.doesNotMatch(frame, /↑\/↓/);
      assert.doesNotMatch(frame, /enter steps/);
      assert.doesNotMatch(frame, /f filter/);
      assert.doesNotMatch(frame, /r refresh/);
      assert.match(frame.trimEnd(), /q quit \(closes this view only\)$/);
    }
    assert.equal(JSON.stringify({ task: value.records.getTask(task.id), events: value.records.listEvents(task.id) }), before);
  } finally {
    if (previousHerdr.env === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr.env;
    if (previousHerdr.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = previousHerdr.workspace;
    if (previousHerdr.tab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = previousHerdr.tab;
    if (previousHerdr.pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousHerdr.pane;
    fake.restore();
    value.close();
  }
});

test("a generated tool-view command starts from a distinct project checkout", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  const previousHerdr = {
    env: process.env.HERDR_ENV,
    workspace: process.env.HERDR_WORKSPACE_ID,
    tab: process.env.HERDR_TAB_ID,
    pane: process.env.HERDR_PANE_ID,
  };
  try {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_TAB_ID = "w1:t0";
    process.env.HERDR_PANE_ID = "w1:p0";
    const projectRepo = join(value.root, "unrelated-project");
    mkdirSync(projectRepo, { recursive: true });
    const project = value.records.createProject({ name: "other checkout", repoPath: projectRepo });
    value.records.createTask({ projectId: project.id, title: "visible from absolute CLI", objective: "test" });

    const opened = await dispatchLauncherAction(
      value.records,
      buildLauncherScreen(value.records, { action: "tasks", projectId: project.id }),
    );
    assert.equal(opened.tab?.action, "created");
    const run = fake.calls().find((call) => call[0] === "pane" && call[1] === "run");
    const command = run?.[3];
    assert.ok(command);
    assert.doesNotMatch(command, /^node src\/cli\.ts/);
    assert.match(command, /\/src\/cli\.ts' workspace view --surface=tasks/);

    const frame = await firstToolFrame(command, projectRepo);
    assert.match(frame, /^\u001b\[H\u001b\[2JMABS tasks/);
    assert.match(frame, /visible from absolute CLI/);
    assert.doesNotMatch(frame, /MODULE_NOT_FOUND/);
  } finally {
    if (previousHerdr.env === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr.env;
    if (previousHerdr.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = previousHerdr.workspace;
    if (previousHerdr.tab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = previousHerdr.tab;
    if (previousHerdr.pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousHerdr.pane;
    fake.restore();
    value.close();
  }
});

test("closed tabs are recreated only by an explicit open and moved tabs are never adopted or closed", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const options = {
      surface: "tasks" as const,
      scopeKey: "project:prj_exact",
      repoPath: value.root,
      command: (workspaceId: string) => `node src/cli.ts workspace view --surface=tasks --workspace='${workspaceId}'`,
      selection: { projectId: "prj_exact", taskId: null },
      cliAlternative: "task watch",
      session: LIVE,
    };
    const first = await openScopedToolTab(options);
    const panes = fake.panes();
    panes[first.paneId as string]!.tab_id = "w1:t-manual";
    fake.setPanes(panes);

    const replacement = await openScopedToolTab(options);
    assert.equal(replacement.action, "created");
    assert.notEqual(replacement.paneId, first.paneId);
    assert.equal(fake.calls().filter((call) => call[1] === "close").length, 0);
    assert.equal(fake.panes()[first.paneId as string]?.tab_id, "w1:t-manual");

    const afterMoveCalls = fake.calls().length;
    const closed = fake.panes();
    delete closed[replacement.paneId as string];
    fake.setPanes(closed);
    // Channel updates never create UI by themselves.
    requestToolView("w1", "tasks", { projectId: "prj_other", taskId: null });
    assert.equal(fake.calls().length, afterMoveCalls);
    const recreated = await openScopedToolTab({
      ...options,
      scopeKey: "project:prj_other",
      selection: { projectId: "prj_other", taskId: null },
    });
    assert.equal(recreated.action, "created");
  } finally {
    fake.restore();
    value.close();
  }
});

test("tool ownership and control requests do not leak across workspaces", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const base = {
      surface: "tasks" as const,
      repoPath: value.root,
      command: (workspaceId: string) => `node src/cli.ts workspace view --surface=tasks --workspace='${workspaceId}'`,
      cliAlternative: "task watch",
    };
    const one = await openScopedToolTab({
      ...base, scopeKey: "project:prj_one", selection: { projectId: "prj_one", taskId: null }, session: LIVE,
    });
    const two = await openScopedToolTab({
      ...base, scopeKey: "project:prj_two", selection: { projectId: "prj_two", taskId: null },
      session: { ...LIVE, workspaceId: "w2", tabId: "w2:t0", paneId: "w2:p0" },
    });
    const oneAgain = await openScopedToolTab({
      ...base, scopeKey: "project:prj_one", selection: { projectId: "prj_one", taskId: null }, session: LIVE,
    });
    assert.equal(oneAgain.action, "reused");
    assert.equal(oneAgain.paneId, one.paneId);
    assert.notEqual(two.paneId, one.paneId);
    assert.equal(readToolViewRequest("w1", "tasks")?.projectId, "prj_one");
    assert.equal(readToolViewRequest("w2", "tasks")?.projectId, "prj_two");
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
  } finally {
    fake.restore();
    value.close();
  }
});

test("stale or cross-workspace control data is rejected", () => {
  const value = fixture();
  try {
    const one = value.records.createProject({ name: "one", repoPath: join(value.root, "one") });
    const two = value.records.createProject({ name: "two", repoPath: join(value.root, "two") });
    const otherTask = value.records.createTask({ projectId: two.id, title: "private to two", objective: "test" });
    const mismatched = requestToolView("w1", "logs", { projectId: one.id, taskId: otherTask.id }).request;
    const frame = renderToolView(value.records, mismatched);
    assert.match(frame, /does not belong/);
    assert.doesNotMatch(frame, /No evidence has been recorded/);

    requestToolView("w1", "tasks", { projectId: "prj_one", taskId: null });
    const path = toolViewRequestPath("w1", "tasks");
    const stale = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    stale.workspaceId = "w2";
    writeFileSync(path, JSON.stringify(stale));
    assert.equal(readToolViewRequest("w1", "tasks"), null);
    assert.equal(readToolViewRequest("w2", "tasks"), null);
  } finally {
    value.close();
  }
});

test("unsupported Herdr environments return the exact scoped CLI alternative", async () => {
  const value = fixture();
  try {
    const result = await openScopedToolTab({
      surface: "logs",
      scopeKey: "task:tsk_exact",
      repoPath: value.root,
      command: () => "node src/cli.ts logs tsk_exact",
      selection: { projectId: "prj_exact", taskId: "tsk_exact" },
      cliAlternative: "`node src/cli.ts logs tsk_exact`",
      session: { ...LIVE, available: false, inSession: false, workspaceId: null, reason: "herdr is unavailable" },
    });
    assert.equal(result.action, "degraded");
    assert.match(result.reason, /node src\/cli\.ts logs tsk_exact/);
  } finally {
    value.close();
  }
});

test("failed command startup removes its owned partial tab and reports the CLI alternative", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root, { failRun: true });
  try {
    const result = await openScopedToolTab({
      surface: "logs",
      scopeKey: "task:tsk_exact",
      repoPath: value.root,
      command: () => "node src/cli.ts logs tsk_exact",
      selection: { projectId: "prj_exact", taskId: "tsk_exact" },
      cliAlternative: "`node src/cli.ts logs tsk_exact`",
      session: LIVE,
    });
    assert.equal(result.action, "degraded");
    assert.match(result.reason, /could not start/i);
    assert.match(result.reason, /incomplete pane .* was closed/i);
    assert.match(result.reason, /node src\/cli\.ts logs tsk_exact/);
    assert.equal(fake.calls().filter((call) => call[0] === "pane" && call[1] === "close").length, 1);
  } finally {
    fake.restore();
    value.close();
  }
});

test("older Herdr versions degrade without touching tabs and name the supported alternative", async () => {
  const value = fixture();
  const fake = fakeHerdr(value.root);
  try {
    const result = await openScopedToolTab({
      surface: "tasks",
      scopeKey: "project:prj_exact",
      repoPath: value.root,
      command: () => "node src/cli.ts task watch --project=prj_exact",
      selection: { projectId: "prj_exact", taskId: null },
      cliAlternative: "`node src/cli.ts task watch --project=prj_exact`",
      session: { ...LIVE, version: "herdr 0.8.9" },
    });
    assert.equal(result.action, "degraded");
    assert.match(result.reason, /0\.9\.1 or newer/);
    assert.match(result.reason, /node src\/cli\.ts task watch --project=prj_exact/);
    assert.deepEqual(fake.calls(), []);
  } finally {
    fake.restore();
    value.close();
  }
});

test("Code opens only the selected live worktree and never substitutes the project checkout", async () => {
  const value = fixture();
  const previousPath = process.env.PATH;
  try {
    const projectRepo = join(value.root, "project-checkout");
    const worktree = join(value.root, "live-worktree");
    mkdirSync(projectRepo, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /tmp/example\n");
    const project = value.records.createProject({ name: "project", repoPath: projectRepo });
    const task = value.records.createTask({ projectId: project.id, title: "task", objective: "test" });
    value.records.updateTaskFields(task.id, { worktree_path: worktree });

    const bin = join(value.root, "code-bin");
    const calls = join(value.root, "code-calls.jsonl");
    mkdirSync(bin, { recursive: true });
    writeFileSync(calls, "");
    const code = join(bin, "code");
    writeFileSync(code, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
    chmodSync(code, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;

    const screen = buildLauncherScreen(value.records, { action: "code", projectId: project.id, taskId: task.id });
    const result = await dispatchLauncherAction(value.records, screen);
    assert.equal(result.status, "opened");
    const invocation = readFileSync(calls, "utf8");
    assert.match(invocation, /--new-window/);
    assert.ok(invocation.includes(worktree));
    assert.ok(!invocation.includes(projectRepo));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    value.close();
  }
});

test("Windows-hosted VS Code receives an explicit WSL remote address", () => {
  const invocation = codeOpenInvocation(
    "/mnt/c/Users/example/AppData/Local/Programs/Microsoft VS Code/bin/code",
    "/home/example/worktrees/tsk_exact",
    "Ubuntu-24.04",
  );
  assert.deepEqual(invocation, {
    executable: "/mnt/c/Users/example/AppData/Local/Programs/Microsoft VS Code/bin/code",
    args: ["--remote", "wsl+Ubuntu-24.04", "--new-window", "/home/example/worktrees/tsk_exact"],
    remote: "wsl+Ubuntu-24.04",
  });
  assert.throws(
    () => codeOpenInvocation("/mnt/c/VSCode/code", "/home/example/worktree", null),
    /WSL_DISTRO_NAME is unset/,
  );
});

test("Code reports a missing live worktree instead of opening a revision or base checkout", async () => {
  const value = fixture();
  try {
    const project = value.records.createProject({ name: "project", repoPath: join(value.root, "project") });
    const task = value.records.createTask({ projectId: project.id, title: "task", objective: "test" });
    value.records.updateTaskFields(task.id, {
      worktree_path: join(value.root, "gone"),
      result_revision: "0123456789abcdef",
    });
    const screen = buildLauncherScreen(value.records, { action: "code", projectId: project.id, taskId: task.id });
    await assert.rejects(() => dispatchLauncherAction(value.records, screen), /no live worktree.*recorded revision/is);
  } finally {
    value.close();
  }
});
