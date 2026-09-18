import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backup } from "node:sqlite";

import { stateDir } from "../core/paths.ts";
import type { Records, Task } from "../store/records.ts";

export const RETENTION_POLICY = {
  completedArtifactDays: 30,
  failedArtifactDays: 90,
  backupCopies: 14,
  databaseRecords: "indefinite",
  activeAndBlockedArtifacts: "indefinite",
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
