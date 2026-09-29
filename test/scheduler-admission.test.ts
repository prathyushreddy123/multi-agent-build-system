import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { ADMISSION_PENDING_PREFIX, Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import {
  AdaptiveConcurrency,
  canonicalRepoKey,
  evaluateAdmission,
  fairOrder,
  type ActiveWork,
  type AdmissionRequest,
  type SchedulingLimits,
} from "../src/scheduling/admission.ts";
import { Store } from "../src/store/db.ts";
import { Records, type GateSpec, type Task } from "../src/store/records.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

const limits = (overrides: Partial<SchedulingLimits> = {}): SchedulingLimits => ({
  modelWorkers: 2, providerLimits: { codex: 1, claude: 1 }, perProjectTasks: 2, activeProjects: 2, gateJobs: 1, childAgents: 0, ...overrides,
});
const work = (overrides: Partial<ActiveWork>): ActiveWork => ({
  taskId: "t-active", projectId: "p1", repoKey: "/repo", kind: "model", provider: "codex",
  executionMode: "parallel", writeScope: ["src/a"], resources: [], ...overrides,
});
const request = (overrides: Partial<AdmissionRequest>): AdmissionRequest => ({
  taskId: "t-new", projectId: "p1", repoKey: "/repo", kind: "model", provider: "claude",
  executionMode: "parallel", writeScope: ["src/b"], resources: [], ...overrides,
});

// ---------------------------------------------------------------------------
// pure admission

test("PAR-02: same-repository work with overlapping write scope is serialized; disjoint scope overlaps", () => {
  assert.equal(evaluateAdmission(request({}), [work({})], limits()).admitted, true);
  const overlapping = evaluateAdmission(request({ writeScope: ["src/a/deep"] }), [work({})], limits());
  assert.equal(overlapping.admitted, false);
  assert.match(overlapping.reasons.join(), /write scope overlaps t-active/);
  const exclusive = evaluateAdmission(request({ executionMode: "sequential" }), [work({})], limits());
  assert.match(exclusive.reasons.join(), /repository is held by t-active/);
});

test("PAR-03: disjoint files that share an exclusive named resource are serialized", () => {
  const denied = evaluateAdmission(request({ resources: ["port:3000"] }), [work({ resources: ["port:3000"] })], limits());
  assert.equal(denied.admitted, false);
  assert.match(denied.reasons.join(), /resource port:3000 is held by t-active/);
  assert.equal(evaluateAdmission(request({ resources: ["port:3001"] }), [work({ resources: ["port:3000"] })], limits()).admitted, true);
});

test("PAR-04: two project paths that resolve to one repository share its lock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-canonical-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "repo"));
  symlinkSync(join(root, "repo"), join(root, "alias"));
  assert.equal(canonicalRepoKey(join(root, "alias")), canonicalRepoKey(join(root, "repo")));
  const decision = evaluateAdmission(
    request({ projectId: "p2", repoKey: canonicalRepoKey(join(root, "alias")), executionMode: "single" }),
    [work({ repoKey: canonicalRepoKey(join(root, "repo")), executionMode: "single" })],
    limits(),
  );
  assert.equal(decision.admitted, false);
});

test("PAR-05/PAR-06: model, provider, project, active-project, and gate caps are each enforced", () => {
  assert.match(evaluateAdmission(request({}), [work({}), work({ taskId: "t2", provider: "claude", writeScope: ["x"] })], limits()).reasons.join(),
    /model worker cap 2 reached/);
  assert.match(evaluateAdmission(request({ provider: "codex" }), [work({})], limits()).reasons.join(), /provider codex cap 1 reached/);
  assert.match(evaluateAdmission(request({ projectId: "p3", repoKey: "/r3" }),
    [work({ projectId: "p1", repoKey: "/r1", kind: null }), work({ taskId: "t2", projectId: "p2", repoKey: "/r2", kind: null })],
    limits({ modelWorkers: 5 })).reasons.join(), /active project cap 2 reached/);
  assert.match(evaluateAdmission(request({ repoKey: "/other" }),
    [work({ kind: null }), work({ taskId: "t2", kind: null, writeScope: ["y"] })], limits({ modelWorkers: 5 })).reasons.join(), /project task cap 2 reached/);
  const gate = evaluateAdmission(request({ kind: "gate", provider: null, repoKey: "/other" }), [work({ kind: "gate", provider: null, repoKey: "/r" })], limits());
  assert.match(gate.reasons.join(), /check job cap 1 reached/);
  // Checks do not consume model-worker capacity, and model work does not consume check capacity.
  assert.equal(evaluateAdmission(request({ kind: "gate", provider: null, projectId: "p9", repoKey: "/other" }),
    [work({ repoKey: "/r" }), work({ taskId: "t2", provider: "claude", repoKey: "/r", writeScope: ["q"] })], limits({ activeProjects: 3 })).admitted, true);
});

