/**
 * Phase 2 — one task/attempt/worktree/revision resolver.
 *
 * A click, a picker selection, a slash command, and a CLI command must never
 * select different worktrees for the same task. Every operator surface resolves
 * its target through this module, so there is exactly one place where "which
 * file does this refer to" is decided.
 *
 * Selection is explicit. When more than one task is a plausible target the
 * resolver returns candidates for a picker instead of guessing.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { Attempt, Project, Records, Task } from "../store/records.ts";

export interface TaskSelector {
  /** Task ID, or a unique prefix or title fragment. */
  task?: string | null;
  /** Attempt ID, or an attempt number such as "2". Defaults to the latest. */
  attempt?: string | null;
  /** Project ID or name, used to narrow an omitted task. */
  project?: string | null;
}

/** Where file content for this context comes from. */
export type ContextView =
  /** The task worktree exists and is being read as it is now. */
  | "live"
  /** The worktree is gone; content comes from a recorded revision. */
  | "revision"
  /** Neither a worktree nor a usable revision is available. */
  | "unavailable";

export interface TaskContext {
  project: Project;
  task: Task;
  attempt: Attempt | null;
  /** Repository the worktree belongs to. Always present. */
  repoPath: string;
  /** Worktree root, or null when it was never created or has been removed. */
  worktreePath: string | null;
  worktreeAvailable: boolean;
  branch: string | null;
  baseRevision: string | null;
  resultRevision: string | null;
  view: ContextView;
  /** Why the view is not live, when it is not. */
  viewReason: string | null;
}

export interface TaskCandidate {
  taskId: string;
  projectId: string;
  projectName: string;
  title: string;
  state: string;
  attempts: number;
  worktreePath: string | null;
  updatedAt: string;
}

export type TaskResolution =
  | { kind: "resolved"; context: TaskContext }
  | { kind: "ambiguous"; reason: string; candidates: TaskCandidate[] }
  | { kind: "unknown"; reason: string };

function candidate(records: Records, task: Task): TaskCandidate {
  const project = records.getProject(task.projectId);
  return {
    taskId: task.id,
    projectId: task.projectId,
    projectName: project?.name ?? task.projectId,
    title: task.title,
    state: task.state,
    attempts: records.listAttempts(task.id).length,
    worktreePath: task.worktreePath,
    updatedAt: task.updatedAt,
  };
}

/** Tasks a person is plausibly looking at: anything with work recorded against it. */
export function plausibleTasks(records: Records, projectId?: string | null): Task[] {
  return records
    .listTasks(projectId ? { projectId } : {})
    .filter((task) => task.worktreePath !== null || task.resultRevision !== null || task.state === "RUNNING")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function findTasks(records: Records, value: string, projectId?: string | null): Task[] {
  const exact = records.getTask(value);
  if (exact && (!projectId || exact.projectId === projectId)) return [exact];
  const all = records.listTasks(projectId ? { projectId } : {});
  const needle = value.toLowerCase();
  const byPrefix = all.filter((task) => task.id.toLowerCase().startsWith(needle));
  if (byPrefix.length > 0) return byPrefix;
  return all.filter((task) => task.title.toLowerCase().includes(needle));
}

function pickAttempt(records: Records, task: Task, selector: string | null | undefined): Attempt | null {
  const attempts = records.listAttempts(task.id);
  if (attempts.length === 0) return null;
  if (!selector) return attempts[attempts.length - 1] ?? null;
  const byId = attempts.find((attempt) => attempt.id === selector || attempt.id.startsWith(selector));
  if (byId) return byId;
  const number = Number(selector);
  if (Number.isSafeInteger(number)) {
    const byNumber = attempts.find((attempt) => attempt.attemptNumber === number);
    if (byNumber) return byNumber;
  }
  return null;
}

function directoryExists(path: string | null): boolean {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the context for one task and attempt.
 *
 * An attempt's own worktree and revisions take precedence over the task's, so
 * inspecting attempt 1 after a retry shows attempt 1's work rather than the
 * latest.
 */
export function buildTaskContext(records: Records, task: Task, attempt: Attempt | null): TaskContext {
  const project = records.getProject(task.projectId);
  if (!project) throw new Error(`Task ${task.id} references unknown project ${task.projectId}`);

  const worktreePath = attempt?.worktreePath ?? task.worktreePath;
  const worktreeAvailable = directoryExists(worktreePath) && existsSync(resolve(worktreePath as string, ".git"));
  const resultRevision = attempt?.resultRevision ?? task.resultRevision;
  const baseRevision = attempt?.baseRevision ?? task.baseRevision;

  let view: ContextView = "live";
  let viewReason: string | null = null;
  if (!worktreeAvailable) {
    if (resultRevision) {
      view = "revision";
      viewReason = worktreePath
        ? `The worktree ${worktreePath} is no longer present; content is read from recorded revision ${resultRevision}.`
        : `No worktree was recorded; content is read from recorded revision ${resultRevision}.`;
    } else {
      view = "unavailable";
      viewReason = worktreePath
        ? `The worktree ${worktreePath} is no longer present and no result revision was recorded.`
        : "No worktree or result revision has been recorded for this task yet.";
    }
  }

  return {
    project,
    task,
    attempt,
    repoPath: resolve(project.repoPath),
    worktreePath: worktreePath ?? null,
    worktreeAvailable,
    branch: task.branch,
    baseRevision,
    resultRevision,
    view,
    viewReason,
  };
}

/** Resolve a selector into exactly one context, candidates, or a clear reason. */
export function resolveTaskContext(records: Records, selector: TaskSelector = {}): TaskResolution {
  const project = selector.project
    ? records.getProject(selector.project) ?? records.findProjectByName(selector.project)
    : null;
  if (selector.project && !project) {
    return { kind: "unknown", reason: `Unknown project ${selector.project}` };
  }

  let tasks: Task[];
  if (selector.task) {
    tasks = findTasks(records, selector.task, project?.id);
    if (tasks.length === 0) return { kind: "unknown", reason: `No task matches ${selector.task}` };
  } else {
    tasks = plausibleTasks(records, project?.id);
    if (tasks.length === 0) {
      return {
        kind: "unknown",
        reason: project
          ? `No task in ${project.name} has a worktree or recorded revision yet.`
          : "No task has a worktree or recorded revision yet.",
      };
    }
  }

  if (tasks.length > 1) {
    return {
      kind: "ambiguous",
      reason: selector.task
        ? `${tasks.length} tasks match ${selector.task}. Select one explicitly.`
        : `${tasks.length} tasks are plausible targets. Select one explicitly.`,
      candidates: tasks.slice(0, 25).map((task) => candidate(records, task)),
    };
  }

  const task = tasks[0] as Task;
  const attempt = pickAttempt(records, task, selector.attempt);
  if (selector.attempt && !attempt) {
    return { kind: "unknown", reason: `No attempt ${selector.attempt} on task ${task.id}` };
  }
  return { kind: "resolved", context: buildTaskContext(records, task, attempt) };
}

/** One line describing what the Code surface is currently showing. */
export function describeContext(context: TaskContext): string {
  const parts = [
    `${context.project.name} · ${context.task.id}`,
    context.attempt ? `attempt ${context.attempt.attemptNumber} (${context.attempt.kind})` : "no attempt yet",
    context.branch ?? "no branch",
    context.view === "live"
      ? `live worktree ${context.worktreePath ?? "unknown"}`
      : context.view === "revision"
        ? `revision ${context.resultRevision ?? "unknown"}`
        : "content unavailable",
  ];
  return parts.join(" · ");
}
