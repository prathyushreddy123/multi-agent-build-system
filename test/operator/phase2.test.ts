import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exec } from "../../src/core/exec.ts";
import { buildTaskContext, describeContext, resolveTaskContext } from "../../src/operator/context.ts";
import { diffFile, openFile, taskChanges, taskFiles } from "../../src/operator/code.ts";
import {
  FileResolutionError,
  listAllFiles,
  listChangedFiles,
  resolveFile,
  resolveWorktreePath,
} from "../../src/operator/files.ts";
import { LinkError, commandFor, encodeOpenTarget, osc8, parseOpenTarget } from "../../src/operator/links.ts";
import { externalEditorPlan } from "../../src/operator/viewer.ts";
import { openRecords, type Records } from "../../src/store/records.ts";

// A file name for every hostile case the plan calls out.
const AWKWARD = [
  "plain.ts",
  "with space.ts",
  "unicode-\u00e9\u4e2d\u6587.ts",
  'quote"name.ts',
  "-leading-hyphen.ts",
  "nested/deep/path.ts",
];

interface Fixture {
  root: string;
  repo: string;
  records: Records;
  projectId: string;
  taskA: string;
  taskB: string;
  worktreeA: string;
  worktreeB: string;
  close: () => void;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await exec("git", args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "mabs-op2-"));
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_DB_PATH = join(root, "state", "mabs.sqlite");

  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "mabs@local"]);
  await git(repo, ["config", "user.name", "MABS Test"]);
  for (const name of AWKWARD) {
    const path = join(repo, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export const source = 'base';\n");
  }
  writeFileSync(join(repo, "renamed-away.ts"), "export const moved = true;\n");
  writeFileSync(join(repo, "removed.ts"), "export const removed = true;\n");
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const head = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
  const baseRevision = head.stdout.trim();

  const records = openRecords();
  const project = records.createProject({ name: "fixture", repoPath: repo, baseBranch: "main" });

  const make = async (title: string, marker: string) => {
    const task = records.createTask({ projectId: project.id, title, objective: `Work on ${marker}` });
    const worktree = join(root, "worktrees", task.id);
    await git(repo, ["worktree", "add", "-q", "-b", `mabs/${task.id}`, worktree, baseRevision]);
    for (const name of AWKWARD) writeFileSync(join(worktree, name), `export const source = '${marker}';\n`);
    return { task, worktree };
  };

  const a = await make("Task A", "task-a");
  const b = await make("Task B", "task-b");

  // Task A commits a rename, a deletion, and an edit, then leaves uncommitted work.
  await git(a.worktree, ["mv", "renamed-away.ts", "renamed-here.ts"]);
  await git(a.worktree, ["rm", "-q", "removed.ts"]);
  await git(a.worktree, ["add", "-A"]);
  await git(a.worktree, ["-c", "user.email=mabs@local", "-c", "user.name=MABS Test", "commit", "-q", "-m", "task a work"]);
  const aHead = await exec("git", ["rev-parse", "HEAD"], { cwd: a.worktree });
  writeFileSync(join(a.worktree, "staged-only.ts"), "export const staged = true;\n");
  await git(a.worktree, ["add", "staged-only.ts"]);
  writeFileSync(join(a.worktree, "plain.ts"), "export const source = 'task-a-unstaged';\n");
  writeFileSync(join(a.worktree, "untracked.ts"), "export const untracked = true;\n");

  records.updateTaskFields(a.task.id, {
    worktree_path: a.worktree, branch: `mabs/${a.task.id}`,
    base_revision: baseRevision, result_revision: aHead.stdout.trim(),
  });
  records.updateTaskFields(b.task.id, {
    worktree_path: b.worktree, branch: `mabs/${b.task.id}`, base_revision: baseRevision,
  });

  return {
    root, repo, records, projectId: project.id,
    taskA: a.task.id, taskB: b.task.id, worktreeA: a.worktree, worktreeB: b.worktree,
    close: () => {
      records.store.close();
      delete process.env.MABS_DB_PATH;
      delete process.env.MABS_STATE_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the same relative path opens each task's own version", async () => {
  const fixture = await makeFixture();
  try {
    for (const name of AWKWARD) {
      const a = await openFile(fixture.records, name, { task: fixture.taskA });
      const b = await openFile(fixture.records, name, { task: fixture.taskB });
      assert.equal(a.kind, "opened", `${name}: ${JSON.stringify(a)}`);
      assert.equal(b.kind, "opened", `${name}: ${JSON.stringify(b)}`);
      if (a.kind !== "opened" || b.kind !== "opened") return;
      assert.match(String(a.content.text), /task-a/, `${name} did not resolve to task A`);
      assert.match(String(b.content.text), /task-b/, `${name} did not resolve to task B`);
      // Neither ever shows the base checkout.
      assert.doesNotMatch(String(a.content.text), /'base'/);
      assert.equal(a.relativePath, name.replaceAll("\\", "/"));
    }
  } finally {
    fixture.close();
  }
});

test("a line number and a link round-trip through the shared resolver", async () => {
  const fixture = await makeFixture();
  try {
    const opened = await openFile(fixture.records, "plain.ts", { task: fixture.taskB, line: 1 });
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    assert.equal(opened.line, 1);

    const target = parseOpenTarget(opened.link);
    assert.equal(target.taskId, fixture.taskB);
    assert.equal(target.path, "plain.ts");
    assert.equal(target.line, 1);

    // The link and its printed command select the same thing.
    assert.match(opened.command, new RegExp(`open ${fixture.taskB} plain\\.ts --line=1`));
    // OSC-8 is decoration; the same target is always reachable by command.
    assert.ok(opened.hyperlink.includes(opened.link));
  } finally {
    fixture.close();
  }
});

test("links with an unexpected scheme or a bad line are refused", () => {
  assert.throws(() => parseOpenTarget("https://example.com/open/p/t?path=a.ts"), LinkError);
  assert.throws(() => parseOpenTarget("file:///etc/passwd"), LinkError);
  assert.throws(() => parseOpenTarget("mabs://exec/p/t?path=a.ts"), LinkError);
  assert.throws(() => parseOpenTarget("mabs://open/p/t?path=a.ts&line=0"), LinkError);
  assert.throws(() => parseOpenTarget("mabs://open/p/t"), LinkError);

  // An awkward path survives encoding intact.
  const encoded = encodeOpenTarget({
    action: "open", projectId: "p 1", taskId: "t/2", attemptId: null,
    path: 'weird "name" -x.ts', line: 12, revision: null,
  });
  const parsed = parseOpenTarget(encoded);
  assert.equal(parsed.path, 'weird "name" -x.ts');
  assert.equal(parsed.projectId, "p 1");
  assert.equal(parsed.taskId, "t/2");
  assert.match(commandFor(parsed), /--line=12/);
  // A label cannot break out of the escape sequence: the only escape characters
  // in the result are the two the hyperlink itself needs, so the injected text
  // is inert.
  const spoofed = osc8("evil\u001b]8;;http://x\u001b\\\\", "mabs://open/p/t?path=a.ts");
  assert.equal(spoofed.split("\u001b").length - 1, 4);
  assert.ok(spoofed.includes("mabs://open/p/t?path=a.ts"));
});

test("traversal, absolute escapes, schemes, and escaping symlinks are rejected", async () => {
  const fixture = await makeFixture();
  try {
    const outside = join(fixture.root, "outside.ts");
    writeFileSync(outside, "export const outside = true;\n");
    symlinkSync(outside, join(fixture.worktreeA, "escape.ts"));

    for (const bad of ["../../repo/plain.ts", "/etc/passwd", "https://example.com/a.ts", "escape.ts"]) {
      await assert.rejects(
        async () => {
          const result = await openFile(fixture.records, bad, { task: fixture.taskA });
          throw new Error(`expected rejection, got ${JSON.stringify(result)}`);
        },
        (error: unknown) => error instanceof FileResolutionError,
        `${bad} was not rejected`,
      );
    }

    // A symlink that stays inside the worktree is fine.
    symlinkSync(join(fixture.worktreeA, "plain.ts"), join(fixture.worktreeA, "inside.ts"));
    const inside = await openFile(fixture.records, "inside.ts", { task: fixture.taskA });
    assert.equal(inside.kind, "opened");
  } finally {
    fixture.close();
  }
});

test("changed files distinguish categories and count each path once", async () => {
  const fixture = await makeFixture();
  try {
    const result = await taskChanges(fixture.records, { task: fixture.taskA });
    assert.equal(result.kind, "changes");
    if (result.kind !== "changes") return;

    const paths = result.files.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length, "a path was listed more than once");

    const byPath = new Map(result.files.map((file) => [file.path, file]));

    const renamed = byPath.get("renamed-here.ts");
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.oldPath, "renamed-away.ts");
    assert.deepEqual(renamed?.categories, ["committed"]);

    const removed = byPath.get("removed.ts");
    assert.equal(removed?.status, "deleted");
    assert.equal(removed?.present, false);

    assert.deepEqual(byPath.get("staged-only.ts")?.categories, ["staged"]);
    assert.deepEqual(byPath.get("untracked.ts")?.categories, ["untracked"]);

    // plain.ts was edited in the worktree before the commit and again after it,
    // so it belongs to two categories and is still one entry.
    const plain = byPath.get("plain.ts");
    assert.ok(plain?.categories.includes("unstaged"));
    assert.equal(result.counts.total, result.files.length);
  } finally {
    fixture.close();
  }
});

