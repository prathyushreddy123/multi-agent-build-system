import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Project, Task } from "../src/store/records.ts";
import { integrateDependencyRevisions, prepareWorkspace, removeWorktree, workspaceChangedFiles } from "../src/workspace/git.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("workspaceChangedFiles expands a new untracked directory into its individual files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mabs-workspace-git-"));
  writeFileSync(join(repo, "existing.txt"), "initial\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
  const baseRevision = git(repo, "rev-parse", "HEAD");

  mkdirSync(join(repo, "plugins", "herdr"), { recursive: true });
  writeFileSync(join(repo, "plugins", "herdr", "README.md"), "docs\n");
  writeFileSync(join(repo, "plugins", "herdr", "config.example.toml"), "id = \"example\"\n");

  const changed = await workspaceChangedFiles(repo, baseRevision);

  // A collapsed "plugins/" entry would falsely fail an allowed-scope check for
  // "plugins/herdr/"; the individual files must be listed instead.
  assert.ok(!changed.includes("plugins/"), `expected no collapsed directory entry, got: ${changed.join(", ")}`);
  assert.ok(changed.includes("plugins/herdr/README.md"), `expected individual file, got: ${changed.join(", ")}`);
  assert.ok(changed.includes("plugins/herdr/config.example.toml"), `expected individual file, got: ${changed.join(", ")}`);
});

test("prepareWorkspace requests dependency integration only for a newly created task branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-workspace-prepare-"));
  const repo = join(root, "repo");
  const worktree = join(root, "task-worktree");
  mkdirSync(repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");

  const project = { id: "prj_prepare", repoPath: repo, baseBranch: "main" } as Project;
  const firstTask = { id: "tsk_prepare", worktreePath: worktree, branch: null, baseRevision: null } as Task;
  const first = await prepareWorkspace(project, firstTask);
  assert.equal(first.needsDependencyIntegration, true, "a new task branch must receive its dependencies");

  const resumedTask = {
    ...firstTask,
    worktreePath: first.path,
    branch: first.branch,
    baseRevision: first.baseRevision,
  } as Task;
  const reused = await prepareWorkspace(project, resumedTask);
  assert.equal(reused.needsDependencyIntegration, false, "redispatching an existing worktree must not replay dependencies");

  await removeWorktree(repo, first.path);
  const recreated = await prepareWorkspace(project, resumedTask);
  assert.equal(recreated.needsDependencyIntegration, false, "recreating a retained task branch must not replay dependencies");
});

test("integrateDependencyRevisions is idempotent when a dependency was already integrated under a different cherry-pick hash", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mabs-workspace-git-deps-"));
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");

  // Simulate task 1's finished branch: one commit with its own result revision.
  git(repo, "checkout", "-q", "-b", "task-1");
  writeFileSync(join(repo, "dependency.txt"), "from task 1\n");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "task 1 result");
  const dependencyRevision = git(repo, "rev-parse", "HEAD");

  // Task 2's branch starts from main, independent of task 1's branch.
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "task-2");

  // First dispatch: integrates cleanly, producing a new cherry-picked commit hash.
  const firstIntegration = await integrateDependencyRevisions(repo, [dependencyRevision]);
  assert.notEqual(firstIntegration, dependencyRevision, "cherry-pick should produce a new commit hash, not reuse the source hash");

  // A retry re-integrates the same original dependency revision, as the controller
  // does on every dispatch. The exact source hash is still not an ancestor of task-2's
  // branch (only its cherry-picked equivalent is), so this must not fail.
  const secondIntegration = await integrateDependencyRevisions(repo, [dependencyRevision]);
  assert.equal(secondIntegration, firstIntegration, "re-integrating an already-applied dependency must be a no-op");

  const status = git(repo, "status", "--porcelain");
  assert.equal(status, "", "no cherry-pick sequencer state or stray changes should remain");
});
