/**
 * Phase 4 — evidence lookup and following.
 *
 * The Logs surface opens the original evidence the controller already wrote:
 * worker transcripts and results, check output, review detail, and context
 * manifests. It creates no new log store and copies nothing.
 *
 * Three constraints shape the reader:
 *  - reads are bounded chunks, not repeated whole-file loads;
 *  - a partial trailing line is never emitted, so an append cannot produce a
 *    duplicate displayed record;
 *  - captured control sequences are escaped when drawn. The file on disk is
 *    left byte-for-byte intact, because it is the evidence.
 */
import { openSync, closeSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { artifactDir, stateDir } from "../core/paths.ts";
import type { Records } from "../store/records.ts";
import { escapeControlSequences } from "./rendering.ts";

export const DEFAULT_CHUNK_BYTES = 64 * 1024;

export type EvidenceKind = "worker-result" | "worker-transcript" | "completion" | "check" | "review" | "context-manifest";

export interface EvidenceEntry {
  /** Stable across refreshes. */
  id: string;
  taskId: string;
  attemptId: string | null;
  attemptNumber: number | null;
  kind: EvidenceKind;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Structured records support per-command navigation; a raw transcript does not. */
  format: "json" | "text";
  navigation: "per-record" | "whole-transcript";
  /** Why navigation is limited, when it is. */
  navigationNote: string | null;
  /** Why the file cannot be opened, when it cannot. */
  unavailableReason: string | null;
}

export interface EvidenceListing {
  taskId: string;
  attempts: { attemptId: string; attemptNumber: number; kind: string; adapter: string; model: string | null; state: string; startedAt: string; endedAt: string | null }[];
  entries: EvidenceEntry[];
  notes: string[];
}

export class EvidenceAccessError extends Error {}

/**
 * Evidence lives under the state directory's artifacts root. Anything else is
 * refused: the Logs surface is not a general file reader.
 */
export function assertInsideArtifacts(path: string): string {
  const root = resolve(join(stateDir(), "artifacts"));
  let canonicalRoot = root;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw new EvidenceAccessError(`The MABS evidence directory ${root} does not exist.`);
  }
  let candidate = resolve(path);
  try {
    candidate = realpathSync(candidate);
  } catch {
    // A missing file is reported by the caller; containment of the literal
    // path is still checked below.
    candidate = resolve(path);
  }
  if (candidate !== canonicalRoot && !candidate.startsWith(canonicalRoot + sep)) {
    throw new EvidenceAccessError(`${path} is outside the MABS evidence directory`);
  }
  return candidate;
}

