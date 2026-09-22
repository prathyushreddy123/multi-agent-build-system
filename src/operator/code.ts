/**
 * Phase 2 — the Code surface.
 *
 * One entry point per action, shared by the CLI, the Pi slash commands, the
 * picker, and link dispatch, so those four routes cannot disagree about which
 * worktree a path belongs to.
 *
 * Inspection is read-only by default. Opening a file in edit mode is a separate,
 * explicit request.
 */
import { basename } from "node:path";

import type { Records } from "../store/records.ts";
import {
  describeContext,
  resolveTaskContext,
  type TaskCandidate,
  type TaskContext,
  type TaskSelector,
} from "./context.ts";
import {
  diffFileForContext,
  listAllFiles,
  listChangedFiles,
  readFileForContext,
  resolveFile,
  type ChangedFile,
  type FileContent,
  type FileDiff,
} from "./files.ts";
import { commandFor, encodeOpenTarget, osc8 } from "./links.ts";
import { readPreferences } from "./preferences.ts";
import { requestViewer, stageContent, type SurfaceKey, type ViewerDispatch } from "./viewer.ts";

export interface SelectionNeeded {
  kind: "selection-needed";
  reason: string;
  candidates: TaskCandidate[];
}

export interface NotFound {
  kind: "not-found";
  reason: string;
}

export interface OpenResult {
  kind: "opened";
  context: string;
  taskId: string;
  attemptId: string | null;
  relativePath: string;
  line: number | null;
  view: TaskContext["view"];
  viewReason: string | null;
  content: FileContent;
  link: string;
  hyperlink: string;
  command: string;
  viewer: ViewerDispatch | null;
}

export interface DiffResult {
  kind: "diff";
  context: string;
  taskId: string;
  relativePath: string;
  diff: FileDiff;
  link: string;
  command: string;
  viewer: ViewerDispatch | null;
}

export interface ChangesResult {
  kind: "changes";
  context: string;
  taskId: string;
  attemptId: string | null;
  view: TaskContext["view"];
  viewReason: string | null;
  files: ChangedFile[];
  counts: Record<"committed" | "staged" | "unstaged" | "untracked" | "total", number>;
}

export interface FilesResult {
  kind: "files";
  context: string;
  taskId: string;
  view: TaskContext["view"];
  files: string[];
  truncated: boolean;
}

export interface OpenOptions extends TaskSelector {
  line?: number | null;
  revision?: string | null;
  mode?: "read-only" | "edit";
  /** Send the selection to the owned viewer. */
  useViewer?: boolean;
  surface?: SurfaceKey;
  maxBytes?: number;
}

function resolve(records: Records, selector: TaskSelector): { context: TaskContext } | SelectionNeeded | NotFound {
  const resolution = resolveTaskContext(records, selector);
  if (resolution.kind === "ambiguous") {
    return { kind: "selection-needed", reason: resolution.reason, candidates: resolution.candidates };
  }
  if (resolution.kind === "unknown") return { kind: "not-found", reason: resolution.reason };
  return { context: resolution.context };
}

function linkFor(context: TaskContext, path: string, line: number | null, revision: string | null, action: "open" | "diff") {
  return {
    projectId: context.project.id,
    taskId: context.task.id,
    attemptId: context.attempt?.id ?? null,
    path,
    line,
    revision,
    action,
  } as const;
}

/** Open one file from the selected task worktree. */
export async function openFile(
  records: Records,
  path: string,
  options: OpenOptions = {},
): Promise<OpenResult | SelectionNeeded | NotFound> {
  const resolved = resolve(records, options);
  if ("kind" in resolved) return resolved;
  const context = resolved.context;

  const target = resolveFile(context, path, { line: options.line ?? null, revision: options.revision ?? null });
  const content = await readFileForContext(context, target, { maxBytes: options.maxBytes });

  let viewer: ViewerDispatch | null = null;
  if (options.useViewer) {
    const surface = options.surface ?? "code";
    // A revision's copy is not a file on disk, so it is staged under the
    // viewer's own directory rather than written anywhere in the worktree.
    let viewerPath = target.absolutePath;
    if (!viewerPath) {
      viewerPath = stageContent(
        surface,
        `${context.task.id}-${target.revision ?? "revision"}-${basename(target.relativePath)}`,
        content.text ?? `${content.unavailableReason ?? "Content is unavailable."}\n`,
      );
    }
    viewer = requestViewer(surface, {
      absolutePath: viewerPath,
      label: `${context.task.id}:${target.relativePath}`,
      line: target.line,
      filetype: null,
      mode: options.mode ?? "read-only",
      description: describeContext(context),
    });
  }

  const link = linkFor(context, target.relativePath, target.line, target.revision, "open");
  const encoded = encodeOpenTarget(link);
  return {
    kind: "opened",
    context: describeContext(context),
    taskId: context.task.id,
    attemptId: context.attempt?.id ?? null,
    relativePath: target.relativePath,
    line: target.line,
    view: context.view,
    viewReason: context.viewReason,
    content,
    link: encoded,
    hyperlink: osc8(`${context.task.id}:${target.relativePath}`, encoded),
    command: commandFor(link),
    viewer,
  };
}

