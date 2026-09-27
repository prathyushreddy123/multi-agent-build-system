/**
 * Provider usage normalization.
 *
 * This module only *reads* recorded provider evidence. `attempts.usage_json`
 * and any raw stream artifact stay byte-identical; every derived figure carries
 * its normalizer version, source semantics, and coverage so a partial or absent
 * measurement can never be mistaken for a measured zero.
 *
 * Two observed schemas are interpreted, and only because their semantics are
 * documented evidence:
 *
 *   - Codex: `input_tokens` already includes `cached_input_tokens`, so the
 *     cached subset is never added a second time.
 *   - Claude: `cache_read_input_tokens` and `cache_creation_input_tokens` are
 *     separate reported input events from `input_tokens`.
 *
 * Anything else is normalized as `generic-reported`: only the fields whose
 * meaning is unambiguous are interpreted, and the rest is left unknown.
 */
import type {
  NormalizedUsage,
  UsageCoverage,
  UsageModelSubtotal,
  UsageSourceSemantics,
  UsageStreamKind,
} from "./types.ts";

export const USAGE_NORMALIZER_VERSION = "mabs.provider-usage.v1";

export interface UsageSourceEvent {
  /** Stable provider event identity, used for deduplication. */
  id?: string | null;
  /** Provider sequence number, used for ordering and as a fallback identity. */
  sequence?: number | null;
  /** Declared stream semantics. Absent means the evidence does not say. */
  kind?: UsageStreamKind;
  raw: unknown;
}

export interface NormalizeUsageOptions {
  /** Provider or CLI schema version recorded alongside the usage evidence. */
  providerSchemaVersion?: string | null;
  /** Provider-reported model, when it was captured outside the usage envelope. */
  reportedModel?: string | null;
}

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cached_input_tokens",
  "reasoning_output_tokens",
] as const;

type TokenField = (typeof TOKEN_FIELDS)[number];

const FIELD_ALIASES: Record<TokenField, readonly string[]> = {
  input_tokens: ["input_tokens", "inputTokens"],
  output_tokens: ["output_tokens", "outputTokens"],
  cache_read_input_tokens: ["cache_read_input_tokens", "cacheReadInputTokens"],
  cache_creation_input_tokens: ["cache_creation_input_tokens", "cacheCreationInputTokens"],
  cached_input_tokens: ["cached_input_tokens", "cachedInputTokens"],
  reasoning_output_tokens: ["reasoning_output_tokens", "reasoningOutputTokens"],
};

/** Fields whose absence makes a provider's coverage incomplete. */
const EXPECTED_FIELDS: Record<UsageSourceSemantics, readonly TokenField[]> = {
  "claude-cache-is-separate": [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ],
  "codex-input-includes-cache": ["input_tokens", "output_tokens"],
  "generic-reported": ["input_tokens", "output_tokens"],
};

type Values = Partial<Record<TokenField, number | null>>;