test("browsing lists every file in the selected worktree, including untracked ones", async () => {
  const fixture = await makeFixture();
  try {
    const result = await taskFiles(fixture.records, { task: fixture.taskA });
    assert.equal(result.kind, "files");
    if (result.kind !== "files") return;
    for (const name of AWKWARD) assert.ok(result.files.includes(name), `${name} is missing from the browser`);
    assert.ok(result.files.includes("untracked.ts"));
    assert.ok(result.files.includes("staged-only.ts"));
    assert.ok(!result.files.includes("removed.ts"));

    const filtered = await taskFiles(fixture.records, { task: fixture.taskA, filter: "nested" });
    assert.equal(filtered.kind, "files");
    if (filtered.kind !== "files") return;
    assert.deepEqual(filtered.files, ["nested/deep/path.ts"]);
  } finally {
    fixture.close();
  }
});

test("a removed worktree falls back to the recorded revision, never to the base checkout", async () => {
  const fixture = await makeFixture();
  try {
    rmSync(fixture.worktreeA, { recursive: true, force: true });

    const resolution = resolveTaskContext(fixture.records, { task: fixture.taskA });
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind !== "resolved") return;
    assert.equal(resolution.context.view, "revision");
    assert.match(String(resolution.context.viewReason), /no longer present/);
    assert.match(describeContext(resolution.context), /revision/);

    const opened = await openFile(fixture.records, "plain.ts", { task: fixture.taskA });
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    assert.equal(opened.content.source, "revision");
    // The recorded revision holds task A's committed content, not the base's.
    assert.match(String(opened.content.text), /task-a/);

    // A path absent from that revision says so rather than showing the base copy.
    const missing = await openFile(fixture.records, "removed.ts", { task: fixture.taskA });
    assert.equal(missing.kind, "opened");
    if (missing.kind !== "opened") return;
    assert.equal(missing.content.text, null);
    assert.match(String(missing.content.unavailableReason), /not available at revision/);
    assert.match(String(missing.content.unavailableReason), /not the base checkout/);
  } finally {
    fixture.close();
  }
});

