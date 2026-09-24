/**
 * Stock-Herdr popup launcher for Code, Tasks, and Logs.
 *
 * Building and displaying the launcher is read-only: it does not call Herdr,
 * write preferences, create tabs, or send input to an agent. Dispatch is a
 * separate, explicit step reached by activating a fully scoped action.
 */
import { statSync } from "node:fs";

import { exec } from "../core/exec.ts";
import type { Project, Records, Task } from "../store/records.ts";
import { buildTaskContext } from "./context.ts";
import { openScopedToolTab, type ScopedToolTabResult } from "./herdr.ts";

export type LauncherAction = "code" | "tasks" | "logs";
export type LauncherInputSource = "keyboard" | "mouse";

export interface LauncherSelection {
  action?: LauncherAction | null;
  /** Stable project ID. Display names are deliberately not selectors. */
  projectId?: string | null;
  /** Stable task ID. Titles are deliberately not selectors. */
  taskId?: string | null;
}

export interface LauncherChoice {
  id: string;
  kind: "action" | "project" | "task" | "dispatch";
  label: string;
  detail: string;
}

export interface LauncherScreen {
  step: "action" | "project" | "task" | "ready" | "empty";
  title: string;
  message: string;
  selection: LauncherSelection;
  choices: LauncherChoice[];
}

export interface LauncherActivation {
  source: LauncherInputSource;
  choiceId: string;
  screen: LauncherScreen;
}

const ACTIONS: readonly LauncherAction[] = ["code", "tasks", "logs"];

function actionLabel(action: LauncherAction): string {
  if (action === "code") return "Code";
  if (action === "tasks") return "Tasks";
  return "Logs";
}

function projectChoices(projects: Project[]): LauncherChoice[] {
  return projects.map((project) => ({
    id: `project:${project.id}`,
    kind: "project",
    label: `${project.name}  [${project.id}]`,
    detail: `${project.status} · ${project.repoPath}`,
  }));
}

