/**
 * The maintenance lock: one exclusive file beside the database.
 *
 * Migration holds it from its drain check until the upgraded database is
 * closed; a controller refuses to tick while it is held. That closes the gap
 * between "no controller is running" and the schema changing underneath one
 * that starts a moment later.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

import { selfIdentity, verifyProcess } from "../core/process-identity.ts";

export interface MaintenanceLockHolder {
  pid: number;
  startTicks: string | null;
  bootId: string | null;
  operation: string;
  startedAt: string;
}

export class MaintenanceInProgressError extends Error {
  readonly holder: MaintenanceLockHolder;

  constructor(path: string, holder: MaintenanceLockHolder) {
    super(`Maintenance (${holder.operation}) holds ${path} since ${holder.startedAt} (pid ${holder.pid}); the controller will not run until it finishes.`);
    this.name = "MaintenanceInProgressError";
    this.holder = holder;
  }
}

export function maintenanceLockPath(databasePath: string): string {
  return `${databasePath}.maintenance.lock`;
}

function readHolder(path: string): MaintenanceLockHolder | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MaintenanceLockHolder;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A torn or unreadable lock is treated as held: it cannot be proven stale.
    return { pid: -1, startTicks: null, bootId: null, operation: "unknown (unreadable lock)", startedAt: "unknown" };
  }
}

/** The live holder, or null. A lock whose process is gone (or was replaced) is stale. */
export function maintenanceLockHolder(databasePath: string): MaintenanceLockHolder | null {
  const holder = readHolder(maintenanceLockPath(databasePath));
  if (!holder) return null;
  if (holder.pid === -1) return holder;
  return verifyProcess(holder.pid, { startTicks: holder.startTicks, bootId: holder.bootId }) === "gone" ? null : holder;
}

/** Refuse while maintenance is running against this database. */
export function assertNoMaintenance(databasePath: string): void {
  if (databasePath === ":memory:") return;
  const holder = maintenanceLockHolder(databasePath);
  if (holder) throw new MaintenanceInProgressError(maintenanceLockPath(databasePath), holder);
}

/**
 * Take the lock exclusively, reclaiming it only from a holder that is provably
 * gone. Returns the release function.
 */
export function acquireMaintenanceLock(databasePath: string, operation: string): () => void {
  const path = maintenanceLockPath(databasePath);
  const record: MaintenanceLockHolder = { ...selfIdentity(), operation, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = maintenanceLockHolder(databasePath);
      if (holder) throw new MaintenanceInProgressError(path, holder);
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    return () => {
      if (readHolder(path)?.pid === record.pid) rmSync(path, { force: true });
    };
  }
  throw new Error(`Could not take the maintenance lock ${path}`);
}
