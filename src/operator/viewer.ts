/**
 * Phase 2 — the internal viewer and its request channel.
 *
 * Phase 0 found no editor remote-control channel here: Neovim is absent and the
 * installed vim is built without clientserver. Reuse is therefore implemented by
 * a MABS-owned process that reads selections from its own request file. Nothing
 * is ever typed into a pane that might be running an editor or an agent.
 *
 * The loop owns one viewer at a time:
 *  - a read-only viewer is replaced when a new selection arrives, because a
 *    read-only buffer has nothing unsaved to lose;
 *  - an editable viewer is never replaced; the selection is queued and the
 *    reason is reported.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../core/exec.ts";
import { stateDir } from "../core/paths.ts";
import type { ViewerChoice } from "./preferences.ts";

export type SurfaceKey = "code" | "diff" | "logs";

export interface ViewerRequest {
  sequence: number;
  requestedAt: string;
  /** Absolute path of the file to show. Always absolute, so a leading hyphen is never read as a flag. */
  absolutePath: string;
  /** What the user selected, for display. */
  label: string;
  line: number | null;
  /** Syntax hint, for example "diff". */
  filetype: string | null;
  mode: "read-only" | "edit";
  /** Context line shown above the file. */
  description: string;
}

export interface ViewerState {
  pid: number;
  startedAt: string;
  surface: SurfaceKey;
  /** Sequence of the request currently displayed. */
  displayedSequence: number | null;
  displayedLabel: string | null;
  mode: "read-only" | "edit" | null;
}

