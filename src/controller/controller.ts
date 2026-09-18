import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { defaultAdapters } from "../adapters/harness.ts";
import type { AdapterHandle, WorkerAdapter } from "../adapters/types.ts";
import { buildContextPacket, type ExecutionSelection } from "../context/packet.ts";
import { consumesRepairBudget, isProviderUnavailable, type FailureClass } from "../core/failure.ts";
import { ids } from "../core/ids.ts";
import { artifactDir } from "../core/paths.ts";
import { runGates } from "../gates/runner.ts";
import type { Attempt, Project, Records, Task } from "../store/records.ts";
import { finalizeWorkspace, prepareWorkspace } from "../workspace/git.ts";

export interface ControllerOptions {
  workerLimit?: number;
  activeProjectLimit?: number;
  pollIntervalMs?: number;
  defaultAdapter?: "claude" | "codex";
  defaultModel?: string | null;
  defaultEffort?: string | null;
  workerTimeoutMs?: number;
  leaseTimeoutMs?: number;
  controllerId?: string;
  adapters?: Map<string, WorkerAdapter>;
}

export class Controller {
  readonly records: Records;
  readonly options: Required<Omit<ControllerOptions, "defaultModel" | "defaultEffort" | "adapters">> & {
    defaultModel: string | null;
    defaultEffort: string | null;
  };
  readonly adapters: Map<string, WorkerAdapter>;
  readonly startedAt = new Date().toISOString();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private dbErrors = 0;
  private expectedTickAt = Date.now();

  constructor(records: Records, options: ControllerOptions = {}) {
    this.records = records;
    this.options = {
      workerLimit: options.workerLimit ?? 2,
      activeProjectLimit: options.activeProjectLimit ?? 2,
      pollIntervalMs: options.pollIntervalMs ?? 2_000,
      defaultAdapter: options.defaultAdapter ?? "codex",
      defaultModel: options.defaultModel ?? null,
      defaultEffort: options.defaultEffort ?? null,
      workerTimeoutMs: options.workerTimeoutMs ?? 45 * 60_000,
      leaseTimeoutMs: options.leaseTimeoutMs ?? 15_000,
      controllerId: options.controllerId ?? ids.launch(),
    };
    this.adapters = options.adapters ?? defaultAdapters();
    if (!this.adapters.has(this.options.defaultAdapter)) {
      throw new Error(`No adapter registered as ${this.options.defaultAdapter}`);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const loopDelayMs = Math.max(0, Date.now() - this.expectedTickAt);
    try {
      if (!this.records.acquireControllerLease(this.options.controllerId, process.pid, this.options.leaseTimeoutMs)) {
        const lease = this.records.currentControllerLease();
        throw new Error(`Controller lease is held by ${String(lease?.controller_id ?? "another process")} (pid ${String(lease?.pid ?? "unknown")})`);
      }
      await this.reconcileAttempts();
      this.promoteTasks();
      await this.dispatchReadyTasks();
      this.writeHealth(loopDelayMs, "running");
    } catch (error) {
      this.dbErrors += 1;
      try { this.writeHealth(loopDelayMs, "degraded"); } catch { /* database outage is already represented by the failed tick */ }
      throw error;
    } finally {
      this.ticking = false;
      this.expectedTickAt = Date.now() + this.options.pollIntervalMs;
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.tick().catch((error) => console.error("controller tick failed", error));
    this.timer = setInterval(() => {
      if (!this.stopped) void this.tick().catch((error) => console.error("controller tick failed", error));
    }, this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    this.writeHealth(0, "stopped");
    this.records.releaseControllerLease(this.options.controllerId);
  }

  async cancelTask(taskId: string, expectedVersion?: number): Promise<void> {
    const task = this.records.getTask(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (expectedVersion !== undefined && task.recordVersion !== expectedVersion) {
      throw new Error(`Task ${taskId} changed since version ${expectedVersion}; current version is ${task.recordVersion}`);
    }
    const attempt = this.records.listAttempts(taskId).findLast((candidate) => candidate.state === "running");
    if (attempt) {
      const adapter = this.requireAdapter(attempt.adapter);
      await adapter.cancel(this.handleOf(attempt));
      this.records.finishAttempt({ attemptId: attempt.id, state: "cancelled", outcome: "cancelled", failureClass: "CANCELLED" });
    }
    this.records.transition(taskId, "CANCELLED", { claimed_by: null, claimed_at: null }, { requestedBy: "controller" });
  }

  private requireAdapter(name: string): WorkerAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`Attempt requires unavailable adapter ${name}`);
    return adapter;
  }

  private handleOf(attempt: Attempt): AdapterHandle {
    return {
      attemptId: attempt.id,
      pid: attempt.pid,
      sessionId: attempt.sessionId,
      completionPath: attempt.outputPath ?? join(artifactDir(attempt.taskId, attempt.id), "completion.json"),
    };
  }

  private async reconcileAttempts(): Promise<void> {
    for (const attempt of this.records.listRunningAttempts()) {
      const task = this.records.getTask(attempt.taskId);
      if (!task) continue;
      const adapter = this.adapters.get(attempt.adapter);
      if (!adapter) {
        this.records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass: "CONFIG", reason: "Adapter is no longer configured." });
        this.blockTask(task, "CONFIG", `Adapter ${attempt.adapter} is not configured; explicit rerouting is required.`);
        continue;
      }
      const status = await adapter.status(this.handleOf(attempt));
      if (status === "running") {
        this.records.heartbeat(attempt.id);
        continue;
      }
      if (status === "lost") {
        this.records.finishAttempt({
          attemptId: attempt.id,
          state: "failed",
          failureClass: "INFRA",
          reason: "Recorded worker process is absent and no completion envelope exists.",
        });
        this.blockTask(task, "INFRA", "Worker disappeared. Worktree and evidence were preserved; retry requires an explicit decision.");
        continue;
      }
      await this.collectAttempt(task, attempt, adapter);
    }

    // A restart can expose a narrow crash window between a task transition and
    // attempt creation. Fail closed instead of silently dispatching a duplicate.
    for (const task of [...this.records.listTasks({ state: "RUNNING" }), ...this.records.listTasks({ state: "CHECKING" })]) {
      if (this.records.listAttempts(task.id).some((attempt) => attempt.state === "running")) continue;
      this.blockTask(task, "INFRA", `Controller recovered ${task.state} without a live attempt; inspect the preserved worktree before retrying.`);
    }
  }

