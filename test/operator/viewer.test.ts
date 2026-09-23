import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readViewerState,
  requestViewer,
  resolveViewerProgram,
  serveViewer,
  stageContent,
} from "../../src/operator/viewer.ts";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A stand-in editor: records what it was asked to show, then waits to be stopped. */
function fakeViewer(root: string): { command: string; log: string } {
  const log = join(root, "opened.log");
  const command = join(root, "fake-viewer");
  writeFileSync(command, [
    "#!/usr/bin/env bash",
    `echo "$@" >> ${JSON.stringify(log)}`,
    "trap 'exit 0' TERM INT",
    "while true; do sleep 0.05; done",
  ].join("\n"));
  chmodSync(command, 0o755);
  return { command, log };
}

async function withViewer(fn: (context: {
  root: string;
  log: () => string[];
  stop: AbortController;
  events: { kind: string; detail: string }[];
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mabs-viewer-"));
  const previousState = process.env.MABS_STATE_DIR;
  const previousViewer = process.env.MABS_VIEWER_COMMAND;
  process.env.MABS_STATE_DIR = join(root, "state");
  const fake = fakeViewer(root);
  process.env.MABS_VIEWER_COMMAND = fake.command;

  const stop = new AbortController();
  const events: { kind: string; detail: string }[] = [];
  const loop = serveViewer({ surface: "code", pollMs: 25, signal: stop.signal, onEvent: (event) => events.push(event) });
  await wait(120);

  try {
    await fn({
      root,
      log: () => {
        try {
          return readFileSync(fake.log, "utf8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
      stop,
      events,
    });
  } finally {
    stop.abort();
    await loop.catch(() => undefined);
    if (previousState === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previousState;
    if (previousViewer === undefined) delete process.env.MABS_VIEWER_COMMAND;
    else process.env.MABS_VIEWER_COMMAND = previousViewer;
    rmSync(root, { recursive: true, force: true });
  }
}

test("the owned viewer is reused for repeated selections instead of starting one per file", async () => {
  await withViewer(async ({ root, log, events }) => {
    const first = join(root, "one.ts");
    const second = join(root, "two.ts");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");

    const state = readViewerState("code");
    assert.ok(state, "no viewer owns the code surface");
    assert.equal(state?.surface, "code");

    const a = requestViewer("code", {
      absolutePath: first, label: "task-a:one.ts", line: null, filetype: null,
      mode: "read-only", description: "task a",
    });
    assert.equal(a.delivered, true);
    assert.equal(a.viewerRunning, true);
    await wait(200);

    const b = requestViewer("code", {
      absolutePath: second, label: "task-a:two.ts", line: 4, filetype: null,
      mode: "read-only", description: "task a",
    });
    assert.equal(b.delivered, true);
    assert.equal(b.sequence, a.sequence + 1);
    await wait(250);

    const opened = log();
    assert.equal(opened.length, 2, `expected two selections, saw ${JSON.stringify(opened)}`);
    assert.ok(opened[0]?.includes("one.ts"));
    assert.ok(opened[1]?.includes("two.ts"));
    // The line number reached the viewer.
    assert.ok(opened[1]?.includes("4"));

    // One owned process served both; no second viewer was started.
    assert.equal(events.filter((event) => event.kind === "started").length, 1);
    assert.equal(events.filter((event) => event.kind === "open").length, 2);
  });
});

test("an editable buffer is never replaced; the next selection is queued with a reason", async () => {
  await withViewer(async ({ root, log }) => {
    const first = join(root, "editable.ts");
    const second = join(root, "other.ts");
    writeFileSync(first, "editable\n");
    writeFileSync(second, "other\n");

    requestViewer("code", {
      absolutePath: first, label: "task-a:editable.ts", line: null, filetype: null,
      mode: "edit", description: "task a",
    });
    await wait(200);
    assert.equal(readViewerState("code")?.mode, "edit");

    const queued = requestViewer("code", {
      absolutePath: second, label: "task-a:other.ts", line: null, filetype: null,
      mode: "read-only", description: "task a",
    });
    assert.equal(queued.delivered, false);
    assert.equal(queued.viewerRunning, true);
    assert.match(String(queued.reason), /queued and will open when that buffer is closed/);

    await wait(200);
    // The editable buffer was left alone.
    assert.equal(log().length, 1);
    assert.ok(log()[0]?.includes("editable.ts"));
  });
});

test("a selection with no viewer running reports how to start one", () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-viewer-none-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = join(root, "state");
  try {
    const dispatch = requestViewer("code", {
      absolutePath: join(root, "a.ts"), label: "task:a.ts", line: null, filetype: null,
      mode: "read-only", description: "task",
    });
    assert.equal(dispatch.delivered, false);
    assert.equal(dispatch.viewerRunning, false);
    assert.match(String(dispatch.reason), /viewer serve --surface=code/);
    // The request is still recorded, so starting a viewer picks it up.
    assert.equal(dispatch.sequence, 1);
  } finally {
    if (previous === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged revision content is written under the viewer's own directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-viewer-stage-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = join(root, "state");
  try {
    const staged = stageContent("code", "task-1-abc123-weird name\"/x.ts", "content\n");
    assert.ok(staged.startsWith(join(root, "state", "operator", "viewer", "code", "content")));
    // A path separator in the name cannot escape the content directory.
    assert.ok(!staged.includes('"'));
    assert.equal(readFileSync(staged, "utf8"), "content\n");
  } finally {
    if (previous === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the viewer program is chosen from what is installed, with read-only arguments", async () => {
  const previous = process.env.MABS_VIEWER_COMMAND;
  delete process.env.MABS_VIEWER_COMMAND;
  try {
    const program = await resolveViewerProgram("auto");
    assert.ok(["nvim", "vim", "less"].includes(program.command));

    const args = program.args("/tmp/a b.ts", 12, "diff", "read-only");
    // The path is its own argument, never interpolated into a command string.
    assert.ok(args.includes("/tmp/a b.ts"));
    assert.ok(args.some((arg) => arg.includes("12")));
    if (program.command !== "less") {
      assert.ok(args.includes("-R"), "the internal viewer opens read-only by default");
      assert.ok(args.includes("--"), "options are separated from the filename");
      const editable = program.args("/tmp/a.ts", null, null, "edit");
      assert.ok(!editable.includes("-R"), "an explicit edit request drops read-only");
    }
  } finally {
    if (previous !== undefined) process.env.MABS_VIEWER_COMMAND = previous;
  }
});

test("a second viewer refuses to take over a surface that is already owned", async () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-viewer-dup-"));
  const previousState = process.env.MABS_STATE_DIR;
  const previousViewer = process.env.MABS_VIEWER_COMMAND;
  process.env.MABS_STATE_DIR = join(root, "state");
  mkdirSync(join(root, "state"), { recursive: true });
  process.env.MABS_VIEWER_COMMAND = fakeViewer(root).command;

  const stop = new AbortController();
  const loop = serveViewer({ surface: "code", pollMs: 25, signal: stop.signal });
  await wait(120);
  try {
    await assert.rejects(
      () => serveViewer({ surface: "code", pollMs: 25 }),
      /already serving the code surface/,
    );
  } finally {
    stop.abort();
    await loop.catch(() => undefined);
    if (previousState === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previousState;
    if (previousViewer === undefined) delete process.env.MABS_VIEWER_COMMAND;
    else process.env.MABS_VIEWER_COMMAND = previousViewer;
    rmSync(root, { recursive: true, force: true });
  }

  // Stopping the loop releases the surface rather than leaving it owned.
  assert.equal(readViewerState("code"), null);
});