test("a task with neither worktree nor revision reports unavailable content", async () => {
  const fixture = await makeFixture();
  try {
    rmSync(fixture.worktreeB, { recursive: true, force: true });
    const changes = await taskChanges(fixture.records, { task: fixture.taskB });
    assert.equal(changes.kind, "not-found");
    if (changes.kind !== "not-found") return;
    assert.match(changes.reason, /no longer present and no result revision/);
  } finally {
    fixture.close();
  }
});

test("more than one plausible task requires an explicit selection", async () => {
  const fixture = await makeFixture();
  try {
    const result = await taskChanges(fixture.records, {});
    assert.equal(result.kind, "selection-needed");
    if (result.kind !== "selection-needed") return;
    assert.equal(result.candidates.length, 2);
    assert.match(result.reason, /Select one explicitly/);
    for (const candidate of result.candidates) {
      assert.ok(candidate.taskId);
      assert.ok(candidate.title);
      assert.equal(candidate.projectName, "fixture");
    }

    // A unique title fragment is enough to select one.
    const chosen = await taskChanges(fixture.records, { task: "Task A" });
    assert.equal(chosen.kind, "changes");
  } finally {
    fixture.close();
  }
});

test("diffs cover renames, deletions, and binary files", async () => {
  const fixture = await makeFixture();
  try {
    const renamed = await diffFile(fixture.records, "renamed-here.ts", { task: fixture.taskA });
    assert.equal(renamed.kind, "diff");
    if (renamed.kind !== "diff") return;
    assert.match(String(renamed.diff.text), /rename from renamed-away\.ts/);
    assert.equal(renamed.diff.oldPath, "renamed-away.ts");

    const deleted = await diffFile(fixture.records, "removed.ts", { task: fixture.taskA });
    assert.equal(deleted.kind, "diff");
    if (deleted.kind !== "diff") return;
    assert.match(String(deleted.diff.text), /deleted file/);

    const binary = await openFile(fixture.records, "logo.bin", { task: fixture.taskA });
    assert.equal(binary.kind, "opened");
    if (binary.kind !== "opened") return;
    assert.equal(binary.content.binary, true);
    assert.equal(binary.content.text, null);
    assert.match(String(binary.content.unavailableReason), /binary file/);
  } finally {
    fixture.close();
  }
});

