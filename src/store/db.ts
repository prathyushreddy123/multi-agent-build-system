import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

import { dbPath } from "../core/paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = "3";

export type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

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
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!taskColumns.some((column) => column.name === "record_version")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1");
    }
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
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
