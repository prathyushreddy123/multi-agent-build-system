import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HarnessAdapter, START_MARKER_FILE } from "../src/adapters/harness.ts";
import { gateJobStatus } from "../src/gates/runner.ts";
import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateProjectConfig, projectConfigSnapshot } from "../src/domain/config.ts";
import {
  CODEX_MODEL,
  DEFAULT_CAPABILITY_REGISTRY,
  evaluateCapability,
  loadCapabilityRegistry,
  recordEntitlementVerification,
  type CapabilityRegistry,
} from "../src/routing/capabilities.ts";
import { DEFAULT_ROUTING_POLICY, selectRoute, type ProviderAvailability } from "../src/routing/router.ts";
import { Store } from "../src/store/db.ts";
import { Records, type Task } from "../src/store/records.ts";
import { claudeArgs, codexArgs, launchClaude, launchCodex, missingCliSurface, type LaunchResult } from "../src/verify/launch.ts";
import {
  CLAUDE_MANAGED_SETTINGS_DIR,
  CODEX_MANAGED_CONFIG_DIR,
  claudeAuthRefusals,
  codexAuthRefusals,
  codexManagedConfigRefusals,
  managedDirectories,
  managedSettingsRefusals,
  ProvenanceError,
} from "../src/verify/provenance.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

function tempRoot(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Put fake `claude` and `codex` executables first on PATH and point HOME at a
 * temporary directory holding a "global" configuration. Each fake records its
 * exact argv and prints a minimal valid provider envelope; no real harness is
 * reachable from inside the test.
 */
interface Invocation { bin: string; argv: string[]; loadedUserConfig: boolean; loadedExternalMcp: boolean }

function fakeHarnesses(t: TestContext, options: { delayMs?: number } = {}) {
  const root = tempRoot(t, "mabs-fake-harness-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const codexConfig = join(home, ".codex", "config.toml");
  const claudeSettings = join(home, ".claude", "settings.json");
  // A hostile global configuration: a paid provider, a key helper, a fallback
  // model, and a hook. None of it may shape an attempt.
  writeFileSync(codexConfig, 'model = "global-default"\nmodel_reasoning_effort = "high"\nmodel_provider = "paid-proxy"\n' +
    '[model_providers.paid-proxy]\nbase_url = "https://proxy.invalid"\nenv_key = "PROXY_KEY"\n');
  writeFileSync(claudeSettings, JSON.stringify({
    effortLevel: "high", model: "claude-haiku-4-5", apiKeyHelper: "echo sk-paid",
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] },
  }));
  const argvLog = join(root, "argv.jsonl");
  // Each fake answers its auth-status command, and otherwise reports which
  // configuration the real CLI would have loaded given this argv: Codex reads
  // $CODEX_HOME/config.toml unless --ignore-user-config; Claude reads user
  // settings unless --setting-sources omits "user".
  const script = (envelope: string) => `#!${process.execPath}
const { appendFileSync, existsSync } = require("node:fs");
const argv = process.argv.slice(2);
const bin = require("node:path").basename(process.argv[1]);
if (bin === "claude" && argv[0] === "auth") { process.stdout.write(process.env.FAKE_CLAUDE_AUTH ?? JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" })); process.exit(0); }
if (bin === "codex" && argv[0] === "login") { process.stderr.write(process.env.FAKE_CODEX_AUTH ?? "Logged in using ChatGPT\\n"); process.exit(0); }
const sources = argv.includes("--setting-sources") ? argv[argv.indexOf("--setting-sources") + 1].split(",") : ["user", "project", "local"];
const loadedUserConfig = bin === "codex" ? !argv.includes("--ignore-user-config") && existsSync(${JSON.stringify(codexConfig)}) : sources.includes("user");
const loadedExternalMcp = bin === "claude" && !argv.includes("--strict-mcp-config");
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ bin, argv, loadedUserConfig, loadedExternalMcp }) + "\\n");
setTimeout(() => process.stdout.write(${JSON.stringify(envelope)}), ${options.delayMs ?? 0});
`;
  writeFileSync(join(bin, "claude"), script(JSON.stringify({
    result: "done",
    session_id: "fake",
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-sonnet-5": { canonicalModel: "claude-sonnet-5" } },
    subagent_stats: { spawned: 0 },
  })));
  writeFileSync(join(bin, "codex"), script(`${JSON.stringify({ type: "thread.started", thread_id: "fake" })}\n`));
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "codex"), 0o755);

  const previous = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.HOME = home;
  t.after(() => {
    process.env.PATH = previous.PATH;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
  });
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    root,
    globalHashes: () => ({ codex: hash(codexConfig), claude: hash(claudeSettings) }),
    invocations: (): Invocation[] => existsSync(argvLog)
      ? readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Invocation)
      : [],
  };
}

function flagValue(argv: string[], flag: string): string[] {
  return argv.flatMap((value, index) => (value === flag ? [argv[index + 1] as string] : []));
}

