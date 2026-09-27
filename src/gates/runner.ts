import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exec } from "../core/exec.ts";
import { diagnoseFailure, type FailureDiagnosis } from "../core/failure.ts";
import { artifactDir } from "../core/paths.ts";
import type { GateResult, GateSpec, Records, Task } from "../store/records.ts";
import type { GateJobSpec } from "./job-process.ts";

/** Unconfigured coverage is a distinct outcome, never an implicit pass. */
export type QualityCoverage = "configured" | "not_configured";
export type QualityStatus = "passed" | "failed" | "not_configured";

export const QUALITY_COVERAGE_GATE = "quality-coverage";
const JOB_ENTRY = fileURLToPath(new URL("./job-process.ts", import.meta.url));

export interface GateRunSummary {
  results: GateResult[];
  passed: boolean;
  failedRequired: GateResult[];
  coverage: QualityCoverage;
  requiredConfigured: number;
  status: QualityStatus;
}

function displayCommand(command: readonly string[]): string {
  return command.map((part) => (/^[a-zA-Z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

export interface GateJobHandle {
  jobId: string;
  specPath: string;
  markerPath: string;
  completionPath: string;
}

export interface GateJobCompletion {
  jobId: string;
  completedAt: string;
  result: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
  };
  toolVersion: string | null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function gateJobHandle(taskId: string, stageRunId: string): GateJobHandle {
  const directory = artifactDir(taskId, `gate-${stageRunId}`);
  return {
    jobId: stageRunId,
    specPath: join(directory, "job.json"),
    markerPath: join(directory, "started.json"),
    completionPath: join(directory, "completion.json"),
  };
}

/**
 * Start a check outside the controller process. The child atomically writes its
 * own PID marker before invoking the command and an immutable completion
 * envelope afterwards, so controller restarts reconcile instead of relaunching.
 */
export async function launchGateJob(input: {
  taskId: string;
  stageRunId: string;
  worktreePath: string;
  spec: GateSpec;
}): Promise<GateJobHandle> {
  const handle = gateJobHandle(input.taskId, input.stageRunId);
  mkdirSync(dirname(handle.specPath), { recursive: true, mode: 0o700 });
  if (existsSync(handle.completionPath) || existsSync(handle.markerPath) || existsSync(handle.specPath)) {
    return handle;
  }
  const spec: GateJobSpec = {
    jobId: handle.jobId,
    cwd: input.spec.cwd ? resolve(input.worktreePath, input.spec.cwd) : input.worktreePath,
    command: [...input.spec.command],
    timeoutMs: input.spec.timeoutMs ?? 10 * 60_000,
    completionPath: handle.completionPath,
    markerPath: handle.markerPath,
    versionCommand: input.spec.versionCommand ? [...input.spec.versionCommand] : undefined,
  };
  writeFileSync(handle.specPath, JSON.stringify(spec, null, 2), { mode: 0o600, flag: "wx" });
  const child = spawn(process.execPath, [JOB_ENTRY, handle.specPath], {
    cwd: spec.cwd,
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
  return handle;
}

export function gateJobStatus(handle: GateJobHandle): "running" | "completed" | "lost" | "unknown" {
  if (existsSync(handle.completionPath)) return "completed";
  if (!existsSync(handle.markerPath)) return existsSync(handle.specPath) ? "unknown" : "lost";
  try {
    const marker = JSON.parse(readFileSync(handle.markerPath, "utf8")) as { jobId?: unknown; pid?: unknown };
    if (marker.jobId !== handle.jobId || !Number.isSafeInteger(marker.pid)) return "unknown";
    return processAlive(Number(marker.pid)) ? "running" : "lost";
  } catch {
    return "unknown";
  }
}

export function collectGateJob(input: {
  records: Records;
  task: Task;
  attemptId: string | null;
  stageRunId: string;
  revision: string;
  spec: GateSpec;
  environmentFingerprint: string | null;
  inputFingerprint: string;
}): { gate: GateResult; diagnosis: FailureDiagnosis | null } {
  const handle = gateJobHandle(input.task.id, input.stageRunId);
  const envelope = JSON.parse(readFileSync(handle.completionPath, "utf8")) as GateJobCompletion;
  if (envelope.jobId !== handle.jobId) throw new Error(`Gate completion belongs to ${envelope.jobId}, expected ${handle.jobId}.`);
  const result = envelope.result;
  const status = result.timedOut || result.code === null || result.code === 126 || result.code === 127
    ? "ERROR"
    : result.code === 0 ? "PASS" : "FAIL";
  const evidencePath = join(dirname(handle.completionPath), "gate.log");
  writeFileSync(
    evidencePath,
    `$ ${displayCommand(input.spec.command)}\n[cwd: ${input.spec.cwd ?? "."}]\n` +
      `[exit: ${result.code}; signal: ${result.signal}; timed_out: ${result.timedOut}]\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    { mode: 0o600 },
  );
  const diagnosis = status === "PASS" ? null : diagnoseFailure({
    stage: "check",
    source: "gate",
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    text: `${result.stdout}\n${result.stderr}`,
    toolResolved: result.code !== 126 && result.code !== 127,
    evidenceIds: [evidencePath, handle.completionPath],
  });
  const commandFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    command: input.spec.command,
    cwd: input.spec.cwd ?? ".",
    timeoutMs: input.spec.timeoutMs ?? 10 * 60_000,
    versionCommand: input.spec.versionCommand ?? null,
  })).digest("hex")}`;
  const gate = input.records.recordGate({
    taskId: input.task.id,
    attemptId: input.attemptId,
    stageRunId: input.stageRunId,
    jobId: handle.jobId,
    name: input.spec.name,
    status,
    required: input.spec.required,
    command: displayCommand(input.spec.command),
    toolVersion: envelope.toolVersion,
    revision: input.revision,
    evidencePath,
    durationMs: result.durationMs,
    waiverId: null,
    environmentFingerprint: input.environmentFingerprint,
    commandFingerprint,
    inputFingerprint: input.inputFingerprint,
    rawExitStatus: result.code,
    rawSignal: result.signal,
    timedOut: result.timedOut,
    failureDiagnosis: diagnosis,
  });
  return { gate, diagnosis };
}

async function toolVersion(spec: GateSpec, cwd: string): Promise<string | null> {
  const command = spec.versionCommand;
  if (!command || command.length === 0) return null;
  const result = await exec(command[0] as string, command.slice(1), { cwd, timeoutMs: 30_000, maxBuffer: 32_000 });
  if (result.code !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0] ?? null;
}

/** Run project-owned deterministic checks and bind every result to one revision. */
export async function runGates(input: {
  records: Records;
  task: Task;
  attemptId: string | null;
  worktreePath: string;
  revision: string;
  specs: GateSpec[];
}): Promise<GateRunSummary> {
  const results: GateResult[] = [];
  for (let index = 0; index < input.specs.length; index += 1) {
    const spec = input.specs[index] as GateSpec;
    const evidencePath = join(artifactDir(input.task.id, input.attemptId ?? "controller"), `gate-${index}-${spec.name.replace(/[^a-z0-9_-]/gi, "-")}.log`);
    if (spec.command.length === 0) {
      const gate = input.records.recordGate({
        taskId: input.task.id,
        attemptId: input.attemptId,
        name: spec.name,
        status: "ERROR",
        required: spec.required,
        command: "",
        toolVersion: null,
        revision: input.revision,
        evidencePath,
        durationMs: 0,
        waiverId: null,
      });
      writeFileSync(evidencePath, "Gate configuration has an empty command.\n", { mode: 0o600 });
      results.push(gate);
      continue;
    }

    const cwd = spec.cwd ? resolve(input.worktreePath, spec.cwd) : input.worktreePath;
    const command = spec.command[0] as string;
    const args = spec.command.slice(1);
    const result = await exec(command, args, { cwd, timeoutMs: spec.timeoutMs ?? 10 * 60_000 });
    const status = result.timedOut || result.code === null || result.code === 127 ? "ERROR" : result.code === 0 ? "PASS" : "FAIL";
    writeFileSync(
      evidencePath,
      `$ ${displayCommand(spec.command)}\n[cwd: ${cwd}]\n[exit: ${result.code}; signal: ${result.signal}; timed_out: ${result.timedOut}]\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      { mode: 0o600 },
    );
    results.push(input.records.recordGate({
      taskId: input.task.id,
      attemptId: input.attemptId,
      name: spec.name,
      status,
      required: spec.required,
      command: displayCommand(spec.command),
      toolVersion: await toolVersion(spec, cwd),
      revision: input.revision,
      evidencePath,
      durationMs: result.durationMs,
      waiverId: null,
    }));
  }

  const requiredConfigured = input.specs.filter((spec) => spec.required).length;
  if (requiredConfigured === 0) {
    // Record the absence as evidence bound to the revision so "nothing ran"
    // can never be read later as "everything passed".
    const evidencePath = join(artifactDir(input.task.id, input.attemptId ?? "controller"), "gate-quality-coverage.log");
    writeFileSync(
      evidencePath,
      `No required quality checks are configured for this project.\n[revision: ${input.revision}]\n` +
        "This revision has no build, lint, typecheck, or test evidence. It is not a passing quality result.\n",
      { mode: 0o600 },
    );
    results.push(input.records.recordGate({
      taskId: input.task.id,
      attemptId: input.attemptId,
      name: QUALITY_COVERAGE_GATE,
      status: "SKIPPED",
      required: false,
      command: "",
      toolVersion: null,
      revision: input.revision,
      evidencePath,
      durationMs: 0,
      waiverId: null,
    }));
  }

  const failedRequired = results.filter((gate) => gate.required && gate.status !== "PASS" && gate.waiverId === null);
  const passed = failedRequired.length === 0;
  return {
    results,
    passed,
    failedRequired,
    coverage: requiredConfigured === 0 ? "not_configured" : "configured",
    requiredConfigured,
    status: requiredConfigured === 0 ? "not_configured" : passed ? "passed" : "failed",
  };
}
