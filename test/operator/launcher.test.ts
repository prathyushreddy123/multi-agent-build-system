import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateLauncherChoice,
  buildLauncherScreen,
  codeOpenInvocation,
  dispatchLauncherAction,
} from "../../src/operator/launcher.ts";
import { openScopedToolTab, type HerdrSession } from "../../src/operator/herdr.ts";
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

function fakeHerdr(root: string, options: { failRun?: boolean } = {}): { calls: () => string[][]; restore: () => void } {
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
if (args[0] === "tab" && args[1] === "create") {
  const n = Object.keys(panes).length + 1;
  const paneId = "w1:p" + n;
  panes[paneId] = { workspace_id: "w1", tab_id: "w1:t" + n };
  writeFileSync(${JSON.stringify(panes)}, JSON.stringify(panes));
  output({ result: { tab: { tab_id: "w1:t" + n }, root_pane: { pane_id: paneId } } });
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
      command: "node src/cli.ts task watch --project=prj_exact",
      cliAlternative: "`node src/cli.ts task watch --project=prj_exact`",
      session: LIVE,
    };
    const first = await openScopedToolTab(options);
    const runCount = fake.calls().filter((call) => call[1] === "run").length;
    const second = await openScopedToolTab(options);
    assert.equal(first.action, "created");
    assert.equal(second.action, "reused");
    assert.equal(second.paneId, first.paneId);
    assert.equal(fake.calls().filter((call) => call[1] === "run").length, runCount);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 1);
    assert.deepEqual(fake.calls().filter((call) => call[0] === "tab" && call[1] === "focus").at(-1), [
      "tab", "focus", first.tabId,
    ]);

    const changed = await openScopedToolTab({
      ...options,
      scopeKey: "project:prj_other",
      command: "node src/cli.ts task watch --project=prj_other",
    });
    assert.equal(changed.action, "created");
    assert.equal(fake.calls().filter((call) => call[1] === "close").length, 1);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
  } finally {
    fake.restore();
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
      command: "node src/cli.ts logs tsk_exact",
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
      command: "node src/cli.ts logs tsk_exact",
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
      command: "node src/cli.ts task watch --project=prj_exact",
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
