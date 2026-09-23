import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneWorktrees, RETENTION_POLICY, worktreeCandidates } from "../src/maintenance/retention.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";
import { prepareWorkspace } from "../src/workspace/git.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with one commit on main, ready to grow worktrees. */
function repo(root: string): string {
  const path = join(root, "repo");
  execFileSync("mkdir", ["-p", path]);
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "test@local");
  git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "base\n");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "base");
  return path;
}

interface Harness {
  root: string;
  repoPath: string;
  records: Records;
}

function harness(t: { after(fn: () => void): void }): Harness {
  const root = mkdtempSync(join(tmpdir(), "mabs-worktree-"));
  const previousState = process.env.MABS_STATE_DIR;
  const previousWorktrees = process.env.MABS_WORKTREE_ROOT;
  process.env.MABS_STATE_DIR = root;
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(join(root, "mabs.sqlite")));
  t.after(() => {
    try { records.store.close(); } catch { /* already closed */ }
    if (previousState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previousState;
    if (previousWorktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previousWorktrees;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repoPath: repo(root), records };
}

/** Drive a task to DONE and give it a worktree, as the controller would. */
async function finishedTask(h: Harness, title: string): Promise<{ id: string; path: string }> {
  const project = h.records.findProjectByName("wt") ?? h.records.createProject({ name: "wt", repoPath: h.repoPath, baseBranch: "main" });
  const task = h.records.createTask({ projectId: project.id, title, objective: title });
  h.records.transition(task.id, "READY");
  h.records.claimTask(task.id, `launch-${title}`);
  h.records.transition(task.id, "RUNNING");
  const workspace = await prepareWorkspace(project, h.records.getTask(task.id)!);
  h.records.store.run(
    "UPDATE tasks SET worktree_path = ?, branch = ?, base_revision = ? WHERE id = ?",
    workspace.path, workspace.branch, workspace.baseRevision, task.id,
  );
  h.records.transition(task.id, "CHECKING");
  h.records.transition(task.id, "DONE", { claimed_by: null, claimed_at: null });
  return { id: task.id, path: workspace.path };
}

/** Backdate the task so it falls outside the retention window. */
function age(h: Harness, taskId: string, days: number): void {
  h.records.store.run(
    "UPDATE tasks SET updated_at = ? WHERE id = ?",
    new Date(Date.now() - days * 86_400_000).toISOString(), taskId,
  );
}

test("a recent worktree is never a pruning candidate", async (t) => {
  const h = harness(t);
  const task = await finishedTask(h, "recent");

  assert.deepEqual(await worktreeCandidates(h.records), []);
  assert.equal(existsSync(task.path), true);
});

test("an unmerged worktree with no recorded result is refused, not removed", async (t) => {
  const h = harness(t);
  const task = await finishedTask(h, "unmerged");
  // Commit inside the worktree so the branch actually diverges from main.
  // Without a commit the branch is an ancestor of base and has nothing to lose.
  writeFileSync(join(task.path, "work.txt"), "only copy\n");
  git(task.path, "add", "-A");
  git(task.path, "commit", "-qm", "unmerged work");
  age(h, task.id, RETENTION_POLICY.completedWorktreeDays + 1);

  const [candidate] = await worktreeCandidates(h.records);
  assert.equal(candidate?.refusal, "No result revision is recorded and the branch is not merged into the base branch.");

  await pruneWorktrees(h.records, { apply: true });
  assert.equal(existsSync(task.path), true, "work that exists nowhere else must survive");
});

test("a branch already merged into base is reclaimable without a result revision", async (t) => {
  const h = harness(t);
  const task = await finishedTask(h, "merged");
  writeFileSync(join(task.path, "work.txt"), "shipped\n");
  git(task.path, "add", "-A");
  git(task.path, "commit", "-qm", "work");
  const branch = h.records.getTask(task.id)?.branch as string;
  git(h.repoPath, "merge", "-q", "--no-ff", "-m", "merge", branch);
  age(h, task.id, RETENTION_POLICY.completedWorktreeDays + 1);

  const [candidate] = await worktreeCandidates(h.records);
  assert.equal(candidate?.refusal, null, "merged work is safe to reclaim");

  await pruneWorktrees(h.records, { apply: true });
  assert.equal(existsSync(task.path), false);
});

test("uncommitted changes refuse removal even when the work is merged", async (t) => {
  const h = harness(t);
  const task = await finishedTask(h, "dirty");
  h.records.store.run("UPDATE tasks SET result_revision = ? WHERE id = ?", "deadbeef", task.id);
  age(h, task.id, RETENTION_POLICY.completedWorktreeDays + 1);
  writeFileSync(join(task.path, "scratch.txt"), "unsaved\n");

  const [candidate] = await worktreeCandidates(h.records);
  assert.equal(candidate?.refusal, "The worktree has uncommitted changes that exist nowhere else.");

  await pruneWorktrees(h.records, { apply: true });
  assert.equal(existsSync(task.path), true);
});

test("a clean worktree with a recorded result is removed but keeps its branch", async (t) => {
  const h = harness(t);
  const task = await finishedTask(h, "reclaimable");
  h.records.store.run("UPDATE tasks SET result_revision = ? WHERE id = ?", "deadbeef", task.id);
  age(h, task.id, RETENTION_POLICY.completedWorktreeDays + 1);
  const branch = h.records.getTask(task.id)?.branch as string;

  // Dry run must not touch anything.
  const preview = await pruneWorktrees(h.records);
  assert.equal(preview.length, 1);
  assert.equal(preview[0]?.refusal, null);
  assert.equal(existsSync(task.path), true, "preview must not remove anything");

  await pruneWorktrees(h.records, { apply: true });
  assert.equal(existsSync(task.path), false, "the directory is the reclaimable part");

  // The branch is the only guarantee the commits stay reachable.
  const branches = execFileSync("git", ["branch", "--list", branch], { cwd: h.repoPath, encoding: "utf8" });
  assert.match(branches, new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // The stale path must not be left behind for the Code surface to resolve.
  assert.equal(h.records.getTask(task.id)?.worktreePath, null);
  assert.equal(
    h.records.listEvents(task.id).some((event) => event.kind === "worktree.pruned"),
    true,
    "removal must leave evidence",
  );
});

test("a worktree belonging to an in-flight task is never considered", async (t) => {
  const h = harness(t);
  const project = h.records.createProject({ name: "wt", repoPath: h.repoPath, baseBranch: "main" });
  const task = h.records.createTask({ projectId: project.id, title: "busy", objective: "busy" });
  h.records.transition(task.id, "READY");
  h.records.claimTask(task.id, "launch-busy");
  h.records.transition(task.id, "RUNNING");
  const workspace = await prepareWorkspace(project, h.records.getTask(task.id)!);
  h.records.store.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", workspace.path, workspace.branch, task.id);
  age(h, task.id, 365);

  assert.deepEqual(await worktreeCandidates(h.records), []);
  assert.equal(existsSync(workspace.path), true);
});
