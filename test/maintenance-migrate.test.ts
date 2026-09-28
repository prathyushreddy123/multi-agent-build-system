import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { migrateDatabase } from "../src/maintenance/migrate.ts";
import { SCHEMA_VERSION, SchemaMigrationRequiredError, Store, createLegacyBaselineDatabase } from "../src/store/db.ts";
import { openRecords } from "../src/store/records.ts";

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
