import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { applyExecutionPlan, validateExecutionPlan, type ExecutionPlan } from "../src/domain/plan.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";
import { integrateDependencyRevisions } from "../src/workspace/git.ts";

class Phase2Adapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  starts: string[] = [];
  failWithQuota = false;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input.attemptId);
    writeFileSync(input.completionPath, JSON.stringify({ complete: true }));
    if (!this.failWithQuota) writeFileSync(join(input.cwd, "value.txt"), `${this.name}\n`);
    return { attemptId: input.attemptId, pid: null, sessionId: `${this.name}-session`, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    if (this.failWithQuota) {
      this.failWithQuota = false;
      return {
        launch: {
          exitCode: 1, timedOut: false, durationMs: 1, finalMessage: "usage limit reached", reportedModel: null,
          usage: null, apiEquivalentEstimateUsd: null, sessionId: `${this.name}-session`, raw: "HTTP 429 usage limit reached", stderr: "",
        },
        validation: validateWorkerOutput(null),
        failureClass: "QUOTA",
        error: "HTTP 429 usage limit reached",
      };
    }
    return {
      launch: {
        exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null,
        usage: null, apiEquivalentEstimateUsd: null, sessionId: `${this.name}-session`, raw: "", stderr: "",
      },
      validation: validateWorkerOutput({
        outcome: "completed",
        reason: "implemented",
        summary: `Completed with ${this.name}.`,
        evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null },
        addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoAt(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "value.txt"), "initial\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-phase2-"));
  const previousState = process.env.MABS_STATE_DIR;
  const previousWorktrees = process.env.MABS_WORKTREE_ROOT;
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previousState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previousState;
    if (previousWorktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previousWorktrees;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, records };
}

test("execution-plan validation rejects cycles and overlapping parallel edits, then atomically applies a valid DAG", (t) => {
  const { records } = setup(t);
  const project = records.createProject({ name: "plan", repoPath: "/tmp/plan" });
  const cyclic: ExecutionPlan = {
    objective: "bad", mode: "parallel", reason: "test validation", tasks: [
      { key: "a", title: "a", objective: "a", acceptanceCriteria: [], dependsOn: ["b"], executionMode: "parallel", executionReason: "independent", allowedScope: ["src"] },
      { key: "b", title: "b", objective: "b", acceptanceCriteria: [], dependsOn: ["a"], executionMode: "parallel", executionReason: "independent", allowedScope: ["src"] },
      { key: "c", title: "c", objective: "c", acceptanceCriteria: [], executionMode: "parallel", executionReason: "claimed independent", allowedScope: ["src"] },
    ],
  };
  const malformed = validateExecutionPlan({} as ExecutionPlan);
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.includes("Plan tasks must be an array."));

  const invalid = validateExecutionPlan(cyclic);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("Dependency cycle")));
  assert.ok(invalid.errors.some((error) => error.includes("parallel edit scopes overlap")));
  assert.ok(invalid.errors.some((error) => error.includes("acceptance criterion")));

  const valid: ExecutionPlan = {
    objective: "two independent modules then integration", mode: "mixed", reason: "modules are disjoint before integration", tasks: [
      { key: "left", title: "left", objective: "left", acceptanceCriteria: ["left done"], executionMode: "parallel", executionReason: "disjoint module", allowedScope: ["src/left"] },
      { key: "right", title: "right", objective: "right", acceptanceCriteria: ["right done"], executionMode: "parallel", executionReason: "disjoint module", allowedScope: ["src/right"] },
      { key: "join", title: "join", objective: "integrate", acceptanceCriteria: ["integrated"], dependsOn: ["left", "right"], executionMode: "sequential", executionReason: "requires both outputs", allowedScope: ["src"] },
    ],
  };
  const created = applyExecutionPlan(records, project.id, valid);
  assert.equal(created.length, 3);
  assert.equal(records.dependenciesOf(created[2]?.id as string).length, 2);
  assert.equal(created[0]?.executionMode, "parallel");
});

