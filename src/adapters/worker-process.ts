#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DelegationPolicy } from "../routing/capabilities.ts";
import { launchClaude, launchCodex } from "../verify/launch.ts";

interface ProcessSpec {
  attemptId: string;
  harness: "claude" | "codex";
  cwd: string;
  prompt: string;
  model: string | null;
  effort?: string | null;
  delegation?: DelegationPolicy;
  timeoutMs: number;
  evidencePath: string;
  completionPath: string;
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error("worker-process requires a launch specification path");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as ProcessSpec;
  // Identify this process durably before any provider exists, so a controller
  // that crashed before persisting the PID can adopt it instead of relaunching.
  const markerPath = join(dirname(spec.completionPath), "start-marker.json");
  const markerTemporary = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(markerTemporary, JSON.stringify({ attemptId: spec.attemptId, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(markerTemporary, markerPath);
  const launch = spec.harness === "claude" ? launchClaude : launchCodex;
  let payload: Record<string, unknown>;
  try {
    const result = await launch({
      cwd: spec.cwd,
      prompt: spec.prompt,
      model: spec.model ?? undefined,
      effort: spec.effort ?? undefined,
      delegation: spec.delegation,
      timeoutMs: spec.timeoutMs,
      evidencePath: spec.evidencePath,
      progressPath: join(dirname(spec.completionPath), "progress.json"),
    });
    payload = { completedAt: new Date().toISOString(), result, error: null };
  } catch (error) {
    payload = {
      completedAt: new Date().toISOString(),
      result: null,
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
    };
  }
  const temporary = `${spec.completionPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(temporary, spec.completionPath);
}

await main();
