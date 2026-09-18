import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyFailure, classifyFromEnvelope } from "../core/failure.ts";
import { validateWorkerOutput } from "../domain/contract.ts";
import { buildWorkerEnv, assertNoPaidFallback } from "../verify/env.ts";
import type { LaunchResult } from "../verify/launch.ts";
import type { AdapterHandle, AdapterLaunch, AdapterStatus, CollectedResult, WorkerAdapter } from "./types.ts";

const PROCESS_ENTRY = fileURLToPath(new URL("./worker-process.ts", import.meta.url));
const RESULT_FILE = join(".mabs", "result.json");

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class HarnessAdapter implements WorkerAdapter {
  readonly name: "claude" | "codex";
  readonly authMode: string;

  constructor(name: "claude" | "codex") {
    this.name = name;
    this.authMode = name === "claude" ? "claude.ai-subscription" : "chatgpt-subscription";
  }

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    mkdirSync(dirname(input.completionPath), { recursive: true, mode: 0o700 });
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true, mode: 0o700 });
    rmSync(input.completionPath, { force: true });
    rmSync(join(input.cwd, RESULT_FILE), { force: true });

    const specPath = join(dirname(input.completionPath), "launch.json");
    writeFileSync(specPath, JSON.stringify({ harness: this.name, ...input }, null, 2), { mode: 0o600 });
    const { env } = buildWorkerEnv();
    assertNoPaidFallback(env);
    const child = spawn(process.execPath, [PROCESS_ENTRY, specPath], {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        child.off("error", reject);
        resolvePromise();
      });
    });
    child.unref();
    return { attemptId: input.attemptId, pid: child.pid ?? null, sessionId: null, completionPath: input.completionPath };
  }

  async status(handle: AdapterHandle): Promise<AdapterStatus> {
    if (existsSync(handle.completionPath)) return "completed";
    if (handle.pid !== null && processAlive(handle.pid)) return "running";
    return "lost";
  }

  async cancel(handle: AdapterHandle): Promise<void> {
    if (handle.pid === null || !processAlive(handle.pid)) return;
    try {
      process.kill(-handle.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && processAlive(handle.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processAlive(handle.pid)) {
      try {
        process.kill(-handle.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  async collectResult(handle: AdapterHandle, cwd: string): Promise<CollectedResult> {
    let envelope: { result: LaunchResult | null; error: string | null };
    try {
      envelope = JSON.parse(readFileSync(handle.completionPath, "utf8")) as typeof envelope;
    } catch (error) {
      return {
        launch: null,
        validation: validateWorkerOutput(null),
        failureClass: "CONTRACT",
        error: `Cannot read completion envelope: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!envelope.result) {
      return {
        launch: null,
        validation: validateWorkerOutput(null),
        failureClass: "INFRA",
        error: envelope.error ?? "Worker process failed without a launch result.",
      };
    }

    const launch = envelope.result;
    let raw: unknown = null;
    const resultPath = join(cwd, RESULT_FILE);
    if (existsSync(resultPath)) {
      try {
        raw = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
      } catch {
        raw = null;
      }
    }
    raw ??= extractJson(launch.finalMessage);
    const validation = validateWorkerOutput(raw);

    let failureClass = null;
    if (launch.timedOut) failureClass = "TIMEOUT" as const;
    else if (launch.exitCode !== 0) {
      if (this.name === "claude") {
        let claudeEnvelope: Record<string, unknown> = {};
        try { claudeEnvelope = JSON.parse(launch.raw) as Record<string, unknown>; } catch { /* evidence retains raw output */ }
        failureClass = classifyFromEnvelope(claudeEnvelope, `${launch.raw}\n${launch.stderr}`, launch.exitCode);
      } else {
        failureClass = classifyFailure(`${launch.raw}\n${launch.stderr}`, launch.exitCode);
      }
    } else if (!validation.ok) failureClass = "CONTRACT" as const;
    else if (validation.output?.outcome === "failed") {
      failureClass = classifyFailure(`${validation.output.reason}\n${validation.output.summary}`, launch.exitCode);
    }

    const observedError = failureClass
      ? (launch.finalMessage || launch.stderr || launch.raw).trim().slice(-8_000) || `Worker exited with ${launch.exitCode}`
      : null;
    return { launch, validation, failureClass, error: envelope.error ?? observedError };
  }
}

export function defaultAdapters(): Map<string, WorkerAdapter> {
  return new Map<string, WorkerAdapter>([
    ["claude", new HarnessAdapter("claude")],
    ["codex", new HarnessAdapter("codex")],
  ]);
}
