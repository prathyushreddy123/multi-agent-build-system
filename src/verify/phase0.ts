/**
 * Phase 0 — access proof and capability baseline.
 *
 * This is a repeatable harness, not a one-off script: the plan requires
 * re-checking product behaviour against installed versions, so every claim
 * here is produced by running the real command and keeping its evidence file.
 *
 * Run: node src/verify/phase0.ts [--quick]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../core/exec.ts";
import { classifyFailure, classifyFromEnvelope } from "../core/failure.ts";
import { stateDir } from "../core/paths.ts";
import { validateWorkerOutput, WORKER_OUTPUT_SCHEMA, CONTRACT_VERSION } from "../domain/contract.ts";
import { assertNoPaidFallback, buildWorkerEnv, FORBIDDEN_ENV_KEYS } from "./env.ts";
import { launchClaude, launchCodex } from "./launch.ts";
import { createFixture, fixtureTestsPass, gitStatus, FIXTURE_TASK } from "./fixture.ts";

export type ProbeStatus = "PASS" | "FAIL" | "UNKNOWN" | "SKIPPED";

export interface Probe {
  id: string;
  name: string;
  status: ProbeStatus;
  detail: string;
  durationMs?: number;
  evidence?: string;
  data?: Record<string, unknown>;
}

const RESULT_FILE = ".mabs/result.json";

/** The worker is told to drop its structured result in a file; prose parsing is only a fallback. */
function contractPrompt(taskText: string): string {
  return [
    taskText,
    "",
    `When the work is finished, write your structured result to ${RESULT_FILE} (create the directory).`,
    "The file must contain exactly one JSON object with these keys:",
    JSON.stringify(WORKER_OUTPUT_SCHEMA.properties, null, 0),
    `Use contract version ${CONTRACT_VERSION}. Set outcome to "completed", "blocked", or "failed".`,
    "Leave any value you cannot measure as null. Do not invent token counts.",
    "Then reply with the same JSON object as your final message, and nothing else.",
  ].join("\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// probes
// --------------------------------------------------------------------------

async function probeClaudeAuth(dir: string): Promise<Probe> {
  const started = Date.now();
  const result = await exec("claude", ["auth", "status"], { timeoutMs: 60_000 });
  const evidence = join(dir, "claude-auth.json");
  writeFileSync(evidence, result.stdout || result.stderr);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { id: "P0-01", name: "Claude subscription auth", status: "FAIL", detail: "auth status did not return JSON", evidence };
  }
  const subscriptionAuth = data.loggedIn === true && data.authMethod === "claude.ai" && data.apiProvider === "firstParty";
  return {
    id: "P0-01",
    name: "Claude subscription auth",
    status: subscriptionAuth ? "PASS" : "FAIL",
    detail: subscriptionAuth
      ? `logged in via ${String(data.authMethod)}, plan=${String(data.subscriptionType)}, provider=${String(data.apiProvider)}`
      : `not a first-party subscription session: ${JSON.stringify(data)}`,
    durationMs: Date.now() - started,
    evidence,
    data: { authMethod: data.authMethod, subscriptionType: data.subscriptionType, apiProvider: data.apiProvider },
  };
}

async function probeCodexAuth(dir: string): Promise<Probe> {
  const started = Date.now();
  const result = await exec("codex", ["login", "status"], { timeoutMs: 60_000 });
  // codex reports login state on stderr, so both streams are inspected.
  const statusText = `${result.stdout}\n${result.stderr}`.trim();
  const evidence = join(dir, "codex-auth.txt");
  const authFile = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "auth.json");
  let authMode: unknown = null;
  let keyPresent = false;
  if (existsSync(authFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
      authMode = parsed.auth_mode ?? null;
      keyPresent = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0;
    } catch {
      // Unreadable auth file is itself evidence; recorded below.
    }
  }
  writeFileSync(evidence, `${statusText}\nauth_mode=${String(authMode)}\napi_key_stored=${keyPresent}`);
  const chatgpt = /chatgpt/i.test(statusText) && !keyPresent;
  return {
    id: "P0-02",
    name: "Codex subscription auth",
    status: chatgpt ? "PASS" : "FAIL",
    detail: chatgpt
      ? `${statusText} · no API key stored in auth.json`
      : `unexpected auth state: ${statusText} (api key stored: ${keyPresent})`,
    durationMs: Date.now() - started,
    evidence,
    data: { authMode, keyPresent },
  };
}

