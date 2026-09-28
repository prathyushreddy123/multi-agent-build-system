import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { migrateDatabase } from "../src/maintenance/migrate.ts";
import { SCHEMA_VERSION, SchemaMigrationRequiredError, Store, createLegacyBaselineDatabase } from "../src/store/db.ts";
import { openRecords, Records } from "../src/store/records.ts";
import { Controller } from "../src/controller/controller.ts";
import { acquireMaintenanceLock, MaintenanceInProgressError } from "../src/maintenance/lock.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function legacy(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-migrate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "mabs.sqlite");
  createLegacyBaselineDatabase(path);
  const env = { ...process.env, MABS_DB_PATH: path, MABS_STATE_DIR: join(root, "state") };
  return { root, path, env };
}

function schemaOf(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return String((db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: unknown }).value);
  } finally {
    db.close();
  }
}

test("an operator command refuses an older schema instead of migrating it; a new database still initializes", (t) => {
  const { root, path, env } = legacy(t);
  assert.throws(() => openRecords(path), SchemaMigrationRequiredError);
  assert.equal(schemaOf(path), "14", "the refused open changed nothing");

  const status = spawnSync(process.execPath, [CLI, "status"], { env, encoding: "utf8" });
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /maintenance migrate/);
  assert.equal(schemaOf(path), "14", "inspection never migrates");

  const fresh = join(root, "fresh.sqlite");
  openRecords(fresh).store.close();
  assert.equal(schemaOf(fresh), SCHEMA_VERSION);
});

test("maintenance backup copies a schema-14 source without migrating it", (t) => {
  const { path, env } = legacy(t);
  const backup = execFileSync(process.execPath, [CLI, "maintenance", "backup"], { env, encoding: "utf8" }).trim();
  assert.equal(schemaOf(path), "14", "the source is still the pre-upgrade database");
  assert.equal(schemaOf(backup), "14", "the backup is the pre-upgrade database");
});

test("maintenance migrate verifies a pre-upgrade backup, then upgrades; a second run is a no-op", async (t) => {
  const { root, path } = legacy(t);
  const backups = join(root, "backups");
  const report = await migrateDatabase({ path, backupDirectory: backups });
  assert.equal(report.migrated, true);
  assert.equal(report.fromSchema, "14");
  assert.equal(report.backupSchema, "14");
  assert.equal(report.backupIntegrity, "ok");
  assert.equal(schemaOf(report.backupPath as string), "14", "the backup stays restorable at the source schema");
  assert.equal(schemaOf(path), SCHEMA_VERSION);
  openRecords(path).store.close();

  const again = await migrateDatabase({ path, backupDirectory: backups });
  assert.equal(again.migrated, false);
  assert.equal(again.backupPath, null);
});

test("maintenance migrate refuses while a controller process is alive", async (t) => {
  const { root, path } = legacy(t);
  const db = new DatabaseSync(path);
  const now = new Date().toISOString();
  const columns = (db.prepare("PRAGMA table_info(controller_lease)").all() as { name: string }[]).map((column) => column.name);
  const values: Record<string, unknown> = { singleton: 1, controller_id: "ctl_live", pid: process.pid, heartbeat_at: now, acquired_at: now, expires_at: now, state: "running" };
  const present = Object.keys(values).filter((name) => columns.includes(name));
  db.prepare(`INSERT INTO controller_lease(${present.join(", ")}) VALUES(${present.map(() => "?").join(", ")})`).run(...present.map((name) => values[name] as never));
  db.close();
  mkdirSync(join(root, "backups"));
  await assert.rejects(migrateDatabase({ path, backupDirectory: join(root, "backups") }), /Refusing to migrate while controller ctl_live/);
  assert.equal(schemaOf(path), "14");
});

test("the library Store still upgrades by default, for tests and rehearsals", (t) => {
  const { path } = legacy(t);
  new Store(path).close();
  assert.equal(schemaOf(path), SCHEMA_VERSION);
});