test("RTE-01: an explicit per-attempt effort reaches the exact provider argv without touching global settings", async (t) => {
  const fake = fakeHarnesses(t);
  const before = fake.globalHashes();
  const cwd = tempRoot(t, "mabs-launch-cwd-");

  const codex = await launchCodex({ cwd, prompt: "task", model: CODEX_MODEL, effort: "medium", timeoutMs: 10_000, evidencePath: join(cwd, "codex.log") });
  const claude = await launchClaude({
    cwd, prompt: "task", model: "claude-sonnet-5", effort: "low", timeoutMs: 10_000, evidencePath: join(cwd, "claude.log"),
  });

  const [codexCall, claudeCall] = fake.invocations();
  assert.equal(codexCall?.bin, "codex");
  assert.ok(flagValue(codexCall.argv, "-c").includes('model_reasoning_effort="medium"'));
  assert.ok(flagValue(codexCall.argv, "-c").includes("features.multi_agent=false"));
  assert.deepEqual(flagValue(codexCall.argv, "-m"), [CODEX_MODEL], "the local config default model is never inherited");
  assert.equal(codexCall.loadedUserConfig, false, "Codex never loads the user's providers, profiles, or defaults");
  assert.ok(flagValue(codexCall.argv, "-c").includes('model_provider="openai"'), "the built-in provider is pinned");
  assert.ok(flagValue(codexCall.argv, "-c").includes('forced_login_method="chatgpt"'), "ChatGPT subscription login is required");
  assert.equal(claudeCall?.bin, "claude");
  assert.deepEqual(flagValue(claudeCall.argv, "--effort"), ["low"]);
  assert.deepEqual(flagValue(claudeCall.argv, "--model"), ["claude-sonnet-5"]);
  const disallowed = claudeCall.argv.slice(claudeCall.argv.indexOf("--disallowedTools") + 1);
  assert.ok(disallowed.includes("Agent"), "Claude's native child-agent tool is disallowed");
  assert.equal(claudeCall.loadedUserConfig, false, "Claude never loads user settings: no apiKeyHelper, hooks, or model default");
  assert.deepEqual(flagValue(claudeCall.argv, "--setting-sources"), [""]);
  assert.equal(claudeCall.loadedExternalMcp, false, "no MCP server outside the empty launch config");
  assert.ok(!claudeCall.argv.includes("--fallback-model"), "no fallback model is ever requested");
  assert.equal(claude.provenance?.authMethod, "claude.ai");
  assert.equal(codex.provenance?.authMethod, "chatgpt");

  assert.deepEqual(codex.applied, { model: CODEX_MODEL, effort: "medium", effortSource: "explicit", delegation: "disabled" });
  assert.deepEqual(claude.applied, { model: "claude-sonnet-5", effort: "low", effortSource: "explicit", delegation: "disabled" });
  assert.deepEqual(fake.globalHashes(), before, "global provider configuration is never edited");
  // Evidence records the command shape but not a second copy of the prompt.
  assert.match(readFileSync(join(cwd, "codex.log"), "utf8"), /<prompt 4 bytes>/);
});

