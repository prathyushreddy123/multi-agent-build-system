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

async function git(cwd: string, args: string[], timeoutMs = 120_000, preserveLeadingWhitespace = false): Promise<string> {
  const result = await exec("git", args, { cwd, timeoutMs });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
  return preserveLeadingWhitespace ? result.stdout.trimEnd() : result.stdout.trim();
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

/** Whether a worktree still holds changes that exist nowhere else. */
export async function workspaceIsDirty(path: string): Promise<boolean> {
  return (await git(path, ["status", "--porcelain"], 60_000, true)) !== "";
}

/** Whether every commit on `branch` is already reachable from `baseBranch`. */
export async function branchIsMerged(repoPath: string, branch: string, baseBranch: string): Promise<boolean> {
  const merged = await exec("git", ["merge-base", "--is-ancestor", branch, baseBranch], { cwd: repoPath, timeoutMs: 30_000 });
  return merged.code === 0;
}

/**
 * Remove a worktree directory, leaving its branch in place.
 *
 * The directory holds effectively all of the disk cost; the branch is a ref
 * costing nothing, and until the work is merged that ref is the only thing
 * keeping the commits reachable. Separating the two means reclaiming space
 * cannot destroy work. Deleting the branch is a separate, explicit decision.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (options.force) args.push("--force");
  await git(repoPath, args);
  // Drops the administrative files git keeps for worktrees that are gone.
  await git(repoPath, ["worktree", "prune"]);
}

/** Materialize completed prerequisite revisions into a downstream task branch. */
export async function integrateDependencyRevisions(path: string, revisions: string[]): Promise<string> {
  for (const revision of revisions) {
    const present = await exec("git", ["merge-base", "--is-ancestor", revision, "HEAD"], { cwd: path, timeoutMs: 30_000 });
    if (present.code === 0) continue;

    // A reviewed task can contain an initial controller commit plus one or more
    // repair commits. Replaying only resultRevision loses its parents and can
    // conflict even on an otherwise empty downstream branch. Apply every
    // dependency commit not already reachable from this workspace, oldest first.
    const missing = await git(path, ["rev-list", "--reverse", "--topo-order", revision, "--not", "HEAD"]);
    const commits = missing.split("\n").filter(Boolean);
    if (commits.length === 0) throw new Error(`Dependency revision ${revision} is not reachable and has no integrable commits.`);
    for (const commit of commits) {
      const cherryPick = await exec("git", [
        "-c", "user.name=MABS Controller",
        "-c", "user.email=mabs@local",
        "cherry-pick", commit,
      ], { cwd: path, timeoutMs: 120_000 });
      if (cherryPick.code !== 0) {
        const output = cherryPick.stderr || cherryPick.stdout;
        // A prior integration of this same dependency can already be present under a
        // different commit hash (cherry-pick never reuses the source hash), so a later
        // retry re-integrating the same dependency finds an empty patch here rather than
        // a real conflict. Skip the now-redundant commit instead of treating already-
        // integrated content as a failure; any other cherry-pick failure still aborts.
        if (/previous cherry-pick is now empty/i.test(output) || /nothing to commit/i.test(output)) {
          const skip = await exec("git", ["cherry-pick", "--skip"], { cwd: path, timeoutMs: 30_000 });
          if (skip.code !== 0) {
            throw new Error(`Could not skip the already-integrated dependency commit ${commit}: ${(skip.stderr || skip.stdout).trim()}`);
          }
          continue;
        }
        await exec("git", ["cherry-pick", "--abort"], { cwd: path, timeoutMs: 30_000 });
        throw new Error(
          `Could not integrate dependency revision ${revision} at commit ${commit}: ` + output.trim(),
        );
      }
    }
  }
  return workspaceRevision(path);
}

export async function workspaceDiff(path: string, baseRevision: string, revision = "HEAD"): Promise<string> {
  return await git(path, ["diff", "--no-ext-diff", "--stat", baseRevision, revision]) + "\n\n" +
    await git(path, ["diff", "--no-ext-diff", baseRevision, revision], 120_000);
}

export async function workspaceChangedFiles(path: string, baseRevision: string): Promise<string[]> {
  const committed = await git(path, ["diff", "--name-only", `${baseRevision}...HEAD`]);
  // --untracked-files=all expands a brand-new directory into its individual files.
  // Without it, git collapses e.g. "plugins/herdr/x" into a single "plugins/" line,
  // which then fails an allowed-scope prefix check even when every actual file is in scope.
  const status = await git(path, ["status", "--porcelain", "--untracked-files=all"], 120_000, true);
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
  const baseRevision = task.baseRevision ?? await workspaceRevision(path);
  const changedBeforeCommit = await workspaceChangedFiles(path, baseRevision);
  if (task.allowedScope.length > 0) {
    const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    const scopes = task.allowedScope.map(normalize);
    const outsideScope = changedBeforeCommit.filter((file) => {
      const normalized = normalize(file);
      return !scopes.some((scope) => normalized === scope || normalized.startsWith(`${scope}/`));
    });
    if (outsideScope.length > 0) {
      throw new Error(`Worker changed files outside the allowed scope: ${outsideScope.join(", ")}`);
    }
  }
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
  return { revision, changedFiles: await workspaceChangedFiles(path, baseRevision) };
}
