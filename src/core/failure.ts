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
  // Claude subscription windows: "You've hit your session limit · resets 10am (...)".
  // Observed live as INFRA, which blocked the task instead of cooling down.
  /hit your (?:session|weekly|daily|usage|opus) limit/i,
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
  /\bENOENT\b/,
  /executable (?:was )?not found/i,
];

/**
 * A broken local environment, not a coding mistake: a harness whose native
 * binary was never installed, a missing executable, a postinstall that never
 * ran. Observed live when the claude wrapper exited 1 with "native binary not
 * installed": the classifier read it as CODE, so the controller spent the whole
 * repair budget re-running an implementation against an environment the worker
 * cannot repair. Re-running cannot install a binary.
 */
const ENVIRONMENT_PATTERNS = [
  /native binary (?:is )?not installed/i,
  /binary (?:is )?not installed/i,
  /\bnot installed\b/i,
  /postinstall did not run/i,
  /spawn \S+ ENOENT/i,
  /\bENOENT\b/,
  /executable (?:was )?not found/i,
  /is not recognized as an internal or external command/i,
];

/** True when failure text describes local tooling that is missing or unusable. */
export function isEnvironmentFailure(text: string): boolean {
  return ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(text));
}

const INFRA_PATTERNS = [
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT/,
  /network/i,
  /socket hang up/i,
  /\b5\d\d\b (?:error|status)/i,
  /internal server error/i,
  /ENOSPC|EACCES|EPERM/,
  /permission denied|not permitted|operation not allowed/i,
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
  if (isEnvironmentFailure(haystack)) return "CONFIG";
  if (INFRA_PATTERNS.some((p) => p.test(haystack))) return "INFRA";
  if (exitCode === null) return "INFRA";
  if (exitCode === 126 || exitCode === 127) return "CONFIG";
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

/**
 * Structured diagnosis.
 *
 * `FailureClass` is a single label that the controller already persists, so it
 * stays as historical evidence. It is too coarse for recovery decisions: it
 * cannot say whether a cause was observed or guessed, which evidence supports
 * it, or which stage to resume. The categories below separate the *responsible
 * layer* from the label, and only one of them may charge a code repair.
 */
export const FAILURE_CATEGORIES = [
  "provider_capacity",
  "provider_auth",
  "environment",
  "host_runtime",
  "controller",
  "worker_contract",
  "product_code",
  "requirement",
  "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_CLASSIFIER_VERSION = "mabs.failure-diagnosis.v1";

export interface FailureDiagnosis {
  category: FailureCategory;
  stage: string;
  symptom: string;
  causeStatus: "observed" | "hypothesis" | "confirmed";
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  classifierVersion: string;
  recoveryAction: string;
  consumesCodeRepair: boolean;
  legacyFailureClass: string | null;
}

/**
 * The repair budget pays for the model's own mistakes. A missing compiler, a
 * denied permission, a rejected contract, an unanswered requirement, and an
 * unexplained exception are all somebody else's move; charging them would
 * spend the budget before a real defect ever appears.
 */
export function categoryConsumesCodeRepair(category: FailureCategory): boolean {
  return category === "product_code";
}

/** Provider access problems block or reroute; they never fall back to paid access. */
export function categoryIsProviderUnavailable(category: FailureCategory): boolean {
  return category === "provider_capacity" || category === "provider_auth";
}

const LEGACY_CATEGORY: Record<FailureClass, FailureCategory> = {
  CODE: "product_code",
  AUTH: "provider_auth",
  QUOTA: "provider_capacity",
  // Network, disk, and memory belong to the machine, not to the project workspace.
  INFRA: "host_runtime",
  CONFIG: "environment",
  CONTRACT: "worker_contract",
  CANCELLED: "controller",
  TIMEOUT: "host_runtime",
};

export function categoryForFailureClass(failure: FailureClass): FailureCategory {
  return LEGACY_CATEGORY[failure];
}

const RECOVERY_ACTION: Record<FailureCategory, string> = {
  provider_capacity:
    "Record the capacity limit with its evidenced reset when available, then wait for capacity or reroute to an eligible subscription provider.",
  provider_auth:
    "Mark the provider unavailable until the operator repairs its login, then retry the same stage.",
  environment:
    "Resolve readiness through the authorized setup plan or the controller-owned check runner, then rerun the affected stage. Do not widen worker permissions.",
  host_runtime: "Resolve the host condition (network, disk, memory, or timeout budget), then retry the same stage.",
  controller: "Reconcile controller state from durable records before scheduling any new work.",
  worker_contract: "Reissue the stage with a corrected contract; the produced work is not accepted as-is.",
  product_code: "Carry the findings into a repair attempt bound to this revision.",
  requirement: "Ask the user the recorded decision question; no agent may assume the answer.",
  unknown: "Preserve the evidence and require an explicit operator decision; an unexplained failure is not a proven defect.",
};

export function recoveryActionFor(category: FailureCategory): string {
  return RECOVERY_ACTION[category];
}

/** Permission denials are an authorization decision, never a coding mistake. */
const PERMISSION_PATTERNS = [
  /permission denied/i,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /not permitted/i,
  /requires approval/i,
  /operation not allowed/i,
  /refus(?:ed|ing) to run/i,
];

/** A tool that never started cannot have produced a product-behaviour verdict. */
const TOOL_MISSING_PATTERNS = [
  /command not found/i,
  /: not found\b/i,
  /\bENOENT\b/,
  /no such file or directory/i,
  /is not recognized as an internal or external command/i,
  /executable (?:was )?not found/i,
];

/** Genuine product evidence: a compiler or test runner that ran and judged the code. */
const PRODUCT_CODE_PATTERNS = [
  /\berror TS\d+\b/,
  /^\s*(?:FAIL|FAILED)\s+\S+/m,
  /\b\d+:\d+\s+error\b/i,
  /\b\d+ errors?\b/i,
  /AssertionError/,
  /\bassert(?:ion)? failed\b/i,
  /Expected .* to (?:equal|be|deepEqual)/i,
  /^\s*not ok \d+/m,
  /\bfail \d+\b/,
  /\bSyntaxError\b/,
  /\bTypeError\b/,
  /\d+ (?:failed|failing)\b/i,
];

export interface FailureObservation {
  /** Execution stage the failure was observed in. */
  stage: string;
  /** Which layer reported it. Gate and worker signals are read differently. */
  source: "worker" | "gate" | "review" | "controller" | "environment" | "contract";
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** Combined stdout/stderr or result text. Prose is the weakest signal used. */
  text?: string;
  /** Harness envelope fields, when the adapter parsed one. */
  envelope?: { terminal_reason?: unknown; is_error?: unknown; modelUsage?: unknown } | null;
  /**
   * Preflight verdict for the actual worktree. A non-ready workspace explains a
   * failing check better than the check's own output does.
   */
  readiness?: { state: string; summary?: string | null } | null;
  /** Whether the command's executable resolved in the workspace that ran it. */
  toolResolved?: boolean | null;
  /** A recorded user decision that the work cannot proceed without. */
  requirementDecision?: { requirementId: string | null; question: string } | null;
  /** A contract violation the controller detected, such as an out-of-scope edit. */
  contractViolation?: string | null;
  evidenceIds?: string[];
  /** Label already persisted for this failure, preserved as historical evidence. */
  legacyFailureClass?: FailureClass | null;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  return (line ?? "").slice(0, 300);
}

function matched(patterns: RegExp[], haystack: string): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

function diagnosis(input: {
  category: FailureCategory;
  stage: string;
  symptom: string;
  causeStatus: FailureDiagnosis["causeStatus"];
  confidence: FailureDiagnosis["confidence"];
  evidenceIds: string[];
  legacyFailureClass: string | null;
}): FailureDiagnosis {
  return {
    category: input.category,
    stage: input.stage,
    symptom: input.symptom,
    causeStatus: input.causeStatus,
    confidence: input.confidence,
    evidenceIds: input.evidenceIds,
    classifierVersion: FAILURE_CLASSIFIER_VERSION,
    recoveryAction: RECOVERY_ACTION[input.category],
    consumesCodeRepair: categoryConsumesCodeRepair(input.category),
    legacyFailureClass: input.legacyFailureClass,
  };
}

/**
 * Diagnose one failure from the strongest signal available.
 *
 * Precedence is deliberate: recorded decisions and structured exit signals are
 * trusted before prose, and prose is trusted before the bare fact that a
 * process exited non-zero. `product_code` therefore requires positive evidence
 * that a tool ran and judged the code, not merely that something failed.
 */
export function diagnoseFailure(observation: FailureObservation): FailureDiagnosis {
  const text = observation.text ?? "";
  const haystack = text.slice(-8000);
  const evidenceIds = observation.evidenceIds ?? [];
  const legacy = observation.legacyFailureClass ?? null;
  const stage = observation.stage;
  const make = (
    category: FailureCategory,
    symptom: string,
    causeStatus: FailureDiagnosis["causeStatus"],
    confidence: FailureDiagnosis["confidence"],
  ): FailureDiagnosis => diagnosis({ category, stage, symptom, causeStatus, confidence, evidenceIds, legacyFailureClass: legacy });

  // 1. A recorded human decision outranks every machine signal.
  if (observation.requirementDecision) {
    const { requirementId, question } = observation.requirementDecision;
    return make(
      "requirement",
      `An accepted requirement${requirementId ? ` (${requirementId})` : ""} needs a user decision: ${question}`,
      "observed",
      "high",
    );
  }

  // 2. A detected contract violation is already a controller observation.
  if (observation.contractViolation || observation.source === "contract") {
    return make(
      "worker_contract",
      observation.contractViolation ?? (firstLine(text) || "The worker contract was violated."),
      "observed",
      "high",
    );
  }

  if (observation.source === "controller") {
    return make("controller", firstLine(text) || "The controller could not complete this stage.", "observed", "medium");
  }

  // 3. Provider access, from prose because providers report it nowhere else.
  //    Only harness-mediated sources talk to a provider; a local deterministic
  //    check that merely prints the word "capacity" is not a quota event.
  const providerMediated = observation.source === "worker" || observation.source === "review";
  if (providerMediated && matched(QUOTA_PATTERNS, haystack)) {
    return make("provider_capacity", firstLine(text) || "The provider reported a capacity or usage limit.", "observed", "high");
  }
  if (providerMediated && matched(AUTH_PATTERNS, haystack)) {
    return make("provider_auth", firstLine(text) || "The provider reported an authentication problem.", "observed", "high");
  }

  // 4. Preflight already inspected the workspace this command ran in, so a
  //    non-ready workspace explains the failure better than the output does.
  if (observation.readiness && observation.readiness.state !== "ready") {
    if (observation.readiness.state === "unknown") {
      return make(
        "unknown",
        observation.readiness.summary ?? "Workspace readiness could not be determined for the stage that failed.",
        "hypothesis",
        "low",
      );
    }
    return make(
      "environment",
      observation.readiness.summary ?? `Workspace readiness is ${observation.readiness.state} for the stage that failed.`,
      "observed",
      "high",
    );
  }

  // 5. Structured exit signals, which outrank any prose in the same output.
  if (observation.toolResolved === false) {
    return make("environment", firstLine(text) || "The command's executable does not resolve in this worktree.", "observed", "high");
  }
  if (observation.exitCode === 126) {
    return make("environment", firstLine(text) || "The required command could not be executed here.", "observed", "high");
  }
  if (observation.exitCode === 127) {
    return make("environment", firstLine(text) || "A required executable was not found.", "observed", "high");
  }

  // 6. A registered tool that resolved and emitted a compiler or test verdict has
  //    judged the product. That positive evidence outranks incidental prose such
  //    as an ENOENT or permission message inside a failing test's own output.
  if (observation.source === "gate" && observation.toolResolved === true && matched(PRODUCT_CODE_PATTERNS, haystack)) {
    return make("product_code", firstLine(text) || "A configured check reported a product defect.", "observed", "high");
  }

  if (matched(PERMISSION_PATTERNS, haystack)) {
    return make("environment", firstLine(text) || "Running the required command was not permitted.", "observed", "high");
  }
  if (matched(TOOL_MISSING_PATTERNS, haystack)) {
    return make("environment", firstLine(text) || "A required executable was not found.", "observed", "high");
  }
  if (observation.timedOut === true) {
    return make("host_runtime", firstLine(text) || "The command exceeded its timeout budget.", "observed", "high");
  }
  if (observation.signal) {
    return make("host_runtime", `The process was terminated by ${observation.signal}.`, "observed", "medium");
  }
  if (matched(CONFIG_PATTERNS, haystack)) {
    return make("environment", firstLine(text) || "The command was rejected as misconfigured.", "observed", "high");
  }
  if (matched(INFRA_PATTERNS, haystack)) {
    return make("host_runtime", firstLine(text) || "A host or network condition interrupted the command.", "observed", "high");
  }

  // 7. A harness that never reached a model did not produce a coding mistake.
  if (observation.envelope) {
    const usage = observation.envelope.modelUsage;
    const reachedAModel = typeof usage === "object" && usage !== null && Object.keys(usage as Record<string, unknown>).length > 0;
    if (observation.envelope.terminal_reason === "api_error" && !reachedAModel) {
      return make("host_runtime", "The harness reported an API error without reaching a model.", "observed", "high");
    }
  }

  if (observation.exitCode === null || observation.exitCode === undefined) {
    return make("unknown", firstLine(text) || "The process produced no exit status.", "hypothesis", "low");
  }

  // 8. Product code, only with evidence that a tool judged the code.
  if (matched(PRODUCT_CODE_PATTERNS, haystack)) {
    return make("product_code", firstLine(text) || "A configured check reported a product defect.", "observed", "high");
  }
  return make("unknown", firstLine(text) || `The stage exited ${observation.exitCode} without a recognized cause.`, "hypothesis", "low");
}

/** Collapse a diagnosis onto the legacy label the controller persists. */
export function failureClassForCategory(category: FailureCategory): FailureClass {
  const inverse: Record<FailureCategory, FailureClass> = {
    provider_capacity: "QUOTA",
    provider_auth: "AUTH",
    environment: "CONFIG",
    host_runtime: "INFRA",
    controller: "INFRA",
    worker_contract: "CONTRACT",
    product_code: "CODE",
    requirement: "CONTRACT",
    unknown: "INFRA",
  };
  return inverse[category];
}
