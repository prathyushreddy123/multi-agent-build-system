#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { launchClaude, launchCodex } from "../verify/launch.ts";

interface ProcessSpec {
  harness: "claude" | "codex";
  cwd: string;
  prompt: string;
  model: string | null;
  timeoutMs: number;
  evidencePath: string;
  completionPath: string;
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error("worker-process requires a launch specification path");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as ProcessSpec;
  const launch = spec.harness === "claude" ? launchClaude : launchCodex;
  let payload: Record<string, unknown>;
  try {
    const result = await launch({
      cwd: spec.cwd,
      prompt: spec.prompt,
      model: spec.model ?? undefined,
      timeoutMs: spec.timeoutMs,
      evidencePath: spec.evidencePath,
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
