/**
 * Cohort subtotals over normalized attempt usage and recorded attempt duration.
 *
 * Every consumer that shows a token or elapsed-time figure builds it here, so
 * one rule holds everywhere: a known subtotal is reported together with how many
 * attempts were measured and which ones were not. A cohort with some missing
 * measurements is `partial` with a real subtotal; a cohort with no measurement
 * at all stays null. Missing never becomes zero.
 */
import { normalizeUsageStream, USAGE_NORMALIZER_VERSION, type UsageSourceEvent } from "./normalize.ts";
import type {
  AttemptDuration,
  DurationSubtotal,
  NormalizedUsage,
  UsageCohortCoverage,
  UsageSourceSemantics,
  UsageSubtotal,
} from "./types.ts";

export const USAGE_SUBTOTAL_SEMANTICS =
  "Known provider-reported token events under each provider's own semantics. "
  + "Not unique tokens, not a normalized billing unit, and not subscription spend.";

export interface UsageAttemptSource {
  attemptId: string;
  adapter: string;
  /** Recorded envelope: a JSON string, a parsed object, or null when absent. */
  raw?: unknown;
  /** Recorded incremental stream, when one was captured. */
  events?: readonly UsageSourceEvent[];
  providerSchemaVersion?: string | null;
  reportedModel?: string | null;
}

export interface NormalizedAttemptUsage {
  attemptId: string;
  usage: NormalizedUsage;
}

export function normalizeAttemptUsage(source: UsageAttemptSource): NormalizedUsage {
  const events: readonly UsageSourceEvent[] = source.events
    ?? [{ id: "final-envelope", kind: "final", raw: source.raw ?? null }];
  return normalizeUsageStream(source.adapter, events, {
    providerSchemaVersion: source.providerSchemaVersion ?? null,
    reportedModel: source.reportedModel ?? null,
  });
}

export function summarizeUsage(sources: Iterable<UsageAttemptSource>): UsageSubtotal {
  const normalized: NormalizedAttemptUsage[] = [];
  for (const source of sources) normalized.push({ attemptId: source.attemptId, usage: normalizeAttemptUsage(source) });
  return subtotalOf(normalized);
}

export function subtotalOf(normalized: readonly NormalizedAttemptUsage[]): UsageSubtotal {
  let inputContributors = 0;
  let outputContributors = 0;
  let knownInputEvents = 0;
  let knownOutputTokens = 0;
  let completeAttempts = 0;
  let partialAttempts = 0;
  const missingAttempts: string[] = [];
  const malformedAttempts: string[] = [];
  const conflicts: string[] = [];
  const semantics = new Set<UsageSourceSemantics>();

  for (const { attemptId, usage } of normalized) {
    semantics.add(usage.sourceSemantics);
    for (const conflict of usage.conflicts) conflicts.push(`${attemptId}: ${conflict}`);
    if (usage.coverage === "complete") completeAttempts += 1;
    else if (usage.coverage === "partial") partialAttempts += 1;
    else if (usage.coverage === "missing") missingAttempts.push(attemptId);
    else malformedAttempts.push(attemptId);
    if (usage.knownInputEvents !== null) {
      knownInputEvents += usage.knownInputEvents;
      inputContributors += 1;
    }
    if (usage.outputTokens !== null) {
      knownOutputTokens += usage.outputTokens;
      outputContributors += 1;
    }
  }

  const measuredAttempts = completeAttempts + partialAttempts;
  let coverage: UsageCohortCoverage;
  if (normalized.length === 0) coverage = "not_applicable";
  else if (measuredAttempts === 0) coverage = malformedAttempts.length > 0 && missingAttempts.length === 0 ? "malformed" : "missing";
  else if (completeAttempts === normalized.length && conflicts.length === 0) coverage = "complete";
  else coverage = "partial";

  return {
    normalizerVersion: USAGE_NORMALIZER_VERSION,
    coverage,
    semantics: USAGE_SUBTOTAL_SEMANTICS,
    sourceSemantics: [...semantics].sort(),
    knownInputEvents: inputContributors === 0 ? null : knownInputEvents,
    knownOutputTokens: outputContributors === 0 ? null : knownOutputTokens,
    attempts: normalized.length,
    measuredAttempts,
    completeAttempts,
    partialAttempts,
    missingAttempts,
    malformedAttempts,
    conflicts,
  };
}

/**
 * Recorded attempt duration is `ended_at - started_at`. A still-running attempt
 * is not a missing measurement, and reversed timestamps are reported rather
 * than clamped to zero.
 */
export function attemptDuration(input: {
  startedAt: unknown;
  endedAt: unknown;
  state?: string | null;
}): AttemptDuration {
  const startedAt = typeof input.startedAt === "string" ? input.startedAt : null;
  const endedAt = typeof input.endedAt === "string" ? input.endedAt : null;
  if (startedAt === null) {
    return { status: "missing", milliseconds: null, detail: "started_at is absent" };
  }
  if (endedAt === null) {
    return input.state === "running"
      ? { status: "running", milliseconds: null, detail: "the attempt has not ended" }
      : { status: "missing", milliseconds: null, detail: "ended_at is absent" };
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { status: "invalid", milliseconds: null, detail: "a recorded timestamp is not parseable" };
  }
  if (end < start) {
    return { status: "invalid", milliseconds: null, detail: "ended_at precedes started_at" };
  }
  return { status: "measured", milliseconds: end - start, detail: null };
}

export function summarizeDurations(
  sources: Iterable<{ attemptId: string; startedAt: unknown; endedAt: unknown; state?: string | null }>,
): DurationSubtotal {
  const subtotal: DurationSubtotal = {
    milliseconds: 0,
    measuredAttempts: 0,
    runningAttempts: [],
    missingAttempts: [],
    invalidAttempts: [],
  };
  for (const source of sources) {
    const duration = attemptDuration(source);
    if (duration.status === "measured") {
      subtotal.milliseconds += duration.milliseconds as number;
      subtotal.measuredAttempts += 1;
    } else if (duration.status === "running") subtotal.runningAttempts.push(source.attemptId);
    else if (duration.status === "missing") subtotal.missingAttempts.push(source.attemptId);
    else subtotal.invalidAttempts.push(source.attemptId);
  }
  return subtotal;
}
