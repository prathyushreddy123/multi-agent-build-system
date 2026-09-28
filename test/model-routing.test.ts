import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HarnessAdapter } from "../src/adapters/harness.ts";
import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateProjectConfig, projectConfigSnapshot } from "../src/domain/config.ts";
import {
  DEFAULT_CAPABILITY_REGISTRY,
  evaluateCapability,
  type CapabilityRegistry,
} from "../src/routing/capabilities.ts";
import { DEFAULT_ROUTING_POLICY, selectRoute, type ProviderAvailability } from "../src/routing/router.ts";
import { Store } from "../src/store/db.ts";
import { Records, type Task } from "../src/store/records.ts";
import { claudeArgs, codexArgs, launchClaude, launchCodex } from "../src/verify/launch.ts";

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
function fakeHarnesses(t: TestContext) {
  const root = tempRoot(t, "mabs-fake-harness-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const codexConfig = join(home, ".codex", "config.toml");
  const claudeSettings = join(home, ".claude", "settings.json");
  writeFileSync(codexConfig, 'model = "global-default"\nmodel_reasoning_effort = "high"\n');
  writeFileSync(claudeSettings, JSON.stringify({ effortLevel: "high" }));
  const argvLog = join(root, "argv.jsonl");
  const script = (envelope: string) => `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ bin: require("node:path").basename(process.argv[1]), argv: process.argv.slice(2) }) + "\\n");
process.stdout.write(${JSON.stringify(envelope)});
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
    invocations: (): { bin: string; argv: string[] }[] => existsSync(argvLog)
      ? readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { bin: string; argv: string[] })
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

  const codex = await launchCodex({ cwd, prompt: "task", effort: "medium", timeoutMs: 10_000, evidencePath: join(cwd, "codex.log") });
  const claude = await launchClaude({
    cwd, prompt: "task", model: "claude-sonnet-5", effort: "low", timeoutMs: 10_000, evidencePath: join(cwd, "claude.log"),
  });

  const [codexCall, claudeCall] = fake.invocations();
  assert.equal(codexCall?.bin, "codex");
  assert.ok(flagValue(codexCall.argv, "-c").includes('model_reasoning_effort="medium"'));
  assert.ok(flagValue(codexCall.argv, "-c").includes("features.multi_agent=false"));
  assert.equal(claudeCall?.bin, "claude");
  assert.deepEqual(flagValue(claudeCall.argv, "--effort"), ["low"]);
  assert.deepEqual(flagValue(claudeCall.argv, "--model"), ["claude-sonnet-5"]);
  const disallowed = claudeCall.argv.slice(claudeCall.argv.indexOf("--disallowedTools") + 1);
  assert.ok(disallowed.includes("Agent"), "Claude's native child-agent tool is disallowed");

  assert.deepEqual(codex.applied, { model: null, effort: "medium", effortSource: "explicit", delegation: "disabled" });
  assert.deepEqual(claude.applied, { model: "claude-sonnet-5", effort: "low", effortSource: "explicit", delegation: "disabled" });
  assert.deepEqual(fake.globalHashes(), before, "global provider configuration is never edited");
  // Evidence records the command shape but not a second copy of the prompt.
  assert.match(readFileSync(join(cwd, "codex.log"), "utf8"), /<prompt 4 bytes>/);
});

test("RTE-01: an absent effort leaves the provider default in force and labels it unknown", () => {
  const args = codexArgs({ cwd: "/w", prompt: "p" }, "/w/last.txt");
  assert.equal(args.some((arg) => arg.startsWith("model_reasoning_effort")), false);
  assert.equal(claudeArgs({ prompt: "p" }).includes("--effort"), false);
  const evidence = evaluateCapability(DEFAULT_CAPABILITY_REGISTRY, { provider: "codex", model: null, effort: null }).evidence;
  assert.equal(evidence.eligible, true);
  assert.equal(evidence.effortSource, "provider_default_unknown");
});

test("RTE-02: unsupported effort or unknown model entitlement launches no provider process", async (t) => {
  const fake = fakeHarnesses(t);
  const cwd = tempRoot(t, "mabs-adapter-reject-");
  const adapter = new HarnessAdapter("codex");
  const launch = (model: string | null, effort: string | null): AdapterLaunch => ({
    attemptId: "att", cwd, prompt: "p", model, effort, timeoutMs: 1_000,
    evidencePath: join(cwd, "a", "worker.log"), completionPath: join(cwd, "a", "completion.json"),
  });
  await assert.rejects(adapter.start(launch(null, "max")), /effort max is unsupported/);
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
  const evidence = evaluateCapability(registry, { provider: "codex", model: null, effort: "high" }).evidence;
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
const available = (overrides: Partial<Record<string, Partial<ProviderAvailability>>> = {}): ProviderAvailability[] =>
  ["codex", "claude"].map((provider) => ({ provider, available: true, active: 0, limit: 1, reason: null, ...overrides[provider] }));

test("fallback and escalation carry distinct, recorded reasons", () => {
  const primary = selectRoute({ task: task(), adapters, providers: available() });
  assert.equal(primary.decision, "primary");
  assert.equal(primary.fallbackReason, null);
  assert.equal(primary.escalationReason, null);
  assert.equal(primary.quotaDomain, "openai:chatgpt-subscription");

  const fallback = selectRoute({
    task: task(), adapters, providers: available({ codex: { available: false, reason: "cooldown after quota" } }),
  });
  assert.equal(fallback.decision, "provider_fallback");
  assert.equal(fallback.chosen?.adapter, "claude");
  assert.match(fallback.fallbackReason ?? "", /codex \(cooldown after quota\)/);
  assert.equal(fallback.escalationReason, null);

  const escalated = selectRoute({ task: task({ changeRisk: "high" }), adapters, providers: available() });
  assert.equal(escalated.decision, "capability_escalation");
  assert.equal(escalated.fallbackReason, null);
  assert.match(escalated.escalationReason ?? "", /small_implementation escalated to complex_coding/);
  assert.equal(escalated.chosen?.effort, "high");
});

test("RTE-03: a busy preferred route waits unless capacity fallback is explicitly allowed", () => {
  const busy = available({ codex: { active: 1, limit: 1 } });
  const waiting = selectRoute({ task: task(), adapters, providers: busy, capacityFallback: "wait" });
  assert.equal(waiting.chosen, null);
  assert.equal(waiting.decision, "capacity_wait");

  const allowed = selectRoute({ task: task(), adapters, providers: busy, capacityFallback: "allow" });
  assert.equal(allowed.chosen?.adapter, "claude");
  assert.equal(allowed.decision, "capacity_fallback");
  assert.match(allowed.fallbackReason ?? "", /Capacity fallback: codex at configured concurrency/);
});

test("RTE-04: an exhausted quota domain excludes every route inside it", () => {
  const shared: CapabilityRegistry = {
    version: "shared-account",
    entries: DEFAULT_CAPABILITY_REGISTRY.entries.map((entry) => ({ ...entry, quotaDomain: "one-account" })),
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
  policy.routes.small_implementation = [{ adapter: "codex", model: null, effort: "max", reason: "bad route" }];
  const selection = selectRoute({ task: task(), adapters, providers: available(), policy });
  assert.equal(selection.chosen, null);
  assert.equal(selection.decision, "no_route");
  assert.match(selection.reason, /effort max is unsupported/);
});

test("curated routing overrides must be eligible in the capability registry", () => {
  const records = new Records(new Store(":memory:"));
  const project = records.createProject({ name: "cfg", repoPath: "/tmp/cfg", projectType: "personal", reviewChoice: "off" });
  const config = projectConfigSnapshot(project);
  config.routingOverrides = { small_implementation: { adapter: "codex", model: null, effort: "max" } };
  assert.ok(validateProjectConfig(config).some((error) => /ineligible in mabs\.capabilities\.v2/.test(error)));
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
  const controller = new Controller(records, {
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
  assert.equal(route?.capability_registry_version, "mabs.capabilities.v2");
  assert.equal(route?.quota_domain_id, "openai:chatgpt-subscription");
  assert.deepEqual(route?.effective_selection, { adapter: "codex", model: null, effort: "low", delegation: "disabled" });
  assert.ok(Array.isArray(route?.eligibility_evidence));
});

test("an ineligible operator override blocks as CONFIG with zero worker launches", async (t) => {
  const { records, task: created } = controllerSetup(t);
  const codex = new StubAdapter("codex");
  const controller = new Controller(records, {
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
  const claude = await launchClaude({ cwd, prompt: "p", model: "claude-opus-5", timeoutMs: 10_000, evidencePath: join(cwd, "c.log") });
  assert.equal(claude.reportedModel, "claude-sonnet-5", "the provider's report is kept even when it differs from the request");
  assert.deepEqual(claude.delegation, { spawned: 0, source: "claude.subagent_stats" });
  const codex = await launchCodex({ cwd, prompt: "p", timeoutMs: 10_000, evidencePath: join(cwd, "x.log") });
  assert.equal(codex.reportedModel, null);
  assert.deepEqual(codex.delegation, { spawned: null, source: "unobservable" }, "no zero is claimed without evidence");
  assert.equal(fake.invocations().length, 2);
});