test("RTE-02: a launch without established subscription provenance starts no provider process", async (t) => {
  const fake = fakeHarnesses(t);
  const cwd = tempRoot(t, "mabs-provenance-");
  const saved = { codex: process.env.FAKE_CODEX_AUTH, claude: process.env.FAKE_CLAUDE_AUTH, managed: process.env.MABS_CLAUDE_MANAGED_SETTINGS_DIR };
  t.after(() => {
    for (const [key, value] of [["FAKE_CODEX_AUTH", saved.codex], ["FAKE_CLAUDE_AUTH", saved.claude], ["MABS_CLAUDE_MANAGED_SETTINGS_DIR", saved.managed]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const options = { cwd, prompt: "task", effort: "low", timeoutMs: 10_000, evidencePath: join(cwd, "x.log") };

  process.env.FAKE_CODEX_AUTH = "Logged in using an API key - sk-proj-***\n";
  await assert.rejects(launchCodex({ ...options, model: CODEX_MODEL }), (error: Error) => error instanceof ProvenanceError && /API key/.test(error.message));

  process.env.FAKE_CLAUDE_AUTH = JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" });
  await assert.rejects(launchClaude({ ...options, model: "claude-sonnet-5" }), /not a claude.ai subscription/);

  delete process.env.FAKE_CLAUDE_AUTH;
  const managed = tempRoot(t, "mabs-managed-");
  writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({ apiKeyHelper: "/usr/bin/key", env: { ANTHROPIC_BASE_URL: "https://proxy" } }));
  process.env.MABS_CLAUDE_MANAGED_SETTINGS_DIR = managed;
  await assert.rejects(launchClaude({ ...options, model: "claude-sonnet-5" }), /sets apiKeyHelper/);

  assert.deepEqual(fake.invocations(), [], "no provider inference ran without provenance");
});

test("RTE-02: provenance rules name every off-subscription route", (t) => {
  assert.deepEqual(claudeAuthRefusals({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }), []);
  assert.match(claudeAuthRefusals({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }).join(), /not first-party/);
  assert.match(claudeAuthRefusals({ loggedIn: false }).join(), /not logged in/);
  assert.deepEqual(codexAuthRefusals("Logged in using ChatGPT"), []);
  assert.match(codexAuthRefusals("Not logged in").join(), /cannot be established/);
  const dir = tempRoot(t, "mabs-managed-rules-");
  assert.deepEqual(managedSettingsRefusals(dir), { files: [], refusals: [] }, "no managed settings is the normal case");
  mkdirSync(join(dir, "managed-settings.d"));
  writeFileSync(join(dir, "managed-settings.d", "10-model.json"), JSON.stringify({ model: "claude-haiku-4-5", forceLoginMethod: "console" }));
  writeFileSync(join(dir, "managed-settings.json"), "{not json");
  const refusals = managedSettingsRefusals(dir).refusals.join(" ");
  assert.match(refusals, /sets model/);
  assert.match(refusals, /console/);
  assert.match(refusals, /cannot be read/, "an unreadable managed file fails closed");
});

test("N2: a managed-settings override adds a directory and never disables the system location", () => {
  assert.deepEqual(managedDirectories(CLAUDE_MANAGED_SETTINGS_DIR, undefined), [CLAUDE_MANAGED_SETTINGS_DIR]);
  assert.deepEqual(managedDirectories(CLAUDE_MANAGED_SETTINGS_DIR, "/tmp/empty"), [CLAUDE_MANAGED_SETTINGS_DIR, "/tmp/empty"]);
  assert.deepEqual(managedDirectories(CODEX_MANAGED_CONFIG_DIR, CODEX_MANAGED_CONFIG_DIR), [CODEX_MANAGED_CONFIG_DIR]);
});

test("N3: system-managed Codex configuration that can reroute an attempt is refused", (t) => {
  const dir = tempRoot(t, "mabs-codex-managed-");
  assert.deepEqual(codexManagedConfigRefusals(dir), { files: [], refusals: [] }, "no managed configuration is the normal case");
  writeFileSync(join(dir, "managed_config.toml"), [
    "# a comment: model = \"ignored\"",
    "forced_login_method = \"chatgpt\"",
    "approval_policy = \"never\"",
    "model = \"gpt-4o\"",
    "[model_providers.proxy]",
    "base_url = \"https://proxy\"",
  ].join("\n"));
  writeFileSync(join(dir, "requirements.toml"), "preferred_auth_method = \"apikey\"\n[sandbox_workspace_write]\nmodel = \"nested keys are not top-level\"\n");
  const { files, refusals } = codexManagedConfigRefusals(dir);
  assert.equal(files.length, 2);
  const text = refusals.join(" ");
  assert.match(text, /managed_config\.toml sets model,/);
  assert.match(text, /\[model_providers\.proxy\]/);
  assert.match(text, /sets preferred_auth_method/);
  assert.doesNotMatch(text, /forced_login_method/, "forcing the ChatGPT login is the safe value");
  assert.doesNotMatch(text, /approval_policy/);
  assert.equal(refusals.length, 3, "comments and keys inside unrelated tables are ignored");
});

test("N3: a Codex launch under rerouting managed configuration starts no provider process", async (t) => {
  const fake = fakeHarnesses(t);
  const cwd = tempRoot(t, "mabs-codex-managed-launch-");
  const managed = tempRoot(t, "mabs-codex-managed-dir-");
  writeFileSync(join(managed, "config.toml"), "model_provider = \"proxy\"\n");
  const saved = process.env.MABS_CODEX_MANAGED_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.MABS_CODEX_MANAGED_CONFIG_DIR; else process.env.MABS_CODEX_MANAGED_CONFIG_DIR = saved; });
  process.env.MABS_CODEX_MANAGED_CONFIG_DIR = managed;
  await assert.rejects(
    launchCodex({ cwd, prompt: "task", model: CODEX_MODEL, effort: "low", timeoutMs: 10_000, evidencePath: join(cwd, "x.log") }),
    (error: Error) => error instanceof ProvenanceError && /sets model_provider/.test(error.message),
  );
  assert.deepEqual(fake.invocations(), [], "no provider inference ran");
});

test("RTE-06: a CLI that drops an isolation flag or feature is reported, and a refused provenance collects as CONFIG", async (t) => {
  const claude = "  --setting-sources <sources>\n  --strict-mcp-config\n  --mcp-config <configs...>\n  --disallowedTools, --disallowed-tools <tools...>\n" +
    "  --allowedTools, --allowed-tools <tools...>\n  --effort <level>\n  --model <model>\n  --permission-mode <mode>\n";
  const codexExec = "      --ignore-user-config\n      --json\n  -s, --sandbox <SANDBOX_MODE>\n  -c, --config <key=value>\n  -m, --model <MODEL>\n";
  const codexFeatures = "multi_agent        stable  true\nmulti_agent_v2     experimental false\n";
  assert.deepEqual(missingCliSurface({ claude, codexExec, codexFeatures }), []);
  assert.deepEqual(missingCliSurface({ claude: claude.replace("--strict-mcp-config", "--other"), codexExec: codexExec.replace("--ignore-user-config", ""), codexFeatures: "multi_agent  stable true\n" }),
    ["claude --strict-mcp-config", "codex exec --ignore-user-config", "codex feature multi_agent_v2"]);

  const cwd = tempRoot(t, "mabs-provenance-collect-");
  const completionPath = join(cwd, "completion.json");
  writeFileSync(completionPath, JSON.stringify({ result: null, failureClass: "CONFIG", error: "ProvenanceError: Refusing to launch Codex: API key" }));
  const collected = await new HarnessAdapter("codex").collectResult({ attemptId: "a", pid: null, sessionId: null, completionPath }, cwd);
  assert.equal(collected.failureClass, "CONFIG", "an operator must fix the login; it is not retried as INFRA");
});

test("RTE-01: an absent model or effort is ineligible and never reaches a provider argv", () => {
  assert.throws(() => codexArgs({ cwd: "/w", prompt: "p", effort: "high" }, "/w/last.txt"), /exact model/);
  assert.throws(() => codexArgs({ cwd: "/w", prompt: "p", model: CODEX_MODEL }, "/w/last.txt"), /explicit effort/);
  assert.throws(() => claudeArgs({ prompt: "p", model: "claude-sonnet-5" }), /explicit effort/);
  assert.throws(() => claudeArgs({ prompt: "p", effort: "low" }), /exact model/);
  const evidence = evaluateCapability(VERIFIED_REGISTRY, { provider: "codex", model: null, effort: null }).evidence;
  assert.equal(evidence.eligible, false);
  assert.equal(evidence.effortSource, "missing");
  assert.match(evidence.reasons.join(), /names no model/);
  assert.match(evidence.reasons.join(), /names no effort/);
  const claudeDefault = evaluateCapability(VERIFIED_REGISTRY, { provider: "claude", model: "claude-sonnet-5", effort: null }).evidence;
  assert.equal(claudeDefault.eligible, false, "an inherited global or managed effort is never accepted");
});

test("RTE-01: every default policy route names an exact model and bounded effort", () => {
  for (const [taskClass, candidates] of Object.entries(DEFAULT_ROUTING_POLICY.routes)) {
    for (const candidate of candidates) {
      assert.ok(candidate.model, `${taskClass}/${candidate.adapter} names a model`);
      assert.ok(candidate.effort, `${taskClass}/${candidate.adapter} names an effort`);
      const evidence = evaluateCapability(VERIFIED_REGISTRY, { provider: candidate.adapter, model: candidate.model, effort: candidate.effort }).evidence;
      assert.equal(evidence.eligible, true, `${taskClass}/${candidate.adapter}: ${evidence.reasons.join("; ")}`);
      const argv = candidate.adapter === "claude"
        ? claudeArgs({ prompt: "p", model: candidate.model ?? undefined, effort: candidate.effort ?? undefined })
        : codexArgs({ cwd: "/w", prompt: "p", model: candidate.model ?? undefined, effort: candidate.effort ?? undefined }, "/w/last.txt");
      assert.ok(argv.includes(candidate.model as string));
    }
  }
});

test("RTE-02: the pinned Codex model is ineligible until an entitlement probe is recorded", (t) => {
  const evidence = evaluateCapability(DEFAULT_CAPABILITY_REGISTRY, { provider: "codex", model: CODEX_MODEL, effort: "high" }).evidence;
  assert.equal(evidence.eligible, false);
  assert.match(evidence.reasons.join(), /entitlement is unknown/);
  const overlay = join(tempRoot(t, "mabs-entitlement-"), "capability-entitlements.json");
  assert.throws(() => recordEntitlementVerification({
    provider: "codex", model: "unregistered-model", effort: "low", verifiedAt: "2026-01-01T00:00:00Z", evidencePath: "/e",
  }, overlay), /not a registered route/);
  recordEntitlementVerification({ provider: "codex", model: CODEX_MODEL, effort: "low", verifiedAt: "2026-01-01T00:00:00Z", evidencePath: "/e" }, overlay);
  const loaded = loadCapabilityRegistry(overlay);
  assert.equal(evaluateCapability(loaded, { provider: "codex", model: CODEX_MODEL, effort: "high" }).evidence.eligible, true);
  assert.equal(loaded.entries.length, DEFAULT_CAPABILITY_REGISTRY.entries.length, "the overlay never adds a model");
});

test("RTE-02: a fallback model answering in place of the requested one fails the attempt as CONFIG", async (t) => {
  const cwd = tempRoot(t, "mabs-fallback-");
  const completionPath = join(cwd, "completion.json");
  const launch: Partial<LaunchResult> = {
    exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", usage: null, apiEquivalentEstimateUsd: null,
    sessionId: null, raw: "", stderr: "", reportedModel: "claude-haiku-4-5",
    applied: { model: "claude-opus-5", effort: "high", effortSource: "explicit", delegation: "disabled" },
    answeringModels: [{ model: "claude-haiku-4-5", outputTokens: 900 }, { model: "claude-opus-5", outputTokens: 3 }],
  };
  writeFileSync(completionPath, JSON.stringify({ result: launch, error: null }));
  const collected = await new HarnessAdapter("claude").collectResult({ attemptId: "a", pid: null, sessionId: null, completionPath }, cwd);
  assert.equal(collected.failureClass, "CONFIG");
  assert.match(collected.error ?? "", /answered with claude-haiku-4-5, not the requested claude-opus-5/);

  const dated: Partial<LaunchResult> = { ...launch, answeringModels: [{ model: "claude-opus-5-20260101", outputTokens: 900 }, { model: "claude-haiku-4-5", outputTokens: 2 }] };
  writeFileSync(completionPath, JSON.stringify({ result: dated, error: null }));
  const accepted = await new HarnessAdapter("claude").collectResult({ attemptId: "a", pid: null, sessionId: null, completionPath }, cwd);
  assert.notEqual(accepted.failureClass, "CONFIG", "a helper model beside the requested one is not a fallback");
});

test("RTE-02: unsupported effort or unknown model entitlement launches no provider process", async (t) => {
  const fake = fakeHarnesses(t);
  const cwd = tempRoot(t, "mabs-adapter-reject-");
  const adapter = new HarnessAdapter("codex");
  const launch = (model: string | null, effort: string | null): AdapterLaunch => ({
    attemptId: "att", cwd, prompt: "p", model, effort, timeoutMs: 1_000,
    evidencePath: join(cwd, "a", "worker.log"), completionPath: join(cwd, "a", "completion.json"),
  });
  await assert.rejects(adapter.start(launch(null, "medium")), /names no model/);
  await assert.rejects(adapter.start(launch(CODEX_MODEL, "max")), /effort max is unsupported/);
  await assert.rejects(adapter.start(launch(CODEX_MODEL, "medium")), /entitlement is unknown/);
  await assert.rejects(new HarnessAdapter("claude").start({ ...launch("claude-sonnet-5", null) }), /names no effort/);
  await assert.rejects(adapter.start(launch("gpt-from-a-catalog", "medium")), /entitlement is unknown/);
  await assert.rejects(new HarnessAdapter("claude").start({ ...launch("claude-opus-5", "xhigh") }), /unsupported/);
  assert.equal(existsSync(join(cwd, "a", "launch.json")), false, "no launch specification was written");
  assert.deepEqual(fake.invocations(), []);
});

test("a registry entry with unverified entitlement is ineligible even when the policy names it", () => {
  const registry: CapabilityRegistry = {
    version: "test",
    entries: [{ ...DEFAULT_CAPABILITY_REGISTRY.entries[0]!, entitlement: "unknown" }],
  };
  const evidence = evaluateCapability(registry, { provider: "codex", model: CODEX_MODEL, effort: "high" }).evidence;
  assert.equal(evidence.eligible, false);
  assert.match(evidence.reasons.join(), /entitlement is unknown/);
});

// ---------------------------------------------------------------------------
// route selection

class StubAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  starts: AdapterLaunch[] = [];
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input);
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"running"> { return "running"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> { throw new Error("not collected in these tests"); }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk", projectId: "prj", title: "t", objective: "o", acceptanceCriteria: [], role: "implementer",
    taskClass: "small_implementation", complexity: "low", ambiguity: "low", changeRisk: "low", language: null,
    domain: null, contextSize: "low", requiredTools: [], deadlineAt: null,
    ...overrides,
  } as Task;
}

