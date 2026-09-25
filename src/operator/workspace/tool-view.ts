/**
 * Workspace-scoped control channel and rail-free Tasks/Logs renderer.
 *
 * A launcher click writes a selection here; the one process owned by that
 * workspace's tool tab reads it on refresh.  No command is typed into a live
 * terminal to change filters, and a request from one workspace can never be
 * consumed by another workspace.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "../../core/paths.ts";
import type { Records } from "../../store/records.ts";
import { INITIAL_VIEW, reconcileView, renderDashboard } from "../dashboard.ts";
import { listEvidence, type EvidenceListing } from "../logs.ts";
import { buildProgressSnapshot } from "../progress.ts";

export type ToolViewSurface = "tasks" | "logs";

export interface ToolViewSelection {
  projectId: string;
  taskId: string | null;
}

export interface ToolViewRequest extends ToolViewSelection {
  version: 1;
  sequence: number;
  requestedAt: string;
  workspaceId: string;
  surface: ToolViewSurface;
}

function workspaceSegment(workspaceId: string): string {
  // Herdr IDs are normally short and safe, but the channel boundary should not
  // rely on that. Base64url has no path separators and does not turn `..` into
  // a parent directory.
  return Buffer.from(workspaceId, "utf8").toString("base64url") || "_";
}

/** The channel path is namespaced by the invoking workspace and surface. */
export function toolViewRequestPath(workspaceId: string, surface: ToolViewSurface): string {
  return join(stateDir(), "operator", "tool-views", workspaceSegment(workspaceId), `${surface}.json`);
}

function validRequest(value: unknown, workspaceId: string, surface: ToolViewSurface): value is ToolViewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<ToolViewRequest>;
  return request.version === 1
    && request.workspaceId === workspaceId
    && request.surface === surface
    && typeof request.sequence === "number"
    && Number.isSafeInteger(request.sequence)
    && request.sequence > 0
    && typeof request.requestedAt === "string"
    && typeof request.projectId === "string"
    && request.projectId.length > 0
    && (request.taskId === null || typeof request.taskId === "string");
}

