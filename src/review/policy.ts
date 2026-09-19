/**
 * Review policy v2.
 *
 * One evaluator, read by dispatch, review verdicts, approval preparation, the
 * CLI, and the workbench, so a policy cannot mean one thing in the controller
 * and another in stored records.
 *
 * Separate axes, deliberately:
 *   trigger  — whether a review runs at all (off / manual / risk / required)
 *   scope    — how much of the change a reviewer is given
 *   cadence  — when acceptance is expected (task / milestone / release)
 * Severity handling and capacity handling are independent of all three.
 *
 * Risk is derived from what actually changed — controller-observed paths and
 * diff content — never from a worker's own claim that its change was harmless.
 */
import { TASK_CLASSES, type ChangeRisk, type TaskClass } from "../routing/router.ts";

export const REVIEW_POLICY_VERSION = "review-policy-v2";

export type ReviewMode = "required" | "substantive" | "none";
export type ReviewPreset = "experiment" | "personal" | "client" | "custom";
export type ReviewTrigger = "off" | "manual" | "risk" | "required";
export type ReviewScope = "change" | "affected_components" | "release";
export type ReviewCadence = "task" | "milestone" | "release";
export type ReviewerRoute = "independent_provider" | "same_provider_fresh_context";
export type CapacityAction = "pending" | "blocked";
/** What a project must show before a revision may be called ready. */
export type QualityExpectation = "advisory" | "configured_checks" | "acceptance_and_gates";

export type FindingSeverity = "critical" | "major" | "minor";
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["critical", "major", "minor"];
export const DEFAULT_FINDING_SEVERITY: FindingSeverity = "major";
export const DEFAULT_BLOCKING_SEVERITIES: readonly FindingSeverity[] = ["critical", "major"];

export const REVIEW_MODES: readonly ReviewMode[] = ["required", "substantive", "none"];
export const REVIEW_PRESETS: readonly ReviewPreset[] = ["experiment", "personal", "client", "custom"];
export const REVIEW_TRIGGERS: readonly ReviewTrigger[] = ["off", "manual", "risk", "required"];
export const REVIEW_SCOPES: readonly ReviewScope[] = ["change", "affected_components", "release"];
export const REVIEW_CADENCES: readonly ReviewCadence[] = ["task", "milestone", "release"];
export const REVIEWER_ROUTES: readonly ReviewerRoute[] = ["independent_provider", "same_provider_fresh_context"];
export const CAPACITY_ACTIONS: readonly CapacityAction[] = ["pending", "blocked"];
export const QUALITY_EXPECTATIONS: readonly QualityExpectation[] = ["advisory", "configured_checks", "acceptance_and_gates"];

/** Classes whose output is deterministic or non-code, so a code review adds nothing. */
export const DEFAULT_SKIP_TASK_CLASSES: readonly TaskClass[] = ["mechanical", "planning", "research"];

export interface RiskRule {
  id: string;
  reason: string;
  /** Matches when the task carries one of these declared classes. */
  taskClasses?: TaskClass[];
  /** Matches when the task carries one of these declared risk levels. */
  changeRisks?: ChangeRisk[];
  /** Case-insensitive regular expressions matched against changed file paths. */
  pathPatterns?: string[];
  /** Case-insensitive regular expressions matched against the change diff. */
  diffPatterns?: string[];
  /** Matches every task the policy did not already skip. */
  always?: boolean;
}

export interface ReviewPolicy {
  version: string;
  preset: ReviewPreset;
  trigger: ReviewTrigger;
  scope: ReviewScope;
  cadence: ReviewCadence;
  blockingSeverities: FindingSeverity[];
  riskRules: RiskRule[];
  reviewerRoute: ReviewerRoute;
  capacityAction: CapacityAction;
  skipTaskClasses: TaskClass[];
  qualityExpectation: QualityExpectation;
  /** Derived from trigger. Retained so v1 readers keep working unchanged. */
  mode: ReviewMode;
}

