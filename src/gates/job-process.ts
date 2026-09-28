#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { exec } from "../core/exec.ts";
import { selfIdentity } from "../core/process-identity.ts";

export interface GateJobSpec {
  jobId: string;
  cwd: string;
  command: string[];
  timeoutMs: number;
  completionPath: string;
  markerPath: string;
  versionCommand?: string[];
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error("gate job requires a launch specification path");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as GateJobSpec;
  const markerTemporary = `${spec.markerPath}.${process.pid}.tmp`;
  writeFileSync(markerTemporary, JSON.stringify({
    jobId: spec.jobId,
    // PID plus kernel start identity, so recovery never mistakes a reused PID for this job.
    ...selfIdentity(),
    startedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  renameSync(markerTemporary, spec.markerPath);

  const command = spec.command[0];
  const result = command
    ? await exec(command, spec.command.slice(1), { cwd: spec.cwd, timeoutMs: spec.timeoutMs })
    : { code: null, signal: null, stdout: "", stderr: "Gate configuration has an empty command.", timedOut: false, durationMs: 0 };
  let toolVersion: string | null = null;
  if (spec.versionCommand?.[0]) {
    const version = await exec(spec.versionCommand[0], spec.versionCommand.slice(1), {
      cwd: spec.cwd,
      timeoutMs: 30_000,
      maxBuffer: 32_000,
    });
    if (version.code === 0) toolVersion = (version.stdout || version.stderr).trim().split("\n")[0] ?? null;
  }
  const temporary = `${spec.completionPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    jobId: spec.jobId,
    completedAt: new Date().toISOString(),
    result,
    toolVersion,
  }, null, 2), { mode: 0o600 });
  renameSync(temporary, spec.completionPath);
}

await main();