interface ParsedEvent {
  identity: string;
  kind: UsageStreamKind;
  sequence: number | null;
  /** `missing`, `malformed`, or usable values. */
  state: "missing" | "malformed" | "values";
  values: Values;
  presentFields: TokenField[];
  invalidFields: TokenField[];
  models: UsageModelSubtotal[];
  reportedModel: string | null;
  providerSchemaVersion: string | null;
  detail: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Reported token counts are non-negative safe integers. Anything else is invalid. */
function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function sum(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

export function usageSemanticsFor(adapter: string): UsageSourceSemantics {
  const name = adapter.toLowerCase();
  if (name.includes("claude")) return "claude-cache-is-separate";
  if (name.includes("codex")) return "codex-input-includes-cache";
  return "generic-reported";
}

/** Read one token field through its observed aliases, separating absent from invalid. */
function readField(
  source: Record<string, unknown>,
  field: TokenField,
): { state: "absent" | "valid" | "invalid"; value: number | null } {
  for (const alias of FIELD_ALIASES[field]) {
    if (!(alias in source)) continue;
    const raw = source[alias];
    if (raw === null || raw === undefined) return { state: "absent", value: null };
    const value = token(raw);
    return value === null ? { state: "invalid", value: null } : { state: "valid", value };
  }
  return { state: "absent", value: null };
}

function readReasoning(source: Record<string, unknown>): { state: "absent" | "valid" | "invalid"; value: number | null } {
  const direct = readField(source, "reasoning_output_tokens");
  if (direct.state !== "absent") return direct;
  const details = asRecord(source.output_tokens_details) ?? asRecord(source.outputTokensDetails);
  if (!details || !("reasoning_tokens" in details)) return { state: "absent", value: null };
  const value = token(details.reasoning_tokens);
  return value === null ? { state: "invalid", value: null } : { state: "valid", value };
}

function modelBreakdown(envelope: Record<string, unknown>, semantics: UsageSourceSemantics): UsageModelSubtotal[] {
  const breakdown = asRecord(envelope.modelUsage) ?? asRecord(envelope.model_usage);
  if (!breakdown) return [];
  const models: UsageModelSubtotal[] = [];
  for (const [key, value] of Object.entries(breakdown)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const input = readField(entry, "input_tokens").value;
    const output = readField(entry, "output_tokens").value;
    const cacheRead = readField(entry, "cache_read_input_tokens").value;
    const cacheCreation = readField(entry, "cache_creation_input_tokens").value;
    const knownInputEvents = input === null
      ? null
      : semantics === "claude-cache-is-separate" ? input + (cacheRead ?? 0) + (cacheCreation ?? 0) : input;
    models.push({
      model: nullableString(entry.canonicalModel) ?? nullableString(entry.model) ?? key,
      knownInputEvents,
      outputTokens: output,
    });
  }
  return models.sort((left, right) => left.model.localeCompare(right.model));
}

function parseEvent(
  event: UsageSourceEvent,
  index: number,
  semantics: UsageSourceSemantics,
): ParsedEvent {
  const identity = nullableString(event.id)
    ?? (typeof event.sequence === "number" ? `sequence:${event.sequence}` : `index:${index}`);
  const base = {
    identity,
    kind: event.kind ?? "unknown",
    sequence: typeof event.sequence === "number" ? event.sequence : null,
    values: {} as Values,
    presentFields: [] as TokenField[],
    invalidFields: [] as TokenField[],
    models: [] as UsageModelSubtotal[],
    reportedModel: null as string | null,
    providerSchemaVersion: null as string | null,
  };

  let parsed: unknown = event.raw;
  if (typeof parsed === "string") {
    if (parsed.trim() === "") return { ...base, state: "missing", detail: "no provider usage was recorded" };
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return { ...base, state: "malformed", detail: "recorded usage is not valid JSON" };
    }
  }
  if (parsed === null || parsed === undefined) {
    return { ...base, state: "missing", detail: "no provider usage was recorded" };
  }
  const envelope = asRecord(parsed);
  if (!envelope) return { ...base, state: "malformed", detail: "recorded usage is not an object" };

  const usage = asRecord(envelope.usage) ?? envelope;
  const values: Values = {};
  const presentFields: TokenField[] = [];
  const invalidFields: TokenField[] = [];
  for (const field of TOKEN_FIELDS) {
    const read = field === "reasoning_output_tokens" ? readReasoning(usage) : readField(usage, field);
    if (read.state === "valid") {
      values[field] = read.value;
      presentFields.push(field);
    } else if (read.state === "invalid") {
      values[field] = null;
      invalidFields.push(field);
    }
  }
  const models = modelBreakdown(envelope, semantics);
  const reportedModel = nullableString(envelope.reported_model)
    ?? nullableString(usage.model)
    ?? nullableString(envelope.model)
    ?? (models.length === 1 ? models[0]?.model ?? null : null);
  const providerSchemaVersion = nullableString(envelope.schema_version)
    ?? nullableString(envelope.provider_schema_version)
    ?? nullableString(envelope.cli_version);

  if (presentFields.length === 0 && models.length === 0) {
    return {
      ...base,
      state: invalidFields.length > 0 ? "malformed" : "missing",
      values,
      invalidFields,
      reportedModel,
      providerSchemaVersion,
      detail: invalidFields.length > 0
        ? `reported usage fields are not valid token counts: ${invalidFields.join(", ")}`
        : "no provider usage was recorded",
    };
  }

  return {
    ...base,
    state: "values",
    values,
    presentFields,
    invalidFields,
    models,
    reportedModel,
    providerSchemaVersion,
    detail: null,
  };
}

function knownInputEventsOf(values: Values, semantics: UsageSourceSemantics): number | null {
  const input = values.input_tokens ?? null;
  if (input === null) return null;
  if (semantics !== "claude-cache-is-separate") return input;
  return input + (values.cache_read_input_tokens ?? 0) + (values.cache_creation_input_tokens ?? 0);
}

function sameTotals(left: Values, right: Values, semantics: UsageSourceSemantics): boolean {
  return knownInputEventsOf(left, semantics) === knownInputEventsOf(right, semantics)
    && (left.output_tokens ?? null) === (right.output_tokens ?? null);
}

function addValues(events: readonly ParsedEvent[]): { values: Values; presentFields: TokenField[]; invalidFields: TokenField[] } {
  const values: Values = {};
  const presentFields = new Set<TokenField>();
  const invalidFields = new Set<TokenField>();
  for (const field of TOKEN_FIELDS) {
    const total = sum(events.map((event) => event.values[field] ?? null));
    if (total !== null) values[field] = total;
  }
  for (const event of events) {
    for (const field of event.presentFields) presentFields.add(field);
    for (const field of event.invalidFields) invalidFields.add(field);
  }
  return { values, presentFields: [...presentFields], invalidFields: [...invalidFields] };
}

function empty(
  semantics: UsageSourceSemantics,
  coverage: UsageCoverage,
  limitations: string[],
  extra: Partial<NormalizedUsage> = {},
): NormalizedUsage {
  return {
    normalizerVersion: USAGE_NORMALIZER_VERSION,
    coverage,
    sourceSemantics: semantics,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    cachedInputTokens: null,
    knownInputEvents: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    reportedModel: null,
    models: [],
    providerSchemaVersion: null,
    countedEvents: [],
    duplicateEvents: [],
    ignoredEvents: [],
    streamKinds: [],
    conflicts: [],
    limitations,
    ...extra,
  };
}

/**
 * Normalize a whole recorded usage stream.
 *
 * Cumulative snapshots replace each other, deltas add up, and a final envelope
 * supersedes earlier snapshots instead of adding another full total. Repeated
 * source identities are dropped rather than double-counted, and contradictions
 * are reported instead of being resolved by picking a convenient number.
 */
export function normalizeUsageStream(
  adapter: string,
  events: readonly UsageSourceEvent[],
  options: NormalizeUsageOptions = {},
): NormalizedUsage {
  const semantics = usageSemanticsFor(adapter);
  const expected = EXPECTED_FIELDS[semantics];
  const conflicts: string[] = [];
  const limitations: string[] = [];
  const duplicateEvents: string[] = [];
  const ignoredEvents: string[] = [];

  if (events.length === 0) {
    return empty(semantics, "missing", ["no provider usage events were recorded"], {
      providerSchemaVersion: options.providerSchemaVersion ?? null,
      reportedModel: options.reportedModel ?? null,
    });
  }

  const seen = new Map<string, ParsedEvent>();
  const unique: ParsedEvent[] = [];
  for (const [index, event] of events.entries()) {
    const parsed = parseEvent(event, index, semantics);
    const previous = seen.get(parsed.identity);
    if (previous) {
      duplicateEvents.push(parsed.identity);
      if (!sameTotals(previous.values, parsed.values, semantics)) {
        conflicts.push(
          `Usage event ${parsed.identity} was reported more than once with different totals; the first observation is used.`,
        );
      }
      continue;
    }
    seen.set(parsed.identity, parsed);
    unique.push(parsed);
  }

  const ordered = unique.every((event) => event.sequence !== null)
    ? [...unique].sort((left, right) => (left.sequence as number) - (right.sequence as number))
    : unique;
  const usable = ordered.filter((event) => event.state === "values");
  const streamKinds = [...new Set(ordered.map((event) => event.kind))];

  if (usable.length === 0) {
    const malformed = ordered.filter((event) => event.state === "malformed");
    const details = [...new Set(ordered.map((event) => event.detail).filter((detail): detail is string => detail !== null))];
    return empty(semantics, malformed.length > 0 ? "malformed" : "missing", details, {
      streamKinds,
      duplicateEvents,
      conflicts,
      providerSchemaVersion: options.providerSchemaVersion ?? null,
      reportedModel: options.reportedModel ?? null,
    });
  }

  const finals = usable.filter((event) => event.kind === "final");
  const cumulative = usable.filter((event) => event.kind === "cumulative");
  const deltas = usable.filter((event) => event.kind === "delta");
  const unknown = usable.filter((event) => event.kind === "unknown");

  let counted: ParsedEvent[];
  let combined: { values: Values; presentFields: TokenField[]; invalidFields: TokenField[] };
  let degraded = false;

  if (finals.length > 0) {
    const authoritative = finals[finals.length - 1] as ParsedEvent;
    counted = [authoritative];
    combined = { values: authoritative.values, presentFields: authoritative.presentFields, invalidFields: authoritative.invalidFields };
    for (const superseded of usable.filter((event) => event !== authoritative)) ignoredEvents.push(superseded.identity);
    for (const other of finals.slice(0, -1)) {
      if (!sameTotals(other.values, authoritative.values, semantics)) {
        conflicts.push(
          `Final usage envelope ${other.identity} disagrees with ${authoritative.identity}; the last envelope is reported and both are preserved in the raw evidence.`,
        );
        degraded = true;
      }
    }
    const finalTotal = knownInputEventsOf(authoritative.values, semantics);
    const streamTotal = knownInputEventsOf(addValues(deltas).values, semantics);
    if (streamTotal !== null && finalTotal !== null && streamTotal > finalTotal) {
      conflicts.push(
        `Incremental usage events total ${streamTotal} reported input events, above the final envelope's ${finalTotal}; the final envelope is reported.`,
      );
      degraded = true;
    }
    const highestSnapshot = cumulative
      .map((snapshot) => knownInputEventsOf(snapshot.values, semantics))
      .reduce<number | null>((highest, value) => (value === null ? highest : Math.max(highest ?? value, value)), null);
    if (highestSnapshot !== null && finalTotal !== null && highestSnapshot > finalTotal) {
      conflicts.push(
        `A cumulative snapshot reported ${highestSnapshot} input events, above the final envelope's ${finalTotal}; the final envelope is reported and both remain in the raw evidence.`,
      );
      degraded = true;
    }
  } else if (cumulative.length > 0) {
    const latest = cumulative[cumulative.length - 1] as ParsedEvent;
    counted = [latest];
    combined = { values: latest.values, presentFields: latest.presentFields, invalidFields: latest.invalidFields };
    for (const superseded of usable.filter((event) => event !== latest)) ignoredEvents.push(superseded.identity);
    let previous: ParsedEvent | null = null;
    for (const snapshot of cumulative) {
      const before = previous === null ? null : knownInputEventsOf(previous.values, semantics);
      const after = knownInputEventsOf(snapshot.values, semantics);
      if (previous !== null && before !== null && after !== null && after < before) {
        conflicts.push(
          `Cumulative usage snapshot ${snapshot.identity} reports ${after} input events after ${previous.identity} reported ${before}; snapshots are not summed and both remain in the raw evidence.`,
        );
        degraded = true;
      }
      previous = snapshot;
    }
    if (deltas.length > 0) {
      for (const delta of deltas) ignoredEvents.push(delta.identity);
      limitations.push("Incremental usage events were not added to a cumulative snapshot, which already contains them.");
      degraded = true;
    }
  } else if (deltas.length > 0) {
    counted = deltas;
    combined = addValues(deltas);
    for (const other of unknown) ignoredEvents.push(other.identity);
    if (unknown.length > 0) {
      limitations.push("Usage events with unknown stream semantics were not added to the incremental total.");
      degraded = true;
    }
  } else {
    const latest = unknown[unknown.length - 1] as ParsedEvent;
    counted = [latest];
    combined = { values: latest.values, presentFields: latest.presentFields, invalidFields: latest.invalidFields };
    for (const superseded of unknown.filter((event) => event !== latest)) ignoredEvents.push(superseded.identity);
    if (unknown.length > 1) {
      limitations.push(
        `${unknown.length} usage events do not declare whether they are cumulative or incremental; they were not summed and only the last one is reported.`,
      );
      degraded = true;
    }
  }

  const values = combined.values;
  const present = new Set(combined.presentFields);
  for (const field of combined.invalidFields) {
    limitations.push(`${field} is present but is not a valid token count`);
  }
  for (const field of expected) {
    if (!present.has(field) && !combined.invalidFields.includes(field)) {
      limitations.push(`${field} is absent`);
    }
  }

  const input = values.input_tokens ?? null;
  const cacheRead = values.cache_read_input_tokens ?? null;
  const cacheCreation = values.cache_creation_input_tokens ?? null;
  const cached = values.cached_input_tokens ?? null;
  const output = values.output_tokens ?? null;
  const reasoning = values.reasoning_output_tokens ?? null;
  const models = counted.length === 1 ? (counted[0] as ParsedEvent).models : [];

  let knownInputEvents = knownInputEventsOf(values, semantics);
  if (knownInputEvents === null && models.length > 0) {
    knownInputEvents = sum(models.map((model) => model.knownInputEvents));
    if (knownInputEvents !== null) {
      limitations.push("Input events were derived from the per-model breakdown because no envelope total was reported.");
      degraded = true;
    }
  }
  let outputTokens = output;
  if (outputTokens === null && models.length > 0) {
    outputTokens = sum(models.map((model) => model.outputTokens));
    if (outputTokens !== null) {
      limitations.push("Output tokens were derived from the per-model breakdown because no envelope total was reported.");
      degraded = true;
    }
  }
  if (models.length > 0) {
    const modelInput = sum(models.map((model) => model.knownInputEvents));
    if (modelInput !== null && knownInputEvents !== null && modelInput !== knownInputEvents) {
      conflicts.push(
        `Per-model input events total ${modelInput} but the envelope reports ${knownInputEvents}; the envelope total is reported.`,
      );
      degraded = true;
    }
  }
  if (reasoning !== null && outputTokens !== null && reasoning > outputTokens) {
    conflicts.push(
      `Reasoning output ${reasoning} exceeds reported output ${outputTokens}, so it cannot be a subset of it.`,
    );
    degraded = true;
  }
  if (cached !== null && input !== null && cached > input) {
    conflicts.push(
      `Cached input ${cached} exceeds reported input ${input}, so it cannot be the documented subset of it.`,
    );
    degraded = true;
  }

  const expectedPresent = expected.every((field) => present.has(field));
  let coverage: UsageCoverage = expectedPresent && combined.invalidFields.length === 0 ? "complete" : "partial";
  // Any contradiction or unusable event keeps coverage below "complete", so a
  // figure that needed a judgement call is never presented as a clean total.
  if (degraded || conflicts.length > 0) coverage = "partial";

  return {
    normalizerVersion: USAGE_NORMALIZER_VERSION,
    coverage,
    sourceSemantics: semantics,
    inputTokens: input,
    // Codex reports one input total that already includes its cached subset, so
    // the uncached remainder is derivable; Claude's `input_tokens` is already the
    // uncached part. For any other schema this split is unknown, not assumed.
    uncachedInputTokens: semantics === "codex-input-includes-cache"
      ? (input === null || cached === null ? null : Math.max(0, input - cached))
      : semantics === "claude-cache-is-separate" ? input : null,
    cacheReadInputTokens: semantics === "claude-cache-is-separate" ? cacheRead : null,
    cacheWriteInputTokens: semantics === "claude-cache-is-separate" ? cacheCreation : null,
    cachedInputTokens: semantics === "codex-input-includes-cache" ? cached : null,
    knownInputEvents,
    outputTokens,
    reasoningOutputTokens: reasoning,
    reportedModel: options.reportedModel
      ?? counted.map((event) => event.reportedModel).find((model): model is string => model !== null)
      ?? null,
    models,
    providerSchemaVersion: options.providerSchemaVersion
      ?? counted.map((event) => event.providerSchemaVersion).find((version): version is string => version !== null)
      ?? null,
    countedEvents: counted.map((event) => event.identity),
    duplicateEvents,
    ignoredEvents: [...new Set(ignoredEvents)],
    streamKinds,
    conflicts,
    limitations: [...new Set(limitations)],
  };
}

/**
 * Normalize a single recorded usage envelope, such as `attempts.usage_json`.
 * A stored envelope is the provider's closing total for that attempt.
 */
export function normalizeProviderUsage(
  adapter: string,
  raw: unknown,
  options: NormalizeUsageOptions = {},
): NormalizedUsage {
  return normalizeUsageStream(adapter, [{ id: "final-envelope", kind: "final", raw }], options);
}

/** Flatten a normalized projection into the scalar dimensions the store persists. */
export function usageProjectionFields(usage: NormalizedUsage): Record<string, number | string | boolean | null> {
  return {
    normalizer_version: usage.normalizerVersion,
    coverage: usage.coverage,
    source_semantics: usage.sourceSemantics,
    input_tokens: usage.inputTokens,
    uncached_input_tokens: usage.uncachedInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    known_input_events: usage.knownInputEvents,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
    reported_model: usage.reportedModel,
    provider_schema_version: usage.providerSchemaVersion,
    models: usage.models.length === 0 ? null : usage.models.map((model) => model.model).join(","),
    counted_events: usage.countedEvents.length === 0 ? null : usage.countedEvents.join(","),
    duplicate_events: usage.duplicateEvents.length === 0 ? null : usage.duplicateEvents.join(","),
    ignored_events: usage.ignoredEvents.length === 0 ? null : usage.ignoredEvents.join(","),
    stream_kinds: usage.streamKinds.join(","),
    conflicts: usage.conflicts.length === 0 ? null : usage.conflicts.join(" | "),
    limitations: usage.limitations.length === 0 ? null : usage.limitations.join(" | "),
    // Cached and reasoning figures are documented subsets, never added again.
    subset_fields: "cached_input_tokens,reasoning_output_tokens",
  };
}