/**
 * Risk signals for the personal preset. Paths and diff content are both used:
 * a change can touch an innocuous path and still delete data.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  {
    id: "declared-elevated-risk",
    reason: "The task is registered as a high-risk change.",
    changeRisks: ["high"],
  },
  {
    id: "complex-change",
    reason: "Complex coding changes carry more behavioural risk than a small edit.",
    taskClasses: ["complex_coding"],
  },
  {
    id: "authentication-or-credentials",
    reason: "The change touches authentication, session, or credential handling.",
    pathPatterns: ["(^|/)(auth|authn|authz|login|session|password|credential|secret|token)[^/]*(/|\\.|$)"],
    diffPatterns: ["\\b(api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization header)\\b"],
  },
  {
    id: "schema-or-migration",
    reason: "The change touches a schema or migration, where mistakes are hard to reverse.",
    pathPatterns: ["(^|/)(migrations?|schema)[^/]*(/|\\.|$)", "\\.sql$"],
    diffPatterns: ["\\b(drop|alter|truncate)\\s+(table|column|database)\\b"],
  },
  {
    id: "destructive-operations",
    reason: "The change introduces a destructive file or data operation.",
    diffPatterns: ["\\brm\\s+-rf\\b", "\\brmSync\\(", "\\bshutil\\.rmtree\\b", "\\bdelete\\s+from\\b", "\\bgit\\s+push\\s+--force\\b"],
  },
  {
    id: "deployment-or-ci-configuration",
    reason: "The change touches deployment or continuous-integration configuration.",
    pathPatterns: ["^\\.github/workflows/", "(^|/)(dockerfile|docker-compose|deploy|k8s|helm|terraform)[^/]*(/|\\.|$)", "\\.(tf|tfvars)$"],
  },
];

function presetPolicy(preset: Exclude<ReviewPreset, "custom">): ReviewPolicy {
  switch (preset) {
    case "experiment":
      return {
        version: REVIEW_POLICY_VERSION, preset, trigger: "off", scope: "change", cadence: "task",
        blockingSeverities: [...DEFAULT_BLOCKING_SEVERITIES], riskRules: [],
        reviewerRoute: "independent_provider", capacityAction: "pending",
        skipTaskClasses: [...DEFAULT_SKIP_TASK_CLASSES], qualityExpectation: "advisory", mode: "none",
      };
    case "personal":
      return {
        version: REVIEW_POLICY_VERSION, preset, trigger: "risk", scope: "change", cadence: "task",
        blockingSeverities: [...DEFAULT_BLOCKING_SEVERITIES], riskRules: DEFAULT_RISK_RULES.map((rule) => ({ ...rule })),
        reviewerRoute: "independent_provider", capacityAction: "pending",
        skipTaskClasses: [...DEFAULT_SKIP_TASK_CLASSES], qualityExpectation: "configured_checks", mode: "substantive",
      };
    case "client":
      return {
        version: REVIEW_POLICY_VERSION, preset, trigger: "required", scope: "affected_components", cadence: "release",
        blockingSeverities: [...DEFAULT_BLOCKING_SEVERITIES], riskRules: DEFAULT_RISK_RULES.map((rule) => ({ ...rule })),
        reviewerRoute: "independent_provider", capacityAction: "blocked",
        skipTaskClasses: [], qualityExpectation: "acceptance_and_gates", mode: "required",
      };
  }
}

export function reviewPreset(preset: Exclude<ReviewPreset, "custom">): ReviewPolicy {
  return presetPolicy(preset);
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = presetPolicy("personal");

function modeForTrigger(trigger: ReviewTrigger): ReviewMode {
  if (trigger === "off") return "none";
  if (trigger === "required") return "required";
  return "substantive";
}

function triggerForMode(mode: ReviewMode): ReviewTrigger {
  if (mode === "none") return "off";
  if (mode === "required") return "required";
  return "risk";
}

/**
 * Migrate a stored v1 policy. `substantive` reviewed every non-skipped class,
 * so it migrates to a risk trigger carrying one explicit always-on rule: the
 * same set of tasks is reviewed, and the reason is now visible instead of implied.
 */