function fileFacts(path: string): { exists: boolean; sizeBytes: number | null; modifiedAt: string | null } {
  try {
    const stats = statSync(path);
    return { exists: stats.isFile(), sizeBytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
  } catch {
    return { exists: false, sizeBytes: null, modifiedAt: null };
  }
}

function entry(input: Omit<EvidenceEntry, "exists" | "sizeBytes" | "modifiedAt" | "unavailableReason">): EvidenceEntry {
  const facts = fileFacts(input.path);
  return {
    ...input,
    ...facts,
    unavailableReason: facts.exists
      ? null
      : `${input.path} is not on disk. Attempt evidence is eligible for retention pruning after 30 days for completed tasks and 90 for failed ones; the record itself remains in the database.`,
  };
}

/**
 * List every evidence record for one task, optionally narrowed to one attempt.
 *
 * Old attempts stay listed: a retry adds evidence, it does not replace it.
 */
export function listEvidence(records: Records, options: { taskId: string; attemptId?: string | null }): EvidenceListing {
  const task = records.getTask(options.taskId);
  if (!task) throw new EvidenceAccessError(`Unknown task ${options.taskId}`);

  const allAttempts = records.listAttempts(task.id);
  const attempts = options.attemptId
    ? allAttempts.filter((attempt) => attempt.id === options.attemptId || attempt.id.startsWith(options.attemptId as string))
    : allAttempts;
  if (options.attemptId && attempts.length === 0) {
    throw new EvidenceAccessError(`No attempt ${options.attemptId} on task ${task.id}`);
  }
  const selected = new Set(attempts.map((attempt) => attempt.id));
  const numbers = new Map(allAttempts.map((attempt) => [attempt.id, attempt.attemptNumber]));

  const entries: EvidenceEntry[] = [];
  for (const attempt of attempts) {
    const dir = join(stateDir(), "artifacts", task.id, attempt.id);
    if (attempt.outputPath) {
      entries.push(entry({
        id: `result:${attempt.id}`, taskId: task.id, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
        kind: "worker-result", label: `attempt ${attempt.attemptNumber} result`, path: attempt.outputPath,
        format: "json", navigation: "per-record", navigationNote: null,
      }));
    }
    entries.push(entry({
      id: `transcript:${attempt.id}`, taskId: task.id, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
      kind: "worker-transcript", label: `attempt ${attempt.attemptNumber} transcript (${attempt.adapter})`,
      path: join(dir, "worker.log"), format: "text", navigation: "whole-transcript",
      // The provider streams one transcript; it is kept as written rather than
      // re-segmented into commands that were never recorded as separate events.
      navigationNote:
        "This is the provider's raw transcript. MABS records no per-command boundaries inside it, " +
        "so navigation is by position in the file, not by individual tool call.",
    }));
    entries.push(entry({
      id: `completion:${attempt.id}`, taskId: task.id, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
      kind: "completion", label: `attempt ${attempt.attemptNumber} completion envelope`,
      path: join(dir, "completion.json"), format: "json", navigation: "per-record", navigationNote: null,
    }));
  }

  for (const gate of records.gatesForTask(task.id)) {
    if (!gate.evidencePath) continue;
    if (gate.attemptId && !selected.has(gate.attemptId) && options.attemptId) continue;
    entries.push(entry({
      id: `check:${gate.id}`, taskId: task.id, attemptId: gate.attemptId,
      attemptNumber: gate.attemptId ? numbers.get(gate.attemptId) ?? null : null,
      kind: "check", label: `${gate.name} ${gate.status}${gate.required ? "" : " (advisory)"}`,
      path: gate.evidencePath, format: "text", navigation: "per-record",
      navigationNote: null,
    }));
  }

  for (const review of records.reviewsForTask(task.id)) {
    if (!review.evidencePath) continue;
    if (!selected.has(review.attemptId) && options.attemptId) continue;
    entries.push(entry({
      id: `review:${review.id}`, taskId: task.id, attemptId: review.attemptId,
      attemptNumber: numbers.get(review.attemptId) ?? null,
      kind: "review", label: `review ${review.verdict}`, path: review.evidencePath,
      format: "json", navigation: "per-record", navigationNote: null,
    }));
  }

  for (const packet of records.packetsForTask(task.id)) {
    const manifest = packet.manifest_path as string | null;
    if (!manifest) continue;
    const attemptId = (packet.attempt_id as string | null) ?? null;
    if (attemptId && !selected.has(attemptId) && options.attemptId) continue;
    entries.push(entry({
      id: `manifest:${String(packet.id)}`, taskId: task.id, attemptId,
      attemptNumber: attemptId ? numbers.get(attemptId) ?? null : null,
      kind: "context-manifest", label: `context packet ${String(packet.id)}`, path: manifest,
      format: "json", navigation: "per-record", navigationNote: null,
    }));
  }

  const notes: string[] = [];
  const missing = entries.filter((item) => !item.exists);
  if (missing.length > 0) {
    notes.push(`${missing.length} evidence file(s) are no longer on disk. Their database records remain.`);
  }
  if (entries.some((item) => item.navigation === "whole-transcript")) {
    notes.push(
      "Worker transcripts are the provider's raw output. Per-command navigation inside them is not available, " +
      "because MABS does not record command boundaries there.",
    );
  }
  if (allAttempts.length > attempts.length) {
    notes.push(`${allAttempts.length - attempts.length} earlier attempt(s) are hidden by the attempt filter but remain available.`);
  }

  return {
    taskId: task.id,
    attempts: allAttempts.map((attempt) => ({
      attemptId: attempt.id, attemptNumber: attempt.attemptNumber, kind: attempt.kind,
      adapter: attempt.adapter, model: attempt.model, state: attempt.state,
      startedAt: attempt.startedAt, endedAt: attempt.endedAt,
    })),
    entries: entries.sort((left, right) => (left.attemptNumber ?? 0) - (right.attemptNumber ?? 0) || left.id.localeCompare(right.id)),
    notes,
  };
}

// --------------------------------------------------------------------------
// bounded reading and following
// --------------------------------------------------------------------------

export interface FileIdentity {
  /** Device and inode, so a replaced file is recognized rather than re-read. */
  dev: number;
  ino: number;
  size: number;
}

export interface LogChunk {
  path: string;
  /** Byte offset this chunk started at. */
  from: number;
  /** Byte offset to resume from. A partial trailing line is not consumed. */
  to: number;
  /** Display-safe lines. Control sequences are escaped; the file is untouched. */
  lines: string[];
  identity: FileIdentity | null;
  /** The file was replaced or truncated since the previous read. */
  rotated: boolean;
  atEnd: boolean;
  /** Bytes skipped because the caller asked to start near the end. */
  skippedBytes: number;
  unavailableReason: string | null;
}

function identityOf(path: string): FileIdentity | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    return { dev: Number(stats.dev), ino: Number(stats.ino), size: stats.size };
  } catch {
    return null;
  }
}

