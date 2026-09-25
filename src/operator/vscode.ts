/**
 * VS Code executable discovery and launch planning.
 *
 * This module never talks to an existing editor window and never writes a
 * file. It passes an exact argument array to the CLI and can therefore request
 * a folder or file without shell parsing, buffer replacement, or checkout
 * fallback. A zero exit status proves only that the CLI accepted the request;
 * it is not evidence that a GUI window was displayed.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { exec } from "../core/exec.ts";

export const VSCODE_EXECUTABLE_ENV = "MABS_VSCODE_EXECUTABLE";

export type VsCodeExecutableSource = "option" | "environment" | "path";

export interface VsCodeExecutable {
  executable: string;
  resolvedPath: string;
  source: VsCodeExecutableSource;
  windowsHosted: boolean;
}

export type VsCodeTarget =
  | { kind: "folder"; path: string }
  | { kind: "file"; path: string; line?: number | null; column?: number | null };

export interface CodeOpenInvocation {
  executable: string;
  args: string[];
  remote: string | null;
}

export interface VsCodeLaunchResult extends CodeOpenInvocation {
  status: "launch-requested";
  /** Process success cannot prove that a GUI rendered the requested target. */
  guiVerified: false;
  target: VsCodeTarget;
  executableSource: VsCodeExecutableSource;
}

export class VsCodeError extends Error {}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveProgram(value: string, pathValue: string, cwd: string): string | null {
  if (value.includes("/") || isAbsolute(value)) {
    const candidate = resolve(cwd, value);
    return isExecutableFile(candidate) ? candidate : null;
  }
  for (const segment of pathValue.split(delimiter)) {
    const candidate = join(segment || cwd, value);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Windows programs exposed through a WSL drive mount need Remote-WSL. */
export function isWindowsHostedVsCode(executable: string): boolean {
  return [executable, canonicalPath(executable)].some((path) => /^\/mnt\/[a-z](?:\/|$)/i.test(path));
}

export interface DiscoverVsCodeOptions {
  configuredExecutable?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  candidates?: readonly string[];
}

/**
 * Resolve one executable without invoking a shell. An explicit option wins,
 * followed by the environment preference and then ordinary PATH discovery.
 */
export function discoverVsCodeExecutable(options: DiscoverVsCodeOptions = {}): VsCodeExecutable {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configured = options.configuredExecutable?.trim();
  const fromEnvironment = env[VSCODE_EXECUTABLE_ENV]?.trim();
  const requested = configured || fromEnvironment;
  const source: VsCodeExecutableSource = configured ? "option" : fromEnvironment ? "environment" : "path";
  const candidates = requested ? [requested] : [...(options.candidates ?? ["code", "code-insiders"])];
  for (const candidate of candidates) {
    const executable = resolveProgram(candidate, env.PATH ?? "", cwd);
    if (!executable) continue;
    const resolvedPath = canonicalPath(executable);
    return { executable, resolvedPath, source, windowsHosted: isWindowsHostedVsCode(executable) };
  }
  if (requested) {
    throw new VsCodeError(
      `Configured VS Code executable ${JSON.stringify(requested)} is unavailable or not executable. ` +
      `Fix --vscode/${VSCODE_EXECUTABLE_ENV}; no checkout was opened.`,
    );
  }
  throw new VsCodeError(
    `VS Code CLI is unavailable. Install 'code', add it to PATH, or set ${VSCODE_EXECUTABLE_ENV} to its executable path.`,
  );
}

export function detectWslDistro(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.WSL_DISTRO_NAME?.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function remoteAuthority(windowsHosted: boolean, distro: string | null): string | null {
  if (!windowsHosted) return null;
  if (!distro) {
    throw new VsCodeError(
      "VS Code is Windows-hosted but WSL_DISTRO_NAME is unset or invalid, so the WSL distribution could not be detected. " +
      "Start MABS inside WSL with WSL_DISTRO_NAME set, or configure a Linux VS Code CLI.",
    );
  }
  return `wsl+${distro}`;
}

function location(target: Extract<VsCodeTarget, { kind: "file" }>): string {
  const line = target.line ?? null;
  const column = target.column ?? null;
  if (line !== null && (!Number.isSafeInteger(line) || line < 1)) throw new VsCodeError("VS Code line must be a positive integer");
  if (column !== null && (!Number.isSafeInteger(column) || column < 1)) throw new VsCodeError("VS Code column must be a positive integer");
  if (column !== null && line === null) throw new VsCodeError("VS Code column requires a line number");
  return `${target.path}${line === null ? "" : `:${line}${column === null ? "" : `:${column}`}`}`;
}

export function buildVsCodeInvocation(
  editor: Pick<VsCodeExecutable, "executable" | "windowsHosted">,
  target: VsCodeTarget,
  wslDistro: string | null = detectWslDistro(),
): CodeOpenInvocation {
  if (!isAbsolute(target.path)) throw new VsCodeError("VS Code targets must be absolute paths resolved inside the selected worktree");
  const remote = remoteAuthority(editor.windowsHosted, wslDistro);
  return {
    executable: editor.executable,
    args: [
      ...(remote ? ["--remote", remote] : []),
      "--new-window",
      ...(target.kind === "file" ? ["--goto", location(target)] : [target.path]),
    ],
    remote,
  };
}

/** Backwards-compatible folder planner used by the popup launcher API. */
export function codeOpenInvocation(
  executable: string,
  worktreePath: string,
  wslDistro: string | null = detectWslDistro(),
): CodeOpenInvocation {
  return buildVsCodeInvocation(
    { executable, windowsHosted: isWindowsHostedVsCode(executable) },
    { kind: "folder", path: worktreePath },
    wslDistro,
  );
}

export interface LaunchVsCodeOptions extends DiscoverVsCodeOptions {
  wslDistro?: string | null;
  timeoutMs?: number;
}

export async function launchVsCode(target: VsCodeTarget, options: LaunchVsCodeOptions = {}): Promise<VsCodeLaunchResult> {
  const editor = discoverVsCodeExecutable(options);
  const distro = options.wslDistro === undefined ? detectWslDistro(options.env) : options.wslDistro;
  const invocation = buildVsCodeInvocation(editor, target, distro);
  const launched = await exec(invocation.executable, invocation.args, { timeoutMs: options.timeoutMs ?? 30_000 });
  if (launched.code !== 0) {
    const detail = (launched.stderr || launched.stdout).trim() || `exit status ${launched.code}`;
    throw new VsCodeError(`VS Code CLI could not request ${target.path}: ${detail}`);
  }
  return {
    ...invocation,
    status: "launch-requested",
    guiVerified: false,
    target,
    executableSource: editor.source,
  };
}