const adapters = new Map<string, WorkerAdapter>([["codex", new StubAdapter("codex")], ["claude", new StubAdapter("claude")]]);
const routes = { adapters, capabilityRegistry: VERIFIED_REGISTRY };
const available = (overrides: Partial<Record<string, Partial<ProviderAvailability>>> = {}): ProviderAvailability[] =>
  ["codex", "claude"].map((provider) => ({ provider, available: true, active: 0, limit: 1, reason: null, ...overrides[provider] }));

test("fallback and escalation carry distinct, recorded reasons", () => {
  const primary = selectRoute({ task: task(), ...routes, providers: available() });
  assert.equal(primary.decision, "primary");
  assert.equal(primary.fallbackReason, null);
  assert.equal(primary.escalationReason, null);
  assert.equal(primary.quotaDomain, "openai:chatgpt-subscription");

  const fallback = selectRoute({
    task: task(), ...routes, providers: available({ codex: { available: false, reason: "cooldown after quota" } }),
  });
  assert.equal(fallback.decision, "provider_fallback");
  assert.equal(fallback.chosen?.adapter, "claude");
  assert.match(fallback.fallbackReason ?? "", /codex \(cooldown after quota\)/);
  assert.equal(fallback.escalationReason, null);

  const escalated = selectRoute({ task: task({ changeRisk: "high" }), ...routes, providers: available() });
  assert.equal(escalated.decision, "capability_escalation");
  assert.equal(escalated.fallbackReason, null);
  assert.match(escalated.escalationReason ?? "", /small_implementation escalated to complex_coding/);
  assert.equal(escalated.chosen?.effort, "high");
});

