/**
 * Disposable upgrade and restore rehearsal (plan Gate E, step 4).
 *
 * The source database is only ever opened read-only and copied with SQLite's
 * backup API. The upgrade runs on a copy inside a new work directory, and the
 * report proves three things without touching the source:
 *   1. every value in every pre-existing table and column survives the upgrade;
 *   2. the copy reaches the supported schema version;
 *   3. a pre-upgrade backup restores to an identical evidence digest.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { evaluateProjectReadiness } from "../domain/project-policy.ts";
import { SCHEMA_VERSION, Store } from "../store/db.ts";
import { Records } from "../store/records.ts";
import { auditExecutionHistory, rehearseBackupRestore } from "./history.ts";

export const UPGRADE_VALIDATION_FORMAT = "mabs.execution-upgrade-validation.v1";

interface TableDigest {
  rows: number;
  sha256: string;
}

function tableDigests(path: string, columnsByTable?: Map<string, string[]>): { digests: Map<string, TableDigest>; columns: Map<string, string[]> } {
  const store = Store.openReadOnly(path);
  try {
    const tables = store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta' ORDER BY name")
      .map((row) => row.name as string);
    const columns = new Map<string, string[]>();
    const digests = new Map<string, TableDigest>();
    for (const table of tables) {
      const present = store.all(`PRAGMA table_info(${table})`).map((row) => row.name as string);
      const selected = columnsByTable ? columnsByTable.get(table) : present;
      if (!selected) continue;
      columns.set(table, present);
      const missing = selected.filter((column) => !present.includes(column));
      if (missing.length > 0) throw new Error(`Upgrade removed column(s) ${missing.join(", ")} from ${table}.`);
      const order = present.includes("id") ? "id" : "rowid";
      const hash = createHash("sha256");
      const rows = store.all(`SELECT ${selected.map((column) => `"${column}"`).join(", ")} FROM ${table} ORDER BY ${order}`);
      for (const row of rows) hash.update(JSON.stringify(selected.map((column) => row[column] ?? null))).update("\n");
      digests.set(table, { rows: rows.length, sha256: hash.digest("hex") });
    }
    return { digests, columns };
  } finally {
    store.close();
  }
}

export interface UpgradeValidationReport {
  format: string;
  sourcePath: string;
  workDir: string;
  sourceSchemaVersion: string | null;
  upgradedSchemaVersion: string | null;
  supportedSchemaVersion: string;
  preservedTables: number;
  changedTables: { table: string; before: TableDigest; after: TableDigest | null }[];
  restore: { consistent: boolean; sourceDigest: string; restoredDigest: string };
  projectsNeedingGovernance: { projectId: string; name: string; missing: string[] }[];
  passed: boolean;
}

export async function validateExecutionUpgrade(input: { sourcePath: string; workDir: string }): Promise<UpgradeValidationReport> {
  const source = resolve(input.sourcePath);
  const work = resolve(input.workDir);
  if (!existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (existsSync(work)) throw new Error(`Work directory must not exist yet: ${work}`);
  if (work.startsWith(`${source}`)) throw new Error("Work directory must be separate from the source database.");
  mkdirSync(work, { recursive: true, mode: 0o700 });

  const sourceAudit = auditExecutionHistory({ dbPath: source });
  const snapshot = join(work, "pre-upgrade.sqlite");
  const snapshotCheck = await rehearseBackupRestore(source, snapshot);
  if (!snapshotCheck.consistent) throw new Error("The pre-upgrade snapshot does not match the source evidence digest.");
  const before = tableDigests(snapshot);

  const upgradedPath = join(work, "upgraded.sqlite");
  await rehearseBackupRestore(snapshot, upgradedPath);
  new Store(upgradedPath).close();
  const after = tableDigests(upgradedPath, before.columns);

  const changedTables: UpgradeValidationReport["changedTables"] = [];
  for (const [table, digest] of before.digests) {
    const upgraded = after.digests.get(table) ?? null;
    if (!upgraded || upgraded.sha256 !== digest.sha256 || upgraded.rows !== digest.rows) changedTables.push({ table, before: digest, after: upgraded });
  }

  const restoredPath = join(work, "restored.sqlite");
  const restore = await rehearseBackupRestore(snapshot, restoredPath);

  const upgradedStore = Store.openReadOnly(upgradedPath);
  let upgradedSchemaVersion: string | null = null;
  let projectsNeedingGovernance: UpgradeValidationReport["projectsNeedingGovernance"] = [];
  try {
    upgradedSchemaVersion = (upgradedStore.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")?.value as string) ?? null;
    const records = new Records(upgradedStore);
    projectsNeedingGovernance = records.listProjects().flatMap((project) => {
      const readiness = evaluateProjectReadiness(project.governance, project.reviewPolicy);
      return readiness.ready ? [] : [{ projectId: project.id, name: project.name, missing: [...readiness.missing, ...readiness.conflicts] }];
    });
  } finally {
    upgradedStore.close();
  }

  const report: UpgradeValidationReport = {
    format: UPGRADE_VALIDATION_FORMAT,
    sourcePath: source,
    workDir: work,
    sourceSchemaVersion: sourceAudit.source.schemaVersion,
    upgradedSchemaVersion,
    supportedSchemaVersion: SCHEMA_VERSION,
    preservedTables: before.digests.size - changedTables.length,
    changedTables,
    restore: { consistent: restore.consistent, sourceDigest: restore.sourceDigest, restoredDigest: restore.restoredDigest },
    projectsNeedingGovernance,
    passed: changedTables.length === 0 && upgradedSchemaVersion === SCHEMA_VERSION && restore.consistent,
  };
  writeFileSync(join(work, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
