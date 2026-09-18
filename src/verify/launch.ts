/**
 * Harness launchers used by the Phase 0 proofs and the baseline suite.
 *
 * These are deliberately thin: Phase 1 turns them into real adapters with
 * start/status/cancel/collect_result. Keeping them in one place means the
 * evidence that proved the contract is the same code that will implement it.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

import { exec } from "../core/exec.ts";
import { buildWorkerEnv, assertNoPaidFallback } from "./env.ts";

// --------------------------------------------------------------------------
// harness launchers (Phase 0 only; Phase 1 extracts these into adapters)
// --------------------------------------------------------------------------

export interface LaunchOptions {
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  evidencePath: string;
}

export interface LaunchResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  finalMessage: string;
  reportedModel: string | null;
  usage: Record<string, unknown> | null;
  apiEquivalentEstimateUsd: number | null;
  sessionId: string | null;
  raw: string;
  stderr: string;
}

export async function launchClaude(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash(python3 *)",
    "Bash(git *)",
    "Bash(mkdir *)",
  ];
  if (options.model) args.push("--model", options.model);

  const result = await exec("claude", args, { cwd: options.cwd, env, timeoutMs: options.timeoutMs });
  writeFileSync(options.evidencePath, `$ claude ${args.join(" ")}\n[env removed: ${removed.join(",") || "none"}]\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`);

  let finalMessage = "";
  let reportedModel: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let estimate: number | null = null;
  let sessionId: string | null = null;
  try {
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    finalMessage = typeof envelope.result === "string" ? envelope.result : "";
    usage = (envelope.usage as Record<string, unknown>) ?? null;
    sessionId = (envelope.session_id as string) ?? null;
    estimate = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
    const modelUsage = envelope.modelUsage as Record<string, { canonicalModel?: string }> | undefined;
    if (modelUsage) {
      const first = Object.values(modelUsage)[0];
      reportedModel = first?.canonicalModel ?? Object.keys(modelUsage)[0] ?? null;
    }
  } catch {
    finalMessage = result.stdout;
  }

  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    finalMessage,
    reportedModel,
    usage,
    apiEquivalentEstimateUsd: estimate,
    sessionId,
    raw: result.stdout,
    stderr: result.stderr,
  };
}

export async function launchCodex(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const lastMessagePath = `${options.evidencePath}.last.txt`;
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-C",
    options.cwd,
    "-o",
    lastMessagePath,
  ];
  if (options.model) args.push("-m", options.model);
  args.push(options.prompt);

  const result = await exec("codex", args, { cwd: options.cwd, env, timeoutMs: options.timeoutMs });
  writeFileSync(options.evidencePath, `$ codex ${args.join(" ")}\n[env removed: ${removed.join(",") || "none"}]\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`);

  let usage: Record<string, unknown> | null = null;
  let sessionId: string | null = null;
  let finalMessage = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8") : "";
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started") sessionId = (event.thread_id as string) ?? sessionId;
      if (event.type === "turn.completed") usage = (event.usage as Record<string, unknown>) ?? usage;
      if (event.type === "item.completed") {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string" && finalMessage === "") {
          finalMessage = item.text;
        }
      }
    } catch {
      // Non-JSON progress lines are expected; evidence keeps the raw stream.
    }
  }

  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    finalMessage,
    // Codex exec does not report which model answered; unknown stays null.
    reportedModel: null,
    usage,
    apiEquivalentEstimateUsd: null,
    sessionId,
    raw: result.stdout,
    stderr: result.stderr,
  };
}
