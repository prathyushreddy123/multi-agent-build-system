/**
 * A refusal from an intake operation that the caller can act on without a
 * guess: a stable code, the human message, and the identifiers needed to
 * retry correctly. The CLI prints it as JSON so the conversation sees the
 * same fields a program would.
 */
export type IntakeErrorCode =
  | "unknown_clarification"
  | "clarification_brief_mismatch"
  | "invalid_resolution"
  | "already_resolved"
  | "stale_version"
  | "request_conflict"
  | "wrong_subject"
  | "stale_start";

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: IntakeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "IntakeError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.details };
  }
}