test("a task's own repair or check is not counted against its project slot", () => {
  const own = work({ taskId: "t-new", kind: null, writeScope: ["src/b"] });
  const decision = evaluateAdmission(request({}), [own, work({ taskId: "t2", kind: null, writeScope: ["z"] })], limits({ perProjectTasks: 2 }));
  assert.equal(decision.admitted, true, decision.reasons.join());
});

test("PAR-08: fairness ages starving projects ahead of heavily served ones and interleaves", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const candidates = [
    { taskId: "a1", projectId: "A", priority: 100, readySince: at(1) },
    { taskId: "a2", projectId: "A", priority: 100, readySince: at(2) },
    { taskId: "b1", projectId: "B", priority: 100, readySince: at(1) },
  ];
  const served = new Map([["A", 10], ["B", 0]]);
  assert.deepEqual(fairOrder(candidates, served, now).map((item) => item.taskId), ["b1", "a2", "a1"]);
  // B has been waiting long enough that aging outweighs A's lower service.
  const aged = [...candidates.slice(0, 2), { taskId: "b1", projectId: "B", priority: 100, readySince: at(120) }];
  assert.deepEqual(fairOrder(aged, new Map([["A", 0], ["B", 5]]), now).map((item) => item.taskId)[0], "b1");
});

test("PAR-09: pressure lowers the adaptive target immediately; it rises only after a healthy streak", () => {
  const adaptive = new AdaptiveConcurrency(3, { raiseAfterHealthyTicks: 3 });
  assert.equal(adaptive.observe(true), 2);
  assert.equal(adaptive.observe(true), 1);
  assert.equal(adaptive.observe(true), 1, "never below the floor");
  assert.equal(adaptive.observe(false), 1);
  assert.equal(adaptive.observe(false), 1);
  assert.equal(adaptive.observe(false), 2, "one step up after three healthy ticks");
  assert.equal(adaptive.observe(true), 1, "hysteresis: a single pressure tick lowers again");
  for (let tick = 0; tick < 20; tick += 1) adaptive.observe(false);
  assert.equal(adaptive.target, 3, "never above the approved ceiling");
});

// ---------------------------------------------------------------------------
// controller

/** Workers stay running until released, so overlap and peak concurrency are observable. */
class HoldingAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name: string;
  readonly started: { attemptId: string; taskTitle: string; cwd: string }[] = [];
  private readonly live = new Set<string>();
  private readonly released = new Set<string>();
  peak = 0;
  autoRelease = false;
  readonly edit: (title: string, cwd: string) => void;

  constructor(name: string, edit: (title: string, cwd: string) => void = (_title, cwd) => writeFileSync(join(cwd, "value.txt"), `${Math.random()}\n`)) {
    this.name = name;
    this.edit = edit;
  }

  static shared: Set<string> = new Set();
  static sharedPeak = 0;

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    const title = /"objective":"([^"]*)"/.exec(input.prompt)?.[1] ?? "";
    this.started.push({ attemptId: input.attemptId, taskTitle: title, cwd: input.cwd });
    this.edit(title, input.cwd);
    this.live.add(input.attemptId);
    HoldingAdapter.shared.add(input.attemptId);
    this.peak = Math.max(this.peak, this.live.size);
    HoldingAdapter.sharedPeak = Math.max(HoldingAdapter.sharedPeak, HoldingAdapter.shared.size);
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  release(attemptId?: string): void {
    for (const id of attemptId ? [attemptId] : [...this.live]) this.released.add(id);
  }
  async status(handle: AdapterHandle): Promise<"running" | "completed"> {
    if (!this.autoRelease && !this.released.has(handle.attemptId)) return "running";
    this.live.delete(handle.attemptId);
    HoldingAdapter.shared.delete(handle.attemptId);
    return "completed";
  }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
        apiEquivalentEstimateUsd: null, sessionId: null, raw: "", stderr: "" },
      validation: validateWorkerOutput({
        outcome: "completed", reason: "done", summary: "done",
        evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null }, addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd });
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-scheduler-"));
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  HoldingAdapter.shared = new Set();
  HoldingAdapter.sharedPeak = 0;
  t.after(() => {
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
    rmSync(root, { recursive: true, force: true });
  });
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "value.txt"), "initial\n");
    git(path, "init", "-q", "-b", "main");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "init");
    return path;
  };
  const project = (name: string, repoPath: string, checkCommands: GateSpec[] = []) => records.createProject({
    name, repoPath, projectType: "personal", reviewChoice: "off", reviewPolicy: { mode: "none", skipTaskClasses: [] }, checkCommands,
  });
  return { root, records, repo, project };
}

