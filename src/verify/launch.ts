/**
 * Harness launchers used by the Phase 0 proofs and the baseline suite.
 *
 * These are deliberately thin: Phase 1 turns them into real adapters with
 * start/status/cancel/collect_result. Keeping them in one place means the
 * evidence that proved the contract is the same code that will implement it.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

import { exec, type ExecResult } from "../core/exec.ts";
import { LiveLog, ProgressWriter, ProviderStreamParser, type StreamProgress } from "../telemetry/stream.ts";
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
  /** Throttled live progress record; omitted for one-off probes. */
  progressPath?: string;
  liveLogBytes?: number;
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
  /** Live-stream accounting, including any output that was not retained. */
  telemetry?: StreamProgress & { stdoutTruncated: boolean; stderrTruncated: boolean };
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
    // stream-json emits events as they happen; its final `result` event is the
    // same envelope `json` returns at exit. --verbose is required with -p.
    "--output-format",
    "stream-json",
    "--verbose",
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

/**
 * Run a harness while streaming its stdout to the evidence log and a provider
 * parser as it arrives. Header and stderr are written around the stream so the
 * log keeps its familiar shape.
 */
async function runStreaming(
  harness: "claude" | "codex",
  args: string[],
  options: LaunchOptions,
  env: NodeJS.ProcessEnv,
  removed: string[],
): Promise<{ result: ExecResult; parser: ProviderStreamParser; telemetry: NonNullable<LaunchResult["telemetry"]> }> {
  writeFileSync(options.evidencePath, `$ ${harness} ${renderArgs(args, options.prompt)}\n[env removed: ${removed.join(",") || "none"}]\n\n`, { mode: 0o600 });
  const log = new LiveLog(options.evidencePath, options.liveLogBytes);
  const parser = new ProviderStreamParser(harness);
  const progress = options.progressPath ? new ProgressWriter(options.progressPath) : null;
  const result = await exec(harness, args, {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs,
    onStdout: (chunk) => {
      log.write(chunk);
      parser.push(chunk);
      progress?.maybeWrite(parser.snapshot(log.snapshot(), false));
    },
  });
  parser.end();
  log.write(`\n--- stderr ---\n${result.stderr}`);
  const final = parser.snapshot(log.snapshot(), true);
  progress?.maybeWrite(final, true);
  return {
    result,
    parser,
    telemetry: { ...final, stdoutTruncated: result.stdoutTruncated ?? false, stderrTruncated: result.stderrTruncated ?? false },
  };
}

export async function launchClaude(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const args = claudeArgs(options);
  const { result, parser, telemetry } = await runStreaming("claude", args, options, env, removed);

  let finalMessage = "";
  let reportedModel: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let estimate: number | null = null;
  let sessionId: string | null = parser.sessionId;
  let spawned: number | null = null;
  // The final result event is the envelope. A single JSON object (the older
  // `json` format) is accepted as the same envelope.
  const envelopeText = parser.resultLine ?? result.stdout;
  try {
    const envelope = JSON.parse(envelopeText) as Record<string, unknown>;
    const stats = envelope.subagent_stats as { spawned?: unknown } | undefined;
    if (typeof stats?.spawned === "number") spawned = stats.spawned;
    finalMessage = typeof envelope.result === "string" ? envelope.result : "";
    usage = (envelope.usage as Record<string, unknown>) ?? null;
    sessionId = (envelope.session_id as string) ?? sessionId;
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
    raw: envelopeText,
    stderr: result.stderr,
    applied: applied(options),
    delegation: { spawned, source: spawned === null ? "unobservable" : "claude.subagent_stats" },
    telemetry,
  };
}

export async function launchCodex(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const lastMessagePath = `${options.evidencePath}.last.txt`;
  const args = codexArgs(options, lastMessagePath);
  const { result, parser, telemetry } = await runStreaming("codex", args, options, env, removed);

  const usage = parser.lastUsage;
  const sessionId = parser.sessionId;
  const finalMessage = (existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8") : "") || (parser.agentMessage ?? "");
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
    telemetry,
  };
}
