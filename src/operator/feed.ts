/**
 * The progress feed: what the conversation's status line and notices show
 * between turns, computed deterministically and with no model call.
 *
 * A frame is a compact, bounded view of active and recently changed tasks.
 * `diffFeed` compares two frames and reports only what a person would want to
 * be told: work finished, work that needs attention or a decision, and a
 * controller that stopped. Routine steps (queued, running, checking) only
 * change the status line. Several changes in one poll are coalesced into one
 * notice per kind. The first frame of a session only sets the status line, so
 * opening Pi never floods old history.
 */
import type { ProgressSnapshot, TaskRow } from "./progress.ts";

export const FEED_VERSION = "mabs.feed.v1";
/** How far back a finished task still appears, so its completion can be noticed. */
export const FEED_RECENT_MS = 60 * 60_000;
export const FEED_TASK_LIMIT = 200;

export interface FeedTask {
  id: string;
  title: string;
  project: string;
  state: string;
  reason: string | null;
}

export interface FeedFrame {
  version: string;
  at: string;
  controller: { state: string; reason: string };
  counts: { active: number; waiting: number; attention: number; done: number };
  tasks: FeedTask[];
}

export interface FeedNotice {
  kind: "done" | "attention" | "decision" | "controller";
  level: "info" | "warning";
  text: string;
}

const ATTENTION = new Set(["BLOCKED", "FAILED"]);
const DECISION = new Set(["AWAITING_APPROVAL"]);
const ACTIVE = new Set(["RUNNING", "CHECKING", "REVIEWING"]);
const WAITING = new Set(["QUEUED", "READY"]);

function firstLine(text: string | null, limit = 140): string | null {
  if (!text) return null;
  const line = text.split("\n")[0] as string;
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

/** A bounded frame from the progress snapshot: unfinished tasks plus anything that changed recently. */
export function feedFrame(snapshot: ProgressSnapshot, now = Date.now()): FeedFrame {
  const recent = (row: TaskRow) => now - Date.parse(row.lastUpdate) <= FEED_RECENT_MS;
  const relevant = snapshot.tasks.filter((row) => !["DONE", "CANCELLED"].includes(row.state) || recent(row));
  const tasks = relevant.slice(0, FEED_TASK_LIMIT).map((row) => ({
    id: row.taskId, title: row.title, project: row.projectName, state: row.state, reason: firstLine(row.blockedReason),
  }));
  const count = (states: Set<string>) => snapshot.tasks.filter((row) => states.has(row.state)).length;
  return {
    version: FEED_VERSION,
    at: snapshot.generatedAt,
    controller: { state: snapshot.controller.state, reason: snapshot.controller.reason },
    counts: { active: count(ACTIVE), waiting: count(WAITING), attention: count(ATTENTION) + count(DECISION), done: count(new Set(["DONE"])) },
    tasks,
  };
}

export function statusLine(frame: FeedFrame): string {
  const parts = [`MABS ${frame.counts.active} active`];
  if (frame.counts.waiting > 0) parts.push(`${frame.counts.waiting} queued`);
  parts.push(`${frame.counts.attention} attention`);
  if (frame.controller.state !== "running" && (frame.counts.active > 0 || frame.counts.waiting > 0)) parts.push(`controller ${frame.controller.state}`);
  return parts.join(" · ");
}

function names(tasks: FeedTask[], limit = 3): string {
  const shown = tasks.slice(0, limit).map((task) => `${task.title} (${task.id})`);
  return tasks.length > limit ? `${shown.join(", ")} and ${tasks.length - limit} more` : shown.join(", ");
}

/** Status line plus coalesced notices for what changed since the previous frame. */
export function diffFeed(previous: FeedFrame | null, next: FeedFrame): { statusLine: string; notices: FeedNotice[] } {
  const line = statusLine(next);
  if (!previous) return { statusLine: line, notices: [] };
  const before = new Map(previous.tasks.map((task) => [task.id, task.state]));
  const changed = next.tasks.filter((task) => before.get(task.id) !== task.state);
  const entered = (states: Set<string>) => changed.filter((task) => states.has(task.state));
  const notices: FeedNotice[] = [];

  const done = entered(new Set(["DONE"]));
  if (done.length > 0) notices.push({ kind: "done", level: "info", text: `${done.length === 1 ? "Done" : `${done.length} done`}: ${names(done)}. Not merged or deployed.` });
  const attention = entered(ATTENTION);
  if (attention.length > 0) {
    const detail = attention.length === 1 && attention[0]?.reason ? ` — ${attention[0].reason}` : "";
    notices.push({ kind: "attention", level: "warning", text: `Needs attention: ${names(attention)}${detail}. Ask about it, or run /mabs-progress.` });
  }
  const decision = entered(DECISION);
  if (decision.length > 0) notices.push({ kind: "decision", level: "warning", text: `Waiting for your approval: ${names(decision)}.` });
  const pending = next.counts.active + next.counts.waiting > 0;
  if (previous.controller.state === "running" && next.controller.state !== "running" && pending) {
    notices.push({ kind: "controller", level: "warning", text: `The MABS controller is ${next.controller.state} with work pending: ${next.controller.reason}` });
  }
  return { statusLine: line, notices };
}