const running = (records: Records) => records.listRunningAttempts().length;

async function tickUntil(controller: Controller, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("PAR-01: two independent tasks overlap under two slots, in disjoint worktrees", async (t) => {
  const { records, repo, project } = fixture(t);
  const one = project("one", repo("one"));
  const two = project("two", repo("two"));
  const a = records.createTask({ projectId: one.id, title: "a", objective: "task a", taskClass: "small_implementation" });
  const b = records.createTask({ projectId: two.id, title: "b", objective: "task b", taskClass: "small_implementation" });
  const codex = new HoldingAdapter("codex");
  const claude = new HoldingAdapter("claude");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]), defaultAdapter: "codex",
    workerLimit: 2, providerLimits: { codex: 1, claude: 1 },
  });
  await controller.tick();
  assert.equal(running(records), 2, "both independent tasks run at once");
  const paths = [records.getTask(a.id)?.worktreePath, records.getTask(b.id)?.worktreePath];
  assert.notEqual(paths[0], paths[1]);
  codex.release(); claude.release();
  await tickUntil(controller, () => records.getTask(a.id)?.state === "DONE" && records.getTask(b.id)?.state === "DONE");
  await controller.stop();
  assert.equal(HoldingAdapter.sharedPeak, 2);
});

test("PAR-05: a repair triggered by an asynchronous check waits for admission instead of exceeding the cap", async (t) => {
  const { records, repo, project } = fixture(t);
  const failOnce: GateSpec = {
    name: "unit", required: true,
    command: [process.execPath, "-e",
      // Slow enough that the other task is admitted while this check runs.
      "setTimeout(()=>{const fs=require('fs');if(fs.readFileSync('value.txt','utf8').startsWith('repaired'))process.exit(0);console.error('AssertionError [ERR_ASSERTION]: value mismatch');process.exit(1)},600)"],
  };
  const first = project("first", repo("first"), [failOnce]);
  const second = project("second", repo("second"));
  const a = records.createTask({ projectId: first.id, title: "a", objective: "task a", taskClass: "small_implementation", repairLimit: 1 });
  const codex = new HoldingAdapter("codex", (title, cwd) => {
    writeFileSync(join(cwd, "value.txt"), codex.started.filter((item) => item.taskTitle === title).length > 1 ? "repaired\n" : "first\n");
  });
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await controller.tick();
  const b = records.createTask({ projectId: second.id, title: "b", objective: "task b", taskClass: "small_implementation" });
  codex.release();
  // A's implementation finishes and its check runs; meanwhile B takes the only model slot.
  await controller.tick();
  assert.equal(records.getTask(b.id)?.state, "RUNNING", "B was admitted while A only held a check");
  await tickUntil(controller, () => records.getTask(a.id)?.blockedReason?.startsWith(ADMISSION_PENDING_PREFIX) === true, 10_000);
  assert.ok(records.getTask(a.id)?.blockedReason?.startsWith(`${ADMISSION_PENDING_PREFIX} repair`),
    `${records.getTask(a.id)?.state}: ${records.getTask(a.id)?.blockedReason}; b=${records.getTask(b.id)?.state}`);
  assert.equal(running(records), 1, "the cap held: only B's worker runs");
  assert.ok(records.listEventsOfKind(a.id, "admission.deferred").length === 1);
  codex.release();
  codex.autoRelease = true;
  await tickUntil(controller, () => records.getTask(a.id)?.state === "DONE" && records.getTask(b.id)?.state === "DONE");
  await controller.stop();
  assert.equal(records.getTask(a.id)?.state, "DONE", records.getTask(a.id)?.blockedReason ?? "");
  assert.equal(records.getTask(a.id)?.repairsUsed, 1, "resuming did not spend a second repair");
  assert.equal(codex.peak, 1, "never more than one model worker");
});

const activeChecks = (records: Records) =>
  records.listActiveStageRuns().filter((stage) => stage.stage === "check" && ["launching", "running"].includes(stage.state)).length;

