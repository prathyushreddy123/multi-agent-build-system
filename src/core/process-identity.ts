/**
 * Process identity beyond a PID.
 *
 * A PID alone is reusable: after a detached wrapper exits, the kernel can hand
 * its number to an unrelated process. Recovery that trusted the bare PID could
 * adopt that process, hold its lease forever, or signal its process group. A
 * live process is therefore the recorded one only when its kernel start time,
 * the boot it started in, and its argv (which names the launch specification)
 * all still match.
 */
import { existsSync, readFileSync } from "node:fs";

export interface ProcessIdentity {
  pid: number;
  /** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
  startTicks: string | null;
  bootId: string | null;
}

export const PROC_AVAILABLE = existsSync("/proc/self/stat");

function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

function startTicks(pid: number | "self"): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesized and may itself contain spaces or
    // parentheses, so fields are counted from the last closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** This process's identity, written into a start marker before any work begins. */
export function selfIdentity(): ProcessIdentity {
  return { pid: process.pid, startTicks: PROC_AVAILABLE ? startTicks("self") : null, bootId: PROC_AVAILABLE ? bootId() : null };
}

function signalable(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether `pid` is still the recorded process.
 * - `alive`: running, and every recorded identity field and the argv match.
 * - `gone`: not running, or the PID now belongs to a different process.
 * - `unverifiable`: something runs under the PID but nothing proves it is
 *   ours (no process table, or no recorded start time or argv to compare);
 *   callers must neither adopt nor signal it.
 */
export function verifyProcess(
  pid: number,
  expected: { argument?: string; startTicks?: string | null; bootId?: string | null },
): "alive" | "gone" | "unverifiable" {
  if (!signalable(pid)) return "gone";
  if (!PROC_AVAILABLE) return "unverifiable";
  if (expected.bootId && expected.bootId !== bootId()) return "gone";
  const ticks = startTicks(pid);
  if (ticks === null) return "gone";
  if (expected.startTicks && expected.startTicks !== ticks) return "gone";
  if (expected.argument === undefined) return expected.startTicks ? "alive" : "unverifiable";
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return argv.includes(expected.argument) ? "alive" : "gone";
  } catch {
    return "gone";
  }
}
