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
import { CODEX_MODEL, DISABLED_DELEGATION, type DelegationPolicy } from "../routing/capabilities.ts";
import { buildWorkerEnv, assertNoPaidFallback } from "./env.ts";
import { requireSubscriptionProvenance, type ProviderProvenance } from "./provenance.ts";

// --------------------------------------------------------------------------
// harness launchers (Phase 0 only; Phase 1 extracts these into adapters)
// --------------------------------------------------------------------------

export interface LaunchOptions {
  cwd: string;
  prompt: string;
  /** Exact model; required; the provider default is never inherited. */
  model?: string;
  /** Explicit per-attempt effort; required, for the same reason. */
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
  effortSource: "explicit";
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
  /** Every model the provider reported using, with its output; null when unreported. */
  answeringModels?: { model: string; outputTokens: number | null }[] | null;
  usage: Record<string, unknown> | null;
  apiEquivalentEstimateUsd: number | null;
  sessionId: string | null;
  raw: string;
  stderr: string;
  applied?: AppliedLaunchSettings;
  delegation?: ObservedDelegation;
  /** The subscription login the launch was verified against before it started. */
  provenance?: ProviderProvenance;
  /** Live-stream accounting, including any output that was not retained. */
  telemetry?: StreamProgress & { stdoutTruncated: boolean; stderrTruncated: boolean };
}

const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(python3 *)", "Bash(git *)", "Bash(mkdir *)"];
/** Claude's native child-agent tool, under its current and legacy names. */
const CLAUDE_DELEGATION_TOOLS = ["Agent", "Task"];
const CLAUDE_EMPTY_MCP = JSON.stringify({ mcpServers: {} });

function requireDisabledDelegation(policy: DelegationPolicy | undefined): void {
  if ((policy ?? DISABLED_DELEGATION).mode !== "disabled") {
    throw new Error("Native delegation must be disabled: child admission and usage accounting do not exist.");
  }
}

/**
 * A launch always names its model and effort. Omitting either would inherit a
 * global, managed, or future provider default that no registry entry checked.
 */
function requireExplicitRoute(options: Pick<LaunchOptions, "model" | "effort">): { model: string; effort: string } {
  if (!options.model) throw new Error("Launch requires an exact model; the provider default is never inherited.");
  if (!options.effort) throw new Error("Launch requires an explicit effort; the provider default is never inherited.");
  return { model: options.model, effort: options.effort };
}

function applied(options: Pick<LaunchOptions, "model" | "effort">): AppliedLaunchSettings {
  const route = requireExplicitRoute(options);
  return { model: route.model, effort: route.effort, effortSource: "explicit", delegation: "disabled" };
}

/**
 * The model that carried the answer: the reported model with the most output.
 * Background helper models may appear with small output alongside it.
 */
export function primaryAnsweringModel(models: { model: string; outputTokens: number | null }[]): string | null {
  const ranked = [...models].sort((a, b) => (b.outputTokens ?? -1) - (a.outputTokens ?? -1));
  return ranked[0]?.model ?? null;
}

/** True when a reported model ID is the requested one, allowing dated or context suffixes. */
export function sameModel(reported: string, requested: string): boolean {
  const base = reported.replace(/\[[^\]]*\]$/, "");
  return base === requested || base.startsWith(`${requested}-`);
}

/**
 * The fixed route verification probes launch with. Probes name their model and
 * effort like any attempt; they exist to produce evidence about these routes.
 */
export const PROBE_ROUTES = {
  claude: { model: "claude-sonnet-5", effort: "low" },
  codex: { model: CODEX_MODEL, effort: "low" },
} as const;

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
    // Ignore user, project, and local settings files: their hooks, plugins,
    // apiKeyHelper, env, and model defaults never shape an attempt. Only
    // admin-managed settings still apply, and provenance refuses those that
    // could change the credential or model.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    CLAUDE_EMPTY_MCP,
  ];
  const route = requireExplicitRoute(options);
  args.push("--model", route.model, "--effort", route.effort);
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
    // $CODEX_HOME/config.toml (providers, profiles, MCP servers, defaults) is
    // never loaded; auth still comes from CODEX_HOME. The built-in provider
    // and ChatGPT login are then pinned explicitly.
    "--ignore-user-config",
    "-c",
    'model_provider="openai"',
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    "mcp_servers={}",
  ];
  const route = requireExplicitRoute(options);
  args.push("-m", route.model, "-c", `model_reasoning_effort="${route.effort}"`);
  args.push(options.prompt);
  return args;
}

/**
 * Every flag and feature the launch argv depends on. `mabs verify` checks the
 * installed CLIs expose them, so a CLI upgrade that drops one fails loudly
 * instead of silently loading configuration again.
 */
export const REQUIRED_CLI_SURFACE = {
  claude: ["--setting-sources", "--strict-mcp-config", "--mcp-config", "--disallowedTools", "--allowedTools", "--effort", "--model", "--permission-mode"],
  codexExec: ["--ignore-user-config", "--json", "--sandbox", "--config", "--model"],
  codexFeatures: ["multi_agent", "multi_agent_v2"],
} as const;

/** Required flags or features absent from the installed CLIs' own help and feature list. */
export function missingCliSurface(help: { claude: string; codexExec: string; codexFeatures: string }): string[] {
  const has = (text: string, flag: string) => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, "\\-")}(?=[\\s,=<]|$)`, "m").test(text);
  return [
    ...REQUIRED_CLI_SURFACE.claude.filter((flag) => !has(help.claude, flag)).map((flag) => `claude ${flag}`),
    ...REQUIRED_CLI_SURFACE.codexExec.filter((flag) => !has(help.codexExec, flag)).map((flag) => `codex exec ${flag}`),
    ...REQUIRED_CLI_SURFACE.codexFeatures.filter((name) => !new RegExp(`^${name}\\s`, "m").test(help.codexFeatures)).map((name) => `codex feature ${name}`),
  ];
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
  const provenance = await requireSubscriptionProvenance("claude", env);
  const args = claudeArgs(options);
  const { result, parser, telemetry } = await runStreaming("claude", args, options, env, removed);

  let finalMessage = "";
  let reportedModel: string | null = null;
  let answeringModels: { model: string; outputTokens: number | null }[] | null = null;
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
    const modelUsage = envelope.modelUsage as Record<string, { canonicalModel?: string; outputTokens?: unknown }> | undefined;
    if (modelUsage) {
      answeringModels = Object.entries(modelUsage).map(([key, entry]) => ({
        model: entry?.canonicalModel ?? key,
        outputTokens: typeof entry?.outputTokens === "number" ? entry.outputTokens : null,
      }));
      reportedModel = primaryAnsweringModel(answeringModels);
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
    answeringModels,
    usage,
    apiEquivalentEstimateUsd: estimate,
    sessionId,
    raw: envelopeText,
    stderr: result.stderr,
    applied: applied(options),
    provenance,
    delegation: { spawned, source: spawned === null ? "unobservable" : "claude.subagent_stats" },
    telemetry,
  };
}

export async function launchCodex(options: LaunchOptions): Promise<LaunchResult> {
  const { env, removed } = buildWorkerEnv();
  assertNoPaidFallback(env);
  const provenance = await requireSubscriptionProvenance("codex", env);
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
    provenance,
    // Multi-agent is switched off on the command line, but exec reports no
    // child count, so zero is enforced rather than observed.
    delegation: { spawned: null, source: "unobservable" },
    telemetry,
  };
}