export function sameFile(left: FileIdentity | null, right: FileIdentity | null): boolean {
  if (!left || !right) return false;
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Read one bounded chunk.
 *
 * `to` stops at the last complete newline, so a line still being written is
 * left for the next read instead of being shown twice.
 *
 * Reaching the end of the file does not make a trailing partial line complete:
 * a file mid-write looks exactly like one that simply has no final newline.
 * The fragment is only emitted when the caller knows there is nothing more
 * coming, which is what `allowPartialFinalLine` means.
 */
export function readChunk(
  path: string,
  options: {
    offset?: number;
    maxBytes?: number;
    previous?: FileIdentity | null;
    /** Emit a trailing line that has no newline. Only safe once writing has stopped. */
    allowPartialFinalLine?: boolean;
  } = {},
): LogChunk {
  const canonical = assertInsideArtifacts(path);
  const identity = identityOf(canonical);
  if (!identity) {
    return {
      path: canonical, from: options.offset ?? 0, to: options.offset ?? 0, lines: [], identity: null,
      rotated: false, atEnd: true, skippedBytes: 0,
      unavailableReason: `${path} is not a readable evidence file. It may have been pruned by the retention policy; the database record remains.`,
    };
  }

  const previous = options.previous ?? null;
  let offset = options.offset ?? 0;
  let rotated = false;
  if (previous && !sameFile(previous, identity)) {
    // The file was replaced. Start from the beginning of the new one rather
    // than at an offset that means nothing in it.
    rotated = true;
    offset = 0;
  } else if (offset > identity.size) {
    // Truncated in place.
    rotated = true;
    offset = 0;
  }

  const maxBytes = options.maxBytes ?? DEFAULT_CHUNK_BYTES;
  const available = Math.max(0, identity.size - offset);
  const length = Math.min(available, maxBytes);
  if (length === 0) {
    return { path: canonical, from: offset, to: offset, lines: [], identity, rotated, atEnd: true, skippedBytes: 0, unavailableReason: null };
  }

  const buffer = Buffer.alloc(length);
  const handle = openSync(canonical, "r");
  try {
    readSync(handle, buffer, 0, length, offset);
  } finally {
    closeSync(handle);
  }

  const text = buffer.toString("utf8");
  const reachedEnd = offset + length >= identity.size;
  const flush = options.allowPartialFinalLine === true && reachedEnd;
  const lastNewline = text.lastIndexOf("\n");
  const consumed = flush
    ? text.length
    : (lastNewline === -1 ? 0 : lastNewline + 1);
  const body = text.slice(0, consumed);
  const lines = body === "" ? [] : body.replace(/\n$/, "").split("\n").map(escapeControlSequences);

  return {
    path: canonical,
    from: offset,
    to: offset + Buffer.byteLength(body, "utf8"),
    lines,
    identity,
    rotated,
    atEnd: offset + Buffer.byteLength(body, "utf8") >= identity.size,
    skippedBytes: 0,
    unavailableReason: null,
  };
}

/** Read the last `lines` lines without loading the whole file. */
export function readTail(path: string, lines = 200, maxBytes = DEFAULT_CHUNK_BYTES * 4): LogChunk {
  const canonical = assertInsideArtifacts(path);
  const identity = identityOf(canonical);
  if (!identity) return readChunk(path, { offset: 0 });

  const window = Math.min(identity.size, maxBytes);
  const start = identity.size - window;
  // A one-shot tail is not following a live writer, so the final line is shown
  // even when the file does not end in a newline.
  const chunk = readChunk(canonical, { offset: start, maxBytes: window, allowPartialFinalLine: true });
  if (start > 0 && chunk.lines.length > 0) {
    // The window may have started mid-line; drop that fragment.
    chunk.lines.shift();
  }
  const kept = chunk.lines.slice(-lines);
  return { ...chunk, lines: kept, skippedBytes: start, from: start, to: identity.size, atEnd: true };
}

export interface FollowOptions {
  /** Start here. Defaults to the end, so following does not replay history. */
  fromOffset?: number;
  pollMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Stop once the run that produced this file has ended. */
  isFinished?: () => boolean;
}

/**
 * Follow a file, yielding only new bytes.
 *
 * Appends, in-place truncation, and replacement are all handled. The generator
 * ends when the signal aborts or `isFinished` reports the run is over, so
 * closing the Logs surface never touches a worker.
 */
export async function* followLog(path: string, options: FollowOptions = {}): AsyncGenerator<LogChunk> {
  const pollMs = Math.max(100, options.pollMs ?? 400);
  let identity = identityOf(assertInsideArtifacts(path));
  let offset = options.fromOffset ?? identity?.size ?? 0;
  let finishedSeen = false;

  while (!options.signal?.aborted) {
    // While the run is live a trailing fragment is held back. Once it has
    // finished, the last partial line is flushed so nothing is lost.
    const finished = options.isFinished?.() === true;
    const chunk = readChunk(path, {
      offset,
      maxBytes: options.maxBytes,
      previous: identity,
      allowPartialFinalLine: finished && finishedSeen,
    });
    if (chunk.lines.length > 0 || chunk.rotated || chunk.unavailableReason) yield chunk;
    offset = chunk.to;
    if (chunk.identity) identity = chunk.identity;

    // Give the run one more poll after it reports finished, so a final write
    // that landed between the last read and the state change is still shown.
    if (finished) {
      if (finishedSeen && chunk.atEnd) return;
      finishedSeen = true;
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

/** Directory holding one attempt's evidence, created on demand by the controller. */
export function attemptEvidenceDir(taskId: string, attemptId: string): string {
  return artifactDir(taskId, attemptId);
}
