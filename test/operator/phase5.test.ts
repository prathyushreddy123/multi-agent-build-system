import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INHERITED_ENV,
  SURFACES,
  inheritedEnvArgs,
  closeWorkspace,
  openWorkspace,
  verifyOwnedSurface,
  workspaceStatus,
  type HerdrSession,
} from "../../src/operator/herdr.ts";
import { readPreferences, setOwnedSurface, updatePreferences } from "../../src/operator/preferences.ts";

/**
 * A stand-in `herdr` that records every invocation and answers from a small
 * in-memory pane table. It is placed first on PATH, so the code under test runs
 * exactly the commands it would run for real.
 */
interface FakeHerdr {
  root: string;
  calls: () => string[][];
  panes: () => Record<string, { workspace_id: string; tab_id: string }>;
  setPanes: (panes: Record<string, { workspace_id: string; tab_id: string }>) => void;
  restore: () => void;
}

function installFakeHerdr(options: { failCreateFor?: string } = {}): FakeHerdr {
  const root = mkdtempSync(join(tmpdir(), "mabs-op5-"));
  const callLog = join(root, "calls.jsonl");
  const paneFile = join(root, "panes.json");
  writeFileSync(callLog, "");
  writeFileSync(paneFile, JSON.stringify({ "w1:p1": { workspace_id: "w1", tab_id: "w1:t1" } }));

  const script = join(root, "herdr");
  writeFileSync(script, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
const panes = JSON.parse(readFileSync(${JSON.stringify(paneFile)}, "utf8"));
const save = () => writeFileSync(${JSON.stringify(paneFile)}, JSON.stringify(panes));
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = (message) => { process.stderr.write(message); process.exit(1); };

if (args[0] === "--version") { process.stdout.write("herdr 0.9.1\\n"); process.exit(0); }
if (args[0] === "pane" && args[1] === "get") {
  const pane = panes[args[2]];
  if (!pane) fail("pane not found");
  out({ result: { pane: { pane_id: args[2], ...pane, cwd: "/repo", agent: null } } });
}
if (args[0] === "tab" && args[1] === "create") {
  const label = args[args.indexOf("--label") + 1] || "";
  ${options.failCreateFor ? `if (label.includes(${JSON.stringify(options.failCreateFor)})) fail("simulated create failure");` : ""}
  const n = Object.keys(panes).length + 1;
  const paneId = "w1:p" + n;
  panes[paneId] = { workspace_id: "w1", tab_id: "w1:t" + n };
  save();
  out({ result: { tab: { tab_id: "w1:t" + n }, root_pane: { pane_id: paneId } } });
}
if (args[0] === "pane" && args[1] === "split") {
  const n = Object.keys(panes).length + 1;
  const paneId = "w1:p" + n;
  panes[paneId] = { workspace_id: "w1", tab_id: "w1:t1" };
  save();
  out({ result: { pane: { pane_id: paneId, tab_id: "w1:t1" } } });
}
// The real herdr prints nothing for these; exit status is the whole answer.
if (args[0] === "pane" && args[1] === "run") process.exit(0);
if (args[0] === "pane" && args[1] === "focus") process.exit(0);
if (args[0] === "pane" && args[1] === "close") {
  if (!panes[args[2]]) fail("pane not found");
  delete panes[args[2]];
  save();
  process.exit(0);
}
fail("unsupported: " + args.join(" "));
`);
  chmodSync(script, 0o755);

  const previousPath = process.env.PATH;
  const previousState = process.env.MABS_STATE_DIR;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.MABS_STATE_DIR = join(root, "state");

  return {
    root,
    calls: () => readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    panes: () => JSON.parse(readFileSync(paneFile, "utf8")) as Record<string, { workspace_id: string; tab_id: string }>,
    setPanes: (panes) => writeFileSync(paneFile, JSON.stringify(panes)),
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousState === undefined) delete process.env.MABS_STATE_DIR;
      else process.env.MABS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const LIVE: HerdrSession = {
  available: true, version: "herdr 0.9.1", inSession: true,
  workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", reason: null,
};

test("opening the workspace creates the missing surfaces and reuses the agent pane", async () => {
  const fake = installFakeHerdr();
  try {
    const result = await openWorkspace({ repoPath: "/repo", projectId: "prj_1", session: LIVE });
    assert.equal(result.degraded, false);
    assert.deepEqual(result.surfaces.map((surface) => surface.surface), [...SURFACES]);

    const agent = result.surfaces.find((surface) => surface.surface === "agent");
    assert.equal(agent?.action, "reused");
    assert.equal(agent?.paneId, "w1:p1");
    assert.match(agent?.reason ?? "", /live session is reused/);

    for (const name of ["code", "tasks", "logs"] as const) {
      assert.equal(result.surfaces.find((surface) => surface.surface === name)?.action, "created", name);
    }

    // Each surface runs its own command, and the dashboard is scoped to the project.
    const runs = fake.calls().filter((call) => call[0] === "pane" && call[1] === "run").map((call) => call[3]);
    assert.ok(runs.some((command) => command?.includes("viewer serve --surface=code")));
    assert.ok(runs.some((command) => command?.includes("task watch --project=prj_1")));

    // Panes are created in the background.
    assert.ok(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").every((call) => call.includes("--no-focus")));
    assert.equal(fake.calls().some((call) => call[1] === "focus"), false);
    assert.ok(result.notes.some((note) => note.includes("Focus was left where it was")));
  } finally {
    fake.restore();
  }
});

test("opening the workspace twice reuses owned panes without starting duplicate processes", async () => {
  const fake = installFakeHerdr();
  try {
    const first = await openWorkspace({ repoPath: "/repo", session: LIVE });
    const createdPanes = first.surfaces.filter((surface) => surface.action === "created").map((surface) => surface.paneId);
    const runsAfterFirst = fake.calls().filter((call) => call[1] === "run").length;

    const second = await openWorkspace({ repoPath: "/repo", session: LIVE });
    assert.ok(second.surfaces.every((surface) => surface.action === "reused"), JSON.stringify(second.surfaces));
    assert.deepEqual(
      second.surfaces.filter((surface) => surface.surface !== "agent").map((surface) => surface.paneId),
      createdPanes,
    );

    // Nothing was sent to a reused pane, so no second viewer or watcher starts.
    assert.equal(fake.calls().filter((call) => call[1] === "run").length, runsAfterFirst);
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 3);
    assert.ok(second.surfaces.some((surface) => surface.reason.includes("without sending anything")));
  } finally {
    fake.restore();
  }
});

test("a closed pane is recreated and an unrelated pane is never adopted", async () => {
  const fake = installFakeHerdr();
  try {
    const first = await openWorkspace({ repoPath: "/repo", session: LIVE });
    const codePane = first.surfaces.find((surface) => surface.surface === "code")?.paneId;
    assert.ok(codePane);

    // The user closed the Code pane.
    const panes = fake.panes();
    delete panes[codePane];
    fake.setPanes(panes);

    const second = await openWorkspace({ repoPath: "/repo", session: LIVE });
    const code = second.surfaces.find((surface) => surface.surface === "code");
    assert.equal(code?.action, "created");
    assert.notEqual(code?.paneId, codePane);
    assert.ok(second.notes.some((note) => note.includes("no longer exists")));

    // The other surfaces were not disturbed.
    assert.equal(second.surfaces.find((surface) => surface.surface === "tasks")?.action, "reused");
  } finally {
    fake.restore();
  }
});

test("ownership is proved by pane identity, not by a label", async () => {
  const fake = installFakeHerdr();
  try {
    await openWorkspace({ repoPath: "/repo", session: LIVE });

    // The pane still exists but now belongs to another workspace.
    const surfaces = readPreferences().workspace.surfaces;
    const tasksPane = surfaces.tasks?.paneId;
    assert.ok(tasksPane);
    const panes = fake.panes();
    panes[tasksPane] = { workspace_id: "w9", tab_id: "w9:t1" };
    fake.setPanes(panes);

    const verified = await verifyOwnedSurface(surfaces.tasks, "w1");
    assert.equal(verified.owned, false);
    assert.match(String(verified.reason), /now belongs to workspace w9/);

    // A renamed label changes nothing, because the label is never the proof.
    const logsSurface = surfaces.logs;
    assert.ok(logsSurface);
    setOwnedSurface("logs", { ...logsSurface, label: "Renamed by the user" });
    const logs = await verifyOwnedSurface(readPreferences().workspace.surfaces.logs, "w1");
    assert.equal(logs.owned, true);
  } finally {
    fake.restore();
  }
});

test("surfaces recorded for another workspace are not reused", async () => {
  const fake = installFakeHerdr();
  try {
    updatePreferences({
      workspace: {
        workspaceId: "w7", repoPath: "/elsewhere", layout: "tabs",
        surfaces: { code: { paneId: "w1:p1", tabId: "w7:t1", label: "Code", createdAt: new Date().toISOString() } },
      },
    });

    const result = await openWorkspace({ repoPath: "/repo", session: LIVE });
    assert.equal(result.surfaces.find((surface) => surface.surface === "code")?.action, "created");
    assert.ok(result.notes.some((note) => note.includes("belonged to workspace w7")));
    // The other workspace's pane was never closed or taken over.
    assert.ok(!fake.calls().some((call) => call[1] === "close"));
  } finally {
    fake.restore();
  }
});

test("a partial startup reports the failure and keeps the surfaces that did come up", async () => {
  const fake = installFakeHerdr({ failCreateFor: "tasks" });
  try {
    const result = await openWorkspace({ repoPath: "/repo", session: LIVE });
    const tasks = result.surfaces.find((surface) => surface.surface === "tasks");
    assert.equal(tasks?.action, "skipped");
    assert.match(tasks?.reason ?? "", /Could not create the tasks surface/);
    // The hint says exactly what to run instead.
    assert.match(tasks?.reason ?? "", /task watch/);

    assert.equal(result.surfaces.find((surface) => surface.surface === "code")?.action, "created");
    assert.equal(result.surfaces.find((surface) => surface.surface === "logs")?.action, "created");
    assert.equal(readPreferences().workspace.surfaces.tasks, undefined);
  } finally {
    fake.restore();
  }
});

test("a created pane inherits the caller's MABS state overrides", async () => {
  const fake = installFakeHerdr();
  try {
    // A new pane starts a fresh shell, so without this a surface would read a
    // different store than the operator is looking at.
    process.env.MABS_WORKTREE_ROOT = "/custom/worktrees";
    const args = inheritedEnvArgs();
    assert.ok(args.includes(`MABS_STATE_DIR=${process.env.MABS_STATE_DIR as string}`));
    assert.ok(args.includes("MABS_WORKTREE_ROOT=/custom/worktrees"));

    await openWorkspace({ repoPath: "/repo", session: LIVE });
    const create = fake.calls().find((call) => call[0] === "tab" && call[1] === "create");
    assert.ok(create?.includes("--env"), "no environment was passed to the new pane");
    assert.ok(create?.some((arg) => arg.startsWith("MABS_STATE_DIR=")));

    // Only MABS overrides are forwarded; the rest of the environment is not.
    const forwarded = (create ?? []).filter((arg) => arg.includes("=")).map((arg) => arg.split("=")[0]);
    for (const key of forwarded) assert.ok((INHERITED_ENV as readonly string[]).includes(key as string), `${key} should not be forwarded`);
    delete process.env.MABS_WORKTREE_ROOT;
  } finally {
    delete process.env.MABS_WORKTREE_ROOT;
    fake.restore();
  }
});

test("focus moves only when it is explicitly requested", async () => {
  const fake = installFakeHerdr();
  try {
    await openWorkspace({ repoPath: "/repo", session: LIVE, focus: "code" });
    const focusCalls = fake.calls().filter((call) => call[0] === "pane" && call[1] === "focus");
    assert.equal(focusCalls.length, 1);
    assert.ok(focusCalls[0]?.includes("--pane"));
  } finally {
    fake.restore();
  }
});

test("the split layout puts Code beside the Agent pane", async () => {
  const fake = installFakeHerdr();
  try {
    const result = await openWorkspace({ repoPath: "/repo", session: LIVE, layout: "split" });
    const split = fake.calls().find((call) => call[0] === "pane" && call[1] === "split");
    assert.ok(split, "no split was requested");
    assert.ok(split?.includes("--direction") && split?.includes("right"));
    assert.ok(split?.includes("--no-focus"));
    assert.equal(result.surfaces.find((surface) => surface.surface === "code")?.action, "created");
    // Tasks and Logs still get their own tabs.
    assert.equal(fake.calls().filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
  } finally {
    fake.restore();
  }
});

test("outside Herdr the plan degrades to CLI commands instead of failing", async () => {
  const fake = installFakeHerdr();
  try {
    const outside: HerdrSession = {
      available: true, version: "herdr 0.9.1", inSession: false,
      workspaceId: null, tabId: null, paneId: null,
      reason: "Not running inside a Herdr pane (HERDR_ENV is not 1), so no pane is created or controlled.",
    };
    const result = await openWorkspace({ repoPath: "/repo", session: outside });
    assert.equal(result.degraded, true);
    assert.ok(result.surfaces.every((surface) => surface.action === "degraded"));
    assert.match(result.surfaces.find((surface) => surface.surface === "tasks")?.reason ?? "", /task watch/);
    assert.match(result.surfaces.find((surface) => surface.surface === "logs")?.reason ?? "", /logs <task>/);
    // Nothing was created or controlled.
    assert.equal(fake.calls().length, 0);
  } finally {
    fake.restore();
  }
});

test("closing the workspace closes only owned panes and never the agent", async () => {
  const fake = installFakeHerdr();
  try {
    const opened = await openWorkspace({ repoPath: "/repo", session: LIVE });
    const owned = opened.surfaces.filter((surface) => surface.action === "created").map((surface) => surface.paneId);

    const closed = await closeWorkspace({ session: LIVE });
    assert.deepEqual(closed.closed.sort(), ["code", "logs", "tasks"]);
    assert.ok(closed.kept.some((entry) => entry.surface === "agent" && entry.reason.includes("your session")));
    assert.ok(closed.notes.some((note) => note.includes("Workers, tasks, evidence, and worktrees are untouched")));

    // The agent pane survives; the owned panes are gone.
    const panes = fake.panes();
    assert.ok(panes["w1:p1"], "the agent pane was closed");
    for (const paneId of owned) assert.equal(panes[paneId as string], undefined);

    // Ownership is forgotten, so a later open recreates rather than reusing.
    const preferences = readPreferences();
    assert.equal(preferences.workspace.surfaces.code, undefined);
  } finally {
    fake.restore();
  }
});

test("a pane that moved to another workspace is forgotten, not closed", async () => {
  const fake = installFakeHerdr();
  try {
    await openWorkspace({ repoPath: "/repo", session: LIVE });
    const codePane = readPreferences().workspace.surfaces.code?.paneId;
    assert.ok(codePane);

    const panes = fake.panes();
    panes[codePane] = { workspace_id: "w9", tab_id: "w9:t2" };
    fake.setPanes(panes);

    const closed = await closeWorkspace({ session: LIVE });
    assert.ok(!closed.closed.includes("code"));
    assert.ok(closed.kept.some((entry) => entry.surface === "code"));
    // The unrelated pane is still there.
    assert.ok(fake.panes()[codePane], "a pane in another workspace was closed");
    assert.equal(readPreferences().workspace.surfaces.code, undefined);
  } finally {
    fake.restore();
  }
});

test("workspace status reports ownership honestly", async () => {
  const fake = installFakeHerdr();
  try {
    await openWorkspace({ repoPath: "/repo", session: LIVE });
    const status = await workspaceStatus();
    // The status command runs its own session probe, which is not inside Herdr
    // under the test runner, so it reports that rather than guessing.
    assert.equal(status.workspaceId, "w1");
    assert.equal(status.repoPath, "/repo");
    assert.equal(status.layout, "tabs");
    assert.deepEqual(status.surfaces.map((surface) => surface.surface), [...SURFACES]);
    for (const surface of status.surfaces) {
      if (!status.session.inSession) assert.equal(surface.owned, false);
    }
  } finally {
    fake.restore();
  }
});