function probeEnvScrub(dir: string): Probe {
  const parent: NodeJS.ProcessEnv = { ...process.env };
  for (const key of FORBIDDEN_ENV_KEYS) parent[key] = "sk-test-should-be-removed";
  const { env, removed } = buildWorkerEnv(parent);
  const leaked = FORBIDDEN_ENV_KEYS.filter((key) => env[key] !== undefined);

  let failClosed = false;
  try {
    assertNoPaidFallback(parent);
  } catch {
    failClosed = true;
  }

  const evidence = join(dir, "env-scrub.json");
  writeFileSync(evidence, JSON.stringify({ removed, leaked, failClosed }, null, 2));
  return {
    id: "P0-03",
    name: "No paid-fallback env reaches a worker",
    status: leaked.length === 0 && failClosed ? "PASS" : "FAIL",
    detail:
      leaked.length === 0 && failClosed
        ? `${removed.length} paid-access variables stripped; launching with any of them present throws`
        : `leaked: ${leaked.join(", ") || "none"}; fail-closed guard: ${failClosed}`,
    evidence,
    data: { removedCount: removed.length },
  };
}

async function probeRoundTrip(
  harness: "claude" | "codex",
  dir: string,
  fixtureRoot: string,
): Promise<Probe> {
  const id = harness === "claude" ? "P0-04" : "P0-05";
  const fixturePath = join(fixtureRoot, `${harness}-roundtrip`);
  const fixture = await createFixture(fixturePath);
  const evidence = join(dir, `${harness}-roundtrip.log`);
  const started = Date.now();

  const launch = harness === "claude" ? launchClaude : launchCodex;
  const result = await launch({
    cwd: fixture.path,
    prompt: contractPrompt(FIXTURE_TASK),
    timeoutMs: 15 * 60_000,
    evidencePath: evidence,
  });

  const tests = await fixtureTestsPass(fixture.path);
  const status = await gitStatus(fixture.path);

  // Prefer the dropped result file; fall back to parsing the final message.
  const resultFile = join(fixture.path, RESULT_FILE);
  const fromFile = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as unknown) : null;
  const parsed = fromFile ?? extractJson(result.finalMessage);
  const validation = validateWorkerOutput(parsed);

  const detail = [
    `exit=${result.exitCode}`,
    `tests ${tests.pass ? "pass" : "fail"}`,
    `${status.changedFiles.length} changed file(s)`,
    `contract ${validation.ok ? "valid" : `invalid (${validation.violations.length} violation(s))`}`,
    `result file ${fromFile ? "written" : "absent"}`,
    `model ${result.reportedModel ?? "not reported"}`,
    `${Math.round(result.durationMs / 1000)}s`,
  ].join(" · ");

  writeFileSync(join(dir, `${harness}-roundtrip-parsed.json`), JSON.stringify({ parsed, validation, tests, status }, null, 2));

  return {
    id,
    name: `${harness} round trip: edit, test, structured result`,
    status: tests.pass && result.exitCode === 0 ? (validation.ok ? "PASS" : "FAIL") : "FAIL",
    detail,
    durationMs: Date.now() - started,
    evidence,
    data: {
      testsPass: tests.pass,
      changedFiles: status.changedFiles,
      contractValid: validation.ok,
      violations: validation.violations,
      resultFileWritten: Boolean(fromFile),
      reportedModel: result.reportedModel,
      usage: result.usage,
      apiEquivalentEstimateUsd: result.apiEquivalentEstimateUsd,
      sessionId: result.sessionId,
    },
  };
}

