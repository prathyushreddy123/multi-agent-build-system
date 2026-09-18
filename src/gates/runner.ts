import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { exec } from "../core/exec.ts";
import { artifactDir } from "../core/paths.ts";
import type { GateResult, GateSpec, Records, Task } from "../store/records.ts";

export interface GateRunSummary {
  results: GateResult[];
  passed: boolean;
  failedRequired: GateResult[];
}

function displayCommand(command: readonly string[]): string {
  return command.map((part) => (/^[a-zA-Z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
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

  const failedRequired = results.filter((gate) => gate.required && gate.status !== "PASS" && gate.waiverId === null);
  return { results, passed: failedRequired.length === 0, failedRequired };
}
