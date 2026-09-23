/**
 * Whether a controller is actually alive right now.
 *
 * The health row records what a controller last said about itself. That is not
 * the same question. A SIGKILLed controller leaves `state: "running"` behind
 * forever, and a controller that is alive but no longer ticking looks identical
 * to a healthy one. Neither case is visible from the health row alone.
 *
 * The lease answers it, because the lease is renewed by every tick and carries
 * the owning pid. Combining "is that pid alive" with "how old is the renewal"
 * separates the four cases that matter operationally.
 */
import type { Records } from "../store/records.ts";

/** A lease renewal older than this means the loop is not ticking normally. */
export const LEASE_STALE_MS = 15_000;

export type ControllerLivenessState =
  /** No lease row: nothing holds the right to dispatch. */
  | "not_running"
  /** Lease held, owner alive, renewals current. */
  | "healthy"
  /** Lease held by a live process whose renewals stopped. */
  | "wedged"
  /** Lease held by a pid that no longer exists. */
  | "crashed";

export interface ControllerLiveness {
  state: ControllerLivenessState;
  controllerId: string | null;
  pid: number | null;
  /** Whether the recorded pid currently exists. Null when there is no lease. */
  processAlive: boolean | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  /** Plain language, safe to print directly. */
  reason: string;
  /** True when starting another controller would just contend for the lease. */
  startWouldContend: boolean;
}

/**
 * Ask the operating system whether a pid exists.
 *
 * Signal 0 performs permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to another user, which
 * still answers the question. Pid reuse can theoretically make a dead
 * controller look alive; locally the risk is negligible and the staleness
 * window bounds it.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function describe(age: number | null): string {
  if (age === null) return "never";
  if (age < 1000) return "just now";
  return `${Math.round(age / 1000)}s ago`;
}

export function controllerLiveness(
  records: Records,
  options: { now?: number; staleMs?: number } = {},
): ControllerLiveness {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? LEASE_STALE_MS;
  const lease = records.currentControllerLease();

  if (!lease) {
    return {
      state: "not_running",
      controllerId: null,
      pid: null,
      processAlive: null,
      heartbeatAt: null,
      heartbeatAgeMs: null,
      reason: "No controller holds the lease. Nothing is dispatching work.",
      startWouldContend: false,
    };
  }

  const controllerId = (lease.controller_id as string | null) ?? null;
  const pid = lease.pid === undefined || lease.pid === null ? null : Number(lease.pid);
  const heartbeatAt = (lease.heartbeat_at as string | null) ?? null;
  const parsed = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
  const alive = pid === null ? false : processAlive(pid);
  const fresh = heartbeatAgeMs !== null && heartbeatAgeMs <= staleMs;

  if (!alive) {
    return {
      state: "crashed", controllerId, pid, processAlive: false, heartbeatAt, heartbeatAgeMs,
      reason:
        `Controller ${controllerId ?? "unknown"} holds the lease but pid ${pid ?? "unknown"} is gone. ` +
        `It last renewed ${describe(heartbeatAgeMs)}. The next controller to start will take the lease over.`,
      // A dead owner cannot contend, and a fresh start reclaims the lease.
      startWouldContend: false,
    };
  }

  if (!fresh) {
    return {
      state: "wedged", controllerId, pid, processAlive: true, heartbeatAt, heartbeatAgeMs,
      reason:
        `Controller ${controllerId ?? "unknown"} (pid ${pid ?? "unknown"}) is running but last renewed the lease ` +
        `${describe(heartbeatAgeMs)}, beyond the ${Math.round(staleMs / 1000)}s window. It is alive and not ticking normally; ` +
        `investigate that process rather than starting another.`,
      // The lease is stale, so a new controller would take it rather than spin.
      startWouldContend: false,
    };
  }

  return {
    state: "healthy", controllerId, pid, processAlive: true, heartbeatAt, heartbeatAgeMs,
    reason: `Controller ${controllerId ?? "unknown"} (pid ${pid ?? "unknown"}) is running; lease renewed ${describe(heartbeatAgeMs)}.`,
    startWouldContend: true,
  };
}