test("with the shipped registry an unprobed Codex route is skipped and Claude carries the work", () => {
  const selection = selectRoute({ task: task(), adapters, providers: available() });
  assert.equal(selection.chosen?.adapter, "claude");
  assert.equal(selection.chosen?.effort, "medium");
  assert.equal(selection.decision, "provider_fallback");
  assert.match(selection.fallbackReason ?? "", /entitlement is unknown/);
});

test("RTE-03: a busy preferred route waits unless capacity fallback is explicitly allowed", () => {
  const busy = available({ codex: { active: 1, limit: 1 } });
  const waiting = selectRoute({ task: task(), ...routes, providers: busy, capacityFallback: "wait" });
  assert.equal(waiting.chosen, null);
  assert.equal(waiting.decision, "capacity_wait");

  const allowed = selectRoute({ task: task(), ...routes, providers: busy, capacityFallback: "allow" });
  assert.equal(allowed.chosen?.adapter, "claude");
  assert.equal(allowed.decision, "capacity_fallback");
  assert.match(allowed.fallbackReason ?? "", /Capacity fallback: codex at configured concurrency/);
});

test("RTE-04: an exhausted quota domain excludes every route inside it", () => {
  const shared: CapabilityRegistry = {
    version: "shared-account",
    entries: VERIFIED_REGISTRY.entries.map((entry) => ({ ...entry, quotaDomain: "one-account" })),
  };
  const selection = selectRoute({
    task: task(), adapters, providers: available(), capabilityRegistry: shared, excludedQuotaDomains: new Set(["one-account"]),
  });
  assert.equal(selection.chosen, null);
  assert.equal(selection.decision, "no_route");
  assert.ok(selection.rejected.every((item) => /quota domain one-account is exhausted/.test(item.reason)));
});