test("PAR-05: an operational check recovery waits for the gate cap instead of launching past it", async (t) => {
  const { root, records, repo, project } = fixture(t);
  const flag = join(root, "tool-installed");
  // Fails once as a missing tool (an environment cause, never a code repair), then passes.
  const flaky: GateSpec = {
    name: "env", required: true,
    command: [process.execPath, "-e",
      `const fs=require('fs');if(fs.existsSync(${JSON.stringify(flag)}))process.exit(0);console.error('sh: 1: lint-tool: command not found');process.exit(127)`],
  };
  const slow: GateSpec = { name: "slow", required: true, command: [process.execPath, "-e", "setTimeout(()=>process.exit(0),1500)"] };
  const first = project("first", repo("first"), [flaky]);
  const second = project("second", repo("second"), [slow]);
  const codex = new HoldingAdapter("codex");
  codex.autoRelease = true;
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 2, gateLimit: 1,
    providerLimits: { codex: 2 },
  });
  const a = records.createTask({ projectId: first.id, title: "a", objective: "task a", taskClass: "small_implementation" });
  await tickUntil(controller, () => records.getTask(a.id)?.state === "BLOCKED", 10_000);
  assert.equal(records.getTask(a.id)?.state, "BLOCKED", records.getTask(a.id)?.blockedReason ?? "");
  assert.equal(records.getTask(a.id)?.repairsUsed, 0, "an environment failure spends no code repair");
  assert.ok(records.getContinuation(a.id).openObligations.some((item) => item.kind === "gate_failure" && item.sourceGateId !== null));

  const b = records.createTask({ projectId: second.id, title: "b", objective: "task b", taskClass: "small_implementation" });
  await tickUntil(controller, () => activeChecks(records) === 1, 10_000);
  assert.equal(activeChecks(records), 1, "B's slow check holds the only gate slot");

  writeFileSync(flag, "");
  records.retryTask(a.id, records.getTask(a.id)?.recordVersion as number);
  const startedBefore = codex.started.length;
  for (let tick = 0; tick < 3; tick += 1) {
    await controller.tick();
    assert.ok(activeChecks(records) <= 1, "the gate cap holds during recovery");
  }
  if (activeChecks(records) === 1 && records.getTask(b.id)?.state !== "DONE") {
    assert.equal(records.getTask(a.id)?.state, "READY", "recovery waits in READY while the gate cap is full");
  }
  assert.equal(codex.started.length, startedBefore, "a waiting recovery never falls through to a new model attempt");

  await tickUntil(controller, () => records.getTask(a.id)?.state === "DONE" && records.getTask(b.id)?.state === "DONE", 15_000);
  await controller.stop();
  assert.equal(records.getTask(a.id)?.state, "DONE", records.getTask(a.id)?.blockedReason ?? "");
  assert.equal(records.getTask(b.id)?.state, "DONE", records.getTask(b.id)?.blockedReason ?? "");
});

test("PAR-07: a blocked first task does not starve compatible work behind it", async (t) => {
  const { records, repo, project } = fixture(t);
  const other = project("other", repo("other"));
  const main = project("main", repo("main"));
  const holder = records.createTask({ projectId: other.id, title: "h", objective: "holds the port", resources: ["port:3000"], taskClass: "small_implementation" });
  const codex = new HoldingAdapter("codex");
  const claude = new HoldingAdapter("claude");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]), defaultAdapter: "codex",
    workerLimit: 2, providerLimits: { codex: 1, claude: 1 },
  });
  await controller.tick();
  assert.equal(records.getTask(holder.id)?.state, "RUNNING");
  const blocked = records.createTask({ projectId: main.id, title: "first", objective: "needs the port", resources: ["port:3000"], priority: 1,
    executionMode: "parallel", allowedScope: ["a"], taskClass: "small_implementation" });
  const compatible = records.createTask({ projectId: main.id, title: "second", objective: "independent", priority: 2,
    executionMode: "parallel", allowedScope: ["b"], taskClass: "small_implementation" });
  await controller.tick();
  await controller.stop();
  assert.equal(records.getTask(blocked.id)?.state, "READY", "the port holder blocks it");
  assert.equal(records.getTask(compatible.id)?.state, "RUNNING", "the compatible task behind it is admitted");
  const explanation = controller.admissionExplanations.get(blocked.id);
  assert.match(explanation?.reasons.join() ?? "", /resource port:3000 is held by/);
});

