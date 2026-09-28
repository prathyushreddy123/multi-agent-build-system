/**
 * Task lifecycle, exactly as specified in the implementation plan.
 *
 * Normal path: QUEUED -> READY -> RUNNING -> CHECKING -> REVIEWING -> DONE.
 * Approval gates can intervene at any action boundary, so AWAITING_APPROVAL is
 * reachable from every working state and returns to the state that requested
 * it.
 */
export const TASK_STATES = [
  "QUEUED",
  "READY",
  "RUNNING",
  "CHECKING",
  "REVIEWING",
  "AWAITING_APPROVAL",
  "BLOCKED",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ["DONE", "FAILED", "CANCELLED"];

/** A task in one of these states owns a worker slot. */
export const SLOT_HOLDING_STATES: readonly TaskState[] = ["RUNNING", "CHECKING", "REVIEWING"];

/** Marks a task whose only outstanding work is a review the controller can retry. */
export const REVIEW_PENDING_PREFIX = "Review pending:";
export const REVIEW_RECOVERY_PREFIX = "Review recovery pending:";
/** In-flight work (repair, reroute) waiting for shared admission capacity. */
export const ADMISSION_PENDING_PREFIX = "Admission pending:";
/**
 * BLOCKED reasons for work that is still in flight: it keeps its allocation
 * and will resume by itself, so it counts as active, not stopped.
 */
export const IN_FLIGHT_BLOCKED_PREFIXES: readonly string[] = [ADMISSION_PENDING_PREFIX, REVIEW_PENDING_PREFIX, REVIEW_RECOVERY_PREFIX];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "BLOCKED", "QUEUED", "CANCELLED"],
  RUNNING: ["CHECKING", "AWAITING_APPROVAL", "BLOCKED", "FAILED", "CANCELLED", "READY"],
  CHECKING: ["REVIEWING", "RUNNING", "AWAITING_APPROVAL", "BLOCKED", "FAILED", "CANCELLED", "DONE"],
  REVIEWING: ["RUNNING", "AWAITING_APPROVAL", "DONE", "BLOCKED", "FAILED", "CANCELLED"],
  // An approval decision returns the task to the state that prepared the action.
  AWAITING_APPROVAL: ["RUNNING", "CHECKING", "REVIEWING", "READY", "BLOCKED", "DONE", "FAILED", "CANCELLED"],
  // REVIEWING is reachable from BLOCKED so a review deferred for provider
  // capacity can resume without repeating the implementation.
  BLOCKED: ["READY", "QUEUED", "RUNNING", "REVIEWING", "FAILED", "CANCELLED"],
  DONE: [],
  FAILED: ["QUEUED", "READY", "CANCELLED"],
  CANCELLED: ["QUEUED"],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function holdsSlot(state: TaskState): boolean {
  return SLOT_HOLDING_STATES.includes(state);
}