test("a policy route with an unsupported effort is rejected as ineligible, not launched", () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.routes.small_implementation = [{ adapter: "codex", model: CODEX_MODEL, effort: "max", reason: "bad route" }];
  const selection = selectRoute({ task: task(), ...routes, providers: available(), policy });
  assert.equal(selection.chosen, null);
  assert.equal(selection.decision, "no_route");
  assert.match(selection.reason, /effort max is unsupported/);
});

test("curated routing overrides must be eligible in the capability registry", () => {
  const records = new Records(new Store(":memory:"));
  const project = records.createProject({ name: "cfg", repoPath: "/tmp/cfg", projectType: "personal", reviewChoice: "off" });
  const config = projectConfigSnapshot(project);
  config.routingOverrides = { small_implementation: { adapter: "codex", model: CODEX_MODEL, effort: "max" } };
  assert.ok(validateProjectConfig(config).some((error) => /ineligible in mabs\.capabilities\.v3/.test(error)));
  config.routingOverrides = { small_implementation: { adapter: "claude", model: "claude-sonnet-5", effort: null } };
  assert.ok(validateProjectConfig(config).some((error) => /names no effort/.test(error)), "an override cannot inherit a default effort");
  records.store.close();
});

// ---------------------------------------------------------------------------
// controller integration

function controllerSetup(t: TestContext) {
  const root = tempRoot(t, "mabs-routing-controller-");
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "initial\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-q", "-m", "init"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  const project = records.createProject({
    name: "routing", repoPath: repo, projectType: "personal", reviewChoice: "off",
    reviewPolicy: { mode: "none", skipTaskClasses: [] },
  });
  const created = records.createTask({
    projectId: project.id, title: "route", objective: "change value", acceptanceCriteria: ["changed"],
    taskClass: "small_implementation",
  });
  return { records, task: created };
}

test("controller passes the exact route effort to the adapter and records requested/effective provenance", async (t) => {
  const { records, task: created } = controllerSetup(t);
  const codex = new StubAdapter("codex");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", defaultEffort: "low", workerLimit: 1,
  });
  await controller.tick();
  await controller.stop();
  assert.equal(codex.starts.length, 1);
  assert.equal(codex.starts[0]?.effort, "low");
  assert.deepEqual(codex.starts[0]?.delegation, { mode: "disabled" });
  const attempt = records.listAttempts(created.id)[0];
  assert.equal(attempt?.requestedEffort, "low");
  assert.equal(attempt?.configuredEffort, "low");
  assert.equal(attempt?.reportedEffort, null, "neither harness reports effort; it stays unknown");
  const [route] = records.routingForTask(created.id);
  assert.equal(route?.capability_registry_version, "mabs.capabilities.v3");
  assert.equal(route?.quota_domain_id, "openai:chatgpt-subscription");
  assert.deepEqual(route?.effective_selection, { adapter: "codex", model: CODEX_MODEL, effort: "low", delegation: "disabled" });
  assert.ok(Array.isArray(route?.eligibility_evidence));
});

