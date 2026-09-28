import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { dbPath, stateDir } from "../core/paths.ts";
import { auditExecutionHistory } from "../diagnostics/history.ts";
import { controllerLiveness } from "../operator/liveness.ts";
import { SCHEMA_VERSION, Store } from "../store/db.ts";
import { Records } from "../store/records.ts";
import { acquireMaintenanceLock } from "./lock.ts";

/**
 * What the file holds: a stamped MABS database, an older MABS database from
 * before schema stamping, an empty file, or something this build does not
 * know how to upgrade.
 */
export type DatabaseLayout = "stamped" | "legacy-mabs" | "empty" | "unknown";

export interface RestoreRehearsal {
  /** The backup restored to a disposable path, then upgraded and audited there. */
  restoredPath: string;
  upgradedSchema: string | null;
  integrity: string;
  /** Every table of the backup kept all its rows through the rehearsed upgrade. */
  rowsPreserved: boolean;
  /** Evidence digest of the history audit of the upgraded copy; null when it holds no tasks. */
  auditDigest: string | null;
}

export interface MigrationReport {
  databasePath: string;
  layout: DatabaseLayout | null;
  fromSchema: string | null;
  toSchema: string;
  migrated: boolean;
  backupPath: string | null;
  backupSchema: string | null;
  backupIntegrity: string | null;
  restoreRehearsal: RestoreRehearsal | null;
  restore: string | null;
}

function tablesOf(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

export function detectLayout(db: DatabaseSync): DatabaseLayout {
  const tables = tablesOf(db);
  if (tables.size === 0) return "empty";
  if (tables.has("schema_meta") && db.prepare("SELECT 1 FROM schema_meta WHERE key = 'schema_version'").get()) return "stamped";
  return tables.has("projects") && tables.has("tasks") ? "legacy-mabs" : "unknown";
}

/**
 * Durable work that is not quiesced. Each probe runs only when its table
 * exists, so an older schema is inspected without querying tables it lacks.
 */
export function drainBlockers(db: DatabaseSync): string[] {
  const tables = tablesOf(db);
  const found: string[] = [];
  const probe = (table: string, sql: string, describe: (row: Record<string, unknown>) => string) => {
    if (!tables.has(table)) return;
    for (const row of db.prepare(sql).all() as Record<string, unknown>[]) found.push(describe(row));
  };
  probe("tasks", "SELECT id, state FROM tasks WHERE state IN ('RUNNING','CHECKING','REVIEWING')", (row) => `task ${String(row.id)} is ${String(row.state)}`);
  probe("attempts", "SELECT id FROM attempts WHERE state = 'running'", (row) => `attempt ${String(row.id)} is running`);
  probe("stage_runs", "SELECT id, stage, state FROM stage_runs WHERE state IN ('reserved','launching','running','waiting','unknown')",
    (row) => `stage ${String(row.id)} (${String(row.stage)}) is ${String(row.state)}`);
  probe("admission_leases", "SELECT id, status FROM admission_leases WHERE status IN ('reserved','active')",
    (row) => `admission lease ${String(row.id)} is ${String(row.status)}`);
  return found;
}

/** Row count of every table, the evidence that a copy holds the whole source. */
function tableCounts(db: DatabaseSync): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [
    name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll("\"", "\"\"")}"`).get() as { n: number }).n),
  ]));
}

