import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { taskDiagnostics } from "../src/diagnostics/task.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

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
  const root = mkdtempSync(join(tmpdir(), "mabs-closeout-"));
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

class StaticAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name: string;
  starts: string[] = [];
  constructor(name: string) { this.name = name; }
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input.attemptId);
    writeFileSync(join(input.cwd, "value.txt"), `${this.name}\n`);
    writeFileSync(input.completionPath, JSON.stringify({ complete: true }));
    return { attemptId: input.attemptId, pid: null, sessionId: `${this.name}-session`, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(handle: AdapterHandle): Promise<CollectedResult> {
    return {
      launch: {
        exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null,
        usage: null, apiEquivalentEstimateUsd: null, sessionId: handle.sessionId, raw: "", stderr: "",
      },
      validation: validateWorkerOutput({
        outcome: "completed", reason: "implemented", summary: `Completed with ${this.name}.`,
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

test("a stale worker heartbeat is surfaced as an actionable warning without automatically declaring failure", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo"); repoAt(repo);
  const project = records.createProject({ name: "heartbeat", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] } });
  const task = records.createTask({ projectId: project.id, title: "long tool run", objective: "exercise heartbeat staleness" });
  records.transition(task.id, "READY");
  records.transition(task.id, "RUNNING", { claimed_by: "test", claimed_at: new Date().toISOString() });
  const attempt = records.startAttempt({ taskId: task.id, launchId: "lnc_test", kind: "initial", adapter: "codex" });
  records.store.run("UPDATE attempts SET heartbeat_at = ? WHERE id = ?", new Date(Date.now() - 20 * 60_000).toISOString(), attempt.id);

  const staleThresholdMs = 10 * 60_000;
  const stale = records.staleHeartbeatAttempts(staleThresholdMs);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.attemptId, attempt.id);
  assert.ok(stale[0]!.ageMs >= 20 * 60_000);

  const diagnostics = taskDiagnostics(records, task.id, { heartbeatStaleMs: staleThresholdMs });
  assert.equal(diagnostics.staleHeartbeats.length, 1);
  assert.ok(diagnostics.warnings.some((warning) => warning.includes("heartbeat is stale") && warning.includes("investigate")));

  // A stale heartbeat alone must not auto-fail the task; a long tool run may still be active.
  assert.equal(records.getTask(task.id)?.state, "RUNNING");

  const fresh = records.staleHeartbeatAttempts(30 * 60_000);
  assert.equal(fresh.length, 0);
});

test("a controller tick reports and deduplicates stale-heartbeat health without failing the task", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo"); repoAt(repo);
  const project = records.createProject({ name: "heartbeat-health", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] } });
  const task = records.createTask({ projectId: project.id, title: "long tool run", objective: "exercise health reporting" });

  class HangingAdapter implements WorkerAdapter {
    readonly authMode = "test-subscription";
    readonly name = "codex";
    async start(input: AdapterLaunch): Promise<AdapterHandle> {
      return { attemptId: input.attemptId, pid: null, sessionId: "hanging", completionPath: input.completionPath };
    }
    async status(): Promise<"running"> { return "running"; }
    async cancel(): Promise<void> {}
    async collectResult(): Promise<CollectedResult> { throw new Error("not collected while hanging"); }
  }

  const controller = new Controller(records, {
    adapters: new Map([["codex", new HangingAdapter()]]), defaultAdapter: "codex", workerLimit: 1, heartbeatStaleMs: 0,
  });
  await controller.tick();
  const health1 = records.latestHealth();
  assert.ok(Number(health1?.stale_heartbeat_workers ?? 0) >= 1);
  const staleEvents1 = records.listEvents(task.id).filter((event) => event.kind === "worker.heartbeat_stale");
  assert.equal(staleEvents1.length, 1);

  await controller.tick();
  const staleEvents2 = records.listEvents(task.id).filter((event) => event.kind === "worker.heartbeat_stale");
  assert.equal(staleEvents2.length, 1, "a stale heartbeat must be reported once per attempt, not on every tick");
  assert.equal(records.getTask(task.id)?.state, "RUNNING");
  await controller.stop();
});

test("many registered inactive projects consume no model calls while two active projects both progress without starving", async (t) => {
  const { root, records } = setup(t);
  const codex = new StaticAdapter("codex");
  const claude = new StaticAdapter("claude");
  const adapters = new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]);

  const activeProjects = ["active-one", "active-two"].map((name) => {
    const repo = join(root, name); repoAt(repo);
    return records.createProject({ name, repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] } });
  });
  const activeTasks = activeProjects.map((project, index) => records.createTask({
    projectId: project.id, title: `active-task-${index}`, objective: "change value", acceptanceCriteria: ["committed"],
  }));

  const inactiveTasks = Array.from({ length: 5 }, (_, index) => {
    const name = `inactive-${index}`;
    const repo = join(root, name); repoAt(repo);
    const project = records.createProject({ name, repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] } });
    records.setProjectStatus(project.id, "paused");
    return records.createTask({
      projectId: project.id, title: `inactive-task-${index}`, objective: "must never run while paused", acceptanceCriteria: ["never dispatched"],
    });
  });

  const controller = new Controller(records, {
    adapters, defaultAdapter: "codex", workerLimit: 4, activeProjectLimit: 2,
    providerLimits: { codex: 2, claude: 2 },
  });
  for (let tick = 0; tick < 6; tick += 1) await controller.tick();
  await controller.stop();

  for (const task of activeTasks) {
    assert.equal(records.getTask(task.id)?.state, "DONE", `active task ${task.id} did not complete`);
  }
  for (const task of inactiveTasks) {
    const current = records.getTask(task.id);
    assert.equal(current?.state, "QUEUED", `paused-project task ${task.id} must remain unpromoted`);
    assert.equal(records.listAttempts(task.id).length, 0, `paused-project task ${task.id} must never be dispatched`);
  }
  assert.equal(codex.starts.length + claude.starts.length, activeTasks.length);
});

test("a database-lease error during a tick is counted, surfaced as degraded, and does not lose task ownership", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo"); repoAt(repo);
  const project = records.createProject({ name: "db-error", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] } });
  records.createTask({ projectId: project.id, title: "unaffected task", objective: "must not be dispatched during an outage" });

  class FlakyRecords extends Records {
    failNext = false;
    override acquireControllerLease(controllerId: string, pid: number, staleAfterMs: number): boolean {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("simulated SQLite outage");
      }
      return super.acquireControllerLease(controllerId, pid, staleAfterMs);
    }
  }
  const flaky = new FlakyRecords(records.store);
  flaky.failNext = true;
  const controller = new Controller(flaky, {
    adapters: new Map([["codex", new StaticAdapter("codex")]]), defaultAdapter: "codex", workerLimit: 1,
  });

  await assert.rejects(controller.tick(), /simulated SQLite outage/);
  const degraded = flaky.latestHealth();
  assert.equal(degraded?.state, "degraded");
  assert.ok(Number(degraded?.db_errors ?? 0) >= 1);
  assert.equal(flaky.listRunningAttempts().length, 0, "no attempt should be dispatched while the controller could not confirm ownership");

  await controller.tick();
  const recovered = flaky.latestHealth();
  assert.equal(recovered?.state, "running");
  assert.ok(Number(recovered?.db_errors ?? 0) >= 1, "the cumulative db-error count remains visible after recovery");
  await controller.stop();
});