test("downstream workspaces materialize completed dependency revisions", async (t) => {
  const { root } = setup(t);
  const repo = join(root, "integration-repo"); repoAt(repo);
  const base = git(repo, "rev-parse", "HEAD");
  const left = join(root, "left");
  const right = join(root, "right");
  const target = join(root, "target");
  git(repo, "worktree", "add", "-q", "-b", "left", left, base);
  writeFileSync(join(left, "left.txt"), "left\n");
  git(left, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(left, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "left");
  const leftRevision = git(left, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", "right", right, base);
  writeFileSync(join(right, "right.txt"), "right\n");
  git(right, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(right, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "right");
  const rightRevision = git(right, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", "target", target, base);

  const integrated = await integrateDependencyRevisions(target, [leftRevision, rightRevision]);
  assert.equal(git(target, "rev-parse", "HEAD"), integrated);
  assert.equal(existsSync(join(target, "left.txt")), true);
  assert.equal(existsSync(join(target, "right.txt")), true);
});

test("two projects dispatch independently while global and provider caps hold", async (t) => {
  const { root, records } = setup(t);
  const codex = new Phase2Adapter("codex");
  const claude = new Phase2Adapter("claude");
  const adapters = new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]);
  const projects = ["one", "two"].map((name) => {
    const repo = join(root, name); repoAt(repo);
    return records.createProject({ name, repoPath: repo });
  });
  const tasks = projects.map((project, index) => records.createTask({
    projectId: project.id, title: `task-${index}`, objective: "change value", acceptanceCriteria: ["committed"],
  }));
  const controller = new Controller(records, {
    adapters, defaultAdapter: "codex", workerLimit: 2, activeProjectLimit: 2,
    providerLimits: { codex: 1, claude: 1 },
  });
  await controller.tick();
  const running = records.listRunningAttempts();
  assert.equal(running.length, 2);
  assert.deepEqual(new Set(running.map((attempt) => attempt.adapter)), new Set(["codex", "claude"]));
  assert.equal(new Set(tasks.map((task) => records.getTask(task.id)?.projectId)).size, 2);

  await controller.tick();
  assert.ok(tasks.every((task) => records.getTask(task.id)?.state === "DONE"));
  const health = records.latestHealth();
  assert.equal(Number(health?.worker_limit), 2);
  assert.ok(Number(health?.active_workers) <= 2);
  await controller.stop();
});

test("task-class policy chooses its evidence-based route unless explicitly overridden", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "review-route"); repoAt(repo);
  const project = records.createProject({ name: "review-route", repoPath: repo });
  const task = records.createTask({
    projectId: project.id, title: "review", objective: "review the current implementation", acceptanceCriteria: ["findings returned"],
    taskClass: "review", role: "reviewer",
  });
  const codex = new Phase2Adapter("codex");
  const claude = new Phase2Adapter("claude");
  const controller = new Controller(records, {
    adapters: new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]),
    workerLimit: 1, providerLimits: { codex: 1, claude: 1 },
  });
  await controller.tick();
  assert.equal(records.listAttempts(task.id)[0]?.adapter, "claude");
  assert.match(String(records.routingForTask(task.id)[0]?.reason), /phase2-routing-v1/);
  await controller.stop();
});

test("routing rejects a task when a required local tool is unavailable", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "missing-tool"); repoAt(repo);
  const project = records.createProject({ name: "missing-tool", repoPath: repo });
  const task = records.createTask({
    projectId: project.id, title: "needs tool", objective: "use a required tool", acceptanceCriteria: ["done"],
    requiredTools: ["mabs-tool-that-does-not-exist"],
  });
  const codex = new Phase2Adapter("codex");
  const controller = new Controller(records, {
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "BLOCKED");
  assert.equal(records.getTask(task.id)?.failureClass, "CONFIG");
  assert.equal(codex.starts.length, 0);
  await controller.stop();
});

test("controller rejects worker edits outside the declared repository scope", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "scoped"); repoAt(repo);
  const project = records.createProject({ name: "scoped", repoPath: repo });
  const task = records.createTask({
    projectId: project.id, title: "scoped change", objective: "only edit docs", acceptanceCriteria: ["docs updated"],
    allowedScope: ["docs"],
  });
  const codex = new Phase2Adapter("codex");
  const controller = new Controller(records, {
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await controller.tick();
  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "BLOCKED");
  assert.equal(records.getTask(task.id)?.failureClass, "CONTRACT");
  assert.match(records.getTask(task.id)?.blockedReason ?? "", /outside the allowed scope/);
  await controller.stop();
});

