/**
 * Phase 3 — the Tasks surface.
 *
 * A read-only terminal dashboard over `buildProgressSnapshot`. It polls the
 * existing read API on a bounded interval while visible and redraws; it never
 * dispatches, claims, or transitions anything, and Ctrl+C stops only the
 * dashboard.
 *
 * Selection is kept by task ID rather than row index, so a refresh that
 * reorders or inserts rows leaves the highlighted task where it was. Scroll
 * offset is clamped, not reset.
 */
import type { Records } from "../store/records.ts";
import {
  TASK_GROUPS,
  buildProgressSnapshot,
  type ProgressSnapshot,
  type TaskGroup,
  type TaskRow,
  type TaskStep,
} from "./progress.ts";

export interface DashboardView {
  /** Task ID of the highlighted row, or null when there are no rows. */
  selectedTaskId: string | null;
  /** Index of the first visible row. */
  scrollOffset: number;
  /** Rows visible at once. */
  pageSize: number;
  /** Show the selected task's recorded steps. */
  expanded: boolean;
  /** Only show these groups. Empty means all. */
  groupFilter: TaskGroup[];
}

export const INITIAL_VIEW: DashboardView = {
  selectedTaskId: null,
  scrollOffset: 0,
  pageSize: 20,
  expanded: false,
  groupFilter: [],
};

export function visibleRows(snapshot: ProgressSnapshot, view: DashboardView): TaskRow[] {
  const order = new Map(TASK_GROUPS.map((group, index) => [group, index]));
  const filtered = view.groupFilter.length === 0
    ? snapshot.tasks
    : snapshot.tasks.filter((row) => view.groupFilter.includes(row.group));
  return [...filtered].sort((left, right) => {
    const byGroup = (order.get(left.group) ?? 99) - (order.get(right.group) ?? 99);
    if (byGroup !== 0) return byGroup;
    return right.lastUpdate.localeCompare(left.lastUpdate);
  });
}

/**
 * Reconcile the view against a fresh snapshot.
 *
 * The selected task is followed by ID. When it disappears, the selection falls
 * to the nearest row rather than jumping to the top, and the scroll offset is
 * clamped so the selection stays on screen.
 */
export function reconcileView(snapshot: ProgressSnapshot, view: DashboardView, previous?: ProgressSnapshot): DashboardView {
  const rows = visibleRows(snapshot, view);
  if (rows.length === 0) return { ...view, selectedTaskId: null, scrollOffset: 0 };

  let selectedIndex = rows.findIndex((row) => row.taskId === view.selectedTaskId);
  if (selectedIndex === -1) {
    if (view.selectedTaskId && previous) {
      // Keep the reader near where they were looking instead of resetting.
      const previousRows = visibleRows(previous, view);
      const previousIndex = previousRows.findIndex((row) => row.taskId === view.selectedTaskId);
      selectedIndex = previousIndex === -1 ? 0 : Math.min(Math.max(previousIndex, 0), rows.length - 1);
    } else {
      selectedIndex = 0;
    }
  }

  const pageSize = Math.max(1, view.pageSize);
  let scrollOffset = Math.min(view.scrollOffset, Math.max(0, rows.length - pageSize));
  scrollOffset = Math.max(0, scrollOffset);
  if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
  if (selectedIndex >= scrollOffset + pageSize) scrollOffset = selectedIndex - pageSize + 1;

  return { ...view, selectedTaskId: rows[selectedIndex]?.taskId ?? null, scrollOffset };
}