async function probeCancellation(harness: "claude" | "codex", dir: string, fixtureRoot: string): Promise<Probe> {
  const id = harness === "claude" ? "P0-06" : "P0-07";
  const fixturePath = join(fixtureRoot, `${harness}-cancel`);
  const fixture = await createFixture(fixturePath);
  const evidence = join(dir, `${harness}-cancel.log`);
  const started = Date.now();

  const prompt =
    "Run `python3 -c \"import time; time.sleep(240)\"` in the shell and wait for it to finish before replying.";
  const launch = harness === "claude" ? launchClaude : launchCodex;
  const result = await launch({ cwd: fixture.path, prompt, timeoutMs: 20_000, evidencePath: evidence });

  // A cancelled worker must leave nothing behind - not the harness, and not the
  // grandchild shell command it launched. The worktree path does not appear in
  // the grandchild's command line, so both are checked explicitly.
  const ps = await exec("bash", [
    "-lc",
    `ps -eo pid,args | grep -E ${JSON.stringify(`${fixturePath}|time\\.sleep\\(240\\)`)} | grep -v grep || true`,
  ]);
  const orphans = ps.stdout.trim();

  return {
    id,
    name: `${harness} cancellation leaves no orphan`,
    status: result.timedOut && orphans === "" ? "PASS" : orphans === "" ? "UNKNOWN" : "FAIL",
    detail: result.timedOut
      ? `SIGTERM after 20s stopped the run and its child command (exit=${result.exitCode}); orphans: ${orphans || "none"}` +
        (result.exitCode === 0 ? " · exit status alone cannot prove cancellation here, so the controller records its own cancel intent" : "")
      : `run ended on its own before cancellation (exit=${result.exitCode}); orphans: ${orphans || "none"}`,
    durationMs: Date.now() - started,
    evidence,
    data: { timedOut: result.timedOut, exitCode: result.exitCode, orphans },
  };
}

async function probeClaudeModels(dir: string, aliases: string[]): Promise<Probe> {
  const started = Date.now();
  const mapping: Record<string, string | null> = {};
  for (const alias of aliases) {
    const evidence = join(dir, `model-${alias}.log`);
    const result = await launchClaude({
      cwd: dir,
      prompt: "Reply with exactly: ok",
      model: alias,
      timeoutMs: 180_000,
      evidencePath: evidence,
    });
    mapping[alias] = result.exitCode === 0 ? result.reportedModel : `error: ${classifyFailure(result.stderr || result.raw, result.exitCode)}`;
  }
  writeFileSync(join(dir, "claude-model-map.json"), JSON.stringify(mapping, null, 2));
  const resolved = Object.values(mapping).filter((value) => value && !value.startsWith("error")).length;
  return {
    id: "P0-08",
    name: "Claude model aliases resolve to real model IDs",
    status: resolved > 0 ? "PASS" : "FAIL",
    detail: Object.entries(mapping)
      .map(([alias, model]) => `${alias} → ${model ?? "unreported"}`)
      .join(" · "),
    durationMs: Date.now() - started,
    evidence: join(dir, "claude-model-map.json"),
    data: mapping,
  };
}

async function probeErrorShapes(dir: string): Promise<Probe> {
  const started = Date.now();
  const findings: Record<string, unknown> = {};

  const claudeBad = await exec("claude", ["-p", "hi", "--output-format", "json", "--model", "definitely-not-a-model"], {
    timeoutMs: 120_000,
    env: buildWorkerEnv().env,
  });
  const claudeText = `${claudeBad.stdout}${claudeBad.stderr}`;
  let claudeEnvelope: Record<string, unknown> = {};
  try {
    claudeEnvelope = JSON.parse(claudeBad.stdout) as Record<string, unknown>;
  } catch {
    // Unparseable output is itself recorded below.
  }
  findings.claude_invalid_model = {
    exit: claudeBad.code,
    classified: classifyFromEnvelope(claudeEnvelope, claudeText, claudeBad.code),
    terminal_reason: claudeEnvelope.terminal_reason ?? null,
    text: claudeText.slice(0, 600),
  };

  const codexBad = await exec("codex", ["exec", "--json", "--skip-git-repo-check", "-m", "definitely-not-a-model", "hi"], {
    timeoutMs: 120_000,
    env: buildWorkerEnv().env,
  });
  findings.codex_invalid_model = {
    exit: codexBad.code,
    classified: classifyFailure(`${codexBad.stdout}${codexBad.stderr}`, codexBad.code),
    text: `${codexBad.stdout}${codexBad.stderr}`.slice(0, 600),
  };

  const evidence = join(dir, "error-shapes.json");
  writeFileSync(evidence, JSON.stringify(findings, null, 2));

  // The point of this probe is that a misconfiguration must never be read as a
  // coding mistake, because repair cycles cannot fix a model name.
  const classes = [
    (findings.claude_invalid_model as { classified: string }).classified,
    (findings.codex_invalid_model as { classified: string }).classified,
  ];
  const noneSpendRepairs = classes.every((value) => value !== "CODE");
  return {
    id: "P0-09",
    name: "Misconfiguration is not classified as a code failure",
    status: noneSpendRepairs ? "PASS" : "FAIL",
    detail:
      `claude invalid model → ${classes[0]}; codex invalid model → ${classes[1]}. ` +
      "Neither consumes a repair cycle. A real quota exhaustion cannot be forced on demand and stays unverified.",
    durationMs: Date.now() - started,
    evidence,
    data: findings,
  };
}