function taskChoices(tasks: Task[]): LauncherChoice[] {
  return [...tasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map((task) => ({
      id: `task:${task.id}`,
      kind: "task",
      label: `${task.title}  [${task.id}]`,
      detail: `${task.state}${task.worktreePath ? ` · ${task.worktreePath}` : " · no live worktree"}`,
    }));
}

/** Build a screen from records and stable IDs, without causing side effects. */
export function buildLauncherScreen(records: Records, selection: LauncherSelection = {}): LauncherScreen {
  if (!selection.action) {
    return {
      step: "action",
      title: "MABS tools",
      message: "Choose an action. Esc dismisses without changing this session.",
      selection: {},
      choices: ACTIONS.map((action) => ({
        id: `action:${action}`,
        kind: "action",
        label: actionLabel(action),
        detail: action === "code"
          ? "Open one live task worktree in VS Code"
          : action === "tasks"
            ? "Open or focus the selected project's task tab"
            : "Open or focus the selected task's evidence tab",
      })),
    };
  }

  const projects = records.listProjects();
  if (projects.length === 0) {
    return {
      step: "empty",
      title: actionLabel(selection.action),
      message: "No MABS projects exist. Register a project before opening Code, Tasks, or Logs.",
      selection: { action: selection.action },
      choices: [],
    };
  }

  const project = selection.projectId ? records.getProject(selection.projectId) : null;
  if (!project) {
    const stale = selection.projectId ? `Project ${selection.projectId} is stale or unknown. ` : "";
    return {
      step: "project",
      title: `${actionLabel(selection.action)} · choose project`,
      message: `${stale}Select a project by its stable ID; names are display-only.`,
      selection: { action: selection.action },
      choices: projectChoices(projects),
    };
  }

  if (selection.action === "tasks") {
    return {
      step: "ready",
      title: "Tasks",
      message: `Project: ${project.name} [${project.id}]`,
      selection: { action: "tasks", projectId: project.id },
      choices: [{
        id: "dispatch:tasks",
        kind: "dispatch",
        label: "Open Tasks",
        detail: `node src/cli.ts task watch --project=${project.id}`,
      }],
    };
  }

  const tasks = records.listTasks({ projectId: project.id });
  if (tasks.length === 0) {
    return {
      step: "empty",
      title: `${actionLabel(selection.action)} · ${project.name}`,
      message: `Project ${project.id} has no tasks.`,
      selection: { action: selection.action, projectId: project.id },
      choices: [],
    };
  }

  const task = selection.taskId ? records.getTask(selection.taskId) : null;
  if (!task || task.projectId !== project.id) {
    const stale = selection.taskId ? `Task ${selection.taskId} is stale or does not belong to ${project.id}. ` : "";
    return {
      step: "task",
      title: `${actionLabel(selection.action)} · choose task`,
      message: `${stale}Select a task by its stable ID; titles are display-only.`,
      selection: { action: selection.action, projectId: project.id },
      choices: taskChoices(tasks),
    };
  }

  return {
    step: "ready",
    title: actionLabel(selection.action),
    message: `${project.name} [${project.id}] · ${task.title} [${task.id}]`,
    selection: { action: selection.action, projectId: project.id, taskId: task.id },
    choices: [{
      id: `dispatch:${selection.action}`,
      kind: "dispatch",
      label: `Open ${actionLabel(selection.action)}`,
      detail: selection.action === "code"
        ? task.worktreePath ?? "No live worktree is recorded"
        : `node src/cli.ts logs ${task.id}`,
    }],
  };
}

/**
 * Activate only a choice present on the current screen. Mouse and keyboard call
 * this same function, so they cannot drift into different scope resolution.
 */
export function activateLauncherChoice(
  records: Records,
  screen: LauncherScreen,
  choiceId: string,
  source: LauncherInputSource,
): LauncherActivation {
  const choice = screen.choices.find((candidate) => candidate.id === choiceId);
  if (!choice) throw new Error(`Choice ${choiceId} is not available on the current launcher screen`);
  if (choice.kind === "dispatch") return { source, choiceId, screen };

  const [kind, id] = choice.id.split(":", 2) as [string, string];
  const selection = { ...screen.selection };
  if (kind === "action") selection.action = id as LauncherAction;
  else if (kind === "project") selection.projectId = id;
  else if (kind === "task") selection.taskId = id;
  return { source, choiceId, screen: buildLauncherScreen(records, selection) };
}

export interface LauncherDispatchResult {
  action: LauncherAction;
  status: "opened" | "degraded";
  projectId: string;
  taskId: string | null;
  reason: string;
  cliAlternative: string;
  tab?: ScopedToolTabResult;
}

function directoryExists(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export interface CodeOpenInvocation {
  executable: string;
  args: string[];
  remote: string | null;
}

/** Build an explicit WSL remote address when `code` is the Windows-hosted CLI. */
export function codeOpenInvocation(
  executable: string,
  worktreePath: string,
  wslDistro: string | null = process.env.WSL_DISTRO_NAME ?? null,
): CodeOpenInvocation {
  const windowsHosted = /^\/mnt\/[a-z]\//i.test(executable);
  if (windowsHosted && !wslDistro) {
    throw new Error("VS Code is Windows-hosted but WSL_DISTRO_NAME is unset; cannot address the selected Linux worktree safely.");
  }
  const remote = windowsHosted ? `wsl+${wslDistro as string}` : null;
  return {
    executable,
    args: [...(remote ? ["--remote", remote] : []), "--new-window", worktreePath],
    remote,
  };
}

function requireReady(records: Records, screen: LauncherScreen): { project: Project; task: Task | null; action: LauncherAction } {
  const action = screen.selection.action;
  const projectId = screen.selection.projectId;
  if (screen.step !== "ready" || !action || !projectId) throw new Error("The launcher action is not fully scoped");
  const project = records.getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} became stale; reopen the launcher and select it again`);
  if (action === "tasks") return { project, task: null, action };
  const taskId = screen.selection.taskId;
  const task = taskId ? records.getTask(taskId) : null;
  if (!task || task.projectId !== project.id) throw new Error(`Task ${taskId ?? "<none>"} became stale; reopen the launcher and select it again`);
  return { project, task, action };
}

/** Dispatch a fully scoped action. This is the only launcher function that mutates UI state. */
export async function dispatchLauncherAction(
  records: Records,
  screen: LauncherScreen,
  options: { cliCommand?: string } = {},
): Promise<LauncherDispatchResult> {
  const { project, task, action } = requireReady(records, screen);
  const cli = options.cliCommand ?? "node src/cli.ts";

  if (action === "code") {
    const context = buildTaskContext(records, task as Task, null);
    const alternative = `${cli} launcher --action=code --project=${project.id} --task=${(task as Task).id} --dispatch`;
    if (!context.worktreePath || !context.worktreeAvailable || !directoryExists(context.worktreePath)) {
      throw new Error(
        `Task ${(task as Task).id} has no live worktree to open. ${context.viewReason ?? "A recorded revision is not a writable checkout."} ` +
        `Inspect it with: ${cli} files ${(task as Task).id}`,
      );
    }
    const located = await exec("bash", ["-lc", "command -v code"], { timeoutMs: 15_000 });
    if (located.code !== 0 || !located.stdout.trim()) {
      throw new Error(`VS Code CLI 'code' is unavailable. Install it or run: code --new-window ${context.worktreePath}`);
    }
    const invocation = codeOpenInvocation(located.stdout.trim(), context.worktreePath);
    const opened = await exec(invocation.executable, invocation.args, { timeoutMs: 30_000 });
    if (opened.code !== 0) throw new Error(`VS Code could not open ${context.worktreePath}: ${(opened.stderr || opened.stdout).trim()}`);
    return {
      action, status: "opened", projectId: project.id, taskId: (task as Task).id,
      reason: `Opened the live worktree ${context.worktreePath} in VS Code${invocation.remote ? ` through ${invocation.remote}` : ""}.`,
      cliAlternative: alternative,
    };
  }

  const scopedCommand = action === "tasks"
    ? `${cli} task watch --project=${project.id}`
    : `${cli} logs ${(task as Task).id}`;
  const alternative = `\`${scopedCommand}\``;
  // The tab runs one stable renderer. Project/task changes are delivered over
  // its workspace-scoped control file, never by reinjecting shell commands.
  const command = `${cli} workspace view --surface=${action} --workspace="$HERDR_WORKSPACE_ID"`;
  const tab = await openScopedToolTab({
    surface: action,
    scopeKey: action === "tasks" ? `project:${project.id}` : `task:${(task as Task).id}`,
    repoPath: project.repoPath,
    command,
    selection: { projectId: project.id, taskId: task?.id ?? null },
    cliAlternative: alternative,
  });
  return {
    action,
    status: tab.action === "degraded" ? "degraded" : "opened",
    projectId: project.id,
    taskId: task?.id ?? null,
    reason: tab.reason,
    cliAlternative: alternative,
    tab,
  };
}

const FIRST_CHOICE_ROW = 5;

export function renderLauncherScreen(screen: LauncherScreen, selectedIndex = 0): string {
  const width = Math.max(40, process.stdout.columns ?? 100);
  const choiceLine = (choice: LauncherChoice, index: number): string => {
    const plain = ` ${choice.label.padEnd(28)} ${choice.detail}`.slice(0, width - 1);
    return index === selectedIndex ? `\u001b[7m${plain}\u001b[0m` : plain;
  };
  const lines = [
    `\u001b[1m${screen.title}\u001b[0m`,
    "",
    screen.message,
    "",
    ...screen.choices.map(choiceLine),
    "",
    "↑/↓ select · Enter open · mouse click · Esc dismiss",
  ];
  return `\u001b[2J\u001b[H${lines.join("\n")}`;
}

function mouseChoiceIndex(input: string): number | null {
  const match = /\u001b\[<0;\d+;(\d+)M/.exec(input);
  if (!match) return null;
  const row = Number(match[1]);
  return Number.isSafeInteger(row) ? row - FIRST_CHOICE_ROW : null;
}

/** Run the terminal popup. Merely entering and leaving this loop is read-only. */
export async function runLauncher(records: Records, initial: LauncherSelection = {}): Promise<LauncherDispatchResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("The popup launcher needs an interactive terminal. Use `node src/cli.ts launcher --json` or a scoped CLI command instead.");
  }
  let screen = buildLauncherScreen(records, initial);
  let selected = 0;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\u001b[?25l\u001b[?1000h\u001b[?1006h");
  try {
    while (true) {
      const pageSize = Math.max(1, (process.stdout.rows ?? 24) - 7);
      const pageStart = Math.floor(selected / pageSize) * pageSize;
      const visibleScreen = { ...screen, choices: screen.choices.slice(pageStart, pageStart + pageSize) };
      process.stdout.write(renderLauncherScreen(visibleScreen, selected - pageStart));
      const input = await new Promise<string>((resolveInput) => process.stdin.once("data", resolveInput));
      if (input === "\u001b" || input === "q" || input === "\u0003") return null;
      if (input === "\u001b[A" || input === "k") selected = Math.max(0, selected - 1);
      else if (input === "\u001b[B" || input === "j") selected = Math.min(Math.max(0, screen.choices.length - 1), selected + 1);
      else {
        const mouseIndex = mouseChoiceIndex(input);
        const source: LauncherInputSource = mouseIndex === null ? "keyboard" : "mouse";
        if (mouseIndex !== null && mouseIndex >= 0 && mouseIndex < visibleScreen.choices.length) selected = pageStart + mouseIndex;
        const activate = input === "\r" || input === "\n" || mouseIndex !== null;
        const choice = screen.choices[selected];
        if (!activate || !choice) continue;
        const activation = activateLauncherChoice(records, screen, choice.id, source);
        if (activation.screen.step === "ready" && activation.screen.choices[0]?.kind === "dispatch" && screen.step === "ready") {
          return await dispatchLauncherAction(records, activation.screen);
        }
        screen = activation.screen;
        selected = 0;
      }
    }
  } finally {
    process.stdout.write("\u001b[?1000l\u001b[?1006l\u001b[?25h\u001b[2J\u001b[H");
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
