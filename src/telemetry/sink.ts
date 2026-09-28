/**
 * Optional telemetry fan-out.
 *
 * Execution never waits on, or fails because of, telemetry. Events go into a
 * bounded in-memory queue; an exporter drains it on its own schedule. When the
 * queue is full the oldest events are dropped and counted. Exporter failures
 * are counted and the batch is retained up to the bound. With no exporter
 * configured the queue is a no-op and nothing leaves the machine.
 */
export interface TelemetryEvent {
  kind: string;
  at: string;
  taskId?: string | null;
  attemptId?: string | null;
  /** Redacted metadata only: no prompts, file contents, or secrets. */
  data: Record<string, unknown>;
}

export interface TelemetryExporter {
  readonly name: string;
  export(events: readonly TelemetryEvent[]): Promise<void>;
}

export interface TelemetryStats {
  queued: number;
  emitted: number;
  exported: number;
  dropped: number;
  exportFailures: number;
  lastExportError: string | null;
  exporter: string | null;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  stats(): TelemetryStats;
}

export const DEFAULT_TELEMETRY_QUEUE = 1_000;

export class BoundedTelemetryQueue implements TelemetrySink {
  private readonly queue: TelemetryEvent[] = [];
  private readonly capacity: number;
  private readonly exporter: TelemetryExporter | null;
  private flushing: Promise<void> | null = null;
  private counters = { emitted: 0, exported: 0, dropped: 0, exportFailures: 0 };
  private lastExportError: string | null = null;

  constructor(options: { exporter?: TelemetryExporter | null; capacity?: number } = {}) {
    this.exporter = options.exporter ?? null;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_TELEMETRY_QUEUE);
  }

  emit(event: TelemetryEvent): void {
    // Without an exporter nothing is retained: disabled export means no data leaves.
    if (!this.exporter) return;
    this.counters.emitted += 1;
    this.queue.push(event);
    while (this.queue.length > this.capacity) {
      this.queue.shift();
      this.counters.dropped += 1;
    }
  }

  /**
   * Send what is queued. Never throws and never rejects; a failed batch stays
   * queued (bounded) for the next attempt.
   */
  flush(): Promise<void> {
    if (!this.exporter || this.queue.length === 0) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const batch = this.queue.splice(0, this.queue.length);
    const exporter = this.exporter;
    this.flushing = (async () => {
      try {
        await exporter.export(batch);
        this.counters.exported += batch.length;
        this.lastExportError = null;
      } catch (error) {
        this.counters.exportFailures += 1;
        this.lastExportError = error instanceof Error ? error.message : String(error);
        this.queue.unshift(...batch);
        while (this.queue.length > this.capacity) {
          this.queue.shift();
          this.counters.dropped += 1;
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  stats(): TelemetryStats {
    return {
      queued: this.queue.length,
      ...this.counters,
      lastExportError: this.lastExportError,
      exporter: this.exporter?.name ?? null,
    };
  }
}

/** Disabled telemetry: the default. */
export const DISABLED_TELEMETRY: TelemetrySink = new BoundedTelemetryQueue();