export function migrateLegacyReviewPolicy(legacy: { mode?: unknown; skipTaskClasses?: unknown }): ReviewPolicy {
  const mode = REVIEW_MODES.includes(legacy.mode as ReviewMode) ? (legacy.mode as ReviewMode) : DEFAULT_REVIEW_POLICY.mode;
  const declared = Array.isArray(legacy.skipTaskClasses)
    ? legacy.skipTaskClasses.filter((taskClass): taskClass is TaskClass => TASK_CLASSES.includes(taskClass as TaskClass))
    : [...DEFAULT_SKIP_TASK_CLASSES];
  const base = presetPolicy(mode === "required" ? "client" : mode === "none" ? "experiment" : "personal");
  return normalizeReviewPolicy({
    ...base,
    preset: "custom",
    trigger: triggerForMode(mode),
    // A migrated project never silently loses readiness requirements. Only an
    // explicit move to the experiment preset relaxes them.
    qualityExpectation: mode === "required" ? "acceptance_and_gates" : "configured_checks",
    skipTaskClasses: mode === "required" ? [] : declared,
    riskRules: mode === "substantive"
      ? [{
          id: "legacy-substantive-change",
          reason: "Migrated from review mode \"substantive\", which reviewed every task class it did not skip.",
          always: true,
        }]
      : base.riskRules.map((rule) => ({ ...rule })),
  });
}

function normalizeRiskRule(input: unknown, index: number): RiskRule | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rule = input as Partial<RiskRule>;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : undefined;
  const normalized: RiskRule = {
    id: typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : `risk-rule-${index + 1}`,
    reason: typeof rule.reason === "string" && rule.reason.trim() ? rule.reason.trim() : "Configured risk rule.",
  };
  const taskClasses = strings(rule.taskClasses)?.filter((value): value is TaskClass => TASK_CLASSES.includes(value as TaskClass));
  const changeRisks = strings(rule.changeRisks)?.filter((value): value is ChangeRisk => ["low", "medium", "high"].includes(value));
  const pathPatterns = strings(rule.pathPatterns);
  const diffPatterns = strings(rule.diffPatterns);
  if (taskClasses?.length) normalized.taskClasses = taskClasses;
  if (changeRisks?.length) normalized.changeRisks = changeRisks;
  if (pathPatterns?.length) normalized.pathPatterns = pathPatterns;
  if (diffPatterns?.length) normalized.diffPatterns = diffPatterns;
  if (rule.always === true) normalized.always = true;
  const matches = normalized.always || normalized.taskClasses || normalized.changeRisks || normalized.pathPatterns || normalized.diffPatterns;
  return matches ? normalized : null;
}

/**
 * Accept a v1 or v2 policy and return a complete, coherent v2 policy.
 * Required triggers never inherit skip classes, whatever the caller passed.
 */
