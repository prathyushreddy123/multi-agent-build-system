import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backup } from "node:sqlite";

import { stateDir } from "../core/paths.ts";
import type { Records, Task } from "../store/records.ts";
import { branchIsMerged, removeWorktree, workspaceIsDirty } from "../workspace/git.ts";

export const RETENTION_POLICY = {
  completedArtifactDays: 30,
  failedArtifactDays: 90,
  backupCopies: 14,
  databaseRecords: "indefinite",
  activeAndBlockedArtifacts: "indefinite",
  /**
   * Worktree directories are reclaimed on the same schedule as the evidence
   * for the same task. Generous on purpose: the Code surface reads these
   * directories, so pruning one costs the ability to browse or diff that task.
   */
  completedWorktreeDays: 30,
  failedWorktreeDays: 90,
  /** Branches are never removed here. They can be the only copy of the work. */
  worktreeBranches: "never-removed",
} as const;

export interface PruneCandidate {
  taskId: string;
  attemptId: string;
  path: string;
  ageDays: number;
  retentionDays: number;
}

function ageDays(value: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(value)) / 86_400_000);
}

function retentionDays(task: Task): number | null {
  if (task.state === "DONE") return RETENTION_POLICY.completedArtifactDays;
  if (task.state === "FAILED" || task.state === "CANCELLED") return RETENTION_POLICY.failedArtifactDays;
  return null;
}

/** Identify only evidence whose durable summary remains in SQLite. */
export function retentionCandidates(records: Records, now = new Date()): PruneCandidate[] {
  const candidates: PruneCandidate[] = [];
  for (const task of records.listTasks({ limit: 100_000 })) {
    const days = retentionDays(task);
    if (days === null) continue;
    for (const attempt of records.listAttempts(task.id)) {
      if (!attempt.endedAt || ageDays(attempt.endedAt, now) < days) continue;
      const path = join(stateDir(), "artifacts", task.id, attempt.id);
      if (!existsSync(path)) continue;
      candidates.push({
        taskId: task.id,
        attemptId: attempt.id,
        path,
        ageDays: ageDays(attempt.endedAt, now),
        retentionDays: days,
      });
    }
  }
  return candidates;
}

/**
 * Pruning is dry-run unless explicitly applied. Database summaries, events,
 * revisions, statuses, and usage remain; only referenced large-file paths are
 * cleared after their files are removed.
 */
export function pruneArtifacts(records: Records, options: { apply?: boolean; now?: Date } = {}): PruneCandidate[] {
  const candidates = retentionCandidates(records, options.now);
  if (!options.apply) return candidates;

  for (const candidate of candidates) {
    rmSync(candidate.path, { recursive: true, force: true });
    records.store.tx(() => {
      records.store.run("UPDATE attempts SET output_path = NULL WHERE id = ?", candidate.attemptId);
      records.store.run("UPDATE gate_results SET evidence_path = NULL WHERE attempt_id = ?", candidate.attemptId);
      records.store.run("UPDATE context_packets SET manifest_path = NULL WHERE attempt_id = ?", candidate.attemptId);
      records.recordEvent({
        kind: "artifact.pruned",
        taskId: candidate.taskId,
        attemptId: candidate.attemptId,
        data: { ageDays: candidate.ageDays, retentionDays: candidate.retentionDays },
      });
    });
  }
  return candidates;
}

// --------------------------------------------------------------------------
// worktrees
// --------------------------------------------------------------------------

export interface WorktreeCandidate {
  taskId: string;
  projectId: string;
  path: string;
  branch: string | null;
  ageDays: number;
  retentionDays: number;
  /** Null when the worktree may be removed; otherwise why it must not be. */
  refusal: string | null;
}

function worktreeRetentionDays(task: Task): number | null {
  if (task.state === "DONE") return RETENTION_POLICY.completedWorktreeDays;
  if (task.state === "FAILED" || task.state === "CANCELLED") return RETENTION_POLICY.failedWorktreeDays;
  // Anything still in flight owns its worktree.
  return null;
}

