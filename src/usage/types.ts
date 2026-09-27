export const USAGE_COVERAGE = ["complete", "partial", "missing", "malformed"] as const;
export type UsageCoverage = (typeof USAGE_COVERAGE)[number];

export interface UsageProjection {
  attemptId: string;
  normalizerVersion: string;
  normalized: Record<string, number | string | boolean | null>;
  sourceArtifactHash: string;
  sourceOffset: number | null;
  coverage: UsageCoverage;
  sourceSemantics: string;
  updatedAt: string;
}

/**
 * Observed provider semantics. These describe *what the recorded schema meant*,
 * not what any future provider schema will mean: a new schema gets a new label
 * rather than being folded into one of these.
 */
export const USAGE_SOURCE_SEMANTICS = [
  /** `input_tokens` already contains `cached_input_tokens`. */
  "codex-input-includes-cache",
  /** Cache read/creation are separate input events from `input_tokens`. */
  "claude-cache-is-separate",
  /** Only generic `input_tokens`/`output_tokens` are interpreted. */
  "generic-reported",
] as const;
export type UsageSourceSemantics = (typeof USAGE_SOURCE_SEMANTICS)[number];

/**
 * How one recorded usage event relates to the rest of its stream. `cumulative`
 * snapshots replace each other, `delta` increments add up, `final` is the
 * closing envelope, and `unknown` means the recorded evidence does not say.
 */
export const USAGE_STREAM_KINDS = ["cumulative", "delta", "final", "unknown"] as const;
export type UsageStreamKind = (typeof USAGE_STREAM_KINDS)[number];

/**
 * Cohort coverage additionally distinguishes "there was nothing to measure"
 * from "measurement is missing". `not_applicable` is never persisted as an
 * attempt projection, whose coverage domain is fixed by the schema.
 */
export type UsageCohortCoverage = UsageCoverage | "not_applicable";

export interface UsageModelSubtotal {
  model: string;
  knownInputEvents: number | null;
  outputTokens: number | null;
}

/** One attempt's usage, normalized without altering the recorded raw evidence. */
export interface NormalizedUsage {
  normalizerVersion: string;
  coverage: UsageCoverage;
  sourceSemantics: UsageSourceSemantics;
  /** The provider's own `input_tokens` field, exactly as reported. */
  inputTokens: number | null;
  /** Input the provider reported as not served from cache, where derivable. */
  uncachedInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  /** Codex reports this as a subset of `input_tokens`; it is never added again. */
  cachedInputTokens: number | null;
  /** Reported input events under this provider's semantics. Not unique tokens. */
  knownInputEvents: number | null;
  outputTokens: number | null;
  /** Reasoning output where the provider reports it as a subset of output. */
  reasoningOutputTokens: number | null;
  reportedModel: string | null;
  models: UsageModelSubtotal[];
  providerSchemaVersion: string | null;
  /** Source identities whose values were used. */
  countedEvents: string[];
  /** Repeated source identities, dropped instead of double-counted. */
  duplicateEvents: string[];
  /** Identities deliberately not added, e.g. snapshots superseded by a final envelope. */
  ignoredEvents: string[];
  streamKinds: UsageStreamKind[];
  /** Contradictions preserved for diagnosis rather than silently resolved. */
  conflicts: string[];
  limitations: string[];
}

export interface UsageSubtotal {
  normalizerVersion: string;
  coverage: UsageCohortCoverage;
  semantics: string;
  sourceSemantics: UsageSourceSemantics[];
  /** Known subtotal. Null means nothing was measured, never zero. */
  knownInputEvents: number | null;
  knownOutputTokens: number | null;
  attempts: number;
  measuredAttempts: number;
  completeAttempts: number;
  partialAttempts: number;
  missingAttempts: string[];
  malformedAttempts: string[];
  conflicts: string[];
}

export type DurationStatus = "measured" | "running" | "missing" | "invalid";

export interface AttemptDuration {
  status: DurationStatus;
  milliseconds: number | null;
  detail: string | null;
}

export interface DurationSubtotal {
  /** Sum of completed attempt durations, including failed attempts. */
  milliseconds: number;
  measuredAttempts: number;
  runningAttempts: string[];
  missingAttempts: string[];
  invalidAttempts: string[];
}