export function moveSelection(snapshot: ProgressSnapshot, view: DashboardView, delta: number): DashboardView {
  const rows = visibleRows(snapshot, view);
  if (rows.length === 0) return view;
  const current = Math.max(0, rows.findIndex((row) => row.taskId === view.selectedTaskId));
  const next = Math.min(rows.length - 1, Math.max(0, current + delta));
  return reconcileView(snapshot, { ...view, selectedTaskId: rows[next]?.taskId ?? null });
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function pad(value: string, width: number): string {
  const text = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return text.padEnd(width);
}

function rowLine(row: TaskRow, selected: boolean): string {
  const marker = selected ? "▸" : " ";
  const route = row.provider ? `${row.provider}${row.model ? `/${row.model}` : ""}` : "unrouted";
  const attempt = row.attemptNumber === null ? "—" : `#${row.attemptNumber}${row.attemptKind ? ` ${row.attemptKind.slice(0, 4)}` : ""}`;
  const reason = row.blockedReason ?? (row.waitingOn.length > 0 ? `waiting on ${row.waitingOn.length} dependency` : "");
  const stale = row.staleHeartbeat ? " [stale heartbeat]" : "";
  return `${marker} ${pad(row.state, 18)} ${pad(row.taskId, 14)} ${pad(row.title, 32)} ${pad(route, 20)} ${pad(attempt, 10)} ${pad(duration(row.elapsedMs), 8)} ${pad(reason + stale, 40)}`;
}

function stepLine(step: TaskStep): string {
  const mark = step.status === "completed" ? "✓" : step.status === "failed" ? "✗" : step.status === "running" ? "…" : step.status === "blocked" ? "■" : "·";
  const attempt = step.attemptNumber === null ? "  " : `#${step.attemptNumber}`;
  const evidence = step.evidencePaths.length > 0 ? ` (${step.evidencePaths.length} evidence)` : "";
  const missing = step.missingEvidence.length > 0 ? ` [${step.missingEvidence.length} evidence missing]` : "";
  return `    ${mark} ${attempt} ${pad(step.kind, 26)} ${pad(step.summary, 58)}${pad(duration(step.durationMs), 9)}${evidence}${missing}`;
}

/** Draw the whole dashboard. Pure, so the layout is testable without a terminal. */
export function renderDashboard(snapshot: ProgressSnapshot, view: DashboardView): string {
  const rows = visibleRows(snapshot, view);
  const lines: string[] = [];

  const counts = snapshot.counts;
  lines.push(
    `MABS tasks — ${counts.total} recorded: ${counts.active} active · ${counts.ready} ready · ` +
    `${counts.waiting} waiting · ${counts.blocked} blocked · ${counts.failed} failed · ${counts.completed} completed`,
  );
  // Completed is a count of recorded completions, not an estimate of progress.
  lines.push(
    `controller ${snapshot.controller.state}` +
    (snapshot.controller.heartbeatAgeMs === null ? " (never reported)" : ` (heartbeat ${duration(snapshot.controller.heartbeatAgeMs)} ago)`) +
    (snapshot.controller.stale ? "  ⚠ STALE" : "") +
    (snapshot.controller.backpressureReason ? `  backpressure: ${snapshot.controller.backpressureReason}` : ""),
  );
  lines.push(
    `providers: ${snapshot.providers.map((provider) => `${provider.provider}=${provider.availability}`).join("  ") || "none observed"}`,
  );
  lines.push("");
  lines.push(`  ${pad("STATE", 18)} ${pad("TASK", 14)} ${pad("TITLE", 32)} ${pad("ROUTE", 20)} ${pad("ATTEMPT", 10)} ${pad("ELAPSED", 8)} ${pad("REASON", 40)}`);

  if (rows.length === 0) {
    lines.push("  No tasks match the current filter.");
  }

  const page = rows.slice(view.scrollOffset, view.scrollOffset + view.pageSize);
  for (const row of page) {
    const selected = row.taskId === view.selectedTaskId;
    lines.push(rowLine(row, selected));
    if (selected && view.expanded) {
      if (row.planObjective) lines.push(`    plan: ${row.planObjective}`);
      if (row.steps.length === 0) {
        lines.push("    No steps have been recorded for this task yet.");
      }
      for (const step of row.steps) lines.push(stepLine(step));
      for (const gap of row.stepGaps) lines.push(`    unavailable: ${gap}`);
      lines.push(`    result revision: ${row.resultRevision ?? "none"}   delivery: ${row.delivery}${row.deliveryDetail ? ` — ${row.deliveryDetail}` : ""}`);
      if (row.review) lines.push(`    review: ${row.review.verdict} (${row.review.blockingFindings} blocking)`);
      if (row.checks.length > 0) {
        lines.push(`    checks: ${row.checks.map((check) => `${check.name}=${check.status}`).join("  ")}`);
      }
    }
  }

  if (rows.length > view.scrollOffset + view.pageSize) {
    lines.push(`  … ${rows.length - view.scrollOffset - view.pageSize} more below`);
  }

  if (snapshot.notes.length > 0) {
    lines.push("");
    for (const note of snapshot.notes) lines.push(`  ⚠ ${note}`);
  }
  lines.push("");
  lines.push("  ↑/↓ select   enter steps   f filter   r refresh   q quit (stops this dashboard only)");
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// loop
// --------------------------------------------------------------------------

export interface WatchOptions {
  projectId?: string | null;
  intervalMs?: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** Write a frame. Defaults to stdout with the alternate screen. */
  write?: (frame: string) => void;
  /** Read keys. Defaults to raw stdin when it is a TTY. */
  input?: NodeJS.ReadStream;
}

/**
 * Run the dashboard until stopped.
 *
 * Polling is bounded and only happens while the surface is visible. Stopping
 * this loop closes a view; no worker, task, or record is affected.
 */
export async function watchTasks(records: Records, options: WatchOptions = {}): Promise<void> {
  const interval = Math.max(250, options.intervalMs ?? 1000);
  const input = options.input ?? process.stdin;
  const isTty = Boolean(input.isTTY) && Boolean(process.stdout.isTTY);
  const write = options.write ?? ((frame: string) => {
    process.stdout.write(`\u001b[H\u001b[2J${frame}\n`);
  });

  let view: DashboardView = { ...INITIAL_VIEW, pageSize: options.pageSize ?? INITIAL_VIEW.pageSize };
  let previous: ProgressSnapshot | undefined;
  let stopped = false;

  const refresh = () => {
    const snapshot = buildProgressSnapshot(records, { projectId: options.projectId, withSteps: true });
    view = reconcileView(snapshot, view, previous);
    previous = snapshot;
    write(renderDashboard(snapshot, view));
    return snapshot;
  };

  const stop = () => { stopped = true; };
  options.signal?.addEventListener("abort", stop, { once: true });

  if (isTty) {
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding("utf8");
  }

  const onKey = (key: string) => {
    if (!previous) return;
    if (key === "q" || key === "\u0003" || key === "\u001b") { stop(); return; }
    if (key === "\u001b[A" || key === "k") view = moveSelection(previous, view, -1);
    else if (key === "\u001b[B" || key === "j") view = moveSelection(previous, view, 1);
    else if (key === "\u001b[5~") view = moveSelection(previous, view, -view.pageSize);
    else if (key === "\u001b[6~") view = moveSelection(previous, view, view.pageSize);
    else if (key === "\r" || key === "\n") view = { ...view, expanded: !view.expanded };
    else if (key === "f") {
      const next: TaskGroup[] = view.groupFilter.length === 0 ? ["active", "blocked", "failed"] : [];
      view = reconcileView(previous, { ...view, groupFilter: next });
    } else if (key !== "r") return;
    write(renderDashboard(previous, view));
  };
  if (isTty) input.on("data", onKey);

  try {
    refresh();
    while (!stopped) {
      await new Promise((done) => setTimeout(done, interval));
      if (stopped) break;
      refresh();
    }
  } finally {
    options.signal?.removeEventListener("abort", stop);
    if (isTty) {
      input.off("data", onKey);
      input.setRawMode?.(false);
      input.pause();
      process.stdout.write("\u001b[?25h\u001b[?1049l");
    }
  }
}