/** Read only an exact workspace/surface request; malformed or stale data is ignored. */
export function readToolViewRequest(workspaceId: string, surface: ToolViewSurface): ToolViewRequest | null {
  const path = toolViewRequestPath(workspaceId, surface);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return validRequest(value, workspaceId, surface) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Atomically select what an already-running tool tab should display.
 * Repeating the exact selection is a no-op, which keeps repeated opens
 * idempotent while still allowing project/task changes through this channel.
 */
export function requestToolView(
  workspaceId: string,
  surface: ToolViewSurface,
  selection: ToolViewSelection,
): { request: ToolViewRequest; changed: boolean } {
  const previous = readToolViewRequest(workspaceId, surface);
  if (
    previous
    && previous.projectId === selection.projectId
    && previous.taskId === selection.taskId
  ) {
    return { request: previous, changed: false };
  }
  const request: ToolViewRequest = {
    version: 1,
    sequence: (previous?.sequence ?? 0) + 1,
    requestedAt: new Date().toISOString(),
    workspaceId,
    surface,
    projectId: selection.projectId,
    taskId: selection.taskId,
  };
  const path = toolViewRequestPath(workspaceId, surface);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return { request, changed: true };
}

/**
 * The footer every tool view ends with.
 *
 * A tool view navigates nothing but itself: the frame redraws on its own
 * interval, so no refresh key is advertised, and the only key it honours is the
 * one that closes this view. Quitting ends a view, not a worker.
 */
const VIEW_FOOTER = "q quit (closes this view only)";

function renderEvidence(listing: EvidenceListing): string {
  const lines = [`MABS logs — ${listing.taskId}`, ""];
  if (listing.entries.length === 0) lines.push("No evidence has been recorded for this task.");
  for (const entry of listing.entries) {
    const availability = entry.exists ? `${entry.sizeBytes ?? 0} bytes` : "unavailable";
    lines.push(`${entry.id}  ${entry.label}  [${availability}]`);
  }
  if (listing.notes.length > 0) {
    lines.push("");
    for (const note of listing.notes) lines.push(`⚠ ${note}`);
  }
  lines.push("", `  ${VIEW_FOOTER}`);
  return lines.join("\n");
}

/**
 * The shared dashboard renderer ends with its own interactive key hints, which
 * offer selection, expansion, and filtering this tab deliberately does not
 * provide. They are dropped by matching the line itself rather than by
 * anchoring to the end of the frame, so a future trailing line cannot silently
 * leave a rail behind.
 */
const INTERACTIVE_HINT = /^\s*↑\/↓\s/;

function railFree(frame: string, footer: string): string {
  const lines = frame.split("\n").filter((line) => !INTERACTIVE_HINT.test(line));
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return [...lines, "", `  ${footer}`].join("\n");
}

/** Render exactly one selected surface. There is deliberately no internal navigation rail. */
export function renderToolView(records: Records, request: ToolViewRequest): string {
  const project = records.getProject(request.projectId);
  if (!project) {
    return `MABS ${request.surface}\n\nSelection ${request.projectId} is stale; reopen the launcher to select a project.\n\n  ${VIEW_FOOTER}`;
  }
  if (request.surface === "tasks") {
    const snapshot = buildProgressSnapshot(records, { projectId: project.id, withSteps: true });
    const frame = renderDashboard(snapshot, reconcileView(snapshot, { ...INITIAL_VIEW, pageSize: 50 }));
    return railFree(frame, VIEW_FOOTER);
  }
  if (!request.taskId) return `MABS logs\n\nNo task is selected.\n\n  ${VIEW_FOOTER}`;
  const task = records.getTask(request.taskId);
  if (!task || task.projectId !== project.id) {
    return `MABS logs\n\nSelection ${request.taskId} is stale or does not belong to ${project.id}; reopen the launcher to select a task.\n\n  ${VIEW_FOOTER}`;
  }
  return renderEvidence(listEvidence(records, { taskId: task.id }));
}

export interface ServeToolViewOptions {
  workspaceId: string;
  surface: ToolViewSurface;
  intervalMs?: number;
  /** Render one frame and return; used by diagnostics without a live terminal. */
  once?: boolean;
  signal?: AbortSignal;
  input?: NodeJS.ReadStream;
  write?: (frame: string) => void;
}

/** Serve one full-tab surface and pick up scope changes from its channel. */
export async function serveToolView(records: Records, options: ServeToolViewOptions): Promise<void> {
  const intervalMs = Math.max(250, options.intervalMs ?? 1000);
  const input = options.input ?? process.stdin;
  const isTty = Boolean(input.isTTY) && Boolean(process.stdout.isTTY);
  const write = options.write ?? ((frame: string) => process.stdout.write(`\u001b[H\u001b[2J${frame}\n`));
  let stopped = false;
  // Quitting must not wait out the refresh interval, so the sleep is woken
  // rather than merely flagged.
  let wake: (() => void) | null = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  const onKey = (key: string) => {
    if (key === "q" || key === "\u001b" || key === "\u0003") stop();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (isTty) {
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onKey);
  }
  try {
    while (!stopped) {
      const request = readToolViewRequest(options.workspaceId, options.surface);
      write(request
        ? renderToolView(records, request)
        : `MABS ${options.surface}\n\nWaiting for a workspace-scoped selection.\n\n  ${VIEW_FOOTER}`);
      if (stopped || options.once) break;
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, intervalMs);
        wake = () => { clearTimeout(timer); resolveDelay(); };
      });
      wake = null;
    }
  } finally {
    wake = null;
    options.signal?.removeEventListener("abort", stop);
    if (isTty) {
      input.off("data", onKey);
      input.setRawMode?.(false);
      input.pause();
      process.stdout.write("\u001b[?25h\u001b[?1049l");
    }
  }
}
