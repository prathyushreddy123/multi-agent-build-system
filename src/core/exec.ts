import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  /** Called with each stdout chunk so long runs can stream to an evidence file. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run a command and always resolve. Callers decide what a non-zero exit means;
 * a controller that throws on exit codes cannot record evidence for the
 * failure it just observed.
 */
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  };

  return new Promise((resolvePromise) => {
    const child = spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            // Escalate if the harness ignores a polite stop.
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
          }, options.timeoutMs)
        : undefined;

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      options.onStdout?.(chunk);
      if (stdout.length < maxBuffer) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      options.onStderr?.(chunk);
      if (stderr.length < maxBuffer) stderr += chunk;
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr += `\n${error.message}`;
      finish(error.code === "ENOENT" ? 127 : null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}