function seedTask(path: string, state: string): void {
  const db = new DatabaseSync(path);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id, name, repo_path, config_version, created_at, updated_at) VALUES('prj_1', 'p', '/r', 'cfg_1', ?, ?)").run(now, now);
  db.prepare("INSERT INTO tasks(id, project_id, title, objective, state, created_at, updated_at) VALUES('tsk_1', 'prj_1', 't', 'o', ?, ?, ?)").run(state, now, now);
  db.close();
}

test("maintenance migrate refuses while durable work is not drained, even with no controller alive", async (t) => {
  const { root, path } = legacy(t);
  seedTask(path, "RUNNING");
  await assert.rejects(migrateDatabase({ path, backupDirectory: join(root, "backups") }), /not drained.*task tsk_1 is RUNNING/);
  assert.equal(schemaOf(path), "14", "the undrained source is unchanged");
  assert.equal(existsSync(`${path}.maintenance.lock`), false, "the lock is released on refusal");
});

test("maintenance migrate rehearses restoring and upgrading its backup before touching the source", async (t) => {
  const { root, path } = legacy(t);
  seedTask(path, "DONE");
  const report = await migrateDatabase({ path, backupDirectory: join(root, "backups") });
  assert.equal(report.migrated, true);
  assert.equal(report.layout, "stamped");
  assert.equal(report.restoreRehearsal?.upgradedSchema, SCHEMA_VERSION);
  assert.equal(report.restoreRehearsal?.integrity, "ok");
  assert.equal(report.restoreRehearsal?.rowsPreserved, true);
  assert.match(report.restoreRehearsal?.auditDigest ?? "", /^[0-9a-f]{64}$|^sha256:/);
  assert.equal(existsSync(report.restoreRehearsal?.restoredPath as string), false, "the disposable restore is removed");
  assert.equal(schemaOf(report.backupPath as string), "14", "the rehearsal never touched the backup itself");
});

test("an unstamped pre-baseline MABS database migrates; an unknown layout is backed up and refused with a specific error", async (t) => {
  const { root, path } = legacy(t);
  const stripped = new DatabaseSync(path);
  stripped.exec("DROP TABLE schema_meta; DROP TABLE controller_lease;");
  stripped.close();
  const report = await migrateDatabase({ path, backupDirectory: join(root, "backups") });
  assert.equal(report.layout, "legacy-mabs");
  assert.equal(report.fromSchema, null);
  assert.equal(schemaOf(path), SCHEMA_VERSION);

  const foreign = join(root, "foreign.sqlite");
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE legacy_data(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO legacy_data(value) VALUES('x');");
  db.close();
  await assert.rejects(migrateDatabase({ path: foreign, backupDirectory: join(root, "backups") }),
    /no schema stamp and none of the MABS tables.*legacy_data.*backed up to .*left unchanged/s);
  const after = new DatabaseSync(foreign, { readOnly: true });
  const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
  after.close();
  assert.deepEqual(tables, ["legacy_data"], "no MABS schema was written into a foreign database");
});

test("the maintenance lock excludes a second migration and a starting controller", async (t) => {
  const { root, path } = legacy(t);
  const release = acquireMaintenanceLock(path, "test");
  t.after(release);
  await assert.rejects(migrateDatabase({ path, backupDirectory: join(root, "backups") }), MaintenanceInProgressError);
  const records = new Records(new Store(join(root, "current.sqlite")));
  t.after(() => records.store.close());
  const currentRelease = acquireMaintenanceLock(records.store.path, "test");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, workerLimit: 1, adapters: new Map() });
  await assert.rejects(controller.tick(), MaintenanceInProgressError);
  assert.ok(!records.currentControllerLease(), "the controller took no lease while maintenance held the database");
  currentRelease();
  await controller.tick();
  assert.ok(records.currentControllerLease(), "after release the controller runs normally");
  await controller.stop();

  // A lock left by a process that no longer exists is reclaimed, not obeyed.
  const stalePath = join(root, "stale.sqlite");
  writeFileSync(`${stalePath}.maintenance.lock`, JSON.stringify({ pid: 2 ** 22, startTicks: "1", bootId: null, operation: "crashed", startedAt: "then" }));
  acquireMaintenanceLock(stalePath, "reclaim")();
});