test("PAR-04: projects registered on one repository never run exclusive work concurrently", async (t) => {
  const { root, records, repo, project } = fixture(t);
  const path = repo("shared");
  symlinkSync(path, join(root, "alias"));
  const first = project("first", path);
  const second = project("second", join(root, "alias"));
  const a = records.createTask({ projectId: first.id, title: "a", objective: "a", taskClass: "small_implementation" });
  const b = records.createTask({ projectId: second.id, title: "b", objective: "b", taskClass: "small_implementation" });
  const codex = new HoldingAdapter("codex");
  const claude = new HoldingAdapter("claude");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]), defaultAdapter: "codex",
    workerLimit: 2, providerLimits: { codex: 1, claude: 1 },
  });
  await controller.tick();
  await controller.tick();
  const states = [records.getTask(a.id)?.state, records.getTask(b.id)?.state].sort();
  assert.deepEqual(states, ["READY", "RUNNING"], "the second project waits on the shared repository lock");
  await controller.stop();
});

test("PAR-11: a restarted controller derives capacity from durable state and starts no duplicate", async (t) => {
  const { records, repo, project } = fixture(t);
  const p = project("restart", repo("restart"));
  const a = records.createTask({ projectId: p.id, title: "a", objective: "a", taskClass: "small_implementation" });
  const b = records.createTask({ projectId: p.id, title: "b", objective: "b", taskClass: "small_implementation" });
  const codex = new HoldingAdapter("codex");
  const first = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1 });
  await first.tick();
  await first.stop();
  assert.equal(running(records), 1);
  const restarted = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1 });
  await restarted.tick();
  await restarted.tick();
  assert.equal(codex.started.length, 1, "no second worker and no duplicate of the first");
  assert.equal([records.getTask(a.id)?.state, records.getTask(b.id)?.state].filter((state) => state === "RUNNING").length, 1);
  codex.autoRelease = true;
  await tickUntil(restarted, () => records.getTask(a.id)?.state === "DONE" && records.getTask(b.id)?.state === "DONE");
  await restarted.stop();
  assert.equal(codex.peak, 1);
});

test("PAR-10: branches that pass alone but disagree at the join fail integration there", async (t) => {
  const { records, repo, project } = fixture(t);
  const integration: GateSpec = {
    name: "integration", required: true,
    command: [process.execPath, "-e", [
      "const fs=require('fs');",
      "if(!fs.existsSync('api.js')||!fs.existsSync('client.js'))process.exit(0);",
      "const r=require('./client.js');",
      "if(r.result!==3){console.error('AssertionError [ERR_ASSERTION]: interface mismatch: expected 3, got '+r.result);process.exit(1)}",
    ].join("")],
  };
  const p = project("join", repo("join"), [integration]);
  const codex = new HoldingAdapter("codex", (title, cwd) => {
    if (title === "provide api") writeFileSync(join(cwd, "api.js"), "exports.total = (a, b) => a + b;\n");
    if (title === "consume api") writeFileSync(join(cwd, "client.js"), "exports.result = require('./api.js').total([1, 2]);\n");
  });
  codex.autoRelease = true;
  const api = records.createTask({ projectId: p.id, title: "api", objective: "provide api", executionMode: "parallel", allowedScope: ["api.js"], taskClass: "small_implementation" });
  const client = records.createTask({ projectId: p.id, title: "client", objective: "consume api", executionMode: "parallel", allowedScope: ["client.js"], taskClass: "small_implementation" });
  const join_ = records.createTask({ projectId: p.id, title: "join", objective: "integrate", taskClass: "mechanical", executionMode: "single",
    executionReason: "Run the integration check on the combined revision.", dependsOn: [api.id, client.id], repairLimit: 0 });
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1 });
  await tickUntil(controller, () => ["DONE", "FAILED", "BLOCKED"].includes(records.getTask(join_.id)?.state ?? ""));
  await controller.stop();
  assert.equal(records.getTask(api.id)?.state, "DONE");
  assert.equal(records.getTask(client.id)?.state, "DONE", "each branch passed its own checks");
  const joined = records.getTask(join_.id);
  assert.notEqual(joined?.state, "DONE", "branch approval is not inherited by the join");
  const gate = records.gatesForTask(join_.id).find((item) => item.name === "integration");
  assert.equal(gate?.status, "FAIL", `${joined?.state}: ${joined?.blockedReason}`);
});

test("the CLI default keeps one production model worker", async () => {
  const cli = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"));
  assert.match(cli, /workerLimit: numberOption\(args, "workers", 1\)/);
});

test("pure admission explains every denial", () => {
  const explanation = evaluateAdmission(request({ resources: ["port:1"] }), [work({ resources: ["port:1"] })], limits({ modelWorkers: 1 }));
  assert.equal(explanation.admitted, false);
  assert.deepEqual(explanation.limits.childAgents, 0);
  assert.ok(explanation.reasons.length >= 2);
  const _typed: Task["resources"] = ["port:1"];
});