export function normalizeReviewPolicy(input: unknown, fallback: ReviewPolicy = DEFAULT_REVIEW_POLICY): ReviewPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...fallback, riskRules: fallback.riskRules.map((rule) => ({ ...rule })) };
  const candidate = input as Partial<ReviewPolicy> & { mode?: unknown };
  if (candidate.trigger === undefined && candidate.version === undefined && candidate.mode !== undefined) {
    return migrateLegacyReviewPolicy(candidate as { mode?: unknown; skipTaskClasses?: unknown });
  }
  const preset = REVIEW_PRESETS.includes(candidate.preset as ReviewPreset) ? (candidate.preset as ReviewPreset) : fallback.preset;
  const trigger = REVIEW_TRIGGERS.includes(candidate.trigger as ReviewTrigger)
    ? (candidate.trigger as ReviewTrigger)
    : REVIEW_MODES.includes(candidate.mode as ReviewMode) ? triggerForMode(candidate.mode as ReviewMode) : fallback.trigger;
  const declaredSkips = Array.isArray(candidate.skipTaskClasses) ? candidate.skipTaskClasses : fallback.skipTaskClasses;
  const blocking = Array.isArray(candidate.blockingSeverities)
    ? candidate.blockingSeverities.filter((severity): severity is FindingSeverity => FINDING_SEVERITIES.includes(severity as FindingSeverity))
    : [...fallback.blockingSeverities];
  const rules = Array.isArray(candidate.riskRules)
    ? candidate.riskRules.map(normalizeRiskRule).filter((rule): rule is RiskRule => rule !== null)
    : fallback.riskRules.map((rule) => ({ ...rule }));
  return {
    version: REVIEW_POLICY_VERSION,
    preset,
    trigger,
    scope: REVIEW_SCOPES.includes(candidate.scope as ReviewScope) ? (candidate.scope as ReviewScope) : fallback.scope,
    cadence: REVIEW_CADENCES.includes(candidate.cadence as ReviewCadence) ? (candidate.cadence as ReviewCadence) : fallback.cadence,
    blockingSeverities: blocking.length > 0 ? [...new Set(blocking)] : [...DEFAULT_BLOCKING_SEVERITIES],
    riskRules: rules,
    reviewerRoute: REVIEWER_ROUTES.includes(candidate.reviewerRoute as ReviewerRoute) ? (candidate.reviewerRoute as ReviewerRoute) : fallback.reviewerRoute,
    capacityAction: CAPACITY_ACTIONS.includes(candidate.capacityAction as CapacityAction) ? (candidate.capacityAction as CapacityAction) : fallback.capacityAction,
    skipTaskClasses: trigger === "required"
      ? []
      : [...new Set(declaredSkips.filter((taskClass): taskClass is TaskClass => TASK_CLASSES.includes(taskClass as TaskClass)))],
    qualityExpectation: QUALITY_EXPECTATIONS.includes(candidate.qualityExpectation as QualityExpectation)
      ? (candidate.qualityExpectation as QualityExpectation)
      : fallback.qualityExpectation,
    mode: modeForTrigger(trigger),
  };
}

/** True when normalization had to change the caller's intent, which is worth recording. */
export function reviewPolicyNormalizationNotes(input: unknown, normalized: ReviewPolicy): string[] {
  const candidate = (input ?? {}) as Partial<ReviewPolicy> & { mode?: unknown };
  const notes: string[] = [];
  const declared = Array.isArray(candidate.skipTaskClasses) ? candidate.skipTaskClasses : [];
  if (candidate.mode !== undefined && !REVIEW_MODES.includes(candidate.mode as ReviewMode)) {
    notes.push(`Unknown review mode ${String(candidate.mode)} replaced with ${normalized.mode}.`);
  }
  if (candidate.trigger !== undefined && !REVIEW_TRIGGERS.includes(candidate.trigger as ReviewTrigger)) {
    notes.push(`Unknown review trigger ${String(candidate.trigger)} replaced with ${normalized.trigger}.`);
  }
  if (normalized.trigger === "required" && declared.length > 0) {
    notes.push(`Required review cannot skip task classes; dropped ${declared.join(", ")}.`);
  }
  const unknown = declared.filter((taskClass) => !TASK_CLASSES.includes(taskClass as TaskClass));
  if (normalized.trigger !== "required" && unknown.length > 0) {
    notes.push(`Dropped unknown review skip task classes: ${unknown.join(", ")}.`);
  }
  if (candidate.version === undefined && candidate.trigger === undefined && candidate.mode !== undefined) {
    notes.push(`Migrated review mode "${String(candidate.mode)}" to ${REVIEW_POLICY_VERSION} trigger "${normalized.trigger}".`);
  }
  return notes;
}

