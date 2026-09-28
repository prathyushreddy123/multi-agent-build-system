/**
 * Live, bounded worker telemetry.
 *
 * Provider output is streamed to disk as it arrives rather than written once
 * the process exits, so an operator can see a long run while it happens. Every
 * buffer here is bounded, and every bound that is hit is reported: a truncated
 * log says so in the log itself and in the progress record, never silently.
 *
 * Nothing in this module is authoritative task state. Progress records are
 * observations; the completion envelope remains the result of record.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const TELEMETRY_VERSION = "mabs.telemetry.v1";
/** Default live-log budget per attempt. */
export const DEFAULT_LIVE_LOG_BYTES = 16 * 1024 * 1024;
/** Longest single line retained for parsing; longer lines are counted, not parsed. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

/**
 * Split an already-decoded text stream into complete lines. Chunk boundaries
 * may fall anywhere, including inside a JSON object; a partial line is held
 * until its newline arrives.
 */
export class LineAssembler {
  private pending = "";
  oversizedLines = 0;

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    if (this.pending.length > MAX_LINE_CHARS) {
      // Keep the process bounded: an endless unterminated line is dropped and counted.
      this.oversizedLines += 1;
      this.pending = "";
    }
    return parts;
  }

  /** The unterminated remainder once the stream has ended. */
  flush(): string[] {
    const rest = this.pending;
    this.pending = "";
    return rest ? [rest] : [];
  }
}

export interface LiveLogStats {
  bytesWritten: number;
  bytesDropped: number;
  truncated: boolean;
  writeErrors: number;
}

/**
 * Append-only evidence file with a byte budget. Once the budget is reached a
 * single marker line is written and further output is counted as dropped.
 * A write failure is counted and never stops the worker.
 */
export class LiveLog {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly stats: LiveLogStats = { bytesWritten: 0, bytesDropped: 0, truncated: false, writeErrors: 0 };

  constructor(path: string, maxBytes = DEFAULT_LIVE_LOG_BYTES) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  write(text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.stats.truncated) {
      this.stats.bytesDropped += bytes;
      return;
    }
    const remaining = this.maxBytes - this.stats.bytesWritten;
    let kept = text;
    if (bytes > remaining) {
      // Cut on a character boundary so the file stays valid UTF-8.
      kept = Buffer.from(text, "utf8").subarray(0, Math.max(0, remaining)).toString("utf8").replace(/�$/, "");
      this.stats.bytesDropped += bytes - Buffer.byteLength(kept, "utf8");
      this.stats.truncated = true;
    }
    try {
      if (kept) appendFileSync(this.path, kept, { mode: 0o600 });
      this.stats.bytesWritten += Buffer.byteLength(kept, "utf8");
      if (this.stats.truncated) {
        appendFileSync(this.path, `\n[mabs: live log truncated at ${this.maxBytes} bytes; later output is counted, not stored]\n`);
      }
    } catch {
      this.stats.writeErrors += 1;
    }
  }

  snapshot(): LiveLogStats {
    return { ...this.stats };
  }
}

export interface StreamProgress {
  telemetryVersion: string;
  provider: string;
  firstOutputAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
  events: number;
  /** Lines that were expected to be provider JSON events but did not parse. */
  malformedLines: number;
  /** Non-JSON lines from a provider that interleaves plain progress text. */
  textLines: number;
  oversizedLines: number;
  /**
   * Usage as the provider reported it so far. Informational only: the final
   * envelope is the single source of recorded usage, so nothing is counted twice.
   */
  observedUsage: Record<string, unknown> | null;
  log: LiveLogStats;
  final: boolean;
}

/**
 * Incremental parser for one provider's JSON-lines stream. It tracks progress
 * and remembers the final result event; it never synthesizes a value the
 * provider did not send.
 */
export class ProviderStreamParser {
  readonly provider: "claude" | "codex";
  private readonly assembler = new LineAssembler();
  private progress: Omit<StreamProgress, "log" | "final" | "oversizedLines">;
  /** Claude `type: "result"` event, verbatim. */
  resultLine: string | null = null;
  sessionId: string | null = null;
  agentMessage: string | null = null;
  lastUsage: Record<string, unknown> | null = null;

  constructor(provider: "claude" | "codex") {
    this.provider = provider;
    this.progress = {
      telemetryVersion: TELEMETRY_VERSION, provider, firstOutputAt: null, lastEventAt: null, lastEventType: null,
      events: 0, malformedLines: 0, textLines: 0, observedUsage: null,
    };
  }

  push(chunk: string, now = new Date()): void {
    for (const line of this.assembler.push(chunk)) this.accept(line, now);
  }

  end(now = new Date()): void {
    for (const line of this.assembler.flush()) this.accept(line, now);
  }

  private accept(raw: string, now: Date): void {
    const line = raw.trim();
    if (!line) return;
    this.progress.firstOutputAt ??= now.toISOString();
    if (!line.startsWith("{")) {
      this.progress.textLines += 1;
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.progress.malformedLines += 1;
      return;
    }
    this.progress.events += 1;
    this.progress.lastEventAt = now.toISOString();
    const type = typeof event.type === "string" ? event.type : null;
    this.progress.lastEventType = type;
    if (this.provider === "codex") {
      if (type === "thread.started" && typeof event.thread_id === "string") this.sessionId = event.thread_id;
      if (type === "turn.completed" && event.usage && typeof event.usage === "object") {
        this.lastUsage = event.usage as Record<string, unknown>;
        this.progress.observedUsage = this.lastUsage;
      }
      if (type === "item.completed") {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string" && this.agentMessage === null) this.agentMessage = item.text;
      }
    } else {
      if (typeof event.session_id === "string") this.sessionId = event.session_id;
      if (type === "result" || (type === null && "result" in event)) {
        this.resultLine = line;
        if (event.usage && typeof event.usage === "object") this.progress.observedUsage = event.usage as Record<string, unknown>;
      }
    }
  }

  snapshot(log: LiveLogStats, final: boolean): StreamProgress {
    return { ...this.progress, oversizedLines: this.assembler.oversizedLines, log, final };
  }
}

/**
 * Throttled, atomically replaced progress file. Readers never observe a
 * partially written record.
 */
export class ProgressWriter {
  readonly path: string;
  private readonly intervalMs: number;
  private lastWrite = 0;
  writeErrors = 0;

  constructor(path: string, intervalMs = 1_000) {
    this.path = path;
    this.intervalMs = intervalMs;
  }

  maybeWrite(progress: StreamProgress, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastWrite < this.intervalMs) return;
    this.lastWrite = now;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      this.writeErrors += 1;
    }
  }
}

/** Read a progress record; absent or unreadable telemetry is null, not an error. */
export function readProgress(path: string): StreamProgress | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StreamProgress;
    return parsed.telemetryVersion === TELEMETRY_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** True when any telemetry was lost or unreadable; the operator must be told. */
export function telemetryGap(progress: StreamProgress | null): string[] {
  if (!progress) return [];
  const gaps: string[] = [];
  if (progress.log.truncated) gaps.push(`live log truncated; ${progress.log.bytesDropped} bytes not stored`);
  if (progress.log.writeErrors > 0) gaps.push(`${progress.log.writeErrors} live-log write error(s)`);
  if (progress.malformedLines > 0) gaps.push(`${progress.malformedLines} malformed provider event line(s)`);
  if (progress.oversizedLines > 0) gaps.push(`${progress.oversizedLines} oversized line(s) dropped before parsing`);
  return gaps;
}
