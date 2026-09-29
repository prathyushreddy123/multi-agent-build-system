/**
 * What a running worker is doing, derived from the provider events it has
 * already streamed: zero tokens, no extra process. Visibility only; nothing
 * is cancelled on this basis.
 */
export type AttemptHealth = "starting" | "working" | "idle" | "stalled" | "finished";

/** A quiet stretch this long is normal while a check or a long tool call runs. */
export const IDLE_AFTER_MS = 90_000;
/** No provider event for this long is worth an operator's attention. */
export const STALL_AFTER_MS = 10 * 60_000;

export function attemptHealth(
  attempt: { state: string; startedAt: string; lastEventAt: string | null },
  now = Date.now(),
): AttemptHealth {
  if (attempt.state !== "running") return "finished";
  const quietMs = now - Date.parse(attempt.lastEventAt ?? attempt.startedAt);
  if (quietMs >= STALL_AFTER_MS) return "stalled";
  if (attempt.lastEventAt === null) return "starting";
  return quietMs >= IDLE_AFTER_MS ? "idle" : "working";
}
