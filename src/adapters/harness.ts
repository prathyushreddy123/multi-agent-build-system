import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyFailure, classifyFromEnvelope } from "../core/failure.ts";
import { validateWorkerOutput } from "../domain/contract.ts";
import { DEFAULT_CAPABILITY_REGISTRY, DISABLED_DELEGATION, evaluateCapability, type CapabilityRegistry } from "../routing/capabilities.ts";
import { buildWorkerEnv, assertNoPaidFallback } from "../verify/env.ts";
import { PROC_AVAILABLE, verifyProcess } from "../core/process-identity.ts";
import { primaryAnsweringModel, sameModel, type LaunchResult } from "../verify/launch.ts";
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

/** Written atomically by the worker wrapper before it starts any provider. */
export const START_MARKER_FILE = "start-marker.json";
const LAUNCH_SPEC_FILE = "launch.json";
const DEFAULT_LAUNCH_GRACE_MS = 30_000;

function launchFiles(handle: Pick<AdapterHandle, "completionPath">): { spec: string; marker: string } {
  const dir = dirname(handle.completionPath);
  return { spec: join(dir, LAUNCH_SPEC_FILE), marker: join(dir, START_MARKER_FILE) };
}

interface RecordedProcess {
  pid: number;
  startTicks: string | null;
  bootId: string | null;
}

function readStartMarker(path: string, attemptId: string): RecordedProcess | null {
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as { attemptId?: unknown; pid?: unknown; startTicks?: unknown; bootId?: unknown };
    if (marker.attemptId !== attemptId || typeof marker.pid !== "number") return null;
    return {
      pid: marker.pid,
      startTicks: typeof marker.startTicks === "string" ? marker.startTicks : null,
      bootId: typeof marker.bootId === "string" ? marker.bootId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Find a live process whose argv names this exact launch specification. The
 * wrapper is started as `node worker-process.ts <spec>`, so this identifies it
 * even when a crash kept its PID out of the database and out of the marker.
 */
function findProcessByArgument(argument: string): number | null {
  if (!PROC_AVAILABLE) return null;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (argv.includes(argument)) return Number(entry);
    } catch {
      // The process exited while scanning.
    }
  }
  return null;
}

export class HarnessAdapter implements WorkerAdapter {
  readonly name: "claude" | "codex";
  readonly authMode: string;
  readonly capabilityRegistry: CapabilityRegistry;

