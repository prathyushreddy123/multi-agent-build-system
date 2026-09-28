/**
 * Optional telemetry exporters. Disabled unless an operator passes an explicit
 * target; with none configured, nothing is written anywhere and no network
 * request is made.
 *
 * Exported events are metadata only. `redactEvent` keeps an allowlist of
 * structural fields and drops anything that could carry a prompt, file
 * excerpt, credential, or other free text, so raw prompts are never exported.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { TelemetryEvent, TelemetryExporter } from "./sink.ts";

export const EXPORT_SCHEMA_VERSION = "mabs.telemetry-export.v1";

const ALLOWED_DATA_KEYS = new Set([
  "provider", "events", "lastEventType", "logBytes", "gaps", "decision", "quotaDomain", "state", "stage",
  "failureClass", "category", "reasons", "workKind", "from", "to", "ceiling", "pressure", "attemptKind",
]);
const SENSITIVE = /prompt|content|excerpt|secret|password|credential|api.?key|authorization|cookie|env\b|finalMessage|stdout|stderr|raw/i;

/** Structural metadata only; free text is truncated and sensitive keys are dropped. */
export function redactEvent(event: TelemetryEvent): TelemetryEvent {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    if (!ALLOWED_DATA_KEYS.has(key) || SENSITIVE.test(key)) continue;
    if (typeof value === "string") data[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) data[key] = value;
    else if (Array.isArray(value)) data[key] = value.slice(0, 20).map((item) => (typeof item === "string" ? item.slice(0, 200) : item));
  }
  return { kind: event.kind, at: event.at, taskId: event.taskId ?? null, attemptId: event.attemptId ?? null, data };
}

/** Local JSON-lines file. No network. */
export class FileExporter implements TelemetryExporter {
  readonly name: string;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.name = `file:${path}`;
  }

  async export(events: readonly TelemetryEvent[]): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, events.map((event) => JSON.stringify({ schema: EXPORT_SCHEMA_VERSION, ...redactEvent(event) })).join("\n") + "\n", { mode: 0o600 });
  }
}

/**
 * OTLP-style JSON over HTTP to an explicitly configured collector. Each batch
 * has a timeout so a hung collector cannot hold a flush open indefinitely.
 */
export class HttpJsonExporter implements TelemetryExporter {
  readonly name: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(endpoint: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Telemetry endpoint must be http or https.");
    this.endpoint = url.toString();
    this.name = `http:${url.host}`;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async export(events: readonly TelemetryEvent[]): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: EXPORT_SCHEMA_VERSION, events: events.map(redactEvent) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Telemetry endpoint returned ${response.status}`);
  }
}

/** `file:<path>` or `http(s)://...`; anything else is rejected. Undefined means disabled. */
export function exporterFromSpec(spec: string | undefined): TelemetryExporter | null {
  if (!spec) return null;
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length);
    if (!path.startsWith("/")) throw new Error("--export=file: requires an absolute path.");
    return new FileExporter(path);
  }
  if (/^https?:\/\//.test(spec)) return new HttpJsonExporter(spec);
  throw new Error("--export must be file:/absolute/path or an http(s) collector URL.");
}