/**
 * Identify worktree directories that are old enough to reclaim, and decide for
 * each whether doing so is safe.
 *
 * Nothing is removed here. A candidate carrying a `refusal` is reported so the
 * operator can see what is holding disk and why it was left alone, rather than
 * having it silently skipped.
 */
export async function worktreeCandidates(records: Records, now = new Date()): Promise<WorktreeCandidate[]> {
  const candidates: WorktreeCandidate[] = [];
  for (const task of records.listTasks({ limit: 100_000 })) {
    const days = worktreeRetentionDays(task);
    if (days === null || !task.worktreePath || !existsSync(task.worktreePath)) continue;

    const finishedAt = task.updatedAt ?? task.createdAt;
    const age = ageDays(finishedAt, now);
    if (age < days) continue;

    const project = records.getProject(task.projectId);
    const candidate: WorktreeCandidate = {
      taskId: task.id,
      projectId: task.projectId,
      path: task.worktreePath,
      branch: task.branch,
      ageDays: age,
      retentionDays: days,
      refusal: null,
    };

    if (!project) {
      candidate.refusal = "The owning project is no longer registered, so its base branch cannot be checked.";
    } else if (await workspaceIsDirty(task.worktreePath).catch(() => true)) {
      // Uncommitted changes exist only here. Removing the directory destroys them.
      candidate.refusal = "The worktree has uncommitted changes that exist nowhere else.";
    } else if (!task.resultRevision && !(task.branch && await branchIsMerged(project.repoPath, task.branch, project.baseBranch).catch(() => false))) {
      // No recorded result and nothing merged: this directory may be the only
      // place the work survives.
      candidate.refusal = "No result revision is recorded and the branch is not merged into the base branch.";
    }

    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Reclaim worktree directories. Dry-run unless `apply` is set.
 *
 * Only directories are removed, and only when nothing refused them. Branches
 * are always left in place, so every commit stays reachable and the operation
 * cannot lose work.
 */
export async function pruneWorktrees(
  records: Records,
  options: { apply?: boolean; now?: Date } = {},
): Promise<WorktreeCandidate[]> {
  const candidates = await worktreeCandidates(records, options.now);
  if (!options.apply) return candidates;

  for (const candidate of candidates) {
    if (candidate.refusal) continue;
    const project = records.getProject(candidate.projectId);
    if (!project) continue;
    try {
      await removeWorktree(project.repoPath, candidate.path);
    } catch (error) {
      candidate.refusal = `Removal failed: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    records.store.tx(() => {
      records.store.run("UPDATE tasks SET worktree_path = NULL WHERE id = ?", candidate.taskId);
      records.recordEvent({
        kind: "worktree.pruned",
        taskId: candidate.taskId,
        data: {
          path: candidate.path,
          branch: candidate.branch,
          ageDays: candidate.ageDays,
          retentionDays: candidate.retentionDays,
          branchRetained: true,
        },
      });
    });
  }
  return candidates;
}

export async function createBackup(records: Records, options: { directory?: string; now?: Date } = {}): Promise<string> {
  if (records.store.path === ":memory:") throw new Error("Cannot back up an in-memory database");
  const directory = options.directory ?? join(stateDir(), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = join(directory, `mabs-${stamp}.sqlite`);
  await backup(records.store.db, destination);
  chmodSync(destination, 0o600);
  pruneOldBackups(directory, RETENTION_POLICY.backupCopies);
  return destination;
}

export function pruneOldBackups(directory: string, keep = RETENTION_POLICY.backupCopies): string[] {
  if (!existsSync(directory)) return [];
  const backups = readdirSync(directory)
    .filter((name) => /^mabs-.*\.sqlite$/.test(name))
    .map((name) => ({ path: join(directory, name), mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = backups.slice(Math.max(0, keep));
  for (const item of removed) rmSync(item.path, { force: true });
  return removed.map((item) => item.path);
}
