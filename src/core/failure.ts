/**
 * Failure classification.
 *
 * The plan requires distinguishing code failures from authentication,
 * infrastructure, and quota failures: repair attempts are a budget for the
 * model's own mistakes and must not be burned retrying an unavailable
 * provider.
 */
export const FAILURE_CLASSES = [
  "CODE",
  "AUTH",
  "QUOTA",
  "INFRA",
  "CONFIG",
  "CONTRACT",
  "CANCELLED",
  "TIMEOUT",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Only CODE failures consume a repair cycle. Everything else blocks or reroutes. */
export function consumesRepairBudget(failure: FailureClass): boolean {
  return failure === "CODE";
}

/** A provider-capacity or credential problem should block, never fall back to paid access. */
export function isProviderUnavailable(failure: FailureClass): boolean {
  return failure === "QUOTA" || failure === "AUTH";
}

const QUOTA_PATTERNS = [
  /rate.?limit/i,
  /quota/i,
  /usage limit/i,
  /too many requests/i,
  /\b429\b/,
  /overloaded/i,
  /capacity/i,
  /upgrade to (?:pro|max|plus)/i,
];

const AUTH_PATTERNS = [
  /unauthor/i,
  /authentication/i,
  /not logged in/i,
  /invalid api key/i,
  /credential/i,
  /\b401\b/,
  /\b403\b/,
  /please run .*login/i,
];

/**
 * Misconfiguration: an unroutable model, a rejected flag, a missing tool.
 * Phase 0 found both harnesses reporting an unknown model as an ordinary
 * non-zero exit, which the first classifier read as CODE and would have spent
 * the repair budget on. Retrying cannot fix a model name.
 */
const CONFIG_PATTERNS = [
  /model metadata for .* not found/i,
  /(unknown|invalid|unsupported|unrecognized) model/i,
  /model .* (not found|does not exist|is not available)/i,
  /invalid (argument|option|flag|value)/i,
  /unknown (argument|option|flag)/i,
  /command not found/i,
  /no such file or directory/i,
];

const INFRA_PATTERNS = [
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT/,
  /network/i,
  /socket hang up/i,
  /\b5\d\d\b (?:error|status)/i,
  /internal server error/i,
  /ENOSPC|EACCES|EPERM/,
];

/**
 * Classify a worker failure from its text. Deliberately conservative: unknown
 * text is CODE only when the harness exited from its own work, otherwise
 * INFRA. Misclassifying a provider outage as CODE would waste repair cycles.
 */
export function classifyFailure(text: string, exitCode: number | null): FailureClass {
  const haystack = text.slice(-8000);
  if (QUOTA_PATTERNS.some((p) => p.test(haystack))) return "QUOTA";
  if (AUTH_PATTERNS.some((p) => p.test(haystack))) return "AUTH";
  if (CONFIG_PATTERNS.some((p) => p.test(haystack))) return "CONFIG";
  if (INFRA_PATTERNS.some((p) => p.test(haystack))) return "INFRA";
  if (exitCode === null) return "INFRA";
  return "CODE";
}

/**
 * Harness envelopes carry stronger signals than their prose. Claude reports
 * `terminal_reason: "api_error"` with empty model usage when it never reached a
 * model at all - that is never the worker's coding mistake.
 */
export function classifyFromEnvelope(
  envelope: { terminal_reason?: unknown; is_error?: unknown; modelUsage?: unknown },
  text: string,
  exitCode: number | null,
): FailureClass {
  const textual = classifyFailure(text, exitCode);
  if (textual !== "CODE") return textual;
  const reachedAModel =
    typeof envelope.modelUsage === "object" &&
    envelope.modelUsage !== null &&
    Object.keys(envelope.modelUsage as Record<string, unknown>).length > 0;
  if (envelope.terminal_reason === "api_error" && !reachedAModel) return "INFRA";
  return textual;
}
