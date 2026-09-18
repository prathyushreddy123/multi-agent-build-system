import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { exec } from "../core/exec.ts";
import { worktreeRoot } from "../core/paths.ts";
import type { Project, Task } from "../store/records.ts";

export interface Workspace {
  path: string;
  branch: string;
  baseRevision: string;
}

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await exec("git", args, { cwd, timeoutMs });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function branchName(task: Task): string {
  return `mabs/${task.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

/** Create or reconcile the isolated worktree assigned to one coding task. */
export async function prepareWorkspace(project: Project, task: Task): Promise<Workspace> {
  const repoPath = resolve(project.repoPath);
  await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  const baseRevision = task.baseRevision ?? (await git(repoPath, ["rev-parse", project.baseBranch]));
  const branch = task.branch ?? branchName(task);
  const path = task.worktreePath ?? join(worktreeRoot(), project.id, task.id);

  if (existsSync(path)) {
    const actualRepo = await git(path, ["rev-parse", "--show-toplevel"]);
    const actualBranch = await git(path, ["branch", "--show-current"]);
    if (resolve(actualRepo) !== resolve(path)) throw new Error(`Workspace ${path} is not a worktree root`);
    if (actualBranch !== branch) throw new Error(`Workspace ${path} is on ${actualBranch}, expected ${branch}`);
    return { path, branch, baseRevision };
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const branchExists = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath });
  if (branchExists.code === 0) await git(repoPath, ["worktree", "add", path, branch]);
  else await git(repoPath, ["worktree", "add", "-b", branch, path, baseRevision]);
  return { path, branch, baseRevision };
}

export async function workspaceRevision(path: string): Promise<string> {
  return git(path, ["rev-parse", "HEAD"]);
}

export async function workspaceChangedFiles(path: string, baseRevision: string): Promise<string[]> {
  const committed = await git(path, ["diff", "--name-only", `${baseRevision}...HEAD`]);
  const status = await git(path, ["status", "--porcelain"]);
  const uncommitted = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((name) => name.includes(" -> ") ? (name.split(" -> ").at(-1) as string) : name);
  return [...new Set([...committed.split("\n").filter(Boolean), ...uncommitted])].sort();
}

/**
 * Bind gate evidence to a revision. If the worker left changes uncommitted,
 * the controller creates the allowed local commit in its isolated branch.
 */
export async function finalizeWorkspace(path: string, task: Task): Promise<{ revision: string; changedFiles: string[] }> {
  const status = await git(path, ["status", "--porcelain"]);
  if (status !== "") {
    await git(path, ["add", "-A"]);
    await git(path, [
      "-c", "user.name=MABS Controller",
      "-c", "user.email=mabs@local",
      "commit", "-m", `mabs: ${task.title}`,
    ]);
  }
  const revision = await workspaceRevision(path);
  return { revision, changedFiles: await workspaceChangedFiles(path, task.baseRevision ?? revision) };
}
