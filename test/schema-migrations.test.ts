import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { auditExecutionHistory, rehearseBackupRestore } from "../src/diagnostics/history.ts";
import { SCHEMA_VERSION, Store, UnsupportedSchemaVersionError } from "../src/store/db.ts";

function rootFor(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function minimalHistory(path: string): void {
  const store = new Store(path);
  const at = "2026-09-25T00:00:00.000Z";
  store.run(
    `INSERT INTO projects(id, name, repo_path, config_version, created_at, updated_at)
     VALUES('prj_restore', 'restore', '/sanitized/restore', 'cfg_restore', ?, ?)`, at, at,
  );
  store.run(
    `INSERT INTO tasks(id, project_id, title, objective, state, created_at, updated_at)
     VALUES('tsk_restore', 'prj_restore', 'restore', 'rehearse', 'DONE', ?, ?)`, at, at,
  );
  store.run(
    `INSERT INTO attempts(
       id, task_id, launch_id, attempt_number, adapter, state, usage_json, started_at, ended_at
     ) VALUES('att_restore', 'tsk_restore', 'launch_restore', 1, 'codex', 'succeeded',
       '{"input_tokens":7,"cached_input_tokens":3,"output_tokens":2}', ?, ?)`, at, at,
  );
  store.close();
}

test("future schema is refused by writable and read-only access without mutation", (t) => {
  const root = rootFor(t, "mabs-future-schema-");
  const path = join(root, "future.sqlite");
  const future = String(Number(SCHEMA_VERSION) + 1);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_meta VALUES('schema_version', ?)").run(future);
  db.exec("CREATE TABLE sentinel(value TEXT NOT NULL)");
  db.exec("INSERT INTO sentinel VALUES('preserve-me')");
  db.close();
  const before = readFileSync(path);

  assert.throws(() => new Store(path), (error) => {
    assert.ok(error instanceof UnsupportedSchemaVersionError);
    assert.equal(error.found, future);
    return true;
  });
  assert.deepEqual(readFileSync(path), before);
  assert.throws(() => Store.openReadOnly(path), UnsupportedSchemaVersionError);
  assert.deepEqual(readFileSync(path), before);
  const verify = new DatabaseSync(path, { readOnly: true });
  assert.equal((verify.prepare("SELECT value FROM sentinel").get() as { value: string }).value, "preserve-me");
  assert.equal((verify.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value, future);
  verify.close();
});

test("read-only access neither migrates an older schema nor creates a missing source path", (t) => {
  const root = rootFor(t, "mabs-readonly-schema-");
  const path = join(root, "schema13.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  legacy.exec("INSERT INTO schema_meta VALUES('schema_version', '13')");
  legacy.exec("CREATE TABLE sentinel(value TEXT NOT NULL)");
  legacy.exec("INSERT INTO sentinel VALUES('unchanged')");
  legacy.close();
  const before = readFileSync(path);

  const readOnly = Store.openReadOnly(path);
  assert.equal(readOnly.get("SELECT value FROM schema_meta WHERE key='schema_version'")?.value, "13");
  assert.equal(readOnly.get("SELECT value FROM sentinel")?.value, "unchanged");
  assert.equal(readOnly.get("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'"), undefined);
  readOnly.close();
  assert.deepEqual(readFileSync(path), before);

  const absent = join(root, "not-created", "missing.sqlite");
  assert.throws(() => Store.openReadOnly(absent), /does not exist/);
  assert.equal(existsSync(join(root, "not-created")), false);
});

test("failed structural migration rolls back all earlier DDL and does not stamp the version", (t) => {
  const root = rootFor(t, "mabs-migration-rollback-");
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  legacy.exec("INSERT INTO schema_meta VALUES('schema_version', '13')");
  // schema.sql creates projects and requirements before reaching this name.
  // The colliding view injects a deterministic failure mid-migration.
  legacy.exec("CREATE VIEW tasks AS SELECT 'sentinel' AS id");
  legacy.close();

  assert.throws(() => new Store(path), /view|already exists|tasks/i);
  const verify = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (verify.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
    "13",
  );
  assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get(), undefined);
  assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requirements'").get(), undefined);
  assert.equal((verify.prepare("SELECT id FROM tasks").get() as { id: string }).id, "sentinel");
  verify.close();
});

test("SQLite backup restores into a disposable path with identical historical evidence", async (t) => {
  const root = rootFor(t, "mabs-restore-rehearsal-");
  const source = join(root, "source.sqlite");
  const restored = join(root, "restored.sqlite");
  minimalHistory(source);

  const rehearsal = await rehearseBackupRestore(source, restored);
  assert.equal(rehearsal.consistent, true);
  assert.equal(rehearsal.schemaVersion, SCHEMA_VERSION);
  assert.equal(rehearsal.sourceDigest, rehearsal.restoredDigest);
  const report = auditExecutionHistory({ dbPath: restored });
  assert.equal(report.totals.tasks, 1);
  assert.equal(report.totals.attempts, 1);
  assert.equal(report.usage.knownInputEvents, 7);
  assert.equal(report.usage.knownOutputTokens, 2);
  await assert.rejects(() => rehearseBackupRestore(source, restored), /refuses to overwrite/);
  await assert.rejects(() => rehearseBackupRestore(source, source), /different destination/);
});