/** Diff one file against the task's recorded base revision. */
export async function diffFile(
  records: Records,
  path: string,
  options: OpenOptions = {},
): Promise<DiffResult | SelectionNeeded | NotFound> {
  const resolved = resolve(records, options);
  if ("kind" in resolved) return resolved;
  const context = resolved.context;

  const target = resolveFile(context, path, { line: options.line ?? null, revision: options.revision ?? null });
  const diff = await diffFileForContext(context, target);

  let viewer: ViewerDispatch | null = null;
  if (options.useViewer) {
    const surface = options.surface ?? "code";
    const staged = stageContent(
      surface,
      `${context.task.id}-${basename(target.relativePath)}.diff`,
      diff.text && diff.text.length > 0
        ? diff.text
        : `${diff.unavailableReason ?? `No changes to ${target.relativePath} against ${diff.from}.`}\n`,
    );
    viewer = requestViewer(surface, {
      absolutePath: staged,
      label: `${context.task.id}:${target.relativePath} (diff)`,
      line: null,
      filetype: "diff",
      mode: "read-only",
      description: describeContext(context),
    });
  }

  const link = linkFor(context, target.relativePath, null, target.revision, "diff");
  return {
    kind: "diff",
    context: describeContext(context),
    taskId: context.task.id,
    relativePath: target.relativePath,
    diff,
    link: encodeOpenTarget(link),
    command: commandFor(link),
    viewer,
  };
}

/** Changed files for the selected task, one entry per path. */
export async function taskChanges(
  records: Records,
  options: TaskSelector = {},
): Promise<ChangesResult | SelectionNeeded | NotFound> {
  const resolved = resolve(records, options);
  if ("kind" in resolved) return resolved;
  const context = resolved.context;

  if (context.view === "unavailable") {
    return { kind: "not-found", reason: context.viewReason ?? "No content is available for this task." };
  }

  const files = await listChangedFiles(context);
  const counts = { committed: 0, staged: 0, unstaged: 0, untracked: 0, total: files.length };
  for (const file of files) {
    for (const category of file.categories) counts[category] += 1;
  }
  return {
    kind: "changes",
    context: describeContext(context),
    taskId: context.task.id,
    attemptId: context.attempt?.id ?? null,
    view: context.view,
    viewReason: context.viewReason,
    files,
    counts,
  };
}

/** Every file in the selected task worktree, for browsing. */
export async function taskFiles(
  records: Records,
  options: TaskSelector & { limit?: number; filter?: string } = {},
): Promise<FilesResult | SelectionNeeded | NotFound> {
  const resolved = resolve(records, options);
  if ("kind" in resolved) return resolved;
  const context = resolved.context;

  if (context.view === "unavailable") {
    return { kind: "not-found", reason: context.viewReason ?? "No content is available for this task." };
  }

  const all = await listAllFiles(context);
  const needle = options.filter?.toLowerCase();
  const filtered = needle ? all.filter((path) => path.toLowerCase().includes(needle)) : all;
  const limit = options.limit ?? 2000;
  return {
    kind: "files",
    context: describeContext(context),
    taskId: context.task.id,
    view: context.view,
    files: filtered.slice(0, limit),
    truncated: filtered.length > limit,
  };
}

/** Preferred viewer, as configured. Exposed so surfaces report the same choice. */
export function configuredViewer(): ReturnType<typeof readPreferences>["viewer"] {
  return readPreferences().viewer;
}
