import { accessSync, constants, copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";
import { delimiter, join } from "node:path";

import { defaultAdapters } from "../adapters/harness.ts";
import type { AdapterHandle, WorkerAdapter } from "../adapters/types.ts";
import { buildContextPacket, type ExecutionSelection } from "../context/packet.ts";
import { consumesRepairBudget, isProviderUnavailable, type FailureClass } from "../core/failure.ts";
import { ids } from "../core/ids.ts";
import { scopesOverlap } from "../domain/plan.ts";
import type { WorkerOutput } from "../domain/contract.ts";
import { artifactDir } from "../core/paths.ts";
import { runGates } from "../gates/runner.ts";
import { classifyFindings, describeReviewPolicy, evaluateReviewPolicy } from "../review/policy.ts";
import type { ReviewDecision } from "../review/policy.ts";
import { WORKER_PROMPT_VERSION, guidanceForAttempt } from "../prompts/versions.ts";
import { DEFAULT_ROUTING_POLICY, selectRoute } from "../routing/router.ts";
import type { RouteCandidate, RouteSelection, RoutingPolicy } from "../routing/router.ts";
import type { Attempt, Project, Records, Task } from "../store/records.ts";
import { finalizeWorkspace, integrateDependencyRevisions, prepareWorkspace, workspaceChangedFiles, workspaceDiff, workspaceRevision } from "../workspace/git.ts";

/** Marks a task whose only outstanding work is a review the controller can retry. */
export const REVIEW_PENDING_PREFIX = "Review pending:";

/**
 * A live peer already owns the lease.
 *
 * Distinguished from every other tick failure because the correct response is
 * the opposite one: other failures are worth retrying next tick, but a lease
 * held by a healthy peer will still be held next tick. Retrying it forever
 * produces a process that fails every cycle and accomplishes nothing, so the
 * loser steps down instead.
 */
export class ControllerLeaseHeldError extends Error {
  readonly holderId: string | null;
  readonly holderPid: number | null;

  constructor(holderId: string | null, holderPid: number | null) {
    super(
      `Controller lease is held by ${holderId ?? "another process"} (pid ${holderPid ?? "unknown"}). ` +
      "Only one controller may dispatch work; this one is standing down.",
    );
    this.name = "ControllerLeaseHeldError";
    this.holderId = holderId;
    this.holderPid = holderPid;
  }
}

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
  heartbeatStaleMs?: number;
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
    heartbeatStaleMs: number;
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
  /**
   * Ticks that threw, for any reason. Persisted in the `db_errors` column,
   * which predates the counter's actual meaning.
   */
  private failedTicks = 0;
  /** Set when this controller stood down because a live peer holds the lease. */
  private steppedDown: ControllerLeaseHeldError | null = null;
  private backpressureReason: string | null = null;
  private reportedStaleHeartbeats = new Set<string>();
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
      heartbeatStaleMs: options.heartbeatStaleMs ?? 10 * 60_000,
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
        throw new ControllerLeaseHeldError(
          (lease?.controller_id as string | null) ?? null,
          lease?.pid === undefined || lease?.pid === null ? null : Number(lease.pid),
        );
      }
      await this.reconcileAttempts();
      await this.resumePendingReviews();
      this.promoteTasks();
      await this.dispatchReadyTasks();
      this.writeHealth(loopDelayMs, "running");
    } catch (error) {
      this.failedTicks += 1;
      // A lease loss is not this controller's health to report: the holder owns
      // the health row, and overwriting it with "degraded" would misreport a
      // healthy peer as broken.
      if (error instanceof ControllerLeaseHeldError) this.steppedDown = error;
      else try { this.writeHealth(loopDelayMs, "degraded"); } catch { /* database outage is already represented by the failed tick */ }
      throw error;
    } finally {
      this.ticking = false;
      this.expectedTickAt = Date.now() + this.options.pollIntervalMs;
    }
  }

  /**
   * Run the loop until stopped, or until a live peer proves this controller is
   * redundant.
   *
   * `onStepDown` is invoked once if the lease turns out to belong to someone
   * else, after the loop has already been halted. Callers use it to exit
   * cleanly rather than linger as a process that can never do any work.
   */
  start(options: { onStepDown?: (error: ControllerLeaseHeldError) => void } = {}): void {
    if (this.timer) return;
    this.stopped = false;
    const run = () => {
      if (this.stopped) return;
      void this.tick().catch((error) => {
        if (error instanceof ControllerLeaseHeldError) {
          this.stopped = true;
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
          options.onStepDown?.(error);
          return;
        }
        console.error("controller tick failed", error);
      });
    };
    run();
    this.timer = setInterval(run, this.options.pollIntervalMs);
  }

  /** The lease-held error that made this controller stand down, if any. */
  get stepDownReason(): ControllerLeaseHeldError | null {
    return this.steppedDown;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    // A controller that never owned the lease must not touch either record:
    // the health row and the lease both belong to the live holder.
    if (!this.steppedDown) {
      this.writeHealth(0, "stopped");
      this.records.releaseControllerLease(this.options.controllerId);
    }
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
    const projectOverride = this.records.getProject(task.projectId)?.routingOverrides[task.taskClass];
    if (projectOverride) {
      const eligibleOverride = selection.eligible.find((candidate) =>
        candidate.adapter === projectOverride.adapter &&
        candidate.model === projectOverride.model &&
        candidate.effort === projectOverride.effort,
      );
      if (eligibleOverride) {
        selection.chosen = eligibleOverride;
        selection.reason += ` Project configuration selected verified ${task.taskClass} route ${eligibleOverride.adapter}:${eligibleOverride.model ?? "default"}.`;
      } else {
        selection.reason += ` Configured ${task.taskClass} route was not currently eligible; retained the eligible policy fallback.`;
      }
    }
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

  private selectReviewRoute(task: Task, excludedAdapter?: string): RouteSelection {
    const reviewTask: Task = { ...task, role: "reviewer", taskClass: "review", requiredTools: [] };
    const excluded = excludedAdapter ? new Set([excludedAdapter]) : new Set<string>();
    const independent = this.selectTaskRoute(reviewTask, excluded);
    if (independent.chosen || !excludedAdapter) return independent;
    const sameProvider = this.selectTaskRoute(reviewTask);
    if (sameProvider.chosen) {
      sameProvider.reason += ` No second eligible provider was available; using a fresh, separate review context on ${sameProvider.chosen.adapter}.`;
    }
    return sameProvider;
  }

  /**
   * Risk is judged from what the controller observed changing, never from the
   * worker's own description of its change.
   */
  private reviewDecision(task: Task, project: Project, change: { changedFiles: string[]; diffText: string }): ReviewDecision {
    return evaluateReviewPolicy(project.reviewPolicy, {
      subject: task,
      changedFiles: change.changedFiles,
      diffText: change.diffText,
      manualRequest: this.records.hasOpenManualReviewRequest(task.id),
    });
  }

  private priorReviewFindings(task: Task): string[] {
    const prior = this.records.reviewsForTask(task.id).at(-1);
    if (!prior) return [];
    return [
      `Previous review of ${prior.revision} returned ${prior.verdict}: ${prior.summary}`,
      ...prior.findings.map((finding) => `Previous finding: ${finding}`),
    ];
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
    for (const task of [
      ...this.records.listTasks({ state: "RUNNING" }),
      ...this.records.listTasks({ state: "CHECKING" }),
      ...this.records.listTasks({ state: "REVIEWING" }),
    ]) {
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
        outputPath: existsSync(resultArtifact) ? resultArtifact : undefined,
      });
      if (attempt.kind === "review") await this.handleReviewFailure(task, failure, reason, attempt.adapter);
      else await this.handleFailure(task, failure, reason, attempt.adapter);
      return;
    }

    if (attempt.kind === "review") {
      await this.collectReview(task, attempt, output, resultArtifact, usage, collected.launch?.exitCode ?? 0);
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
        outputPath: existsSync(resultArtifact) ? resultArtifact : undefined,
      });
      this.records.recordCheckpoint({
        taskId: task.id, attemptId: attempt.id, kind: "worker_blocked", summary: output.summary,
        baseRevision: attempt.baseRevision, findings: output.follow_up.unresolved,
        unresolved: output.follow_up.decisions_requested, nextAction: output.follow_up.next_step,
        evidence: output.evidence.artifacts,
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
        outputPath: existsSync(resultArtifact) ? resultArtifact : undefined,
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
      outputPath: existsSync(resultArtifact) ? resultArtifact : this.handleOf(attempt).completionPath,
    });
    this.records.invalidateApprovals(task.id, "Task revision changed after implementation or repair.", finalized.revision);
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: attempt.id, kind: attempt.kind === "repair" ? "repair_complete" : "implementation_complete",
      summary: output.summary, baseRevision: attempt.baseRevision, resultRevision: finalized.revision,
      changedFiles: finalized.changedFiles, findings: output.follow_up.unresolved,
      unresolved: output.follow_up.decisions_requested, nextAction: output.follow_up.next_step,
      evidence: [resultArtifact, ...output.evidence.artifacts],
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
      const notConfigured = gates.status === "not_configured";
      if (notConfigured) {
        this.records.recordEvent({
          kind: "quality.not_configured",
          projectId: project.id,
          taskId: task.id,
          attemptId: attempt.id,
          data: { revision: finalized.revision, note: "No required quality checks are registered for this project." },
        });
      }
      // The reviewer decision needs the real change, so it is computed from the
      // controller's own diff of the revision it just created.
      const diffText = (await workspaceDiff(task.worktreePath, task.baseRevision ?? attempt.baseRevision ?? finalized.revision, finalized.revision)).slice(0, 400_000);
      const decision = this.reviewDecision(checking, project, { changedFiles: finalized.changedFiles, diffText });
      this.records.recordEvent({
        kind: "review.decision",
        projectId: project.id,
        taskId: task.id,
        attemptId: attempt.id,
        data: {
          review: decision.review,
          reason: decision.reason,
          matchedRules: decision.matchedRules,
          policy: describeReviewPolicy(project.reviewPolicy),
          changedFiles: finalized.changedFiles.length,
        },
      });
      this.records.recordCheckpoint({
        taskId: task.id, attemptId: attempt.id,
        kind: notConfigured ? "quality_not_configured" : "checks_passed",
        summary: notConfigured
          ? "No required quality checks are configured; this revision has no quality evidence."
          : `All ${gates.requiredConfigured} required checks passed.`,
        resultRevision: finalized.revision, changedFiles: finalized.changedFiles,
        findings: notConfigured
          ? ["[major] Quality coverage is not configured; register build, lint, typecheck, or test checks before treating this revision as ready."]
          : [],
        nextAction: decision.review ? `Run independent revision-bound review. ${decision.reason}` : `Complete task. ${decision.reason}`,
        evidence: gates.results.map((gate) => gate.evidencePath).filter((path): path is string => path !== null),
      });
      if (decision.review) {
        await this.beginReview(this.records.getTask(task.id) as Task, project, attempt, decision);
      } else {
        const done = this.records.transition(task.id, "DONE", { claimed_by: null, claimed_at: null }, { review: decision.reason, gates: gates.results.length, quality: gates.status });
        this.records.completeFeedbackForTask(task.id, done.resultSummary ?? "Response task completed without a summary.");
      }
      return;
    }
    const finding = gates.failedRequired.map((gate) => `${gate.name}: ${gate.status} (${gate.evidencePath ?? "no evidence"})`).join("; ");
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: attempt.id, kind: "checks_failed", summary: "One or more required checks failed.",
      resultRevision: finalized.revision, changedFiles: finalized.changedFiles, findings: [finding],
      nextAction: "Repair the failed required checks and rerun all required checks.",
      evidence: gates.failedRequired.map((gate) => gate.evidencePath).filter((path): path is string => path !== null),
    });
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

  private async beginReview(task: Task, project: Project, implementationAttempt: Attempt, decision: ReviewDecision): Promise<void> {
    const reviewing = this.records.transition(task.id, "REVIEWING", {}, {
      revision: task.resultRevision,
      implementationAttemptId: implementationAttempt.id,
      policy: decision.reason,
      scope: decision.scope,
    });
    const excluded = decision.reviewerRoute === "independent_provider" ? implementationAttempt.adapter : undefined;
    const selection = this.selectReviewRoute(reviewing, excluded);
    if (!selection.chosen) {
      this.deferReview(reviewing, decision, selection);
      return;
    }
    await this.launchAttempt(reviewing, project, "review", this.priorReviewFindings(reviewing), ids.launch(), selection);
  }

  /**
   * Required review coverage that cannot run right now is recorded as pending
   * or blocked, with the missing work named. It is never silently skipped.
   */
  private deferReview(task: Task, decision: ReviewDecision, selection: RouteSelection): void {
    const pending = decision.capacityAction === "pending";
    const reason = `${pending ? REVIEW_PENDING_PREFIX : "Independent review is blocked:"} ${selection.reason}`;
    this.records.recordCheckpoint({
      taskId: task.id, kind: pending ? "review_pending" : "review_blocked",
      summary: "Required independent review has not been performed for this revision.",
      resultRevision: task.resultRevision, findings: [`[major] ${reason}`],
      nextAction: pending
        ? "The controller retries this review when an eligible subscription provider has capacity."
        : "Resolve provider availability, then retry the task to run the outstanding review.",
    });
    this.records.recordEvent({
      kind: pending ? "review.pending" : "review.blocked",
      projectId: task.projectId,
      taskId: task.id,
      data: { capacityAction: decision.capacityAction, reason: selection.reason, revision: task.resultRevision },
    });
    this.blockTask(task, this.providerBlockClass(selection), reason);
  }

  /** Resume reviews deferred for capacity once an eligible provider is free. */
  private async resumePendingReviews(): Promise<void> {
    if (this.records.listRunningAttempts().length >= this.options.workerLimit) return;
    for (const task of this.records.listTasks({ state: "BLOCKED" })) {
      if (!task.blockedReason?.startsWith(REVIEW_PENDING_PREFIX)) continue;
      if (!task.resultRevision || !task.worktreePath) continue;
      const project = this.records.getProject(task.projectId);
      if (!project || project.status !== "active") continue;
      const implementer = this.records.listAttempts(task.id).findLast((attempt) => attempt.kind !== "review");
      const excluded = project.reviewPolicy.reviewerRoute === "independent_provider" ? implementer?.adapter : undefined;
      const selection = this.selectReviewRoute(task, excluded);
      if (!selection.chosen) continue;
      const reviewing = this.records.transition(task.id, "REVIEWING", { blocked_reason: null, failure_class: null }, {
        reason: "review capacity became available; resuming the outstanding review",
        revision: task.resultRevision,
      });
      await this.launchAttempt(reviewing, project, "review", this.priorReviewFindings(reviewing), ids.launch(), selection);
      if (this.records.listRunningAttempts().length >= this.options.workerLimit) return;
    }
  }

  private async collectReview(
    task: Task,
    attempt: Attempt,
    output: WorkerOutput,
    resultArtifact: string,
    usage: Record<string, unknown> | null,
    exitStatus: number,
  ): Promise<void> {
    const revision = task.resultRevision;
    if (!task.worktreePath || !revision) {
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass: "CONFIG", reason: "Review task has no checked revision.", usage });
      this.blockTask(task, "CONFIG", "Independent review has no checked revision to inspect.");
      return;
    }
    const currentRevision = await workspaceRevision(task.worktreePath);
    const reviewEdits = await workspaceChangedFiles(task.worktreePath, revision);
    if (currentRevision !== revision || reviewEdits.length > 0) {
      const reason = `Read-only reviewer modified or moved the checked workspace: ${reviewEdits.join(", ") || `${revision} -> ${currentRevision}`}`;
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass: "CONTRACT", reason, usage, outputPath: existsSync(resultArtifact) ? resultArtifact : undefined });
      this.blockTask(task, "CONTRACT", reason);
      return;
    }

    const project = this.records.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project ${task.projectId}`);
    const required = this.records.listRequirements(task.projectId).filter((requirement) => requirement.mandatory).map((requirement) => requirement.id);
    const missingCoverage = required.filter((requirement) => !output.addressed_requirements.includes(requirement));
    const reported = [
      ...output.follow_up.unresolved,
      ...output.follow_up.decisions_requested.map((decision) => `[major] Decision required: ${decision}`),
      ...missingCoverage.map((requirement) => `[major] Review did not verify mandatory requirement ${requirement}.`),
    ];
    if (output.outcome === "failed" && reported.length === 0) reported.push(`[major] ${output.reason || output.summary}`);
    // Minor suggestions are retained as advice; only blocking severities send
    // the task back for repair. An unfinished review is never disguised as
    // approval: a blocked outcome stays blocked.
    const classified = classifyFindings(reported, project.reviewPolicy.blockingSeverities);
    const findings = classified.all;
    const verdict = output.outcome === "blocked" ? "blocked" : classified.blocking.length > 0 ? "request_changes" : "approved";
    const review = this.records.recordReview({
      taskId: task.id,
      attemptId: attempt.id,
      revision,
      verdict,
      summary: output.summary,
      findings,
      blockingFindings: classified.blocking,
      advisoryFindings: classified.advisory,
      requirementsChecked: output.addressed_requirements,
      evidencePath: existsSync(resultArtifact) ? resultArtifact : null,
      policyVersion: project.reviewPolicy.version,
      contextFingerprint: this.records.reviewContextFingerprint(task.id),
    });
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: attempt.id, kind: `review_${verdict}`, summary: output.summary,
      resultRevision: revision, changedFiles: this.records.changedFilesForTask(task.id), findings,
      unresolved: output.follow_up.decisions_requested,
      nextAction: verdict === "approved"
        ? classified.advisory.length > 0
          ? `Complete task. ${classified.advisory.length} advisory finding(s) recorded without blocking acceptance.`
          : "Complete task."
        : verdict === "request_changes" ? "Repair blocking review findings and rerun checks." : output.follow_up.next_step,
      evidence: [review.evidencePath].filter((path): path is string => path !== null),
    });
    this.records.finishAttempt({
      attemptId: attempt.id,
      state: "succeeded",
      outcome: output.outcome,
      reason: output.reason,
      exitStatus,
      resultRevision: revision,
      usage,
      outputPath: existsSync(resultArtifact) ? resultArtifact : undefined,
    });

    if (verdict === "blocked") {
      this.records.transition(task.id, "BLOCKED", {
        blocked_reason: `Independent review blocked: ${output.reason}`,
        claimed_by: null,
        claimed_at: null,
      });
      return;
    }
    if (verdict === "approved") {
      const done = this.records.transition(task.id, "DONE", {
        claimed_by: null,
        claimed_at: null,
        blocked_reason: null,
        failure_class: null,
      }, { reviewId: this.records.reviewsForTask(task.id).at(-1)?.id, revision, advisoryFindings: classified.advisory });
      this.records.completeFeedbackForTask(task.id, done.resultSummary ?? output.summary);
      return;
    }

    const current = this.records.getTask(task.id) as Task;
    if (current.repairsUsed >= current.repairLimit) {
      this.records.transition(task.id, "FAILED", {
        failure_class: "CODE",
        blocked_reason: `Independent review found blocking changes after the repair limit was exhausted: ${classified.blocking.join("; ")}`,
        claimed_by: null,
        claimed_at: null,
      });
      return;
    }
    this.records.transition(task.id, "RUNNING", {
      repairs_used: current.repairsUsed + 1,
      claimed_by: null,
      claimed_at: null,
    }, { reason: "independent review requested changes", findings: classified.blocking, advisory: classified.advisory });
    await this.launchAttempt(this.records.getTask(task.id) as Task, project, "repair", [
      ...classified.blocking,
      ...classified.advisory.map((finding) => `${finding} (advisory: optional, does not block acceptance)`),
    ]);
  }

  private async handleReviewFailure(task: Task, failure: FailureClass, reason: string, failedAdapter: string): Promise<void> {
    const current = this.records.getTask(task.id) ?? task;
    const latestAttempt = this.records.listAttempts(task.id).at(-1);
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: latestAttempt?.id, kind: "review_failed",
      summary: `${failure}: ${reason}`, resultRevision: current.resultRevision,
      findings: [reason], nextAction: isProviderUnavailable(failure)
        ? "Run a fresh independent review with another eligible subscription provider."
        : "Resolve the review blocker before completion.",
      evidence: latestAttempt?.outputPath ? [latestAttempt.outputPath] : [],
    });
    if (isProviderUnavailable(failure)) {
      this.records.noteProviderFailure(failedAdapter, failure, reason, this.options.quotaCooldownMs);
      const project = this.records.getProject(current.projectId);
      if (!project) throw new Error(`Unknown project ${current.projectId}`);
      const selection = this.selectReviewRoute(current, failedAdapter);
      if (selection.chosen) {
        this.records.transition(current.id, "REVIEWING", {}, {
          reason: "review provider unavailable; rerouting without spending repair budget",
          failedAdapter,
          fallback: selection.chosen.adapter,
        });
        await this.launchAttempt(this.records.getTask(current.id) as Task, project, "review", [reason], ids.launch(), selection);
        return;
      }
    }
    this.blockTask(current, failure, `Independent review failed: ${reason}`);
  }

  private async handleFailure(task: Task, failure: FailureClass, reason: string, failedAdapter: string): Promise<void> {
    const current = this.records.getTask(task.id) ?? task;
    const latestAttempt = this.records.listAttempts(task.id).at(-1);
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: latestAttempt?.id, kind: "attempt_failed",
      summary: `${failure}: ${reason}`, baseRevision: latestAttempt?.baseRevision ?? null,
      findings: [reason], nextAction: isProviderUnavailable(failure)
        ? "Retry with an eligible subscription provider when capacity is available."
        : consumesRepairBudget(failure) ? "Repair the reported failure without repeating the rejected approach." : "Resolve the operational blocker.",
      evidence: latestAttempt?.outputPath ? [latestAttempt.outputPath] : [],
    });
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
      this.records.listTasks().filter((task) => task.state === "RUNNING" || task.state === "REVIEWING").map((task) => task.projectId),
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
    const running = this.records.listTasks({ projectId: task.projectId })
      .filter((candidate) => candidate.state === "RUNNING" || candidate.state === "REVIEWING");
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
    const reviewArtifacts: string[] = [];
    if (kind === "review") {
      if (!task.resultRevision) throw new Error(`Task ${task.id} has no result revision to review`);
      const diffPath = join(dir, "review-diff.patch");
      writeFileSync(diffPath, await workspaceDiff(task.worktreePath, task.baseRevision, task.resultRevision), { mode: 0o600 });
      reviewArtifacts.push(diffPath);
      // A re-review after a repair gets the repair delta as well, but only
      // while the reviewed context still matches. After meaningful drift the
      // full change is reviewed again instead of just the increment.
      const prior = this.records.reviewsForTask(task.id).findLast((review) => review.revision !== task.resultRevision);
      if (prior && project.reviewPolicy.scope === "change") {
        const fingerprint = this.records.reviewContextFingerprint(task.id);
        if (prior.contextFingerprint === null || prior.contextFingerprint === fingerprint) {
          const deltaPath = join(dir, "review-delta.patch");
          writeFileSync(deltaPath, await workspaceDiff(task.worktreePath, prior.revision, task.resultRevision), { mode: 0o600 });
          reviewArtifacts.push(deltaPath);
        } else {
          this.records.recordEvent({
            kind: "review.scope_broadened",
            projectId: project.id,
            taskId: task.id,
            data: {
              priorRevision: prior.revision,
              revision: task.resultRevision,
              reason: "Requirements, policy, configuration, or dependency revisions changed since the prior review.",
            },
          });
        }
      }
      reviewArtifacts.push(
        ...this.records.gatesForRevision(task.id, task.resultRevision)
          .map((gate) => gate.evidencePath)
          .filter((path): path is string => path !== null),
      );
    }
    const packet = buildContextPacket({
      records: this.records,
      project,
      task,
      attemptId,
      workspace: {
        path: task.worktreePath,
        branch: task.branch,
        baseRevision: kind === "review" ? (task.resultRevision as string) : task.baseRevision,
      },
      execution,
      previousFindings,
      purpose: kind === "review" ? "review" : "implementation",
      additionalArtifacts: reviewArtifacts,
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
      baseRevision: kind === "review" ? task.resultRevision : task.baseRevision,
      packetId: packet.id,
      outputPath: completionPath,
      promptVersion: WORKER_PROMPT_VERSION,
      skillVersions: guidanceForAttempt(task, kind),
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
    const staleHeartbeats = this.records.staleHeartbeatAttempts(this.options.heartbeatStaleMs);
    const staleIds = new Set(staleHeartbeats.map((item) => item.attemptId));
    for (const id of this.reportedStaleHeartbeats) if (!staleIds.has(id)) this.reportedStaleHeartbeats.delete(id);
    this.records.writeHealth({
      id: this.options.controllerId,
      pid: process.pid,
      startedAt: this.startedAt,
      loopDelayMs: Math.round(loopDelayMs),
      dbErrors: this.failedTicks,
      queueDepth: ready.length,
      oldestReadyAgeS: Math.round(oldest),
      oldestClaimAgeS: Math.round(oldestClaim),
      activeWorkers: running.length,
      workerLimit: this.options.workerLimit,
      slotUtilization: this.options.workerLimit === 0 ? 0 : running.length / this.options.workerLimit,
      uptimeS: Math.round((Date.now() - Date.parse(this.startedAt)) / 1000),
      providerStatus,
      backpressureReason: this.backpressureReason,
      staleHeartbeatWorkers: staleHeartbeats.length,
      state: effectiveState,
    });
    for (const stale of staleHeartbeats) {
      if (this.reportedStaleHeartbeats.has(stale.attemptId)) continue;
      this.reportedStaleHeartbeats.add(stale.attemptId);
      this.records.recordEvent({
        kind: "worker.heartbeat_stale",
        projectId: stale.projectId,
        taskId: stale.taskId,
        attemptId: stale.attemptId,
        data: { ageMs: stale.ageMs, thresholdMs: this.options.heartbeatStaleMs, note: "Investigate before assuming failure; a long tool run may still be active." },
      });
    }
  }
}
