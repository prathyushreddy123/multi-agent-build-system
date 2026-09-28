import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { dbPath, stateDir } from "../core/paths.ts";
import { controllerLiveness } from "../operator/liveness.ts";
import { SCHEMA_VERSION, Store } from "../store/db.ts";
import { Records } from "../store/records.ts";

export interface MigrationReport {
  databasePath: string;
  fromSchema: string | null;
  toSchema: string;
  migrated: boolean;
  backupPath: string | null;
  backupSchema: string | null;
  backupIntegrity: string | null;
  restore: string | null;
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
 * The one explicit path from an older schema to this build's. It refuses while
 * a controller is alive, takes a read-only backup of the unmigrated source,
 * proves the copy is intact and at the source schema, and only then upgrades.
 */
export async function migrateDatabase(options: { path?: string; backupDirectory?: string; now?: Date } = {}): Promise<MigrationReport> {
  const path = options.path ?? dbPath();
  if (!existsSync(path)) throw new Error(`No database at ${path}; a new database needs no migration.`);
  const fromSchema = readSchema(path);
  const report: MigrationReport = {
    databasePath: path, fromSchema, toSchema: SCHEMA_VERSION, migrated: false,
    backupPath: null, backupSchema: null, backupIntegrity: null, restore: null,
  };
  if (fromSchema === SCHEMA_VERSION) return report;

  const directory = options.backupDirectory ?? join(stateDir(), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = join(directory, `mabs-premigrate-schema${fromSchema ?? "legacy"}-${stamp}.sqlite`);
  if (existsSync(backupPath)) throw new Error(`Refusing to overwrite ${backupPath}`);

  const source = Store.openReadOnly(path);
  let sourceCounts: Record<string, number>;
  try {
    const liveness = controllerLiveness(new Records(source));
    if (liveness.processAlive) {
      throw new Error(`Refusing to migrate while controller ${liveness.controllerId ?? "?"} (pid ${liveness.pid ?? "?"}) is ${liveness.state}; stop it first.`);
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

  new Store(path, { migrations: "auto" }).close();
  report.migrated = true;
  report.toSchema = readSchema(path) ?? SCHEMA_VERSION;
  report.restore = `With the controller stopped: cp ${backupPath} ${path} && rm -f ${path}-wal ${path}-shm`;
  return report;
}