/** Strict validation for explicitly authored configuration, which must not be silently repaired. */
export function validateReviewPolicy(policy: unknown, label = "reviewPolicy"): string[] {
  const errors: string[] = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return [`${label} must be an object.`];
  const candidate = policy as Partial<ReviewPolicy> & { mode?: unknown };
  const known = [
    "version", "preset", "trigger", "scope", "cadence", "blockingSeverities", "riskRules",
    "reviewerRoute", "capacityAction", "skipTaskClasses", "qualityExpectation", "mode",
  ];
  for (const key of Object.keys(candidate)) {
    if (!known.includes(key)) errors.push(`${label} contains unknown property ${key}.`);
  }
  const legacyOnly = candidate.trigger === undefined && candidate.version === undefined;
  if (legacyOnly) {
    if (!REVIEW_MODES.includes(candidate.mode as ReviewMode)) {
      errors.push(`${label} mode must be required, substantive, or none.`);
      return errors;
    }
  } else {
    if (!REVIEW_TRIGGERS.includes(candidate.trigger as ReviewTrigger)) errors.push(`${label} trigger must be off, manual, risk, or required.`);
    if (!REVIEW_PRESETS.includes(candidate.preset as ReviewPreset)) errors.push(`${label} preset must be experiment, personal, client, or custom.`);
    if (!REVIEW_SCOPES.includes(candidate.scope as ReviewScope)) errors.push(`${label} scope must be change, affected_components, or release.`);
    if (!REVIEW_CADENCES.includes(candidate.cadence as ReviewCadence)) errors.push(`${label} cadence must be task, milestone, or release.`);
    if (!REVIEWER_ROUTES.includes(candidate.reviewerRoute as ReviewerRoute)) errors.push(`${label} reviewerRoute must be independent_provider or same_provider_fresh_context.`);
    if (!CAPACITY_ACTIONS.includes(candidate.capacityAction as CapacityAction)) errors.push(`${label} capacityAction must be pending or blocked.`);
    if (!QUALITY_EXPECTATIONS.includes(candidate.qualityExpectation as QualityExpectation)) {
      errors.push(`${label} qualityExpectation must be advisory, configured_checks, or acceptance_and_gates.`);
    }
    if (!Array.isArray(candidate.blockingSeverities) || candidate.blockingSeverities.length === 0 ||
        candidate.blockingSeverities.some((severity) => !FINDING_SEVERITIES.includes(severity as FindingSeverity))) {
      errors.push(`${label} blockingSeverities must list at least one of critical, major, minor.`);
    } else if (!candidate.blockingSeverities.includes("critical")) {
      errors.push(`${label} blockingSeverities must always include critical.`);
    }
    if (!Array.isArray(candidate.riskRules)) errors.push(`${label} riskRules must be an array.`);
    else {
      for (const [index, rule] of candidate.riskRules.entries()) {
        if (normalizeRiskRule(rule, index) === null) errors.push(`${label} riskRules[${index}] must declare at least one matching condition.`);
        for (const pattern of [...((rule as RiskRule)?.pathPatterns ?? []), ...((rule as RiskRule)?.diffPatterns ?? [])]) {
          try { new RegExp(pattern, "i"); } catch { errors.push(`${label} riskRules[${index}] contains an invalid pattern: ${pattern}`); }
        }
      }
    }
    if (candidate.trigger === "risk" && Array.isArray(candidate.riskRules) && candidate.riskRules.length === 0) {
      errors.push(`${label}: a risk trigger with no risk rules would never review anything; use trigger "off" if that is intended.`);
    }
    if (candidate.mode !== undefined && candidate.trigger !== undefined && candidate.mode !== modeForTrigger(candidate.trigger as ReviewTrigger)) {
      errors.push(`${label} mode ${String(candidate.mode)} disagrees with trigger ${String(candidate.trigger)}.`);
    }
  }
  const skips = candidate.skipTaskClasses;
  if (!Array.isArray(skips) || skips.some((taskClass) => !TASK_CLASSES.includes(taskClass as TaskClass))) {
    errors.push(`${label} contains an unknown skip task class.`);
  } else if ((candidate.trigger ?? triggerForMode(candidate.mode as ReviewMode)) === "required" && skips.length > 0) {
    errors.push(`${label}: required review mode cannot skip task classes.`);
  }
  return [...new Set(errors)];
}