function readSchema(path: string): string | null {
  const store = Store.openReadOnly(path);
  try {
    return (store.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")?.value as string | undefined) ?? null;
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/**
 * Restore the backup to a disposable path, upgrade that copy, and prove it
 * opens, is intact, kept every row, and passes the history audit. The live
 * source is migrated only after this succeeds.
 */
async function rehearseRestore(backupPath: string, backupCounts: Record<string, number>): Promise<RestoreRehearsal> {
  const restoredPath = `${backupPath}.restore-rehearsal.sqlite`;
  if (existsSync(restoredPath)) throw new Error(`Refusing to overwrite ${restoredPath}`);
  const source = new DatabaseSync(backupPath, { readOnly: true });
  try {
    await backup(source, restoredPath);
  } finally {
    source.close();
  }
  try {
    new Store(restoredPath, { migrations: "auto" }).close();
    const check = new DatabaseSync(restoredPath, { readOnly: true });
    let integrity: string;
    let upgradedCounts: Record<string, number>;
    try {
      integrity = String((check.prepare("PRAGMA integrity_check").get() as { integrity_check: unknown }).integrity_check);
      upgradedCounts = tableCounts(check);
    } finally {
      check.close();
    }
    // The audit needs at least one task; an empty history has nothing to audit.
    const audit = (upgradedCounts.tasks ?? 0) > 0 ? auditExecutionHistory({ dbPath: restoredPath }) : null;
    return {
      restoredPath,
      upgradedSchema: readSchema(restoredPath),
      integrity,
      rowsPreserved: Object.entries(backupCounts).every(([table, rows]) => upgradedCounts[table] === rows),
      auditDigest: audit?.evidence.sha256 ?? null,
    };
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${restoredPath}${suffix}`, { force: true });
  }
}

/**
 * The one explicit path from an older schema to this build's. Under an
 * exclusive maintenance lock (so no controller can start meanwhile) it refuses
 * while a controller is alive or any work is not drained, takes a read-only
 * backup of the unmigrated source, proves the copy is intact and at the source
 * schema, rehearses restoring and upgrading that copy, and only then upgrades.
 */
export async function migrateDatabase(options: { path?: string; backupDirectory?: string; now?: Date } = {}): Promise<MigrationReport> {
  const path = options.path ?? dbPath();
  if (!existsSync(path)) throw new Error(`No database at ${path}; a new database needs no migration.`);
  const fromSchema = readSchema(path);
  const report: MigrationReport = {
    databasePath: path, layout: null, fromSchema, toSchema: SCHEMA_VERSION, migrated: false,
    backupPath: null, backupSchema: null, backupIntegrity: null, restoreRehearsal: null, restore: null,
  };
  if (fromSchema === SCHEMA_VERSION) {
    report.layout = "stamped";
    return report;
  }

  const release = acquireMaintenanceLock(path, "migrate");
  try {
    const directory = options.backupDirectory ?? join(stateDir(), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const backupPath = join(directory, `mabs-premigrate-schema${fromSchema ?? "legacy"}-${stamp}.sqlite`);
    if (existsSync(backupPath)) throw new Error(`Refusing to overwrite ${backupPath}`);

    const source = Store.openReadOnly(path);
    let sourceCounts: Record<string, number>;
    try {
      report.layout = detectLayout(source.db);
      // Older and foreign layouts may lack the lease table entirely.
      if (tablesOf(source.db).has("controller_lease")) {
        const liveness = controllerLiveness(new Records(source));
        if (liveness.processAlive) {
          throw new Error(`Refusing to migrate while controller ${liveness.controllerId ?? "?"} (pid ${liveness.pid ?? "?"}) is ${liveness.state}; stop it first.`);
        }
      }
      const undrained = drainBlockers(source.db);
      if (undrained.length > 0) {
        throw new Error(`Refusing to migrate: ${undrained.length} item(s) are not drained (${undrained.slice(0, 10).join("; ")}). ` +
          "Let them finish or cancel them, with the controller stopped, then migrate.");
      }
      await backup(source.db, backupPath);
      sourceCounts = tableCounts(source.db);
    } finally {
      source.close();
    }
    chmodSync(backupPath, 0o600);

    const check = new DatabaseSync(backupPath, { readOnly: true });
    let integrity: string;
    let backupCounts: Record<string, number>;
    try {
      integrity = String((check.prepare("PRAGMA integrity_check").get() as { integrity_check: unknown }).integrity_check);
      backupCounts = tableCounts(check);
    } finally {
      check.close();
    }
    report.backupPath = backupPath;
    report.backupSchema = readSchema(backupPath);
    report.backupIntegrity = integrity;
    const complete = JSON.stringify(sourceCounts) === JSON.stringify(backupCounts);
    if (integrity !== "ok" || report.backupSchema !== fromSchema || !complete) {
      throw new Error(`Backup ${backupPath} did not verify (integrity=${integrity}, schema=${report.backupSchema}, complete=${complete}); the source was not migrated.`);
    }
    if (report.layout === "unknown") {
      throw new Error(`${path} has no schema stamp and none of the MABS tables this build can upgrade (found: ${Object.keys(sourceCounts).join(", ") || "none"}). ` +
        `It was backed up to ${backupPath} and left unchanged.`);
    }

    const rehearsal = await rehearseRestore(backupPath, backupCounts);
    report.restoreRehearsal = rehearsal;
    if (rehearsal.integrity !== "ok" || rehearsal.upgradedSchema !== SCHEMA_VERSION || !rehearsal.rowsPreserved) {
      throw new Error(`Restore rehearsal of ${backupPath} failed (integrity=${rehearsal.integrity}, schema=${rehearsal.upgradedSchema}, ` +
        `rowsPreserved=${rehearsal.rowsPreserved}); the source was not migrated.`);
    }

    new Store(path, { migrations: "auto" }).close();
    report.migrated = true;
    report.toSchema = readSchema(path) ?? SCHEMA_VERSION;
    report.restore = `With the controller stopped: cp ${backupPath} ${path} && rm -f ${path}-wal ${path}-shm (rehearsed before this migration)`;
    return report;
  } finally {
    release();
  }
}
