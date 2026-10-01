/**
 * Idempotency records for conversational intake operations. A request id is
 * bound to the hash of the exact request the first time it is seen: an
 * identical retry gets the recorded outcome back, and a different request
 * under the same id is refused rather than silently applied.
 */
import { createHash } from "node:crypto";

import { nowIso } from "../store/db.ts";
import type { Records } from "../store/records.ts";
import { IntakeError } from "./errors.ts";

export type IntakeOperation = "resolve" | "start";
export type IntakeRequestState = "in_progress" | "completed" | "failed";

export interface IntakeRequest<P = Record<string, unknown>, R = unknown> {
  requestId: string;
  briefId: string;
  operation: IntakeOperation;
  payloadHash: string;
  state: IntakeRequestState;
  progress: P;
  result: R | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** JSON with object keys sorted at every depth, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(operation: IntakeOperation, payload: unknown): string {
  return createHash("sha256").update(`${operation}\n${canonical(payload)}`).digest("hex");
}

function toRequest<P, R>(row: Record<string, unknown>): IntakeRequest<P, R> {
  return {
    requestId: String(row.request_id),
    briefId: String(row.brief_id),
    operation: row.operation as IntakeOperation,
    payloadHash: String(row.payload_hash),
    state: row.state as IntakeRequestState,
    progress: JSON.parse(String(row.progress ?? "{}")) as P,
    result: row.result ? JSON.parse(String(row.result)) as R : null,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getIntakeRequest<P = Record<string, unknown>, R = unknown>(records: Records, requestId: string): IntakeRequest<P, R> | null {
  const row = records.store.get("SELECT * FROM intake_requests WHERE request_id = ?", requestId);
  return row ? toRequest<P, R>(row) : null;
}

/**
 * The request recorded under this id, refusing one that was made for a
 * different operation, brief, or payload. Null when the id is new.
 */
export function matchIntakeRequest<P = Record<string, unknown>, R = unknown>(records: Records, input: {
  requestId: string;
  briefId: string;
  operation: IntakeOperation;
  payloadHash: string;
}): IntakeRequest<P, R> | null {
  const existing = getIntakeRequest<P, R>(records, input.requestId);
  if (!existing) return null;
  if (existing.operation !== input.operation || existing.briefId !== input.briefId || existing.payloadHash !== input.payloadHash) {
    throw new IntakeError(
      "request_conflict",
      `Request ${input.requestId} was already used for a different ${existing.operation} request on brief ${existing.briefId}; ` +
      "use a new request id for a new request.",
      { requestId: input.requestId, recordedOperation: existing.operation, recordedBriefId: existing.briefId },
    );
  }
  return existing;
}

export function insertIntakeRequest<P>(records: Records, input: {
  requestId: string;
  briefId: string;
  operation: IntakeOperation;
  payloadHash: string;
  state: IntakeRequestState;
  progress?: P;
  result?: unknown;
}): void {
  const now = nowIso();
  records.store.run(
    `INSERT INTO intake_requests(request_id, brief_id, operation, payload_hash, state, progress, result, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    input.requestId, input.briefId, input.operation, input.payloadHash, input.state,
    JSON.stringify(input.progress ?? {}), input.result === undefined ? null : JSON.stringify(input.result), now, now,
  );
}

export function updateIntakeRequest<P>(records: Records, requestId: string, patch: {
  state?: IntakeRequestState;
  progress?: P;
  result?: unknown;
  error?: string | null;
}): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.state !== undefined) { sets.push("state = ?"); values.push(patch.state); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); values.push(JSON.stringify(patch.progress)); }
  if (patch.result !== undefined) { sets.push("result = ?"); values.push(JSON.stringify(patch.result)); }
  if (patch.error !== undefined) { sets.push("error = ?"); values.push(patch.error); }
  sets.push("updated_at = ?");
  values.push(nowIso());
  records.store.run(`UPDATE intake_requests SET ${sets.join(", ")} WHERE request_id = ?`, ...values, requestId);
}