  constructor(name: "claude" | "codex", capabilityRegistry: CapabilityRegistry = DEFAULT_CAPABILITY_REGISTRY) {
    this.name = name;
    this.authMode = name === "claude" ? "claude.ai-subscription" : "chatgpt-subscription";
    this.capabilityRegistry = capabilityRegistry;
  }

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    // Last line of defence: whatever path reached this adapter, an ineligible
    // model, effort, or delegation setting never becomes a provider process.
    const eligibility = evaluateCapability(this.capabilityRegistry, {
      provider: this.name,
      model: input.model,
      effort: input.effort,
      authMode: this.authMode,
      delegation: input.delegation ?? DISABLED_DELEGATION,
    });
    if (!eligibility.evidence.eligible) {
      throw new Error(`Launch rejected before provider start: ${eligibility.evidence.reasons.join("; ")}`);
    }
    mkdirSync(dirname(input.completionPath), { recursive: true, mode: 0o700 });
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true, mode: 0o700 });
    rmSync(input.completionPath, { force: true });
    rmSync(launchFiles(input).marker, { force: true });
    rmSync(join(input.cwd, RESULT_FILE), { force: true });

    const specPath = launchFiles(input).spec;
    writeFileSync(specPath, JSON.stringify({
      harness: this.name,
      ...input,
      delegation: input.delegation ?? DISABLED_DELEGATION,
      eligibility: eligibility.evidence,
    }, null, 2), { mode: 0o600 });
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

  /**
   * The recorded process: the wrapper's own marker (which carries its start
   * identity), else the durable PID, else a live process naming this launch.
   */
  private locate(handle: AdapterHandle): RecordedProcess | null {
    const files = launchFiles(handle);
    const marker = readStartMarker(files.marker, handle.attemptId);
    if (marker && (handle.pid === null || handle.pid === marker.pid)) return marker;
    if (handle.pid !== null) return { pid: handle.pid, startTicks: null, bootId: null };
    const found = existsSync(files.spec) ? findProcessByArgument(files.spec) : null;
    return found === null ? null : { pid: found, startTicks: null, bootId: null };
  }

  /** Whether the recorded process is still this launch's wrapper; a reused PID is never ours. */
  private verify(handle: AdapterHandle): { recorded: RecordedProcess | null; verdict: "alive" | "gone" | "unverifiable" } {
    const recorded = this.locate(handle);
    if (!recorded) return { recorded, verdict: "gone" };
    return { recorded, verdict: verifyProcess(recorded.pid, { argument: launchFiles(handle).spec, startTicks: recorded.startTicks, bootId: recorded.bootId }) };
  }

  recoverHandle(handle: AdapterHandle): AdapterHandle {
    const { recorded, verdict } = this.verify(handle);
    return { ...handle, pid: verdict === "alive" && recorded ? recorded.pid : handle.pid };
  }

  async status(handle: AdapterHandle, options: { launchGraceMs?: number } = {}): Promise<AdapterStatus> {
    if (existsSync(handle.completionPath)) return "completed";
    const { recorded, verdict } = this.verify(handle);
    if (verdict === "alive") return "running";
    // Something runs under the PID, but without a process table it cannot be
    // proven to be ours, so it is neither adopted nor presumed lost.
    if (verdict === "unverifiable") return "ambiguous";
    const files = launchFiles(handle);
    // A crash between spawn and the PID write leaves only the specification.
    // The wrapper marks itself before starting any provider, so a missing
    // marker with no matching process after the grace window proves nothing
    // ran; without a process table that proof is unavailable.
    if (recorded === null && existsSync(files.spec)) {
      const ageMs = Date.now() - statSync(files.spec).mtimeMs;
      if (ageMs <= (options.launchGraceMs ?? DEFAULT_LAUNCH_GRACE_MS)) return "launching";
      if (!PROC_AVAILABLE) return "ambiguous";
    }
    return "lost";
  }

  async cancel(recorded: AdapterHandle): Promise<void> {
    const first = this.verify(recorded);
    if (first.verdict === "unverifiable") {
      throw new Error(`Cannot prove pid ${first.recorded?.pid} is still attempt ${recorded.attemptId}'s worker; refusing to signal it. Stop it manually.`);
    }
    if (first.verdict !== "alive" || !first.recorded) return;
    const pid = first.recorded.pid;
    // Signal the group only while the identity still matches: between checks
    // the wrapper can exit and its PID be reused.
    const signal = (name: NodeJS.Signals): boolean => {
      if (this.verify(recorded).verdict !== "alive") return false;
      try {
        process.kill(-pid, name);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return false;
      }
    };
    if (!signal("SIGTERM")) return;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && this.verify(recorded).verdict === "alive") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    signal("SIGKILL");
  }

  async collectResult(handle: AdapterHandle, cwd: string): Promise<CollectedResult> {
    let envelope: { result: LaunchResult | null; error: string | null; failureClass?: "CONFIG" | null };
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
        failureClass: envelope.failureClass ?? "INFRA",
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

    // A fallback model answering in place of the requested one is a route the
    // registry never approved; the attempt fails instead of being accepted.
    let routeError: string | null = null;
    const requested = launch.applied?.model;
    const answering = launch.answeringModels ? primaryAnsweringModel(launch.answeringModels) : null;
    if (!launch.timedOut && requested && answering && !sameModel(answering, requested)) {
      failureClass = "CONFIG" as const;
      routeError = `Provider answered with ${answering}, not the requested ${requested}; a fallback or default model is never accepted.`;
    }

    const observedError = failureClass
      ? (launch.finalMessage || launch.stderr || launch.raw).trim().slice(-8_000) || `Worker exited with ${launch.exitCode}`
      : null;
    return { launch, validation, failureClass, error: envelope.error ?? routeError ?? observedError };
  }
}

export function defaultAdapters(capabilityRegistry: CapabilityRegistry = DEFAULT_CAPABILITY_REGISTRY): Map<string, WorkerAdapter> {
  return new Map<string, WorkerAdapter>([
    ["claude", new HarnessAdapter("claude", capabilityRegistry)],
    ["codex", new HarnessAdapter("codex", capabilityRegistry)],
  ]);
}
