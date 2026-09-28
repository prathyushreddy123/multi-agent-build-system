/**
 * Harness launchers used by the Phase 0 proofs and the baseline suite.
 *
 * These are deliberately thin: Phase 1 turns them into real adapters with
 * start/status/cancel/collect_result. Keeping them in one place means the
 * evidence that proved the contract is the same code that will implement it.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

import { exec } from "../core/exec.ts";
import { DISABLED_DELEGATION, type DelegationPolicy } from "../routing/capabilities.ts";
import { buildWorkerEnv, assertNoPaidFallback } from "./env.ts";

// --------------------------------------------------------------------------
// harness launchers (Phase 0 only; Phase 1 extracts these into adapters)
// --------------------------------------------------------------------------

export interface LaunchOptions {
  cwd: string;
  prompt: string;
  model?: string;
  /** Explicit per-attempt effort. Absent means the provider's own default, which MABS cannot observe. */
  effort?: string;
  delegation?: DelegationPolicy;
  timeoutMs: number;
  evidencePath: string;
}

/**
 * The settings actually placed on the provider command line. Per-invocation
 * flags only: MABS never edits ~/.claude or ~/.codex configuration, so an
 * explicit setting here overrides the user's global default for this attempt
 * alone.
 */
export interface AppliedLaunchSettings {
  model: string | null;
  effort: string | null;
  effortSource: "explicit" | "provider_default_unknown";
  delegation: "disabled";
}

/** Child-agent activity the provider reported; null when it reports nothing. */
export interface ObservedDelegation {
  spawned: number | null;
  source: "claude.subagent_stats" | "unobservable";
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
  applied?: AppliedLaunchSettings;
  delegation?: ObservedDelegation;
}

const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(python3 *)", "Bash(git *)", "Bash(mkdir *)"];
/** Claude's native child-agent tool, under its current and legacy names. */
const CLAUDE_DELEGATION_TOOLS = ["Agent", "Task"];

function requireDisabledDelegation(policy: DelegationPolicy | undefined): void {
  if ((policy ?? DISABLED_DELEGATION).mode !== "disabled") {
    throw new Error("Native delegation must be disabled: child admission and usage accounting do not exist.");
  }
}

function applied(options: Pick<LaunchOptions, "model" | "effort">): AppliedLaunchSettings {
  return {
    model: options.model ?? null,
    effort: options.effort ?? null,
    effortSource: options.effort ? "explicit" : "provider_default_unknown",
    delegation: "disabled",
  };
}

/** Exact Claude argv for one attempt; pure so tests can assert it without a process. */
export function claudeArgs(options: Pick<LaunchOptions, "prompt" | "model" | "effort" | "delegation">): string[] {
  requireDisabledDelegation(options.delegation);
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...CLAUDE_TOOLS,
    "--disallowedTools",
    ...CLAUDE_DELEGATION_TOOLS,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

/** Exact Codex argv for one attempt. `-c` overrides apply to this process only. */
export function codexArgs(options: Pick<LaunchOptions, "cwd" | "prompt" | "model" | "effort" | "delegation">, lastMessagePath: string): string[] {
  requireDisabledDelegation(options.delegation);
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
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.multi_agent_v2=false",
  ];
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort="${options.effort}"`);
  args.push(options.prompt);
  return args;
}

/** Redact the prompt so evidence records the command shape without duplicating the packet. */
function renderArgs(args: string[], prompt: string): string {
  return args.map((arg) => arg === prompt ? `<prompt ${Buffer.byteLength(prompt)} bytes>` : arg).join(" ");
}

export async function launchClaude(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const args = claudeArgs(options);

  const result = await exec("claude", args, { cwd: options.cwd, env, timeoutMs: options.timeoutMs });
  writeFileSync(options.evidencePath, `$ claude ${renderArgs(args, options.prompt)}\n[env removed: ${removed.join(",") || "none"}]\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`);

  let finalMessage = "";
  let reportedModel: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let estimate: number | null = null;
  let sessionId: string | null = null;
  let spawned: number | null = null;
  try {
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const stats = envelope.subagent_stats as { spawned?: unknown } | undefined;
    if (typeof stats?.spawned === "number") spawned = stats.spawned;
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
    applied: applied(options),
    delegation: { spawned, source: spawned === null ? "unobservable" : "claude.subagent_stats" },
  };
}

export async function launchCodex(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const lastMessagePath = `${options.evidencePath}.last.txt`;
  const args = codexArgs(options, lastMessagePath);

  const result = await exec("codex", args, { cwd: options.cwd, env, timeoutMs: options.timeoutMs });
  writeFileSync(options.evidencePath, `$ codex ${renderArgs(args, options.prompt)}\n[env removed: ${removed.join(",") || "none"}]\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`);

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
    applied: applied(options),
    // Multi-agent is switched off on the command line, but exec reports no
    // child count, so zero is enforced rather than observed.
    delegation: { spawned: null, source: "unobservable" },
  };
}
