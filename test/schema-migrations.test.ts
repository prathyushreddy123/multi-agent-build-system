import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { auditExecutionHistory, rehearseBackupRestore } from "../src/diagnostics/history.ts";
import {
  SCHEMA_VERSION,
  Store,
  UnsupportedSchemaVersionError,
  createLegacyBaselineDatabase,
} from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";

function rootFor(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface SchemaShape {
  objects: string[];
  columns: Record<string, string[]>;
}

/**
 * Everything a migration can get wrong: which objects exist, their exact DDL,
 * and each column's type, nullability, default, and key position.
 */
function schemaShape(path: string): SchemaShape {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const objects = (db.prepare(
      `SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    ).all() as { type: string; name: string; sql: string }[])
      .map((object) => `${object.type} ${object.name} :: ${object.sql.replace(/\s+/g, " ").trim()}`);
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((table) => table.name);
    const columns: Record<string, string[]> = {};
    for (const table of tables) {
      columns[table] = (db.prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
      }[]).map((column) =>
        `${column.name} ${column.type} notnull=${column.notnull} default=${String(column.dflt_value)} pk=${column.pk}`,
      );
    }
    return { objects, columns };
  } finally {
    db.close();
  }
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

test("a fresh database and a migrated schema-14 database converge on one schema", (t) => {
  const root = rootFor(t, "mabs-schema-convergence-");
  const fresh = join(root, "fresh.sqlite");
  const upgraded = join(root, "upgraded.sqlite");

  const freshStore = new Store(fresh);
  assert.equal(freshStore.get("SELECT value FROM schema_meta WHERE key='schema_version'")?.value, SCHEMA_VERSION);
  freshStore.close();

  // The schema-14 baseline must genuinely predate this migration, otherwise the
  // comparison below would prove nothing.
  createLegacyBaselineDatabase(upgraded);
  const baseline = new DatabaseSync(upgraded, { readOnly: true });
  assert.equal(
    (baseline.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
    "14",
  );
  for (const absent of ["stage_runs", "task_obligations", "project_policy_decisions", "attempt_usage"]) {
    assert.equal(
      baseline.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(absent), undefined,
      `${absent} must not exist at schema 14`,
    );
  }
  baseline.close();

  const upgradedStore = new Store(upgraded);
  assert.equal(upgradedStore.get("SELECT value FROM schema_meta WHERE key='schema_version'")?.value, SCHEMA_VERSION);
  upgradedStore.close();

  const target = schemaShape(fresh);
  assert.deepEqual(schemaShape(upgraded), target);
  // Objects added to schema.sql without a migration, or the reverse, would make
  // the two paths diverge; spot-check that schema 15 really is present in both.
  assert.ok(target.columns.projects?.some((column) => column.startsWith("project_type ")));
  assert.ok(target.columns.stage_runs?.some((column) => column.startsWith("fencing_token ")));

  // Reopening must be a no-op: the migration list is version-guarded.
  new Store(upgraded).close();
  new Store(fresh).close();
  assert.deepEqual(schemaShape(upgraded), target);
  assert.deepEqual(schemaShape(fresh), target);

  assert.throws(() => createLegacyBaselineDatabase(upgraded), /Refusing to overwrite/);
});

test("migrating to schema 15 neither classifies a project nor reopens completed work", (t) => {
  const root = rootFor(t, "mabs-migration-preserves-");
  const path = join(root, "legacy14.sqlite");
  createLegacyBaselineDatabase(path);

  const at = "2026-09-25T00:00:00.000Z";
  const legacy = new DatabaseSync(path);
  // The name and path look like client work on purpose: nothing may infer from them.
  legacy.prepare(
    `INSERT INTO projects(id, name, repo_path, config_version, created_at, updated_at)
     VALUES('prj_legacy', 'Acme client portal', '/sanitized/clients/acme', 'cfg_legacy', ?, ?)`,
  ).run(at, at);
  legacy.prepare(
    `INSERT INTO tasks(id, project_id, title, objective, state, created_at, updated_at)
     VALUES('tsk_legacy_done', 'prj_legacy', 'finished', 'stay done', 'DONE', ?, ?)`,
  ).run(at, at);
  legacy.prepare(
    `INSERT INTO product_briefs(id, title, state, created_at, updated_at)
     VALUES('brf_legacy', 'legacy brief', 'ACCEPTED', ?, ?)`,
  ).run(at, at);
  legacy.close();

  const store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.get("SELECT value FROM schema_meta WHERE key='schema_version'")?.value, SCHEMA_VERSION);

  const project = store.get("SELECT * FROM projects WHERE id = 'prj_legacy'");
  assert.equal(project?.project_type, null);
  assert.equal(project?.review_choice, null);
  assert.equal(project?.governance_decision_id, null);
  assert.equal(Number(project?.governance_version), 0);
  assert.equal(project?.updated_at, at);

  const brief = store.get("SELECT * FROM product_briefs WHERE id = 'brf_legacy'");
  assert.equal(brief?.project_type, null);
  assert.equal(brief?.review_choice, null);
  assert.equal(brief?.governance_decision_id, null);
  assert.equal(Number(brief?.governance_version), 0);

  // Completed work stays completed, with its original timestamp.
  const task = store.get("SELECT * FROM tasks WHERE id = 'tsk_legacy_done'");
  assert.equal(task?.state, "DONE");
  assert.equal(task?.updated_at, at);

  for (const table of [
    "project_policy_decisions", "execution_episodes", "stage_runs", "task_obligations",
    "admission_leases", "incidents", "incident_occurrences", "attempt_usage",
    "environment_checks", "task_requirement_ownership", "projection_cursors",
  ]) {
    assert.equal(Number(store.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n), 0, `${table} must stay empty`);
  }

  // Missing classification is a question to ask, never a default to assume.
  const readiness = new Records(store).readProjectReadiness("prj_legacy");
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["project_type", "confirmed_decision"]);
  assert.deepEqual(readiness.conflicts, []);
  assert.equal(readiness.questions[0]?.key, "project_type");
  assert.equal(new Records(store).readProjectReadiness({ briefId: "brf_legacy" }).ready, false);
});