test("a file changing during inspection does not change which file was selected", async () => {
  const fixture = await makeFixture();
  try {
    const first = await openFile(fixture.records, "plain.ts", { task: fixture.taskA });
    writeFileSync(join(fixture.worktreeA, "plain.ts"), "export const source = 'task-a-changed';\n");
    const second = await openFile(fixture.records, "plain.ts", { task: fixture.taskA });

    assert.equal(first.kind, "opened");
    assert.equal(second.kind, "opened");
    if (first.kind !== "opened" || second.kind !== "opened") return;
    // Same identity, honestly different content.
    assert.equal(first.relativePath, second.relativePath);
    assert.equal(first.link, second.link);
    assert.notEqual(first.content.text, second.content.text);
    assert.match(String(second.content.text), /task-a-changed/);
  } finally {
    fixture.close();
  }
});

test("path resolution is independent of the store", () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-op2-path-"));
  try {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c.ts"), "x");
    assert.equal(resolveWorktreePath(root, "a/b/c.ts").relativePath, "a/b/c.ts");
    assert.equal(resolveWorktreePath(root, "./a/b/c.ts").relativePath, "a/b/c.ts");
    assert.equal(resolveWorktreePath(root, join(root, "a", "b", "c.ts")).relativePath, "a/b/c.ts");
    assert.throws(() => resolveWorktreePath(root, "../escape.ts"), FileResolutionError);
    assert.throws(() => resolveWorktreePath(root, ""), FileResolutionError);
    assert.throws(() => resolveWorktreePath(root, "ssh://host/a.ts"), FileResolutionError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an external editor is described as a separate window, with WSL addressing", () => {
  const wsl = externalEditorPlan("cursor", "/home/u/repo/a.ts", 12, { windowsHosted: true, wslDistro: "Ubuntu-24.04" });
  assert.deepEqual(wsl.args, ["--remote", "wsl+Ubuntu-24.04", "--goto", "/home/u/repo/a.ts:12"]);
  assert.match(wsl.note, /not embedded in the terminal/);

  const native = externalEditorPlan("code", "/home/u/repo/a.ts", null, { windowsHosted: false, wslDistro: null });
  assert.deepEqual(native.args, ["--goto", "/home/u/repo/a.ts"]);

  assert.throws(
    () => externalEditorPlan("cursor", "/a.ts", null, { windowsHosted: true, wslDistro: null }),
    /cannot address this filesystem/,
  );
});

test("listings work directly against a context without the surface layer", async () => {
  const fixture = await makeFixture();
  try {
    const task = fixture.records.getTask(fixture.taskB);
    assert.ok(task);
    const context = buildTaskContext(fixture.records, task, null);
    assert.equal(context.view, "live");
    const files = await listAllFiles(context);
    assert.ok(files.includes("plain.ts"));
    const changes = await listChangedFiles(context);
    // Task B edited the tracked files but never committed or staged them.
    assert.ok(changes.every((file) => file.categories.includes("unstaged")));
    const resolved = resolveFile(context, "plain.ts", { line: 3 });
    assert.equal(resolved.line, 3);
    assert.equal(resolved.revision, null);
  } finally {
    fixture.close();
  }
});
