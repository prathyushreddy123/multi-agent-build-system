import { accessSync, constants, copyFileSync, existsSync, rmSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";
import { delimiter, join } from "node:path";

import { defaultAdapters } from "../adapters/harness.ts";
import type { AdapterHandle, WorkerAdapter } from "../adapters/types.ts";
import { buildContextPacket, type ExecutionSelection } from "../context/packet.ts";
import { consumesRepairBudget, isProviderUnavailable, type FailureClass } from "../core/failure.ts";
import { ids } from "../core/ids.ts";
import { scopesOverlap } from "../domain/plan.ts";
import { artifactDir } from "../core/paths.ts";
import { runGates } from "../gates/runner.ts";
import { DEFAULT_ROUTING_POLICY, selectRoute } from "../routing/router.ts";
import type { RouteCandidate, RouteSelection, RoutingPolicy } from "../routing/router.ts";
import type { Attempt, Project, Records, Task } from "../store/records.ts";
import { finalizeWorkspace, integrateDependencyRevisions, prepareWorkspace, workspaceRevision } from "../workspace/git.ts";

export interface ControllerOptions {
  workerLimit?: number;
  activeProjectLimit?: number;
  perProjectWorkerLimit?: number;
  pollIntervalMs?: number;
  defaultAdapter?: "claude" | "codex";
  defaultModel?: string | null;
  defaultEffort?: string | null;
  workerTimeoutMs?: number;
  leaseTimeoutMs?: number;
  quotaCooldownMs?: number;
  providerLimits?: Record<string, number>;
  minFreeMemoryMb?: number;
  maxLoadPerCpu?: number;
  routingPolicy?: RoutingPolicy;
  controllerId?: string;
  adapters?: Map<string, WorkerAdapter>;
}

export class Controller {
  readonly records: Records;
  readonly options: {
    workerLimit: number;
    activeProjectLimit: number;
    perProjectWorkerLimit: number;
    pollIntervalMs: number;
    defaultAdapter: "claude" | "codex";
    defaultModel: string | null;
    defaultEffort: string | null;
    workerTimeoutMs: number;
    leaseTimeoutMs: number;
    quotaCooldownMs: number;
    providerLimits: Record<string, number>;
    minFreeMemoryMb: number;
    maxLoadPerCpu: number;
    controllerId: string;
  };
  readonly adapters: Map<string, WorkerAdapter>;
  readonly routingPolicy: RoutingPolicy;
  private readonly preferredAdapter: "claude" | "codex" | null;
  readonly startedAt = new Date().toISOString();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private dbErrors = 0;
  private backpressureReason: string | null = null;
  private expectedTickAt = Date.now();

  constructor(records: Records, options: ControllerOptions = {}) {
    this.records = records;
    const workerLimit = options.workerLimit ?? 2;
    this.options = {
      workerLimit,
      activeProjectLimit: options.activeProjectLimit ?? 2,
      perProjectWorkerLimit: options.perProjectWorkerLimit ?? workerLimit,
      pollIntervalMs: options.pollIntervalMs ?? 2_000,
      defaultAdapter: options.defaultAdapter ?? "codex",
      defaultModel: options.defaultModel ?? null,
      defaultEffort: options.defaultEffort ?? null,
      workerTimeoutMs: options.workerTimeoutMs ?? 45 * 60_000,
      leaseTimeoutMs: options.leaseTimeoutMs ?? 15_000,
      quotaCooldownMs: options.quotaCooldownMs ?? 15 * 60_000,
      providerLimits: options.providerLimits ?? {
        claude: Math.max(1, Math.ceil(workerLimit / 2)),
        codex: Math.max(1, Math.floor(workerLimit / 2)),
      },
      minFreeMemoryMb: options.minFreeMemoryMb ?? 0,
      maxLoadPerCpu: options.maxLoadPerCpu ?? Number.POSITIVE_INFINITY,
      controllerId: options.controllerId ?? ids.launch(),
    };
    this.adapters = options.adapters ?? defaultAdapters();
    this.routingPolicy = options.routingPolicy ?? DEFAULT_ROUTING_POLICY;
    this.preferredAdapter = options.defaultAdapter ?? null;
    if (!Number.isSafeInteger(this.options.workerLimit) || this.options.workerLimit < 1) throw new Error("Worker limit must be a positive integer");
    if (!Number.isSafeInteger(this.options.perProjectWorkerLimit) || this.options.perProjectWorkerLimit < 1) throw new Error("Per-project worker limit must be a positive integer");
    if (!Number.isSafeInteger(this.options.activeProjectLimit) || this.options.activeProjectLimit < 1) throw new Error("Active-project limit must be a positive integer");
    if (!Number.isFinite(this.options.minFreeMemoryMb) || this.options.minFreeMemoryMb < 0) throw new Error("Minimum free memory must be non-negative");
    if (Number.isNaN(this.options.maxLoadPerCpu) || this.options.maxLoadPerCpu <= 0) throw new Error("Maximum load per CPU must be positive");
    if (options.defaultAdapter && !this.adapters.has(options.defaultAdapter)) {
      throw new Error(`No adapter registered as ${options.defaultAdapter}`);
    }
    for (const provider of this.adapters.keys()) {
      this.records.configureProvider(provider, this.options.providerLimits[provider] ?? this.options.workerLimit);
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

  private selectTaskRoute(task: Task, excludedAdapters = new Set<string>()): RouteSelection {
    const exclusions = new Set(excludedAdapters);
    if (task.failureClass !== null && isProviderUnavailable(task.failureClass)) {
      const failedAttempt = this.records.listAttempts(task.id).findLast((attempt) =>
        attempt.state === "failed" && attempt.failureClass !== null && isProviderUnavailable(attempt.failureClass),
      );
      if (failedAttempt) exclusions.add(failedAttempt.adapter);
    }
    const active = new Map<string, number>();
    for (const attempt of this.records.listRunningAttempts()) {
      active.set(attempt.adapter, (active.get(attempt.adapter) ?? 0) + 1);
    }
    const configured = new Map(this.records.listProviderCapacity().map((provider) => [provider.provider, provider]));
    const providers = [...this.adapters.keys()].map((provider) => {
      const capacity = configured.get(provider);
      return {
        provider,
        available: !capacity || capacity.state === "available",
        active: active.get(provider) ?? 0,
        limit: capacity?.maxConcurrency ?? this.options.workerLimit,
        reason: capacity?.reason ?? null,
      };
    });
    const availableTools = new Set(["filesystem", "shell"]);
    for (const tool of task.requiredTools) {
      if (!/^[a-zA-Z0-9._+-]+$/.test(tool)) continue;
      const found = (process.env.PATH ?? "").split(delimiter).some((directory) => {
        try {
          accessSync(join(directory, tool), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
      if (found) availableTools.add(tool);
    }
    const selection = selectRoute({
      task,
      policy: this.routingPolicy,
      adapters: this.adapters,
      providers,
      preferredAdapter: this.preferredAdapter,
      excludedAdapters: exclusions,
      availableTools,
    });
    if (selection.chosen?.adapter === this.options.defaultAdapter) {
      selection.chosen = {
        ...selection.chosen,
        model: this.options.defaultModel ?? selection.chosen.model,
        effort: this.options.defaultEffort ?? selection.chosen.effort,
      };
    }
    if (selection.chosen && (this.preferredAdapter || this.options.defaultModel || this.options.defaultEffort)) {
      selection.reason += ` Operator override: adapter=${this.preferredAdapter ?? "policy"}, model=${this.options.defaultModel ?? "policy"}, effort=${this.options.defaultEffort ?? "policy"}.`;
    }
    return selection;
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

    // A restart can expose a claim made before workspace preparation. Once its
    // lease-age window has elapsed and no attempt exists, release only the claim.
    for (const task of this.records.listTasks({ state: "READY" })) {
      if (!task.claimedAt || Date.now() - Date.parse(task.claimedAt) <= this.options.leaseTimeoutMs) continue;
      if (this.records.listAttempts(task.id).some((attempt) => attempt.state === "running")) continue;
      this.records.updateTaskFields(task.id, { claimed_by: null, claimed_at: null });
      this.records.recordEvent({
        kind: "task.claim_released",
        projectId: task.projectId,
        taskId: task.id,
        data: { previousClaim: task.claimedBy, reason: "stale pre-attempt claim" },
      });
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
      await this.handleFailure(task, failure, reason, attempt.adapter);
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
      await this.handleFailure(task, failure, output.reason, attempt.adapter);
      return;
    }

    let finalized: Awaited<ReturnType<typeof finalizeWorkspace>>;
    try {
      finalized = await finalizeWorkspace(task.worktreePath, task);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure: FailureClass = detail.startsWith("Worker changed files outside the allowed scope") ? "CONTRACT" : "INFRA";
      const reason = `Could not create the revision to check: ${detail}`;
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", outcome: output.outcome, failureClass: failure, reason, usage });
      this.blockTask(task, failure, reason);
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

  private async handleFailure(task: Task, failure: FailureClass, reason: string, failedAdapter: string): Promise<void> {
    const current = this.records.getTask(task.id) ?? task;
    if (isProviderUnavailable(failure)) {
      this.records.noteProviderFailure(failedAdapter, failure, reason, this.options.quotaCooldownMs);
      const project = this.records.getProject(current.projectId);
      if (!project) throw new Error(`Unknown project ${current.projectId}`);
      const selection = this.selectTaskRoute(current, new Set([failedAdapter]));
      if (selection.chosen) {
        this.records.transition(current.id, "RUNNING", {}, {
          reason: "provider unavailable; rerouting without spending repair budget",
          failedAdapter,
          fallback: selection.chosen.adapter,
        });
        await this.launchAttempt(this.records.getTask(current.id) as Task, project, "reroute", [reason], ids.launch(), selection);
        return;
      }
      if (selection.deferred.length > 0) {
        this.records.transition(current.id, "READY", {
          claimed_by: null,
          claimed_at: null,
          blocked_reason: "Fallback provider is currently at capacity.",
          failure_class: failure,
        }, { reason: "fallback deferred by provider capacity", failedAdapter });
        return;
      }
      this.blockTask(current, failure, `${reason} No eligible subscription fallback is available.`);
      return;
    }
    if (consumesRepairBudget(failure) && current.repairsUsed < current.repairLimit) {
      const project = this.records.getProject(current.projectId);
      if (!project) throw new Error(`Unknown project ${current.projectId}`);
      this.records.transition(current.id, "RUNNING", { repairs_used: current.repairsUsed + 1 }, { reason: "worker code failure" });
      await this.launchAttempt(this.records.getTask(current.id) as Task, project, "repair", [reason]);
      return;
    }
    if (["INFRA", "CONFIG", "CONTRACT", "TIMEOUT"].includes(failure)) {
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
    this.backpressureReason = this.machineBackpressure();
    if (this.backpressureReason) return;
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
      const schedule = this.records.projectSchedule();
      const candidates = [...perProject.entries()]
        .filter(([projectId]) => activeProjectIds.has(projectId) || activeProjectIds.size < this.options.activeProjectLimit)
        .sort(([a], [b]) => {
          const left = schedule.get(a)?.dispatchCount ?? 0;
          const right = schedule.get(b)?.dispatchCount ?? 0;
          return left - right || a.localeCompare(b);
        });
      if (candidates.length === 0) break;
      let dispatchedInRound = false;
      for (const [projectId, tasks] of candidates) {
        if (available <= 0) break;
        const task = tasks.shift();
        if (!task) { perProject.delete(projectId); continue; }
        const project = this.records.getProject(projectId);
        if (project?.status === "active" && this.executionResourcesAvailable(task)) {
          const selection = this.selectTaskRoute(task);
          if (task.taskClass === "mechanical") {
            await this.dispatchMechanical(task, project);
            this.records.markProjectDispatched(projectId);
            dispatchedInRound = true;
          } else if (selection.chosen) {
            const started = await this.dispatchInitial(task, project, selection);
            if (started) {
              this.records.markProjectDispatched(projectId);
              activeProjectIds.add(projectId);
              available -= 1;
              dispatchedInRound = true;
            }
          } else if (selection.deferred.length === 0) {
            this.blockTask(task, this.providerBlockClass(selection), selection.reason);
          }
        }
        if (tasks.length === 0) perProject.delete(projectId);
      }
      if (!dispatchedInRound) break;
    }
  }

  private machineBackpressure(): string | null {
    const freeMb = freemem() / (1024 * 1024);
    if (freeMb < this.options.minFreeMemoryMb) {
      return `Free memory ${Math.round(freeMb)} MiB is below configured minimum ${this.options.minFreeMemoryMb} MiB.`;
    }
    const loadPerCpu = (loadavg()[0] ?? 0) / Math.max(1, cpus().length);
    if (loadPerCpu > this.options.maxLoadPerCpu) {
      return `One-minute load per CPU ${loadPerCpu.toFixed(2)} exceeds configured maximum ${this.options.maxLoadPerCpu}.`;
    }
    return null;
  }

  private executionResourcesAvailable(task: Task): boolean {
    const running = this.records.listTasks({ projectId: task.projectId, state: "RUNNING" });
    if (running.length === 0) return true;
    if (running.length >= this.options.perProjectWorkerLimit) return false;
    if (task.executionMode === "single" || task.executionMode === "sequential") return false;
    return running.every((active) =>
      (active.executionMode === "parallel" || active.executionMode === "mixed") &&
      !scopesOverlap(task.allowedScope, active.allowedScope),
    );
  }

  private providerBlockClass(selection: RouteSelection): FailureClass {
    if (selection.rejected.some((item) => item.reason === "adapter is not installed" || item.reason.startsWith("required tools are unavailable"))) return "CONFIG";
    const statuses = this.records.listProviderCapacity();
    return statuses.some((provider) => provider.state === "cooldown") ? "QUOTA" : "AUTH";
  }

  private async prepareTaskWorkspace(project: Project, task: Task): Promise<{ path: string; branch: string; baseRevision: string }> {
    const workspace = await prepareWorkspace(project, task);
    const dependencies = this.records.dependenciesOf(task.id).map((id) => this.records.getTask(id));
    const revisions = dependencies.map((dependency) => {
      if (!dependency?.resultRevision) throw new Error(`Dependency ${dependency?.id ?? "unknown"} has no result revision to integrate.`);
      return dependency.resultRevision;
    });
    if (revisions.length === 0) return workspace;
    const baseRevision = await integrateDependencyRevisions(workspace.path, revisions);
    this.records.recordEvent({
      kind: "task.dependencies_integrated",
      projectId: task.projectId,
      taskId: task.id,
      data: { revisions, baseRevision },
    });
    return { ...workspace, baseRevision };
  }

  private async dispatchInitial(task: Task, project: Project, selection: RouteSelection): Promise<boolean> {
    const launchId = ids.launch();
    const claimed = this.records.claimTask(task.id, launchId);
    if (!claimed) return false;
    try {
      const workspace = await this.prepareTaskWorkspace(project, claimed);
      this.records.updateTaskFields(task.id, {
        branch: workspace.branch,
        worktree_path: workspace.path,
        base_revision: workspace.baseRevision,
      });
      this.records.transition(task.id, "RUNNING");
      const kind: Attempt["kind"] = task.failureClass !== null && isProviderUnavailable(task.failureClass) ? "reroute" : "initial";
      await this.launchAttempt(this.records.getTask(task.id) as Task, project, kind, [], launchId, selection);
      return this.records.listAttempts(task.id).some((attempt) => attempt.state === "running");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.records.getTask(task.id) as Task;
      if (current.state === "READY" || current.state === "RUNNING") this.blockTask(current, "INFRA", reason);
      return false;
    }
  }

  private async dispatchMechanical(task: Task, project: Project): Promise<void> {
    const launchId = ids.launch();
    const claimed = this.records.claimTask(task.id, launchId);
    if (!claimed) return;
    try {
      const workspace = await this.prepareTaskWorkspace(project, claimed);
      this.records.updateTaskFields(task.id, {
        branch: workspace.branch,
        worktree_path: workspace.path,
        base_revision: workspace.baseRevision,
      });
      this.records.transition(task.id, "RUNNING", {}, { routing: "deterministic; no model inference" });
      const revision = await workspaceRevision(workspace.path);
      const checking = this.records.transition(task.id, "CHECKING", { result_revision: revision });
      const gates = await runGates({
        records: this.records,
        task: checking,
        attemptId: null,
        worktreePath: workspace.path,
        revision,
        specs: project.checkCommands,
      });
      this.records.recordRouting({
        taskId: task.id,
        rule: this.routingPolicy.version,
        reason: "Mechanical task executed only registered deterministic gates.",
        eligible: [],
        chosen: "deterministic",
      });
      if (gates.passed) {
        this.records.transition(task.id, "DONE", {
          result_summary: "Registered deterministic gates passed without model inference.",
          claimed_by: null,
          claimed_at: null,
        });
      } else {
        this.records.transition(task.id, "FAILED", {
          failure_class: "CODE",
          blocked_reason: "One or more required deterministic gates failed.",
          claimed_by: null,
          claimed_at: null,
        });
      }
    } catch (error) {
      const current = this.records.getTask(task.id) as Task;
      this.blockTask(current, "INFRA", error instanceof Error ? error.message : String(error));
    }
  }

  private async launchAttempt(
    task: Task,
    project: Project,
    kind: Attempt["kind"],
    previousFindings: string[],
    launchId = ids.launch(),
    routeSelection?: RouteSelection,
  ): Promise<void> {
    if (!task.worktreePath || !task.branch || !task.baseRevision) throw new Error(`Task ${task.id} has no prepared workspace`);
    const selection = routeSelection ?? this.selectTaskRoute(task);
    if (!selection.chosen) throw new Error(selection.reason);
    const candidate: RouteCandidate = selection.chosen;
    const adapter = this.requireAdapter(candidate.adapter);
    const execution: ExecutionSelection = {
      harness: adapter.name,
      model: candidate.model,
      effort: candidate.effort,
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
      rule: selection.policyVersion,
      reason: selection.reason,
      eligible: selection.eligible.map((route) => `${route.adapter}:${route.model ?? "default"}`),
      chosen: adapter.name,
      model: execution.model,
      effort: execution.effort,
    });
    if (this.preferredAdapter || this.options.defaultModel || this.options.defaultEffort) {
      this.records.recordEvent({
        kind: "routing.override",
        projectId: task.projectId,
        taskId: task.id,
        data: {
          attemptId,
          adapter: this.preferredAdapter,
          model: this.options.defaultModel,
          effort: this.options.defaultEffort,
        },
      });
    }
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
    const claimed = this.records.listTasks().filter((task) => task.claimedAt !== null);
    const oldest = ready.reduce((value, task) => Math.max(value, (Date.now() - Date.parse(task.createdAt)) / 1000), 0);
    const oldestClaim = claimed.reduce((value, task) => Math.max(value, (Date.now() - Date.parse(task.claimedAt as string)) / 1000), 0);
    const running = this.records.listRunningAttempts();
    const activeByProvider = new Map<string, number>();
    for (const attempt of running) activeByProvider.set(attempt.adapter, (activeByProvider.get(attempt.adapter) ?? 0) + 1);
    const providerStatus = this.records.listProviderCapacity().map((provider) => ({
      provider: provider.provider,
      state: provider.state,
      active: activeByProvider.get(provider.provider) ?? 0,
      limit: provider.maxConcurrency,
      blockedUntil: provider.blockedUntil,
      reason: provider.reason,
      errors: provider.errorCount,
    }));
    const effectiveState = state === "running" && ready.length > 0 && (this.backpressureReason !== null || (providerStatus.length > 0 && providerStatus.every((provider) => provider.state !== "available")))
      ? "degraded"
      : state;
    this.records.writeHealth({
      id: this.options.controllerId,
      pid: process.pid,
      startedAt: this.startedAt,
      loopDelayMs: Math.round(loopDelayMs),
      dbErrors: this.dbErrors,
      queueDepth: ready.length,
      oldestReadyAgeS: Math.round(oldest),
      oldestClaimAgeS: Math.round(oldestClaim),
      activeWorkers: running.length,
      workerLimit: this.options.workerLimit,
      slotUtilization: this.options.workerLimit === 0 ? 0 : running.length / this.options.workerLimit,
      uptimeS: Math.round((Date.now() - Date.parse(this.startedAt)) / 1000),
      providerStatus,
      backpressureReason: this.backpressureReason,
      state: effectiveState,
    });
  }
}