  private async collectAttempt(task: Task, attempt: Attempt, adapter: WorkerAdapter): Promise<void> {
    if (!task.worktreePath) {
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass: "CONFIG", reason: "Task has no worktree path." });
      this.blockTask(task, "CONFIG", "Cannot collect a worker result without its recorded worktree.");
      return;
    }
    const collected = await adapter.collectResult(this.handleOf(attempt), task.worktreePath);
    const output = collected.validation.output;
    const resultArtifact = join(artifactDir(task.id, attempt.id), "worker-result.json");
    const worktreeResult = join(task.worktreePath, ".mabs", "result.json");
    if (existsSync(worktreeResult)) {
      copyFileSync(worktreeResult, resultArtifact);
      rmSync(worktreeResult, { force: true });
    }
    const usage = collected.launch?.usage
      ? { ...collected.launch.usage, reported_model: collected.launch.reportedModel }
      : null;

    if ((collected.failureClass && output?.outcome !== "failed") || !collected.validation.ok || !output) {
      const failure = collected.failureClass ?? "CONTRACT";
      const reason = collected.error ?? collected.validation.violations.map((item) => `${item.path}: ${item.message}`).join("; ");
      this.records.finishAttempt({
        attemptId: attempt.id,
        state: "failed",
        failureClass: failure,
        reason,
        exitStatus: collected.launch?.exitCode ?? null,
        usage,
      });
      await this.handleFailure(task, failure, reason);
      return;
    }

    if (output.outcome === "blocked") {
      this.records.finishAttempt({
        attemptId: attempt.id,
        state: "succeeded",
        outcome: output.outcome,
        reason: output.reason,
        exitStatus: collected.launch?.exitCode ?? 0,
        usage,
      });
      this.records.transition(task.id, "BLOCKED", {
        blocked_reason: output.reason,
        result_summary: output.summary,
        claimed_by: null,
        claimed_at: null,
      });
      return;
    }
    if (output.outcome === "failed") {
      const failure: FailureClass = collected.failureClass ?? "CODE";
      this.records.finishAttempt({
        attemptId: attempt.id,
        state: "failed",
        outcome: output.outcome,
        failureClass: failure,
        reason: output.reason,
        exitStatus: collected.launch?.exitCode ?? 0,
        usage,
      });
      await this.handleFailure(task, failure, output.reason);
      return;
    }

    let finalized: Awaited<ReturnType<typeof finalizeWorkspace>>;
    try {
      finalized = await finalizeWorkspace(task.worktreePath, task);
    } catch (error) {
      const reason = `Could not create the revision to check: ${error instanceof Error ? error.message : String(error)}`;
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", outcome: output.outcome, failureClass: "INFRA", reason, usage });
      this.blockTask(task, "INFRA", reason);
      return;
    }
    this.records.finishAttempt({
      attemptId: attempt.id,
      state: "succeeded",
      outcome: output.outcome,
      reason: output.reason,
      exitStatus: collected.launch?.exitCode ?? 0,
      resultRevision: finalized.revision,
      usage,
      outputPath: this.handleOf(attempt).completionPath,
    });
    const checking = this.records.transition(task.id, "CHECKING", {
      result_revision: finalized.revision,
      result_summary: output.summary,
      blocked_reason: null,
      failure_class: null,
    }, { changedFiles: finalized.changedFiles });
    const project = this.records.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project ${task.projectId}`);
    const gates = await runGates({
      records: this.records,
      task: checking,
      attemptId: attempt.id,
      worktreePath: task.worktreePath,
      revision: finalized.revision,
      specs: project.checkCommands,
    });
    if (gates.passed) {
      this.records.transition(task.id, "DONE", { claimed_by: null, claimed_at: null }, { review: "not configured", gates: gates.results.length });
      return;
    }
    const finding = gates.failedRequired.map((gate) => `${gate.name}: ${gate.status} (${gate.evidencePath ?? "no evidence"})`).join("; ");
    const current = this.records.getTask(task.id) as Task;
    if (current.repairsUsed < current.repairLimit) {
      this.records.transition(task.id, "RUNNING", { repairs_used: current.repairsUsed + 1 }, { reason: "required gate failed" });
      await this.launchAttempt(this.records.getTask(task.id) as Task, project, "repair", [finding]);
    } else {
      this.records.transition(task.id, "FAILED", {
        failure_class: "CODE",
        blocked_reason: `Repair limit exhausted. ${finding}`,
        claimed_by: null,
        claimed_at: null,
      });
    }
  }

  private async handleFailure(task: Task, failure: FailureClass, reason: string): Promise<void> {
    const current = this.records.getTask(task.id) ?? task;
    if (consumesRepairBudget(failure) && current.repairsUsed < current.repairLimit) {
      const project = this.records.getProject(current.projectId);
      if (!project) throw new Error(`Unknown project ${current.projectId}`);
      this.records.transition(current.id, "RUNNING", { repairs_used: current.repairsUsed + 1 }, { reason: "worker code failure" });
      await this.launchAttempt(this.records.getTask(current.id) as Task, project, "repair", [reason]);
      return;
    }
    if (isProviderUnavailable(failure) || ["INFRA", "CONFIG", "CONTRACT", "TIMEOUT"].includes(failure)) {
      this.blockTask(current, failure, reason);
    } else {
      this.records.transition(current.id, "FAILED", {
        failure_class: failure,
        blocked_reason: reason,
        claimed_by: null,
        claimed_at: null,
      });
    }
  }

  private blockTask(task: Task, failure: FailureClass, reason: string): void {
    const current = this.records.getTask(task.id) ?? task;
    if (current.state === "BLOCKED") return;
    this.records.transition(task.id, "BLOCKED", {
      failure_class: failure,
      blocked_reason: reason,
      claimed_by: null,
      claimed_at: null,
    });
  }

  private promoteTasks(): void {
    for (const task of this.records.listTasks({ state: "QUEUED" })) {
      const project = this.records.getProject(task.projectId);
      if (!project || project.status !== "active") continue;
      const dependencies = this.records.dependenciesOf(task.id).map((id) => this.records.getTask(id)).filter((item): item is Task => item !== null);
      const failed = dependencies.find((dependency) => ["FAILED", "CANCELLED"].includes(dependency.state));
      if (failed) {
        this.records.transition(task.id, "BLOCKED", { blocked_reason: `Dependency ${failed.id} is ${failed.state}.` });
      } else if (dependencies.every((dependency) => dependency.state === "DONE")) {
        this.records.transition(task.id, "READY");
      }
    }
  }

  private async dispatchReadyTasks(): Promise<void> {
    let available = this.options.workerLimit - this.records.listRunningAttempts().length;
    if (available <= 0) return;
    const activeProjectIds = new Set(
      this.records.listTasks({ state: "RUNNING" }).map((task) => task.projectId),
    );
    const ready = this.records.listTasks({ state: "READY" });
    const perProject = new Map<string, Task[]>();
    for (const task of ready) {
      const tasks = perProject.get(task.projectId) ?? [];
      tasks.push(task);
      perProject.set(task.projectId, tasks);
    }

    while (available > 0 && perProject.size > 0) {
      const candidates = [...perProject.entries()]
        .filter(([projectId]) => activeProjectIds.has(projectId) || activeProjectIds.size < this.options.activeProjectLimit)
        .sort(([a], [b]) => a.localeCompare(b));
      if (candidates.length === 0) break;
      for (const [projectId, tasks] of candidates) {
        if (available <= 0) break;
        const task = tasks.shift();
        if (!task) { perProject.delete(projectId); continue; }
        const project = this.records.getProject(projectId);
        if (project?.status === "active") {
          await this.dispatchInitial(task, project);
          activeProjectIds.add(projectId);
          available -= 1;
        }
        if (tasks.length === 0) perProject.delete(projectId);
      }
    }
  }

  private async dispatchInitial(task: Task, project: Project): Promise<void> {
    const launchId = ids.launch();
    const claimed = this.records.claimTask(task.id, launchId);
    if (!claimed) return;
    try {
      const workspace = await prepareWorkspace(project, claimed);
      this.records.updateTaskFields(task.id, {
        branch: workspace.branch,
        worktree_path: workspace.path,
        base_revision: workspace.baseRevision,
      });
      this.records.transition(task.id, "RUNNING");
      await this.launchAttempt(this.records.getTask(task.id) as Task, project, "initial", [], launchId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.records.getTask(task.id) as Task;
      if (current.state === "READY" || current.state === "RUNNING") this.blockTask(current, "INFRA", reason);
    }
  }

  private async launchAttempt(
    task: Task,
    project: Project,
    kind: Attempt["kind"],
    previousFindings: string[],
    launchId = ids.launch(),
  ): Promise<void> {
    if (!task.worktreePath || !task.branch || !task.baseRevision) throw new Error(`Task ${task.id} has no prepared workspace`);
    const adapter = this.requireAdapter(this.options.defaultAdapter);
    const execution: ExecutionSelection = {
      harness: adapter.name,
      model: this.options.defaultModel,
      effort: this.options.defaultEffort,
      authMode: adapter.authMode,
    };
    const attemptId = ids.attempt();
    const dir = artifactDir(task.id, attemptId);
    const completionPath = join(dir, "completion.json");
    const evidencePath = join(dir, "worker.log");
    const packet = buildContextPacket({
      records: this.records,
      project,
      task,
      attemptId,
      workspace: { path: task.worktreePath, branch: task.branch, baseRevision: task.baseRevision },
      execution,
      previousFindings,
    });
    const attempt = this.records.startAttempt({
      id: attemptId,
      taskId: task.id,
      launchId,
      kind,
      adapter: adapter.name,
      model: execution.model,
      effort: execution.effort,
      authMode: execution.authMode,
      worktreePath: task.worktreePath,
      baseRevision: task.baseRevision,
      packetId: packet.id,
      outputPath: completionPath,
    });
    this.records.updateTaskFields(task.id, { claimed_by: launchId, claimed_at: new Date().toISOString() });
    this.records.recordRouting({
      taskId: task.id,
      attemptId,
      rule: "configured-default",
      reason: `Phase 1 explicit default for ${task.role} tasks.`,
      eligible: [...this.adapters.keys()],
      chosen: adapter.name,
      model: execution.model,
      effort: execution.effort,
    });
    try {
      const handle = await adapter.start({
        attemptId,
        cwd: task.worktreePath,
        prompt: packet.prompt,
        model: execution.model,
        timeoutMs: this.options.workerTimeoutMs,
        evidencePath,
        completionPath,
      });
      this.records.setAttemptProcess(attempt.id, handle.pid, handle.sessionId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.records.finishAttempt({ attemptId, state: "failed", failureClass: "INFRA", reason });
      this.blockTask(task, "INFRA", reason);
    }
  }

  private writeHealth(loopDelayMs: number, state: "running" | "stopped" | "degraded"): void {
    const ready = this.records.listTasks({ state: "READY" });
    const oldest = ready.reduce((value, task) => Math.max(value, (Date.now() - Date.parse(task.createdAt)) / 1000), 0);
    this.records.writeHealth({
      id: this.options.controllerId,
      pid: process.pid,
      startedAt: this.startedAt,
      loopDelayMs: Math.round(loopDelayMs),
      dbErrors: this.dbErrors,
      queueDepth: ready.length,
      oldestReadyAgeS: Math.round(oldest),
      activeWorkers: this.records.listRunningAttempts().length,
      workerLimit: this.options.workerLimit,
      state,
    });
  }
}
