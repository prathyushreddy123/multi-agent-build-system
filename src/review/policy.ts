/**
 * Review policy: one normalization, one validation, one severity vocabulary.
 *
 * Dispatch, review verdicts, approval preparation, the CLI, and the workbench
 * all read this module so a policy cannot mean one thing in the controller and
 * another in stored records.
 */
import { TASK_CLASSES, type TaskClass } from "../routing/router.ts";

export type ReviewMode = "required" | "substantive" | "none";

export interface ReviewPolicy {
  mode: ReviewMode;
  skipTaskClasses: TaskClass[];
}

export const REVIEW_MODES: readonly ReviewMode[] = ["required", "substantive", "none"];

/** Classes whose output is deterministic or non-code, so a code review adds nothing. */
export const DEFAULT_SKIP_TASK_CLASSES: readonly TaskClass[] = ["mechanical", "planning", "research"];

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  mode: "substantive",
  skipTaskClasses: [...DEFAULT_SKIP_TASK_CLASSES],
};

export type FindingSeverity = "critical" | "major" | "minor";
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["critical", "major", "minor"];

/** A finding without an explicit severity is treated as blocking, never as advice. */
export const DEFAULT_FINDING_SEVERITY: FindingSeverity = "major";
export const DEFAULT_BLOCKING_SEVERITIES: readonly FindingSeverity[] = ["critical", "major"];

export interface ClassifiedFindings {
  all: string[];
  blocking: string[];
  advisory: string[];
  counts: Record<FindingSeverity, number>;
}

/**
 * Normalize an untrusted policy value. Required mode never inherits skip
 * classes: a project that asks for review of everything gets review of
 * everything, whatever the caller passed alongside the mode.
 */
export function normalizeReviewPolicy(input: unknown, fallback: ReviewPolicy = DEFAULT_REVIEW_POLICY): ReviewPolicy {
  const candidate = (input ?? {}) as Partial<ReviewPolicy>;
  const mode = REVIEW_MODES.includes(candidate.mode as ReviewMode) ? (candidate.mode as ReviewMode) : fallback.mode;
  const declared = Array.isArray(candidate.skipTaskClasses) ? candidate.skipTaskClasses : fallback.skipTaskClasses;
  const skipTaskClasses = mode === "required"
    ? []
    : [...new Set(declared.filter((taskClass): taskClass is TaskClass => TASK_CLASSES.includes(taskClass as TaskClass)))];
  return { mode, skipTaskClasses };
}

/** True when normalization had to change the caller's intent, which is worth recording. */
export function reviewPolicyNormalizationNotes(input: unknown, normalized: ReviewPolicy): string[] {
  const candidate = (input ?? {}) as Partial<ReviewPolicy>;
  const notes: string[] = [];
  const declared = Array.isArray(candidate.skipTaskClasses) ? candidate.skipTaskClasses : [];
  if (candidate.mode !== undefined && !REVIEW_MODES.includes(candidate.mode as ReviewMode)) {
    notes.push(`Unknown review mode ${String(candidate.mode)} replaced with ${normalized.mode}.`);
  }
  if (normalized.mode === "required" && declared.length > 0) {
    notes.push(`Required review cannot skip task classes; dropped ${declared.join(", ")}.`);
  }
  const unknown = declared.filter((taskClass) => !TASK_CLASSES.includes(taskClass as TaskClass));
  if (normalized.mode !== "required" && unknown.length > 0) {
    notes.push(`Dropped unknown review skip task classes: ${unknown.join(", ")}.`);
  }
  return notes;
}

/** Strict validation for explicitly authored configuration, which must not be silently repaired. */
export function validateReviewPolicy(policy: unknown, label = "reviewPolicy"): string[] {
  const errors: string[] = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return [`${label} must be an object.`];
  const candidate = policy as Partial<ReviewPolicy>;
  for (const key of Object.keys(candidate)) {
    if (!["mode", "skipTaskClasses"].includes(key)) errors.push(`${label} contains unknown property ${key}.`);
  }
  if (!REVIEW_MODES.includes(candidate.mode as ReviewMode)) {
    errors.push(`${label} mode must be required, substantive, or none.`);
    return errors;
  }
  if (!Array.isArray(candidate.skipTaskClasses) ||
      candidate.skipTaskClasses.some((taskClass) => !TASK_CLASSES.includes(taskClass as TaskClass))) {
    errors.push(`${label} contains an unknown skip task class.`);
  } else if (candidate.mode === "required" && candidate.skipTaskClasses.length > 0) {
    errors.push(`${label}: required review mode cannot skip task classes.`);
  }
  return errors;
}

/** Whether an independent review runs for this task under this policy. */
export function reviewRequiredFor(policy: ReviewPolicy, input: { taskClass: TaskClass; role: string }): boolean {
  const normalized = normalizeReviewPolicy(policy);
  if (input.role === "reviewer" || normalized.mode === "none") return false;
  return !normalized.skipTaskClasses.includes(input.taskClass);
}

export function findingSeverity(finding: string): FindingSeverity {
  const match = /^\s*\[(critical|major|minor)\]/i.exec(finding);
  return match ? (match[1] as string).toLowerCase() as FindingSeverity : DEFAULT_FINDING_SEVERITY;
}

/** Stamp an explicit severity so stored evidence is never ambiguous. */
export function labelFinding(finding: string): string {
  return /^\s*\[(critical|major|minor)\]/i.test(finding) ? finding.trim() : `[${DEFAULT_FINDING_SEVERITY}] ${finding.trim()}`;
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