/** A change that a policy may weaken only by explicit user decision. */
export function weakensReview(from: ReviewPolicy, to: ReviewPolicy): string[] {
  const strength: Record<ReviewTrigger, number> = { off: 0, manual: 1, risk: 2, required: 3 };
  const reasons: string[] = [];
  if (strength[to.trigger] < strength[from.trigger]) reasons.push(`review trigger weakened from ${from.trigger} to ${to.trigger}`);
  const added = to.skipTaskClasses.filter((taskClass) => !from.skipTaskClasses.includes(taskClass));
  if (added.length > 0) reasons.push(`review now skips ${added.join(", ")}`);
  const droppedSeverities = from.blockingSeverities.filter((severity) => !to.blockingSeverities.includes(severity));
  if (droppedSeverities.length > 0) reasons.push(`findings of severity ${droppedSeverities.join(", ")} no longer block`);
  const expectation: Record<QualityExpectation, number> = { advisory: 0, configured_checks: 1, acceptance_and_gates: 2 };
  if (expectation[to.qualityExpectation] < expectation[from.qualityExpectation]) {
    reasons.push(`quality expectation weakened from ${from.qualityExpectation} to ${to.qualityExpectation}`);
  }
  return reasons;
}

export interface ReviewSubject {
  taskClass: TaskClass;
  role: string;
  changeRisk?: ChangeRisk;
}

export interface MatchedRiskRule {
  id: string;
  reason: string;
  evidence: string;
}

export interface ReviewDecision {
  review: boolean;
  policyVersion: string;
  preset: ReviewPreset;
  trigger: ReviewTrigger;
  scope: ReviewScope;
  cadence: ReviewCadence;
  reviewerRoute: ReviewerRoute;
  capacityAction: CapacityAction;
  blockingSeverities: FindingSeverity[];
  matchedRules: MatchedRiskRule[];
  reason: string;
}

function matchRule(rule: RiskRule, input: { subject: ReviewSubject; changedFiles: string[]; diffText: string }): MatchedRiskRule | null {
  if (rule.always) return { id: rule.id, reason: rule.reason, evidence: "policy reviews every task class it does not skip" };
  if (rule.taskClasses?.includes(input.subject.taskClass)) {
    return { id: rule.id, reason: rule.reason, evidence: `task class ${input.subject.taskClass}` };
  }
  if (input.subject.changeRisk && rule.changeRisks?.includes(input.subject.changeRisk)) {
    return { id: rule.id, reason: rule.reason, evidence: `declared change risk ${input.subject.changeRisk}` };
  }
  for (const pattern of rule.pathPatterns ?? []) {
    let expression: RegExp;
    try { expression = new RegExp(pattern, "i"); } catch { continue; }
    const hit = input.changedFiles.find((path) => expression.test(path.replaceAll("\\", "/")));
    if (hit) return { id: rule.id, reason: rule.reason, evidence: `changed path ${hit}` };
  }
  for (const pattern of rule.diffPatterns ?? []) {
    let expression: RegExp;
    try { expression = new RegExp(pattern, "i"); } catch { continue; }
    const match = expression.exec(input.diffText);
    if (match) return { id: rule.id, reason: rule.reason, evidence: `change content matched ${JSON.stringify(match[0].slice(0, 80))}` };
  }
  return null;
}

/**
 * Decide whether this task gets an independent review, and say exactly why.
 * `changedFiles` and `diffText` must come from the controller's own view of
 * the revision, never from the worker's self-report.
 */