test("an ineligible operator override blocks as CONFIG with zero worker launches", async (t) => {
  const { records, task: created } = controllerSetup(t);
  const codex = new StubAdapter("codex");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", defaultEffort: "max", workerLimit: 1,
  });
  await controller.tick();
  await controller.stop();
  assert.equal(codex.starts.length, 0);
  assert.equal(records.listAttempts(created.id).length, 0);
  const current = records.getTask(created.id);
  assert.equal(current?.state, "BLOCKED");
  assert.equal(current?.failureClass, "CONFIG");
  assert.match(current?.blockedReason ?? "", /effort max is unsupported/);
});

test("RTE-05/RTE-06: reported settings and child-agent evidence stay distinct from requests", async (t) => {
  const fake = fakeHarnesses(t);
  const cwd = tempRoot(t, "mabs-observed-");
  const claude = await launchClaude({ cwd, prompt: "p", model: "claude-opus-5", effort: "high", timeoutMs: 10_000, evidencePath: join(cwd, "c.log") });
  assert.equal(claude.reportedModel, "claude-sonnet-5", "the provider's report is kept even when it differs from the request");
  assert.deepEqual(claude.delegation, { spawned: 0, source: "claude.subagent_stats" });
  const codex = await launchCodex({ cwd, prompt: "p", model: CODEX_MODEL, effort: "high", timeoutMs: 10_000, evidencePath: join(cwd, "x.log") });
  assert.equal(codex.reportedModel, null);
  assert.deepEqual(codex.delegation, { spawned: null, source: "unobservable" }, "no zero is claimed without evidence");
  assert.equal(fake.invocations().length, 2);
});

// ---------------------------------------------------------------------------
// REC-06: the crash window between OS launch and the durable PID write

test("REC-06: a launch with no durable PID is identified by marker or process table, never presumed lost", async (t) => {
  const dir = tempRoot(t, "mabs-launch-marker-");
  const completionPath = join(dir, "completion.json");
  const spec = join(dir, "launch.json");
  const handle = { attemptId: "att_1", pid: null, sessionId: null, completionPath };
  const adapter = new HarnessAdapter("codex", VERIFIED_REGISTRY);
  assert.equal(await adapter.status(handle), "lost", "nothing was ever launched");

  writeFileSync(spec, "{}");
  assert.equal(await adapter.status(handle), "launching", "inside the grace window the wrapper may not have marked itself yet");

  const wrapper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", spec], { stdio: "ignore" });
  t.after(() => wrapper.kill("SIGKILL"));
  await new Promise((resolvePromise) => wrapper.once("spawn", resolvePromise));
  const old = new Date(Date.now() - 60_000);
  utimesSync(spec, old, old);
  assert.equal(await adapter.status(handle), "running", "a live process naming the specification is found without a PID");
  assert.equal(adapter.recoverHandle(handle).pid, wrapper.pid);

  wrapper.kill("SIGKILL");
  await new Promise((resolvePromise) => wrapper.once("exit", resolvePromise));
  writeFileSync(join(dir, START_MARKER_FILE), JSON.stringify({ attemptId: "att_other", pid: process.pid }));
  assert.equal(await adapter.status(handle), "lost", "a marker for another attempt is ignored; past grace with no process nothing ran");
  // PID reuse: the marker names a live process that is not this launch's wrapper.
  writeFileSync(join(dir, START_MARKER_FILE), JSON.stringify({ attemptId: "att_1", pid: process.pid }));
  assert.equal(await adapter.status(handle), "lost", "a live PID that does not name the launch specification is not the worker");
});