export function viewerDir(surface: SurfaceKey): string {
  const dir = join(stateDir(), "operator", "viewer", surface);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function requestPath(surface: SurfaceKey): string { return join(viewerDir(surface), "request.json"); }
function statePath(surface: SurfaceKey): string { return join(viewerDir(surface), "state.json"); }
function contentDir(surface: SurfaceKey): string {
  const dir = join(viewerDir(surface), "content");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The owned viewer for this surface, or null when none is running. */
export function readViewerState(surface: SurfaceKey): ViewerState | null {
  const state = readJson<ViewerState>(statePath(surface));
  if (!state) return null;
  // A saved PID is not proof. Verify the process still exists before treating
  // the surface as owned.
  if (!processAlive(state.pid)) return null;
  return state;
}

export function readViewerRequest(surface: SurfaceKey): ViewerRequest | null {
  return readJson<ViewerRequest>(requestPath(surface));
}

/**
 * Write content that is not a live file (a revision's copy, a diff, or an
 * unavailability notice) to a stable, viewer-owned path.
 */
export function stageContent(surface: SurfaceKey, name: string, text: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "content";
  const path = join(contentDir(surface), safe);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

export interface ViewerDispatch {
  /** The owned viewer picked the selection up. */
  delivered: boolean;
  /** Why not, when it did not. */
  reason: string | null;
  sequence: number;
  viewerRunning: boolean;
}

/** Hand a selection to the owned viewer, if one is running. */
export function requestViewer(
  surface: SurfaceKey,
  request: Omit<ViewerRequest, "sequence" | "requestedAt">,
): ViewerDispatch {
  const previous = readViewerRequest(surface);
  const sequence = (previous?.sequence ?? 0) + 1;
  const full: ViewerRequest = { ...request, sequence, requestedAt: new Date().toISOString() };
  writeAtomic(requestPath(surface), `${JSON.stringify(full, null, 2)}\n`);

  const state = readViewerState(surface);
  if (!state) {
    return {
      delivered: false,
      reason: `No MABS viewer is running for the ${surface} surface. Start one with: node src/cli.ts viewer serve --surface=${surface}`,
      sequence,
      viewerRunning: false,
    };
  }
  if (state.mode === "edit") {
    return {
      delivered: false,
      reason: "The Code viewer is in edit mode with a buffer open. The selection is queued and will open when that buffer is closed.",
      sequence,
      viewerRunning: true,
    };
  }
  return { delivered: true, reason: null, sequence, viewerRunning: true };
}

// --------------------------------------------------------------------------
// viewer selection
// --------------------------------------------------------------------------

export interface ViewerProgram {
  command: string;
  /** Build the argument array. Paths are always passed as separate arguments. */
  args: (file: string, line: number | null, filetype: string | null, mode: "read-only" | "edit") => string[];
  /** True when the program provides browsing, search, syntax highlighting, and diff. */
  full: boolean;
}

const PROGRAMS: Record<"nvim" | "vim" | "less", ViewerProgram> = {
  nvim: {
    command: "nvim",
    full: true,
    args: (file, line, filetype, mode) => [
      ...(mode === "read-only" ? ["-R"] : []),
      ...(filetype ? ["-c", `set filetype=${filetype}`] : []),
      ...(line ? [`+${String(line)}`] : []),
      "--", file,
    ],
  },
  vim: {
    command: "vim",
    full: true,
    args: (file, line, filetype, mode) => [
      ...(mode === "read-only" ? ["-R"] : []),
      ...(filetype ? ["-c", `set filetype=${filetype}`] : []),
      ...(line ? [`+${String(line)}`] : []),
      "--", file,
    ],
  },
  less: {
    command: "less",
    full: false,
    // less has no `--` separator; absolute paths keep a leading hyphen from
    // ever being read as an option.
    args: (file, line) => [...(line ? [`+${String(line)}g`] : []), file],
  },
};

async function available(command: string): Promise<boolean> {
  const result = await exec("bash", ["-lc", `command -v ${command}`], { timeoutMs: 15_000 });
  return result.code === 0;
}

/** Choose the viewer: the preference when usable, otherwise the best available. */
export async function resolveViewerProgram(preference: ViewerChoice = "auto"): Promise<ViewerProgram> {
  const override = process.env.MABS_VIEWER_COMMAND;
  if (override) {
    return {
      command: override,
      full: false,
      args: (file, line) => [...(line ? [String(line)] : []), file],
    };
  }
  const order: ("nvim" | "vim" | "less")[] = preference === "auto"
    ? ["nvim", "vim", "less"]
    : [preference, "nvim", "vim", "less"].filter((value, index, all) => all.indexOf(value) === index) as ("nvim" | "vim" | "less")[];
  for (const name of order) {
    const program = PROGRAMS[name];
    if (await available(program.command)) return program;
  }
  throw new Error("No viewer is available. Install nvim, vim, or less, or configure an external editor.");
}

// --------------------------------------------------------------------------
// serve loop
// --------------------------------------------------------------------------

export interface ServeOptions {
  surface?: SurfaceKey;
  viewer?: ViewerChoice;
  /** How often to look for a new selection. */
  pollMs?: number;
  /** Stop the loop without signalling the process. */
  signal?: AbortSignal;
  onEvent?: (event: { kind: string; detail: string }) => void;
}

/**
 * Run the owned viewer for one surface until stopped.
 *
 * Stopping this loop closes a viewer, never a worker: it holds no task state
 * and touches no records.
 */
export async function serveViewer(options: ServeOptions = {}): Promise<void> {
  const surface = options.surface ?? "code";
  const pollMs = options.pollMs ?? 200;
  const program = await resolveViewerProgram(options.viewer ?? "auto");
  const report = options.onEvent ?? (() => undefined);

  const existing = readViewerState(surface);
  if (existing) {
    throw new Error(`A MABS viewer is already serving the ${surface} surface (pid ${existing.pid}).`);
  }

  let child: ChildProcess | null = null;
  let displayed: ViewerRequest | null = null;
  let stopping = false;

  const saveState = (request: ViewerRequest | null) => {
    const state: ViewerState = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      surface,
      displayedSequence: request?.sequence ?? null,
      displayedLabel: request?.label ?? null,
      mode: request?.mode ?? null,
    };
    writeAtomic(statePath(surface), `${JSON.stringify(state, null, 2)}\n`);
  };

  const stop = () => {
    stopping = true;
    if (child && !child.killed) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop, { once: true });
  saveState(null);
  report({ kind: "started", detail: `${program.command} serving the ${surface} surface (pid ${process.pid})` });

  try {
    while (!stopping) {
      const request = readViewerRequest(surface);
      const isNew = request !== null && request.sequence !== displayed?.sequence;

      if (isNew && request) {
        // Replacing a read-only buffer loses nothing. An editable buffer is
        // never taken away from the user.
        if (child && displayed?.mode === "edit") {
          report({ kind: "queued", detail: `${request.label} is waiting for the open editable buffer to close` });
        } else {
          if (child) {
            child.kill("SIGTERM");
            await new Promise<void>((done) => child?.once("exit", () => done()));
            child = null;
          }
          displayed = request;
          saveState(request);
          report({ kind: "open", detail: `${request.label}${request.line ? `:${String(request.line)}` : ""}` });
          child = spawn(program.command, program.args(request.absolutePath, request.line, request.filetype, request.mode), {
            stdio: "inherit",
          });
          const current = child;
          current.once("exit", () => {
            if (child === current) {
              child = null;
              // The surface is still owned; only the displayed selection ends.
              displayed = null;
              if (!stopping) saveState(null);
            }
          });
        }
      }
      await new Promise((done) => setTimeout(done, pollMs));
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
    if (child && !child.killed) child.kill("SIGTERM");
    rmSync(statePath(surface), { force: true });
    report({ kind: "stopped", detail: `viewer for the ${surface} surface stopped` });
  }
}

// --------------------------------------------------------------------------
// optional external editor
// --------------------------------------------------------------------------

export interface ExternalEditorPlan {
  command: string;
  args: string[];
  /** What the user will actually see. */
  note: string;
}

/**
 * Build the command for an optional external editor.
 *
 * A Windows-hosted editor reached from WSL cannot address this filesystem by
 * path, so it needs the WSL remote authority. The result opens a separate GUI
 * window; it is never embedded in a terminal pane.
 */
export function externalEditorPlan(
  editor: "code" | "cursor",
  file: string,
  line: number | null,
  options: { windowsHosted: boolean; wslDistro: string | null },
): ExternalEditorPlan {
  const target = line ? `${file}:${String(line)}` : file;
  if (options.windowsHosted) {
    if (!options.wslDistro) {
      throw new Error(
        `${editor} is a Windows binary but WSL_DISTRO_NAME is not set, so it cannot address this filesystem. ` +
        "Use the internal viewer instead.",
      );
    }
    return {
      command: editor,
      args: ["--remote", `wsl+${options.wslDistro}`, "--goto", target],
      note: `${editor} opens a separate GUI window on Windows, addressing this filesystem through wsl+${options.wslDistro}. It is not embedded in the terminal.`,
    };
  }
  return {
    command: editor,
    args: ["--goto", target],
    note: `${editor} opens a separate GUI window. It is not embedded in the terminal.`,
  };
}