export function evaluateReviewPolicy(policyInput: unknown, input: {
  subject: ReviewSubject;
  changedFiles?: string[];
  diffText?: string;
  /** A person explicitly asked for this review. */
  manualRequest?: boolean;
}): ReviewDecision {
  const policy = normalizeReviewPolicy(policyInput);
  const base = {
    policyVersion: policy.version,
    preset: policy.preset,
    trigger: policy.trigger,
    scope: policy.scope,
    cadence: policy.cadence,
    reviewerRoute: policy.reviewerRoute,
    capacityAction: policy.capacityAction,
    blockingSeverities: [...policy.blockingSeverities],
    matchedRules: [] as MatchedRiskRule[],
  };
  if (input.subject.role === "reviewer") {
    return { ...base, review: false, reason: "This task is itself a review." };
  }
  if (input.manualRequest) {
    return { ...base, review: true, reason: `Review was requested explicitly; the ${policy.preset} preset allows manual review at any time.` };
  }
  if (policy.trigger === "off") {
    return { ...base, review: false, reason: `The ${policy.preset} preset leaves automatic review off; manual review remains available.` };
  }
  if (policy.trigger === "manual") {
    return { ...base, review: false, reason: "This policy reviews only on explicit request." };
  }
  if (policy.skipTaskClasses.includes(input.subject.taskClass)) {
    return { ...base, review: false, reason: `Task class ${input.subject.taskClass} is excluded from review by project policy.` };
  }
  if (policy.trigger === "required") {
    return { ...base, review: true, reason: `The ${policy.preset} preset requires review of every change.` };
  }
  const changedFiles = input.changedFiles ?? [];
  const diffText = input.diffText ?? "";
  const matchedRules = policy.riskRules
    .map((rule) => matchRule(rule, { subject: input.subject, changedFiles, diffText }))
    .filter((match): match is MatchedRiskRule => match !== null);
  if (matchedRules.length > 0) {
    return {
      ...base,
      matchedRules,
      review: true,
      reason: `Risk-based review: ${matchedRules.map((rule) => `${rule.id} (${rule.evidence})`).join("; ")}.`,
    };
  }
  const inspected = changedFiles.length === 0 && diffText === ""
    ? "no change evidence was available yet"
    : `${changedFiles.length} changed file(s)`;
  return { ...base, review: false, reason: `No configured risk rule matched (${inspected}).` };
}

/** Compatibility helper for callers that only know the task, not the change. */
export function reviewRequiredFor(policy: unknown, subject: ReviewSubject, options: {
  changedFiles?: string[];
  diffText?: string;
  manualRequest?: boolean;
} = {}): boolean {
  return evaluateReviewPolicy(policy, { subject, ...options }).review;
}

export function findingSeverity(finding: string): FindingSeverity {
  const match = /^\s*\[(critical|major|minor)\]/i.exec(finding);
  return match ? (match[1] as string).toLowerCase() as FindingSeverity : DEFAULT_FINDING_SEVERITY;
}

/** Stamp an explicit severity so stored evidence is never ambiguous. */
export function labelFinding(finding: string): string {
  return /^\s*\[(critical|major|minor)\]/i.test(finding) ? finding.trim() : `[${DEFAULT_FINDING_SEVERITY}] ${finding.trim()}`;
}

export interface ClassifiedFindings {
  all: string[];
  blocking: string[];
  advisory: string[];
  counts: Record<FindingSeverity, number>;
}

/**
 * Split findings into blocking and advisory without discarding anything. An
 * advisory finding is still recorded, still shown, and still reviewed again if
 * the revision changes; it simply does not force another repair cycle.
 */
export function classifyFindings(
  findings: readonly string[],
  blockingSeverities: readonly FindingSeverity[] = DEFAULT_BLOCKING_SEVERITIES,
): ClassifiedFindings {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const all: string[] = [];
  const counts: Record<FindingSeverity, number> = { critical: 0, major: 0, minor: 0 };
  for (const raw of findings) {
    const finding = labelFinding(raw);
    const severity = findingSeverity(finding);
    counts[severity] += 1;
    all.push(finding);
    if (blockingSeverities.includes(severity)) blocking.push(finding);
    else advisory.push(finding);
  }
  return { all, blocking, advisory, counts };
}

/** One-line rendering for the CLI, the workbench, and event data. */
export function describeReviewPolicy(policyInput: unknown): string {
  const policy = normalizeReviewPolicy(policyInput);
  return [
    `preset=${policy.preset}`,
    `trigger=${policy.trigger}`,
    `scope=${policy.scope}`,
    `cadence=${policy.cadence}`,
    `blocking=${policy.blockingSeverities.join("+")}`,
    `quality=${policy.qualityExpectation}`,
    `reviewer=${policy.reviewerRoute}`,
    `capacity=${policy.capacityAction}`,
    policy.skipTaskClasses.length > 0 ? `skips=${policy.skipTaskClasses.join(",")}` : "skips=none",
    `rules=${policy.riskRules.length}`,
  ].join(" ");
}