test("REC-06/PAR-11: recovery adopts and signals only the process whose start identity still matches", async (t) => {
  const dir = tempRoot(t, "mabs-identity-");
  const completionPath = join(dir, "completion.json");
  const spec = join(dir, "launch.json");
  writeFileSync(spec, "{}");
  const wrapper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", spec], { stdio: "ignore", detached: true });
  t.after(() => { try { process.kill(-(wrapper.pid as number), "SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolvePromise) => wrapper.once("spawn", resolvePromise));
  const pid = wrapper.pid as number;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const adapter = new HarnessAdapter("codex", VERIFIED_REGISTRY);
  const handle = { attemptId: "att_1", pid, sessionId: null, completionPath };

  writeFileSync(join(dir, START_MARKER_FILE), JSON.stringify({ attemptId: "att_1", pid, startTicks, bootId }));
  assert.equal(await adapter.status(handle), "running", "matching PID, start time, boot, and argv is the worker");

  // The recorded identity belongs to an earlier process that held this PID.
  writeFileSync(join(dir, START_MARKER_FILE), JSON.stringify({ attemptId: "att_1", pid, startTicks: String(Number(startTicks) - 1), bootId }));
  assert.equal(await adapter.status(handle), "lost", "a reused PID is never adopted");
  await adapter.cancel(handle);
  assert.doesNotThrow(() => process.kill(pid, 0), "cancel never signals a process whose identity does not match");

  writeFileSync(join(dir, START_MARKER_FILE), JSON.stringify({ attemptId: "att_1", pid, startTicks, bootId: "another-boot" }));
  assert.equal(await adapter.status(handle), "lost", "a PID from a previous boot is never ours");

  writeFileSync(join(dir, START_MARKER_FILE), JSON.stringify({ attemptId: "att_1", pid, startTicks, bootId }));
  const exited = new Promise((resolvePromise) => wrapper.once("exit", resolvePromise));
  await adapter.cancel(handle);
  await exited;
  assert.equal(await adapter.status(handle), "lost");
});

test("PAR-11: a gate job whose PID was reused is lost, not running", async (t) => {
  const dir = tempRoot(t, "mabs-gate-identity-");
  const handle = {
    jobId: "job_1", specPath: join(dir, "spec.json"), markerPath: join(dir, "marker.json"), completionPath: join(dir, "completion.json"),
  } as Parameters<typeof gateJobStatus>[0];
  writeFileSync(handle.specPath, "{}");
  writeFileSync(handle.markerPath, JSON.stringify({ jobId: "job_1", pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(gateJobStatus(handle), "lost", "the test runner is alive but is not this gate job");
  const job = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", handle.specPath], { stdio: "ignore" });
  t.after(() => job.kill("SIGKILL"));
  await new Promise((resolvePromise) => job.once("spawn", resolvePromise));
  writeFileSync(handle.markerPath, JSON.stringify({ jobId: "job_1", pid: job.pid }));
  assert.equal(gateJobStatus(handle), "running");
});

test("REC-06: a worker launched just before a controller crash is adopted on restart and never relaunched", async (t) => {
  const fake = fakeHarnesses(t, { delayMs: 2_500 });
  const { records, task: created } = controllerSetup(t);
  const options = () => ({
    capabilityRegistry: VERIFIED_REGISTRY, defaultAdapter: "codex" as const, workerLimit: 1,
    adapters: new Map<string, WorkerAdapter>([["codex", new HarnessAdapter("codex", VERIFIED_REGISTRY)]]),
  });
  // The crash: the OS launch succeeded but neither the PID nor the stage's
  // launch start reached the database before the controller died.
  const setAttemptProcess = records.setAttemptProcess.bind(records);
  const recordLaunchStarted = records.recordLaunchStarted.bind(records);
  records.setAttemptProcess = () => {};
  records.recordLaunchStarted = ((stageId, token, handle) =>
    handle?.attemptId ? records.getStageRun(stageId) : recordLaunchStarted(stageId, token, handle)) as Records["recordLaunchStarted"];
  const first = new Controller(records, options());
  await first.tick();
  await first.stop();
  records.setAttemptProcess = setAttemptProcess;
  records.recordLaunchStarted = recordLaunchStarted;

  const [launched] = records.listAttempts(created.id);
  assert.equal(launched?.state, "running");
  assert.equal(launched?.pid, null, "the crash kept the PID out of the database");
  const activeLeases = () => records.store.all("SELECT * FROM admission_leases WHERE status = 'active'").length;
  assert.equal(activeLeases(), 1);

  const restarted = new Controller(records, options());
  const deadline = Date.now() + 5_000;
  while (records.getAttempt(launched.id)?.pid === null && Date.now() < deadline) {
    await restarted.tick();
    assert.equal(records.getAttempt(launched.id)?.state, "running", "the live worker is never declared lost");
    assert.equal(activeLeases(), 1, "its admission lease is never released while it runs");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const adopted = records.getAttempt(launched.id);
  assert.ok(adopted?.pid, "the restarted controller adopted the running wrapper");
  assert.equal(records.getStageRun(adopted.stageRunId as string)?.attemptId, adopted.id, "its stage is bound to the adopted attempt");
  assert.equal(records.listEventsOfKind(created.id, "attempt.process_adopted").length, 1);

  const finished = Date.now() + 10_000;
  while (records.getAttempt(launched.id)?.state === "running" && Date.now() < finished) {
    await restarted.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  await restarted.stop();
  assert.notEqual(records.getAttempt(launched.id)?.state, "running", "the adopted worker was collected");
  assert.equal(fake.invocations().length, 1, "exactly one provider process ever ran");
  assert.equal(records.listAttempts(created.id).filter((attempt) => attempt.kind === "initial").length, 1);
});

test("REC-06: a retry is refused while an attempt is unresolved", (t) => {
  const { records, task: created } = controllerSetup(t);
  records.startAttempt({ taskId: created.id, launchId: "lnc_x", kind: "initial", adapter: "codex", worktreePath: "/w" } as Parameters<Records["startAttempt"]>[0]);
  records.transition(created.id, "BLOCKED", { blocked_reason: "ambiguous launch", failure_class: "INFRA" });
  assert.throws(() => records.retryTask(created.id, records.getTask(created.id)?.recordVersion as number), /unresolved attempt/);
});