// --------------------------------------------------------------------------
// report
// --------------------------------------------------------------------------

function renderReport(probes: Probe[], runDir: string, versions: Record<string, string>): string {
  const counts = probes.reduce<Record<string, number>>((acc, probe) => {
    acc[probe.status] = (acc[probe.status] ?? 0) + 1;
    return acc;
  }, {});
  const lines: string[] = [];
  lines.push("# Phase 0 — access proof and capability baseline");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Evidence: \`${runDir}\``);
  lines.push("");
  lines.push("## Installed versions under test");
  lines.push("");
  lines.push("| Component | Version |");
  lines.push("| --- | --- |");
  for (const [name, version] of Object.entries(versions)) lines.push(`| ${name} | ${version} |`);
  lines.push("");
  lines.push("## Probe results");
  lines.push("");
  lines.push(`${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ")}`);
  lines.push("");
  lines.push("| ID | Probe | Status | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const probe of probes) {
    lines.push(`| ${probe.id} | ${probe.name} | **${probe.status}** | ${probe.detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## Notes that change the design");
  lines.push("");
  lines.push(
    "- Claude reports `total_cost_usd` and per-model list pricing even on a subscription session. " +
      "That number is an API-equivalent estimate and is stored as `api_equivalent_estimate_usd`; " +
      "it is never presented as subscription spend or remaining quota.",
  );
  lines.push("- Codex `exec --json` reports token usage but not which model answered, so the reported model stays null while the requested model is recorded.");
  lines.push("- Structured results are collected from a worker-written result file first and parsed prose second, so a chatty final message cannot break the contract.");
  lines.push("- Real subscription exhaustion cannot be provoked on demand; the failure classifier is pattern-based and must be re-checked the first time a genuine limit is hit.");
  lines.push("");
  return lines.join("\n");
}

async function versionOf(command: string, args: string[]): Promise<string> {
  const result = await exec(command, args, { timeoutMs: 60_000 });
  return (result.stdout || result.stderr).trim().split("\n")[0] ?? "unknown";
}

export async function runPhase0(options: { quick?: boolean } = {}): Promise<Probe[]> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(stateDir(), "phase0", runId);
  const fixtureRoot = join(runDir, "fixtures");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(fixtureRoot, { recursive: true });

  const versions = {
    "Claude Code": await versionOf("claude", ["--version"]),
    Codex: await versionOf("codex", ["--version"]),
    Node: process.version,
    Python: await versionOf("python3", ["--version"]),
    Git: await versionOf("git", ["--version"]),
  };

  const probes: Probe[] = [];
  const record = (probe: Probe) => {
    probes.push(probe);
    const mark = probe.status === "PASS" ? "✓" : probe.status === "FAIL" ? "✗" : "·";
    console.log(`${mark} ${probe.id} ${probe.name}\n    ${probe.detail}`);
  };

  record(await probeClaudeAuth(runDir));
  record(await probeCodexAuth(runDir));
  record(probeEnvScrub(runDir));

  if (!options.quick) {
    record(await probeRoundTrip("claude", runDir, fixtureRoot));
    record(await probeRoundTrip("codex", runDir, fixtureRoot));
    record(await probeCancellation("claude", runDir, fixtureRoot));
    record(await probeCancellation("codex", runDir, fixtureRoot));
    record(await probeClaudeModels(runDir, ["sonnet", "opus", "haiku"]));
    record(await probeErrorShapes(runDir));
  }

  writeFileSync(join(runDir, "probes.json"), JSON.stringify({ versions, probes }, null, 2));
  const report = renderReport(probes, runDir, versions);
  writeFileSync(join(runDir, "report.md"), report);
  console.log(`\nEvidence: ${runDir}`);
  return probes;
}

if (import.meta.filename === process.argv[1]) {
  const quick = process.argv.includes("--quick");
  const probes = await runPhase0({ quick });
  const failed = probes.filter((probe) => probe.status === "FAIL");
  process.exitCode = failed.length > 0 ? 1 : 0;
}