test("mechanical tasks run registered gates without a model worker", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "mechanical"); repoAt(repo);
  const project = records.createProject({
    name: "mechanical", repoPath: repo,
    checkCommands: [{ name: "check", command: [process.execPath, "-e", "process.exit(0)"], required: true }],
  });
  const task = records.createTask({
    projectId: project.id, title: "run checks", objective: "run existing checks", acceptanceCriteria: ["check passes"],
    taskClass: "mechanical", executionMode: "single", executionReason: "No code change or model reasoning is required.",
  });
  const codex = new Phase2Adapter("codex");
  const controller = new Controller(records, {
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "DONE");
  assert.equal(records.listAttempts(task.id).length, 0);
  assert.equal(codex.starts.length, 0);
  assert.equal(records.gatesForTask(task.id)[0]?.status, "PASS");
  await controller.stop();
});

test("machine backpressure leaves work READY and reports the constraint", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "backpressure"); repoAt(repo);
  const project = records.createProject({ name: "backpressure", repoPath: repo });
  const task = records.createTask({ projectId: project.id, title: "wait", objective: "wait for capacity", acceptanceCriteria: ["done"] });
  const codex = new Phase2Adapter("codex");
  const controller = new Controller(records, {
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1,
    minFreeMemoryMb: Number.MAX_SAFE_INTEGER,
  });
  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "READY");
  assert.equal(codex.starts.length, 0);
  assert.equal(records.latestHealth()?.state, "degraded");
  assert.match(String(records.latestHealth()?.backpressure_reason), /below configured minimum/);
  await controller.stop();
});

test("fair scheduling gives the next slot to the less-dispatched project", async (t) => {
  const { root, records } = setup(t);
  const codex = new Phase2Adapter("codex");
  const adapters = new Map<string, WorkerAdapter>([["codex", codex]]);
  const projects = ["fair-one", "fair-two"].map((name) => {
    const repo = join(root, name); repoAt(repo);
    return records.createProject({ name, repoPath: repo });
  });
  for (const project of projects) {
    records.createTask({ projectId: project.id, title: `${project.name}-1`, objective: "change value", acceptanceCriteria: ["done"] });
    records.createTask({ projectId: project.id, title: `${project.name}-2`, objective: "change value again", acceptanceCriteria: ["done"] });
  }
  const controller = new Controller(records, {
    adapters, defaultAdapter: "codex", workerLimit: 1, activeProjectLimit: 2, providerLimits: { codex: 1 },
  });
  await controller.tick();
  const firstAttempt = records.listRunningAttempts()[0];
  const firstProject = records.getTask(firstAttempt?.taskId as string)?.projectId;
  assert.ok(firstProject);

  await controller.tick();
  const secondAttempt = records.listRunningAttempts()[0];
  const secondProject = records.getTask(secondAttempt?.taskId as string)?.projectId;
  assert.notEqual(secondProject, firstProject);
  await controller.stop();
});

test("quota failure reroutes at an attempt boundary without spending repair budget", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo"); repoAt(repo);
  const project = records.createProject({ name: "reroute", repoPath: repo });
  const task = records.createTask({ projectId: project.id, title: "fallback", objective: "change value", acceptanceCriteria: ["committed"] });
  const codex = new Phase2Adapter("codex"); codex.failWithQuota = true;
  const claude = new Phase2Adapter("claude");
  const controller = new Controller(records, {
    adapters: new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]),
    defaultAdapter: "codex", workerLimit: 2, providerLimits: { codex: 1, claude: 1 }, quotaCooldownMs: 60_000,
  });

  await controller.tick();
  assert.equal(records.listAttempts(task.id)[0]?.adapter, "codex");
  await controller.tick();
  const attemptsAfterReroute = records.listAttempts(task.id);
  assert.equal(attemptsAfterReroute.length, 2);
  assert.equal(attemptsAfterReroute[1]?.kind, "reroute");
  assert.equal(attemptsAfterReroute[1]?.adapter, "claude");
  assert.equal(records.getTask(task.id)?.repairsUsed, 0);
  assert.equal(records.getProviderCapacity("codex")?.state, "cooldown");

  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "DONE");
  assert.equal(records.listAttempts(task.id).length, 2);
  await controller.stop();
});
