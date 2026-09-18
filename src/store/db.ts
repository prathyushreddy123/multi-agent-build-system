import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

import { dbPath } from "../core/paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = "10";

export type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private transactionDepth = 0;

  constructor(path?: string) {
    this.path = path ?? dbPath();
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    // WAL keeps the workbench's reads from blocking the controller's writes.
    if (this.path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const schema = readFileSync(join(HERE, "schema.sql"), "utf8");
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
    ensureColumn("context_packets", "config_version", "TEXT");
    ensureColumn("context_packets", "provider", "TEXT");
    ensureColumn("context_packets", "checkpoint_id", "TEXT");
    ensureColumn("context_packets", "budget_tokens", "INTEGER");
    ensureColumn("controller_health", "stale_heartbeat_workers", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("controller_health", "oldest_claim_age_s", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("controller_health", "slot_utilization", "REAL NOT NULL DEFAULT 0");
    ensureColumn("controller_health", "uptime_s", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("controller_health", "provider_status", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("controller_health", "backpressure_reason", "TEXT");
    this.db
      .prepare("INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SCHEMA_VERSION);
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }

  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  /**
   * Run a unit of work in one transaction. Task state and its event are always
   * written together so history can never disagree with current state.
   */
  tx<T>(fn: () => T): T {
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
