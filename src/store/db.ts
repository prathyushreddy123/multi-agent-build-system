import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbPath } from "../core/paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = "14";

export type Row = Record<string, unknown>;

export interface StoreOptions {
  /**
   * Open an existing database without creating directories, applying
   * migrations, or changing persistent pragmas. A path is mandatory.
   */
  readOnly?: boolean;
}

export class UnsupportedSchemaVersionError extends Error {
  readonly found: string;
  readonly supported: string;

  constructor(path: string, found: string) {
    super(`Database ${path} uses schema ${found}; this MABS build supports at most schema ${SCHEMA_VERSION}.`);
    this.name = "UnsupportedSchemaVersionError";
    this.found = found;
    this.supported = SCHEMA_VERSION;
  }
}

function schemaVersion(db: DatabaseSync, path: string): number | null {
  const table = db.prepare(
    "SELECT 1 present FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
  ).get() as { present: number } | undefined;
  if (!table) return null;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    | { value: unknown }
    | undefined;
  if (!row) return null;
  const raw = String(row.value);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`Database ${path} has invalid schema_version metadata: ${JSON.stringify(raw)}.`);
  }
  const version = Number(raw);
  if (version > Number(SCHEMA_VERSION)) throw new UnsupportedSchemaVersionError(path, raw);
  return version;
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly readOnly: boolean;
  private transactionDepth = 0;

  constructor(path?: string, options: StoreOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    if (this.readOnly && path === undefined) {
      throw new Error("Read-only Store access requires an explicit database path.");
    }
    this.path = path ?? dbPath();
    if (this.readOnly) {
      if (this.path === ":memory:") throw new Error("Read-only Store access requires a filesystem database path.");
      if (!existsSync(this.path) || !statSync(this.path).isFile()) {
        throw new Error(`Read-only database does not exist or is not a file: ${this.path}`);
      }
      this.db = new DatabaseSync(this.path, { readOnly: true });
      try {
        // query_only is connection-local. It is defense in depth on top of the
        // read-only SQLite handle and does not alter source metadata.
        this.db.exec("PRAGMA query_only = ON");
        schemaVersion(this.db, this.path);
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }

    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    try {
      // Refuse a future database before WAL or DDL can touch it. This protects
      // against an older binary stamping a newer schema down.
      schemaVersion(this.db, this.path);
      // WAL keeps the workbench's reads from blocking the controller's writes.
      if (this.path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  static openReadOnly(path: string): Store {
    return new Store(path, { readOnly: true });
  }

  private migrate(): void {
    const schema = readFileSync(join(HERE, "schema.sql"), "utf8");
    this.tx(() => {
      this.db.exec(schema);
      const ensureColumn = (table: string, name: string, definition: string) => {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      };
      ensureColumn("projects", "review_policy", "TEXT NOT NULL DEFAULT '{\"mode\":\"substantive\",\"skipTaskClasses\":[\"mechanical\",\"planning\",\"research\"]}'");
      ensureColumn("projects", "routing_overrides", "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn("projects", "prompt_profile", "TEXT NOT NULL DEFAULT '{\"implementationAddendum\":null,\"reviewAddendum\":null,\"researchAddendum\":null}'");
      ensureColumn("projects", "controller_settings", "TEXT NOT NULL DEFAULT '{\"defaultRepairLimit\":2,\"contextBudgetTokens\":12000}'");
      ensureColumn("config_versions", "project_id", "TEXT REFERENCES projects(id) ON DELETE CASCADE");
      ensureColumn("config_versions", "parent_id", "TEXT REFERENCES config_versions(id)");
      ensureColumn("config_versions", "kind", "TEXT NOT NULL DEFAULT 'snapshot'");
      ensureColumn("config_versions", "revision", "TEXT");
      ensureColumn("config_activations", "source_config_version", "TEXT");
      ensureColumn("curator_evaluations", "case_results", "TEXT NOT NULL DEFAULT '[]'");
      this.db.exec("CREATE INDEX IF NOT EXISTS config_versions_by_project ON config_versions(project_id, active, created_at)");
      ensureColumn("tasks", "record_version", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn("tasks", "task_class", "TEXT NOT NULL DEFAULT 'small_implementation'");
      ensureColumn("tasks", "complexity", "TEXT NOT NULL DEFAULT 'medium'");
      ensureColumn("tasks", "ambiguity", "TEXT NOT NULL DEFAULT 'low'");
      ensureColumn("tasks", "change_risk", "TEXT NOT NULL DEFAULT 'medium'");
      ensureColumn("tasks", "language", "TEXT");
      ensureColumn("tasks", "domain", "TEXT");
      ensureColumn("tasks", "context_size", "TEXT NOT NULL DEFAULT 'medium'");
      ensureColumn("tasks", "required_tools", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("tasks", "allowed_scope", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("tasks", "execution_reason", "TEXT");
      // v13: reusable guidance provenance and resumable bootstrap profile evidence.
      ensureColumn("attempts", "prompt_version", "TEXT");
      ensureColumn("attempts", "skill_versions", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("bootstrap_runs", "profile_resolution", "TEXT");
      ensureColumn("bootstrap_runs", "environment_plan", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("bootstrap_runs", "artifacts", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("context_packets", "config_version", "TEXT");
      ensureColumn("context_packets", "provider", "TEXT");
      ensureColumn("context_packets", "checkpoint_id", "TEXT");
      ensureColumn("context_packets", "budget_tokens", "INTEGER");
      // v11: packet provenance, review finding severity, product intake.
      ensureColumn("context_packets", "source_workspace", "TEXT");
      ensureColumn("context_packets", "inspected_revision", "TEXT");
      ensureColumn("review_results", "blocking_findings", "TEXT");
      ensureColumn("review_results", "advisory_findings", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("review_results", "policy_version", "TEXT");
      ensureColumn("review_results", "context_fingerprint", "TEXT");
      ensureColumn("controller_health", "stale_heartbeat_workers", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("controller_health", "oldest_claim_age_s", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("controller_health", "slot_utilization", "REAL NOT NULL DEFAULT 0");
      ensureColumn("controller_health", "uptime_s", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("controller_health", "provider_status", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("controller_health", "backpressure_reason", "TEXT");
      this.db
        .prepare("INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(SCHEMA_VERSION);
    });
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }

  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    if (this.readOnly) throw new Error("Cannot run a mutating statement through a read-only Store.");
    this.db.prepare(sql).run(...(params as never[]));
  }

  /**
   * Run a unit of work in one transaction. Task state and its event are always
   * written together so history can never disagree with current state.
   */
  tx<T>(fn: () => T): T {
    if (this.readOnly) throw new Error("Cannot start a write transaction through a read-only Store.");
    const nested = this.transactionDepth > 0;
    const savepoint = `mabs_tx_${this.transactionDepth}`;
    if (nested) this.db.exec(`SAVEPOINT ${savepoint}`);
    else this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = fn();
      if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      else this.db.exec("COMMIT");
      this.transactionDepth -= 1;
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.db.exec("ROLLBACK");
        }
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}
