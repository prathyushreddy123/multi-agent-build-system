import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { defaultAdapters } from "../adapters/harness.ts";
import type { AdapterHandle, CollectedResult, WorkerAdapter } from "../adapters/types.ts";
import { ContextBudgetExceededError, buildContextPacket, type ContextPacket, type ExecutionSelection } from "../context/packet.ts";
import {
  consumesRepairBudget,
  diagnoseFailure,
  failureClassForCategory,
  isProviderUnavailable,
  type FailureClass,
  type FailureDiagnosis,
} from "../core/failure.ts";
import { ids } from "../core/ids.ts";
import { scopesOverlap } from "../domain/plan.ts";
import { requireProjectReadiness } from "../domain/project-policy.ts";
import type { WorkerOutput } from "../domain/contract.ts";
import { artifactDir, stateDir } from "../core/paths.ts";
import {
  QUALITY_COVERAGE_GATE,
  collectGateJob,
  gateJobHandle,
  gateJobStatus,
  launchGateJob,
} from "../gates/runner.ts";
import { preflightWorktree } from "../environment/preflight.ts";
import { describeReviewPolicy, evaluateReviewPolicy, triageReviewOutput } from "../review/policy.ts";
import type { ReviewDecision, ReviewItem, ReviewerRoute } from "../review/policy.ts";
import { WORKER_PROMPT_VERSION, guidanceForAttempt } from "../prompts/versions.ts";
import { DEFAULT_ROUTING_POLICY, selectRoute } from "../routing/router.ts";
import { BoundedTelemetryQueue, type TelemetrySink } from "../telemetry/sink.ts";
import {
  AdaptiveConcurrency,
  canonicalRepoKey,
  collectActiveWork,
  evaluateAdmission,
  fairOrder,
  type ActiveWork,
  type SchedulingLimits,
  type WorkKind,
} from "../scheduling/admission.ts";
import type { AdmissionExplanation } from "../scheduling/types.ts";
import { readProgress, telemetryGap } from "../telemetry/stream.ts";
import {
  DEFAULT_CAPABILITY_REGISTRY,
  DISABLED_DELEGATION,
  evaluateCapability,
  quotaDomainsFor,
  type CapabilityRegistry,
} from "../routing/capabilities.ts";
import type { RouteCandidate, RouteSelection, RoutingPolicy } from "../routing/router.ts";
import { trialBindingForTask, trialLaunchRefusal, type TrialBinding } from "../optimization/experiments.ts";
import type { Attempt, GateResult, GateSpec, Project, Records, Task } from "../store/records.ts";
import type { ExecutionEpisode, ExecutionStage, StageRun, TaskObligation } from "../domain/execution.ts";
import { finalizeWorkspace, integrateDependencyRevisions, prepareWorkspace, workspaceChangedFiles, workspaceContainsRevision, workspaceDiff, workspaceRevision } from "../workspace/git.ts";

import { assertNoMaintenance, MaintenanceInProgressError } from "../maintenance/lock.ts";
import { ADMISSION_PENDING_PREFIX, IN_FLIGHT_BLOCKED_PREFIXES, REVIEW_PENDING_PREFIX, REVIEW_RECOVERY_PREFIX } from "../domain/states.ts";
export { ADMISSION_PENDING_PREFIX, REVIEW_PENDING_PREFIX, REVIEW_RECOVERY_PREFIX };
/** Ready tasks inspected per tick; bounded so a long queue cannot stall a tick. */
const READY_SCAN_LIMIT = 200;
const ENGINE_REVISION = "mabs.controller.stage.v1";

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

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
  capabilityRegistry?: CapabilityRegistry;
  /** `wait` keeps a busy preferred route rather than moving to a free fallback provider. */
  capacityFallback?: "allow" | "wait";
  controllerId?: string;
  adapters?: Map<string, WorkerAdapter>;
  /** Optional export fan-out; disabled by default and never able to stop execution. */
  telemetry?: TelemetrySink;
  /** Concurrent check jobs, capped separately from model workers. */
  gateLimit?: number;
  /**
   * How long a launched check job may take to write its launch marker before
   * the launch is treated as ambiguous. Deliberately separate from the
   * controller lease timeout, which governs a different question.
   */
  launchMarkerGraceMs?: number;
  /** Opt-in: lower the model-worker target under pressure, raise it after a healthy streak. */
  adaptiveConcurrency?: { raiseAfterHealthyTicks?: number };
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
    capacityFallback: "allow" | "wait";
    gateLimit: number;
    launchMarkerGraceMs: number;
  };
  readonly adapters: Map<string, WorkerAdapter>;
  readonly routingPolicy: RoutingPolicy;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly telemetry: TelemetrySink;
  private readonly firstOutputSeen = new Set<string>();
  readonly adaptive: AdaptiveConcurrency | null;
  /** Last admission decision per task, for `scheduler explain` and deduplicated events. */
  readonly admissionExplanations = new Map<string, AdmissionExplanation & { kind: WorkKind; at: string }>();
  private readonly repoKeys = new Map<string, string>();
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
      capacityFallback: options.capacityFallback ?? "allow",
      gateLimit: options.gateLimit ?? Math.max(2, workerLimit),
      launchMarkerGraceMs: options.launchMarkerGraceMs ?? 30_000,
    };
    this.capabilityRegistry = options.capabilityRegistry ?? DEFAULT_CAPABILITY_REGISTRY;
    this.adapters = options.adapters ?? defaultAdapters(this.capabilityRegistry);
    this.routingPolicy = options.routingPolicy ?? DEFAULT_ROUTING_POLICY;
    this.telemetry = options.telemetry ?? new BoundedTelemetryQueue();
    this.adaptive = options.adaptiveConcurrency
      ? new AdaptiveConcurrency(this.options.workerLimit, { raiseAfterHealthyTicks: options.adaptiveConcurrency.raiseAfterHealthyTicks })
      : null;
    this.preferredAdapter = options.defaultAdapter ?? null;
    if (!Number.isSafeInteger(this.options.workerLimit) || this.options.workerLimit < 1) throw new Error("Worker limit must be a positive integer");
    if (!Number.isSafeInteger(this.options.perProjectWorkerLimit) || this.options.perProjectWorkerLimit < 1) throw new Error("Per-project worker limit must be a positive integer");
    if (!Number.isSafeInteger(this.options.activeProjectLimit) || this.options.activeProjectLimit < 1) throw new Error("Active-project limit must be a positive integer");
    if (!Number.isSafeInteger(this.options.gateLimit) || this.options.gateLimit < 1) throw new Error("Gate limit must be a positive integer");
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
      // Migration holds this lock from its drain check until the upgrade ends.
      assertNoMaintenance(this.records.store.path);
      if (!this.records.acquireControllerLease(this.options.controllerId, process.pid, this.options.leaseTimeoutMs)) {
        const lease = this.records.currentControllerLease();
        throw new ControllerLeaseHeldError(
          (lease?.controller_id as string | null) ?? null,
          lease?.pid === undefined || lease?.pid === null ? null : Number(lease.pid),
        );
      }
      await this.reconcileAttempts();
      await this.reconcileGateStages();
      this.observePressure();
      // In-flight work resumes before new work is admitted.
      await this.resumeAdmissionPending();
      await this.resumePendingReviews();
      this.promoteTasks();
      await this.dispatchReadyTasks();
      // Give newly spawned, very short deterministic checks one bounded
      // collection opportunity. Long checks remain detached and never hold the
      // controller beyond this small grace window.
      await this.reconcileGateStages();
      this.writeHealth(loopDelayMs, "running");
      // Export is detached from the loop: a slow or failing exporter can
      // neither delay nor fail a tick.
      if (this.telemetry instanceof BoundedTelemetryQueue) {
        void this.telemetry.flush();
        const stats = this.telemetry.stats();
        if (stats.exporter) {
          try {
            writeFileSync(join(stateDir(), "telemetry-status.json"), JSON.stringify({ at: new Date().toISOString(), controllerId: this.options.controllerId, ...stats }, null, 2), { mode: 0o600 });
          } catch { /* status is informational; it never fails a tick */ }
        }
      }
    } catch (error) {
      this.failedTicks += 1;
      // A lease loss is not this controller's health to report: the holder owns
      // the health row, and overwriting it with "degraded" would misreport a
      // healthy peer as broken.
      if (error instanceof ControllerLeaseHeldError) this.steppedDown = error;
      // Maintenance owns the database: write nothing, not even health.
      else if (error instanceof MaintenanceInProgressError) { /* retried next tick */ }
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
    // Close every stage the task still owns and release its admission leases,
    // so cancellation leaves no capacity held and no stage unresolved.
    for (const stage of this.records.listActiveStageRuns().filter((item) => item.taskId === taskId)) {
      const current = this.records.getTask(taskId) as Task;
      this.finishStage(stage, { state: "cancelled", failureClass: "CANCELLED", failureDetail: "task cancelled", taskState: current.state });
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
    const excludedQuotaDomains = new Set<string>();
    if (task.failureClass !== null && isProviderUnavailable(task.failureClass)) {
      const failedAttempt = this.records.listAttempts(task.id).findLast((attempt) =>
        attempt.state === "failed" && attempt.failureClass !== null && isProviderUnavailable(attempt.failureClass),
      );
      if (failedAttempt) {
        exclusions.add(failedAttempt.adapter);
        // Exhausted quota belongs to the account, not the model: every route
        // in that domain is excluded, so a model switch cannot pretend to
        // restore capacity.
        if (failedAttempt.failureClass === "QUOTA") {
          for (const domain of quotaDomainsFor(this.capabilityRegistry, failedAttempt.adapter)) excludedQuotaDomains.add(domain);
        }
      }
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
      excludedQuotaDomains,
      availableTools,
      capabilityRegistry: this.capabilityRegistry,
      delegation: DISABLED_DELEGATION,
      capacityFallback: this.options.capacityFallback,
    });
    // A live experiment trial runs exactly its variant's route: no project or
    // operator override may substitute another model into the measurement.
    const trial = task.taskClass === "review" ? null : trialBindingForTask(this.records, task.id);
    if (trial) return this.applyTrialRoute(selection, trial);
    const projectOverride = this.records.getProject(task.projectId)?.routingOverrides[task.taskClass];
    if (projectOverride) {
      const eligibleOverride = selection.eligible.find((candidate) =>
        candidate.adapter === projectOverride.adapter &&
        candidate.model === projectOverride.model &&
        candidate.effort === projectOverride.effort,
      );
      if (eligibleOverride) {
        selection.chosen = eligibleOverride;
        selection.quotaDomain = evaluateCapability(this.capabilityRegistry, {
          provider: eligibleOverride.adapter, model: eligibleOverride.model, effort: eligibleOverride.effort,
        }).evidence.quotaDomain;
        selection.reason += ` Project configuration selected verified ${task.taskClass} route ${eligibleOverride.adapter}:${eligibleOverride.model ?? "default"}.`;
      } else {
        selection.reason += ` Configured ${task.taskClass} route was not currently eligible; retained the eligible policy fallback.`;
      }
    }
    if (selection.chosen?.adapter === this.options.defaultAdapter && (this.options.defaultModel || this.options.defaultEffort)) {
      const overridden: RouteCandidate = {
        ...selection.chosen,
        model: this.options.defaultModel ?? selection.chosen.model,
        effort: this.options.defaultEffort ?? selection.chosen.effort,
      };
      // An operator override is still a request, not an entitlement: an
      // unsupported effort or unknown model launches nothing.
      const evaluation = evaluateCapability(this.capabilityRegistry, {
        provider: overridden.adapter, model: overridden.model, effort: overridden.effort, delegation: DISABLED_DELEGATION,
      });
      selection.eligibility.push(evaluation.evidence);
      if (!evaluation.evidence.eligible) {
        selection.rejected.push({ candidate: overridden, reason: `capability ineligible: ${evaluation.evidence.reasons.join("; ")}` });
        selection.chosen = null;
        selection.quotaDomain = null;
        selection.decision = "no_route";
        selection.reason = `Operator route override rejected before launch: ${evaluation.evidence.reasons.join("; ")}.`;
        return selection;
      }
      selection.chosen = overridden;
      selection.quotaDomain = evaluation.evidence.quotaDomain;
    }
    if (selection.chosen && (this.preferredAdapter || this.options.defaultModel || this.options.defaultEffort)) {
      selection.reason += ` Operator override: adapter=${this.preferredAdapter ?? "policy"}, model=${this.options.defaultModel ?? "policy"}, effort=${this.options.defaultEffort ?? "policy"}.`;
    }
    return selection;
  }

  private applyTrialRoute(selection: RouteSelection, trial: TrialBinding): RouteSelection {
    const applied = trial.appliedConfig as { adapter?: string; model?: string | null; effort?: string | null };
    if (!applied.adapter && applied.model === undefined && applied.effort === undefined) return selection;
    const base = selection.chosen ?? selection.eligible[0] ?? null;
    const adapter = applied.adapter ?? base?.adapter;
    if (!adapter) return selection;
    const inherited = base && base.adapter === adapter ? base : null;
    const pinned: RouteCandidate = {
      adapter,
      model: applied.model !== undefined ? applied.model : inherited?.model ?? null,
      effort: applied.effort !== undefined ? applied.effort : inherited?.effort ?? null,
      reason: `Experiment ${trial.experimentId} ${trial.variant} trial route.`,
    };
    const evaluation = evaluateCapability(this.capabilityRegistry, {
      provider: pinned.adapter, model: pinned.model, effort: pinned.effort, delegation: DISABLED_DELEGATION,
    });
    selection.eligibility.push(evaluation.evidence);
    if (!evaluation.evidence.eligible || !this.adapters.has(pinned.adapter)) {
      const why = evaluation.evidence.eligible ? `adapter ${pinned.adapter} is not configured` : evaluation.evidence.reasons.join("; ");
      selection.chosen = null;
      selection.quotaDomain = null;
      selection.decision = "no_route";
      selection.reason = `Trial route ${pinned.adapter}:${pinned.model ?? "?"}@${pinned.effort ?? "?"} cannot launch: ${why}.`;
      return selection;
    }
    // A pinned provider in cooldown waits; it never falls back to another
    // route. Concurrency caps are enforced by admission like any launch.
    const capacity = this.records.listProviderCapacity().find((provider) => provider.provider === pinned.adapter);
    if (capacity && capacity.state !== "available") {
      selection.chosen = null;
      selection.deferred = [pinned];
      selection.decision = "capacity_wait";
      selection.reason = `Trial route ${pinned.adapter} is ${capacity.state}; the trial waits rather than change route.`;
      return selection;
    }
    selection.chosen = pinned;
    selection.quotaDomain = evaluation.evidence.quotaDomain;
    selection.reason += ` Pinned to experiment ${trial.experimentId} ${trial.variant} route ${pinned.adapter}:${pinned.model}@${pinned.effort}.`;
    return selection;
  }

  /**
   * Honor the recorded reviewer route. `independent_provider` excludes the
   * implementer's provider and never falls back to it: when no other provider
   * is eligible, the review waits or blocks under the policy's capacity
   * action. Only an explicitly chosen `same_provider_fresh_context` policy may
   * use the implementer's provider, always in a fresh session.
   */
  private selectReviewRoute(task: Task, route: ReviewerRoute, implementerAdapter?: string, failedAdapter?: string): RouteSelection {
    const reviewTask: Task = { ...task, role: "reviewer", taskClass: "review", requiredTools: [] };
    const excluded = new Set<string>();
    if (route === "independent_provider" && implementerAdapter) excluded.add(implementerAdapter);
    if (failedAdapter) excluded.add(failedAdapter);
    const selection = this.selectTaskRoute(reviewTask, excluded);
    if (!selection.chosen && route === "independent_provider" && implementerAdapter) {
      selection.reason += ` Reviewer policy requires a provider other than ${implementerAdapter}; same-provider review is not substituted.`;
    }
    if (selection.chosen && route === "same_provider_fresh_context" && selection.chosen.adapter === implementerAdapter) {
      selection.reason += ` Explicit same-provider policy: fresh, separate review session on ${selection.chosen.adapter}.`;
    }
    return selection;
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

  private ensureEpisode(task: Task): ExecutionEpisode {
    const continuation = this.records.getContinuation(task.id);
    if (continuation.episode?.status === "active") return continuation.episode;
    return this.records.createExecutionEpisode({
      taskId: task.id,
      expectedTaskVersion: continuation.taskVersion,
      repairLimit: task.repairLimit,
      recoveryLimit: 2,
    });
  }

  private reserveStage(
    task: Task,
    stage: ExecutionStage,
    launchKey: string,
    input: unknown,
    options: {
      revision?: string | null;
      environmentFingerprint?: string | null;
      consumeRepair?: boolean;
      consumeRecovery?: boolean;
    } = {},
  ): StageRun {
    const existing = this.records.stageByLaunchKey(launchKey);
    if (existing) return existing;
    const episode = this.ensureEpisode(this.records.getTask(task.id) ?? task);
    const current = this.records.getTask(task.id) as Task;
    return this.records.reserveStage({
      taskId: task.id,
      episodeId: episode.id,
      stage,
      ordinal: this.records.stageRunsForTask(task.id).length + 1,
      launchKey,
      inputFingerprint: fingerprint(input),
      revision: options.revision ?? null,
      environmentFingerprint: options.environmentFingerprint ?? null,
      engineRevision: ENGINE_REVISION,
      expectedTaskVersion: current.recordVersion,
      consumeRepair: options.consumeRepair,
      consumeRecovery: options.consumeRecovery,
    });
  }

  private releaseStageAdmission(stage: StageRun, reason: string): void {
    const lease = this.records.admissionForStage(stage.id);
    if (lease && (lease.status === "reserved" || lease.status === "active")) {
      this.records.releaseAdmission(lease.id, lease.fencingToken, reason);
    }
  }

  private finishStage(stage: StageRun, outcome: Parameters<Records["finishStage"]>[2]): StageRun {
    this.releaseStageAdmission(stage, outcome.state === "succeeded" ? "stage complete" : outcome.failureDetail ?? outcome.state);
    return this.records.finishStage(stage.id, stage.fencingToken, outcome);
  }

  private recordObligationOnce(input: Parameters<Records["recordObligation"]>[0]): TaskObligation {
    const existing = this.records.getContinuation(input.taskId).openObligations.find((item) => item.sourceKey === input.sourceKey);
    return existing ?? this.records.recordObligation(input);
  }

  private async runPreflight(task: Task, project: Project, launchId: string, consumeRecovery = false): Promise<boolean> {
    const current = this.records.getTask(task.id) as Task;
    const launchKey = `${launchId}:preflight`;
    for (const prior of this.records.listActiveStageRuns()) {
      if (prior.taskId === current.id && prior.stage === "preflight" && prior.launchKey !== launchKey &&
          (prior.state === "waiting" || prior.state === "unknown")) {
        this.finishStage(prior, {
          state: "failed",
          failureClass: prior.failureClass,
          failureDetail: "Superseded by an explicitly retried preflight stage.",
          taskState: current.state,
        });
      }
    }
    const stage = this.reserveStage(current, "preflight", launchKey, {
      worktreePath: current.worktreePath,
      revision: current.baseRevision,
      checks: project.checkCommands,
    }, { revision: current.baseRevision, consumeRecovery });
    if (!current.worktreePath) {
      this.finishStage(stage, { state: "waiting", failureClass: "CONFIG", failureDetail: "Prepared worktree path is missing." });
      return false;
    }
    if (stage.state === "reserved" || stage.state === "launching") {
      this.records.recordLaunchStarted(stage.id, stage.fencingToken);
    }
    const result = preflightWorktree({
      worktreePath: current.worktreePath,
      expected: {
        branch: current.branch,
        baseRevision: current.baseRevision,
        dependencyRevisions: this.records.dependenciesOf(current.id)
          .map((id) => this.records.getTask(id)?.resultRevision)
          .filter((revision): revision is string => Boolean(revision)),
        allowedDirtyPaths: [],
      },
      capabilityPolicy: {
        version: ENGINE_REVISION,
        workerCheckCommands: [],
        controllerCheckRunner: true,
        permissions: { worktreeRead: true, outputWrite: true },
      },
      outputPaths: [artifactDir(current.id, "preflight")],
    });
    const components = result.components.length > 0
      ? result.components
      : [{ root: ".", profile: "unknown", state: result.state, missingTools: [], setupCommands: [] }];
    for (const component of components) {
      this.records.recordEnvironmentCheck({
        taskId: current.id,
        stageRunId: stage.id,
        component: component.root,
        profile: component.profile,
        revision: result.revision,
        runtimeFingerprint: result.fingerprint,
        lockfileFingerprint: null,
        outcome: component.state === "ready" ? "ready" : component.state === "setup_required" ? "missing" : component.state === "unavailable" ? "mismatch" : "error",
        evidenceRefs: result.evidence.map((item) => item.id),
        setupActionRequired: component.setupCommands[0]?.join(" ") ?? null,
      });
    }
    // Unknown preserves compatibility for repositories with custom/no detected
    // profile. Positive unavailable/setup evidence blocks without launching a model.
    if (result.state === "setup_required" || result.state === "unavailable") {
      const summary = result.evidence.find((item) => item.status === "fail")?.summary ?? `Worktree readiness is ${result.state}.`;
      this.recordObligationOnce({
        taskId: current.id,
        kind: "gate_failure",
        severity: "blocking",
        blocking: true,
        sourceKey: `preflight:${result.fingerprint}`,
        summary,
        introducedRevision: result.revision,
        evidenceRefs: result.evidence.map((item) => item.id),
      });
      this.finishStage(stage, { state: "waiting", failureClass: "CONFIG", failureDetail: summary });
      return false;
    }
    if (result.state === "ready") {
      for (const obligation of this.records.getContinuation(current.id).openObligations) {
        if (obligation.sourceKey.startsWith("preflight:")) {
          this.records.resolveObligation(
            { obligationId: obligation.id, state: "resolved", resolvedRevision: result.revision },
            result.evidence.map((item) => item.id),
          );
        }
      }
    }
    this.finishStage(stage, { state: "succeeded", taskState: "RUNNING" });
    return true;
  }

  /**
   * "waiting" means the recovery is valid but the shared gate cap is full: no
   * state changed, no recovery budget was spent, and a later tick retries it.
   */
  private async retryOperationalCheck(task: Task, project: Project, obligation: TaskObligation): Promise<boolean | "waiting"> {
    if (!task.resultRevision || !task.worktreePath || !obligation.sourceGateId) return false;
    const failedGate = this.records.gatesForRevision(task.id, task.resultRevision).find((gate) => gate.id === obligation.sourceGateId);
    if (!failedGate || failedGate.failureDiagnosis?.consumesCodeRepair) return false;
    const index = project.checkCommands.findIndex((spec) => spec.name === failedGate.name);
    const spec = project.checkCommands[index];
    if (!spec || index < 0) return false;
    // Recovery is a check launch like any other and holds no slot of its own.
    if (!this.admit(task, "gate", null).admitted) return "waiting";
    const current = task.state === "READY"
      ? this.records.transition(task.id, "RUNNING", { blocked_reason: null, failure_class: null }, { reason: "retry operational check stage" })
      : task;
    const priorRuns = this.records.stageRunsForTask(task.id).filter((stage) =>
      stage.stage === "check" && stage.inputFingerprint === this.checkFingerprint(current, spec, index),
    ).length;
    const stage = this.reserveStage(current, "check", `${current.id}:check:${index}:${current.resultRevision}:recovery:${priorRuns}`, {
      revision: current.resultRevision,
      index,
      spec,
    }, {
      revision: current.resultRevision,
      environmentFingerprint: this.records.latestEnvironmentCheck(current.id)?.runtimeFingerprint ?? null,
      consumeRecovery: true,
    });
    const lease = this.records.reserveAdmission({
      stageRunId: stage.id,
      controllerId: this.options.controllerId,
      resources: ["gate", "cpu", `worktree:${current.id}`],
    });
    this.records.activateAdmission(lease.id, lease.fencingToken);
    await launchGateJob({ taskId: current.id, stageRunId: stage.id, worktreePath: task.worktreePath, spec });
    this.records.recordLaunchStarted(stage.id, stage.fencingToken);
    return true;
  }

  private async resumeOperationalTask(task: Task, project: Project): Promise<boolean | "waiting"> {
    const obligations = this.records.getContinuation(task.id).openObligations.filter((item) => item.blocking);
    const recoveryAvailable = (): boolean => {
      const episode = this.records.getContinuation(task.id).episode;
      if (!episode || episode.recoveriesConsumed < episode.recoveryLimit) return true;
      this.blockTask(task, "CONFIG", "The active execution episode exhausted its operational recovery budget.");
      return false;
    };
    const reviewRecovery = obligations.find((item) => item.sourceKey.startsWith("review-recovery:"));
    if (reviewRecovery && task.resultRevision && task.worktreePath) {
      if (!recoveryAvailable()) return true;
      const running = this.records.transition(task.id, "RUNNING", { blocked_reason: null, failure_class: null }, { reason: "explicit review recovery" });
      const checking = this.records.transition(running.id, "CHECKING", {}, { reason: "resume the already finalized revision" });
      const reviewing = this.records.transition(checking.id, "REVIEWING", {}, { reason: "retry only the outstanding review" });
      const implementer = this.records.listAttempts(task.id).findLast((attempt) => attempt.kind !== "review");
      const selection = this.selectReviewRoute(reviewing, project.reviewPolicy.reviewerRoute, implementer?.adapter);
      if (selection.chosen) {
        await this.launchAttempt(reviewing, project, "review", [reviewRecovery.summary], ids.launch(), selection, { consumeRecovery: true });
      }
      else this.blockTask(reviewing, this.providerBlockClass(selection), `${REVIEW_RECOVERY_PREFIX} ${selection.reason}`);
      return true;
    }
    const preflight = obligations.find((item) => item.sourceKey.startsWith("preflight:"));
    if (preflight && task.worktreePath) {
      if (!recoveryAvailable()) return true;
      const running = this.records.transition(task.id, "RUNNING", { blocked_reason: null, failure_class: null }, { reason: "retry environment preflight" });
      const launchId = ids.launch();
      if (!await this.runPreflight(running, project, launchId, true)) return true;
      const current = this.records.getTask(task.id) as Task;
      if (current.resultRevision) await this.scheduleNextCheck(current, project);
      else {
        const selection = this.selectTaskRoute(current);
        if (selection.chosen) await this.launchAttempt(current, project, "initial", [], launchId, selection);
      }
      return true;
    }
    const gate = obligations.find((item) => item.sourceGateId !== null && item.kind === "gate_failure");
    if (gate) {
      if (!recoveryAvailable()) return true;
      return this.retryOperationalCheck(task, project, gate);
    }
    const policyBlocker = obligations.find((item) => item.kind === "decision_needed" || item.kind === "requirement_evidence");
    if (policyBlocker) {
      this.blockTask(task, "CONTRACT", `The task is still waiting on obligation ${policyBlocker.id}: ${policyBlocker.summary}`);
      return true;
    }
    return false;
  }

  private checkFingerprint(task: Task, spec: GateSpec, index: number): string {
    return fingerprint({ revision: task.resultRevision, index, spec });
  }

  private implementationAttempt(taskId: string): Attempt | null {
    return this.records.listAttempts(taskId).findLast((attempt) =>
      attempt.kind !== "review" && attempt.state === "succeeded",
    ) ?? null;
  }

  private async scheduleNextCheck(task: Task, project: Project): Promise<void> {
    const current = this.records.getTask(task.id) as Task;
    if (!current.resultRevision || !current.worktreePath) {
      this.blockTask(current, "CONFIG", "Checks require a finalized revision and recorded worktree.");
      return;
    }
    if (this.records.listActiveStageRuns().some((stage) => stage.taskId === current.id && stage.stage === "check")) return;
    const gates = this.records.gatesForRevision(current.id, current.resultRevision);
    if (project.checkCommands.length === 0) {
      if (!gates.some((gate) => gate.name === QUALITY_COVERAGE_GATE)) {
        const stage = this.reserveStage(current, "check", `${current.id}:check:coverage:${current.resultRevision}`, {
          revision: current.resultRevision,
          coverage: "not_configured",
        }, { revision: current.resultRevision });
        this.records.recordLaunchStarted(stage.id, stage.fencingToken);
        const evidencePath = join(artifactDir(current.id, "controller"), "gate-quality-coverage.log");
        writeFileSync(evidencePath,
          `No required quality checks are configured for this project.\n[revision: ${current.resultRevision}]\n`,
          { mode: 0o600 });
        this.records.recordGate({
          taskId: current.id, attemptId: this.implementationAttempt(current.id)?.id ?? null,
          stageRunId: stage.id, jobId: stage.id, name: QUALITY_COVERAGE_GATE, status: "SKIPPED",
          required: false, command: "", toolVersion: null, revision: current.resultRevision,
          evidencePath, durationMs: 0, waiverId: null, inputFingerprint: stage.inputFingerprint,
        });
        this.finishStage(stage, { state: "succeeded", taskState: "CHECKING" });
      }
      await this.completeChecks(current, project);
      return;
    }
    const next = project.checkCommands
      .map((spec, index) => ({ spec, index, inputFingerprint: this.checkFingerprint(current, spec, index) }))
      .find((item) => !gates.some((gate) => gate.inputFingerprint === item.inputFingerprint));
    if (!next) {
      await this.completeChecks(current, project);
      return;
    }
    const stage = this.reserveStage(current, "check", `${current.id}:check:${next.index}:${current.resultRevision}`, {
      revision: current.resultRevision,
      index: next.index,
      spec: next.spec,
    }, {
      revision: current.resultRevision,
      environmentFingerprint: this.records.latestEnvironmentCheck(current.id)?.runtimeFingerprint ?? null,
    });
    // Over the check-job cap the stage stays reserved; reconcileGateStages
    // launches it once capacity frees, and a restart sees it as active work.
    if (!this.admit(current, "gate", null).admitted) return;
    const lease = this.records.reserveAdmission({
      stageRunId: stage.id,
      controllerId: this.options.controllerId,
      resources: ["gate", "cpu", `worktree:${current.id}`],
    });
    this.records.activateAdmission(lease.id, lease.fencingToken);
    await launchGateJob({ taskId: current.id, stageRunId: stage.id, worktreePath: current.worktreePath, spec: next.spec });
    this.records.recordLaunchStarted(stage.id, stage.fencingToken);
  }

  private async reconcileGateStages(): Promise<void> {
    for (const stage of this.records.listActiveStageRuns().filter((candidate) => candidate.stage === "check")) {
      const task = this.records.getTask(stage.taskId);
      if (!task || !task.resultRevision || !task.worktreePath) continue;
      const project = this.records.getProject(task.projectId);
      if (!project) continue;
      const entry = project.checkCommands
        .map((spec, index) => ({ spec, index, inputFingerprint: this.checkFingerprint(task, spec, index) }))
        .find((item) => item.inputFingerprint === stage.inputFingerprint);
      if (!entry) {
        if (stage.state !== "waiting" && stage.state !== "unknown") {
          this.finishStage(stage, { state: "unknown", failureClass: "CONFIG", failureDetail: "The registered check changed while its stage was active." });
        }
        continue;
      }
      if (stage.state === "waiting" || stage.state === "unknown") continue;
      if (stage.state === "reserved") {
        if (!this.admit(task, "gate", null).admitted) continue;
        let lease = this.records.admissionForStage(stage.id);
        if (!lease) {
          lease = this.records.reserveAdmission({
            stageRunId: stage.id,
            controllerId: this.options.controllerId,
            resources: ["gate", "cpu", `worktree:${task.id}`],
          });
        }
        if (lease.status === "reserved") this.records.activateAdmission(lease.id, lease.fencingToken);
        await launchGateJob({ taskId: task.id, stageRunId: stage.id, worktreePath: task.worktreePath, spec: entry.spec });
        this.records.recordLaunchStarted(stage.id, stage.fencingToken);
        continue;
      }
      const handle = gateJobHandle(task.id, stage.id);
      let status = gateJobStatus(handle);
      const stageAgeMs = Date.now() - Date.parse(stage.startedAt ?? stage.reservedAt);
      if ((status === "running" || status === "unknown") && stageAgeMs < 150) {
        const graceDeadline = Date.now() + 100;
        while ((status === "running" || status === "unknown") && Date.now() < graceDeadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          status = gateJobStatus(handle);
        }
      }
      if (status === "running") continue;
      if (status === "unknown") {
        if (Date.now() - Date.parse(stage.startedAt ?? stage.reservedAt) <= this.options.launchMarkerGraceMs) continue;
        // A launch spec without a trustworthy marker is an ambiguous crash
        // boundary. Never create a second process to make it look recovered.
        this.recordObligationOnce({
          taskId: task.id, kind: "gate_failure", severity: "blocking", blocking: true,
          sourceKey: `check-launch-unknown:${stage.id}`,
          summary: `Check ${entry.spec.name} has an ambiguous launch marker; operator reconciliation is required.`,
          introducedRevision: task.resultRevision,
          evidenceRefs: [handle.specPath],
        });
        this.finishStage(stage, { state: "unknown", failureClass: "INFRA", failureDetail: `Ambiguous launch for check ${entry.spec.name}.` });
        continue;
      }
      if (status === "lost") {
        const detail = `Check job ${entry.spec.name} disappeared before writing a completion envelope.`;
        try { this.records.consumeRecovery(stage.episodeId, stage.id, detail); } catch { /* the bounded limit is reflected by the durable episode */ }
        this.recordObligationOnce({
          taskId: task.id, kind: "gate_failure", severity: "blocking", blocking: true,
          sourceKey: `check-job-lost:${stage.id}`, summary: detail,
          introducedRevision: task.resultRevision, evidenceRefs: [handle.specPath, handle.markerPath],
        });
        this.finishStage(stage, { state: "waiting", failureClass: "INFRA", failureDetail: detail });
        continue;
      }
      const { gate } = collectGateJob({
        records: this.records,
        task,
        attemptId: this.implementationAttempt(task.id)?.id ?? null,
        stageRunId: stage.id,
        revision: task.resultRevision,
        spec: entry.spec,
        environmentFingerprint: stage.environmentFingerprint,
        inputFingerprint: stage.inputFingerprint,
      });
      this.finishStage(stage, { state: "succeeded", taskState: "CHECKING" });
      this.records.recordEvent({
        kind: "gate.collected", projectId: task.projectId, taskId: task.id,
        attemptId: gate.attemptId, data: { stageRunId: stage.id, gateId: gate.id, jobId: stage.id },
      });
      await this.scheduleNextCheck(this.records.getTask(task.id) as Task, project);
    }
  }

  private resolveValidatedGateObligations(taskId: string, revision: string, gates: GateResult[]): void {
    const passing = gates.filter((gate) => gate.status === "PASS");
    if (passing.length === 0) return;
    const allGates = this.records.gatesForTask(taskId);
    for (const obligation of this.records.getContinuation(taskId).openObligations) {
      if (obligation.sourceReviewId !== null) continue;
      if (obligation.sourceGateId !== null && (obligation.kind === "gate_failure" || obligation.kind === "code_defect")) {
        const source = allGates.find((gate) => gate.id === obligation.sourceGateId);
        if (!source) continue;
        const validation = passing.find((gate) =>
          (gate.inputFingerprint != null && gate.inputFingerprint === source.inputFingerprint) ||
          (gate.commandFingerprint != null && gate.commandFingerprint === source.commandFingerprint),
        );
        if (!validation) continue;
        this.records.resolveObligation(
          { obligationId: obligation.id, state: "resolved", resolvedRevision: revision },
          [`gate:${validation.id}:PASS`],
        );
        continue;
      }
      // A worker-reported defect has no source gate. It is cleared only after
      // the repaired revision reaches complete passing gate coverage.
      if (obligation.kind === "code_defect" && obligation.sourceKey.startsWith("attempt:")) {
        this.records.resolveObligation(
          { obligationId: obligation.id, state: "resolved", resolvedRevision: revision },
          passing.map((gate) => `gate:${gate.id}:PASS`),
        );
      }
    }
  }

  private async completeChecks(task: Task, project: Project): Promise<void> {
    const current = this.records.getTask(task.id) as Task;
    if (!current.resultRevision) return;
    const collected = this.records.gatesForRevision(current.id, current.resultRevision);
    const latest = new Map<string, GateResult>();
    for (const gate of collected) latest.set(gate.inputFingerprint ?? gate.name, gate);
    const gates = [...latest.values()];
    const failedRequired = gates.filter((gate) => gate.required && gate.status !== "PASS" && gate.waiverId === null);
    const configured = project.checkCommands.filter((spec) => spec.required).length;
    if (failedRequired.length === 0) {
      this.resolveValidatedGateObligations(current.id, current.resultRevision, gates);
      const notConfigured = configured === 0;
      if (notConfigured) {
        this.records.recordEvent({
          kind: "quality.not_configured", projectId: project.id, taskId: current.id,
          data: { revision: current.resultRevision, note: "No required quality checks are registered for this project." },
        });
      }
      const attempt = this.implementationAttempt(current.id);
      if (!attempt) {
        await this.acceptTask(current, notConfigured ? "Mechanical task has no configured quality coverage." : "Mechanical checks passed.", gates,
          { status: "not_required" });
        return;
      }
      const changedFiles = await workspaceChangedFiles(current.worktreePath as string, current.baseRevision ?? attempt.baseRevision ?? current.resultRevision);
      const diffText = (await workspaceDiff(current.worktreePath as string, current.baseRevision ?? attempt.baseRevision ?? current.resultRevision, current.resultRevision)).slice(0, 400_000);
      const policyDecision = this.reviewDecision(current, project, { changedFiles, diffText });
      // Findings from an earlier review can only be validated by a review; a
      // risk policy that would skip this revision must not strand them.
      const openReviewFindings = this.records.getContinuation(current.id).openObligations
        .filter((item) => item.blocking && item.sourceReviewId !== null && item.kind !== "decision_needed");
      const decision: ReviewDecision = !policyDecision.review && openReviewFindings.length > 0
        ? { ...policyDecision, review: true, reason: `${openReviewFindings.length} open review finding(s) need review validation. ${policyDecision.reason}` }
        : policyDecision;
      this.records.recordEvent({
        kind: "review.decision",
        projectId: project.id,
        taskId: current.id,
        attemptId: attempt.id,
        data: {
          review: decision.review,
          reason: decision.reason,
          matchedRules: decision.matchedRules,
          policy: describeReviewPolicy(project.reviewPolicy),
          changedFiles: changedFiles.length,
        },
      });
      this.records.recordCheckpoint({
        taskId: current.id, attemptId: attempt.id,
        kind: notConfigured ? "quality_not_configured" : "checks_passed",
        summary: notConfigured ? "No required quality checks are configured; this revision has no quality evidence." : `All ${configured} required checks passed.`,
        resultRevision: current.resultRevision, changedFiles,
        findings: notConfigured ? ["[major] Quality coverage is not configured."] : [],
        nextAction: decision.review ? `Run independent revision-bound review. ${decision.reason}` : `Complete task. ${decision.reason}`,
        evidence: gates.map((gate) => gate.evidencePath).filter((path): path is string => path !== null),
      });
      if (decision.review) await this.beginReview(current, project, attempt, decision);
      else await this.acceptTask(current, decision.reason, gates, { status: "not_required" });
      return;
    }

    const findings = failedRequired.map((gate) => `${gate.name}: ${gate.status} (${gate.evidencePath ?? "no evidence"})`);
    for (const gate of failedRequired) {
      this.recordObligationOnce({
        taskId: current.id,
        kind: gate.failureDiagnosis?.category === "product_code" ? "code_defect" : "gate_failure",
        severity: "blocking",
        blocking: true,
        sourceKey: `gate:${gate.id}`,
        summary: `${gate.name}: ${gate.failureDiagnosis?.symptom ?? gate.status}`,
        sourceGateId: gate.id,
        introducedRevision: current.resultRevision,
        evidenceRefs: [gate.evidencePath, gate.jobId ? gateJobHandle(current.id, gate.jobId).completionPath : null].filter((item): item is string => Boolean(item)),
      });
    }
    this.records.recordCheckpoint({
      taskId: current.id, attemptId: this.implementationAttempt(current.id)?.id,
      kind: "checks_failed", summary: "One or more required checks failed.",
      resultRevision: current.resultRevision, findings,
      nextAction: "Repair proven code defects; operational failures retain their obligations for readiness recovery.",
      evidence: failedRequired.map((gate) => gate.evidencePath).filter((path): path is string => path !== null),
    });
    const diagnoses = failedRequired.map((gate) => gate.failureDiagnosis).filter((item): item is FailureDiagnosis => item !== null && item !== undefined);
    const codeFailure = diagnoses.some((item) => item.consumesCodeRepair);
    if (codeFailure && current.repairsUsed < current.repairLimit) {
      this.records.transition(current.id, "RUNNING", { repairs_used: current.repairsUsed + 1 }, { reason: "evidenced required gate defect" });
      await this.launchAttempt(this.records.getTask(current.id) as Task, project, "repair", findings);
      return;
    }
    const diagnosis = diagnoses.find((item) => !item.consumesCodeRepair) ?? diagnoses[0];
    const failure = diagnosis ? failureClassForCategory(diagnosis.category) : codeFailure ? "CODE" : "INFRA";
    if (codeFailure) {
      this.records.transition(current.id, "FAILED", {
        failure_class: failure,
        blocked_reason: `Repair limit exhausted. ${findings.join("; ")}`,
        claimed_by: null,
        claimed_at: null,
      });
    } else if (diagnosis?.category === "unknown") {
      // An unexplained required-check verdict is not evidence of a code defect
      // and must not spend a repair. It is still a terminal unsuccessful run:
      // retain the typed obligation and evidence so only an explicit retry can
      // begin recovery instead of presenting the check as a resumable setup
      // condition.
      this.records.transition(current.id, "FAILED", {
        failure_class: failure,
        blocked_reason: `${diagnosis.recoveryAction} ${findings.join("; ")}`,
        claimed_by: null,
        claimed_at: null,
      });
    } else {
      this.blockTask(current, failure, `${diagnosis?.recoveryAction ?? "Resolve the operational check failure."} ${findings.join("; ")}`);
    }
  }

  /**
   * `review.status` says why acceptance did not need or did get a review.
   * A task accepted with no review required is labeled `not_required`, never
   * approved.
   */
  private async acceptTask(
    task: Task,
    reason: string,
    gates: GateResult[],
    review: { status: "approved" | "not_required"; reviewId?: string },
  ): Promise<void> {
    const current = this.records.getTask(task.id) as Task;
    const blocking = this.records.getContinuation(current.id).openObligations.filter((item) => item.blocking);
    if (blocking.length > 0) {
      this.blockTask(current, "CONTRACT", `Acceptance is waiting on ${blocking.length} durable obligation(s).`);
      return;
    }
    const stage = this.reserveStage(current, "accept", `${current.id}:accept:${current.resultRevision ?? "none"}`, {
      revision: current.resultRevision,
      obligations: [],
      gates: gates.map((gate) => gate.id),
    }, { revision: current.resultRevision });
    this.records.recordLaunchStarted(stage.id, stage.fencingToken);
    this.finishStage(stage, { state: "succeeded" });
    this.records.updateTaskFields(current.id, { claimed_by: null, claimed_at: null });
    const done = this.records.getTask(current.id) as Task;
    this.records.recordEvent({
      kind: "task.accepted", projectId: current.projectId, taskId: current.id,
      data: { reason, stageRunId: stage.id, review: { status: review.status, reviewId: review.reviewId ?? null } },
    });
    this.records.completeFeedbackForTask(current.id, done.resultSummary ?? "Response task completed without a summary.");
  }

  private async reconcileAttempts(): Promise<void> {
    for (const attempt of this.records.listRunningAttempts()) {
      const task = this.records.getTask(attempt.taskId);
      if (!task) continue;
      const adapter = this.adapters.get(attempt.adapter);
      if (!adapter) {
        this.records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass: "CONFIG", reason: "Adapter is no longer configured." });
        if (attempt.kind === "review") {
          await this.handleReviewFailure(task, "CONFIG", `Adapter ${attempt.adapter} is not configured; explicit rerouting is required.`, attempt.adapter);
        } else {
          this.blockTask(task, "CONFIG", `Adapter ${attempt.adapter} is not configured; explicit rerouting is required.`);
        }
        continue;
      }
      const handle = this.handleOf(attempt);
      const status = await adapter.status(handle, { launchGraceMs: this.options.launchMarkerGraceMs });
      if (status === "running") {
        if (attempt.pid === null) this.adoptLaunchedAttempt(task, attempt, adapter, handle);
        this.records.heartbeat(attempt.id);
        this.observeProgress(task, attempt);
        continue;
      }
      // The wrapper may not have identified itself yet; the attempt keeps its
      // stage and admission lease, and no relaunch can overlap it.
      if (status === "launching") continue;
      if (status === "ambiguous") {
        const detail = `Worker for attempt ${attempt.id} was launched but its process can neither be found nor ruled out; ` +
          "its lease is held until an operator confirms it stopped (task cancel).";
        this.recordObligationOnce({
          taskId: task.id, kind: "gate_failure", severity: "blocking", blocking: true,
          sourceKey: `worker-launch-unknown:${attempt.id}`, summary: detail,
          introducedRevision: task.resultRevision ?? task.baseRevision, evidenceRefs: [handle.completionPath],
        });
        this.blockTask(task, "INFRA", detail);
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

    await this.reconcileOrphanStages();

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
      const stage = this.records.getContinuation(task.id).currentStage;
      if (stage && ["reserved", "launching", "running", "waiting", "unknown"].includes(stage.state)) continue;
      this.blockTask(task, "INFRA", `Controller recovered ${task.state} without a live attempt; inspect the preserved worktree before retrying.`);
    }
  }

  /**
   * A crash after spawn but before the PID write leaves a live worker the
   * database cannot name. Adopt it: persist its PID and bind its stage, so the
   * running process keeps its lease and is never relaunched beside itself.
   */
  private adoptLaunchedAttempt(task: Task, attempt: Attempt, adapter: WorkerAdapter, handle: AdapterHandle): void {
    const recovered = adapter.recoverHandle?.(handle);
    if (!recovered || recovered.pid === null) return;
    this.records.setAttemptProcess(attempt.id, recovered.pid, attempt.sessionId);
    const stage = attempt.stageRunId ? this.records.getStageRun(attempt.stageRunId) : null;
    if (stage && (stage.state === "reserved" || stage.state === "launching")) {
      this.records.recordLaunchStarted(stage.id, stage.fencingToken, { attemptId: attempt.id });
    }
    this.records.recordEvent({
      kind: "attempt.process_adopted", projectId: task.projectId, taskId: task.id, attemptId: attempt.id,
      data: { pid: recovered.pid, stageRunId: attempt.stageRunId },
    });
  }

  private async reconcileOrphanStages(): Promise<void> {
    for (const stage of this.records.listActiveStageRuns().filter((candidate) => candidate.stage !== "check")) {
      if (stage.state === "waiting" || stage.state === "unknown") continue;
      const task = this.records.getTask(stage.taskId);
      if (!task) continue;
      const project = this.records.getProject(task.projectId);
      if (!project) continue;
      // A crash before recordLaunchStarted leaves the attempt pointing at its
      // stage but not the reverse; either link binds them.
      const boundAttempt = stage.attemptId
        ? this.records.getAttempt(stage.attemptId)
        : this.records.listAttempts(task.id).find((attempt) => attempt.stageRunId === stage.id) ?? null;
      if (boundAttempt?.state === "running") continue;
      if (boundAttempt && ["implement", "repair", "review"].includes(stage.stage)) {
        this.finishStage(stage, {
          state: boundAttempt.state === "succeeded" ? "succeeded" : boundAttempt.state === "cancelled" ? "cancelled" : "failed",
          failureClass: boundAttempt.failureClass,
          failureDetail: boundAttempt.reason,
          taskState: task.state,
        });
        continue;
      }
      if (stage.stage === "prepare_workspace") {
        try {
          if (stage.state === "reserved" || stage.state === "launching") this.records.recordLaunchStarted(stage.id, stage.fencingToken);
          const workspace = await this.prepareTaskWorkspace(project, task);
          this.records.updateTaskFields(task.id, {
            branch: workspace.branch,
            worktree_path: workspace.path,
            base_revision: workspace.baseRevision,
          });
          this.finishStage(stage, { state: "succeeded", taskState: "RUNNING" });
          const launchId = stage.launchKey.endsWith(":prepare") ? stage.launchKey.slice(0, -":prepare".length) : ids.launch();
          if (await this.runPreflight(this.records.getTask(task.id) as Task, project, launchId)) {
            if (task.taskClass === "mechanical") {
              const revision = await workspaceRevision(workspace.path);
              this.records.transition(task.id, "CHECKING", { result_revision: revision });
              await this.scheduleNextCheck(this.records.getTask(task.id) as Task, project);
            } else {
              const selection = this.selectTaskRoute(this.records.getTask(task.id) as Task);
              if (selection.chosen) await this.launchAttempt(this.records.getTask(task.id) as Task, project, "initial", [], launchId, selection);
            }
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.finishStage(stage, { state: "unknown", failureClass: "INFRA", failureDetail: detail, taskState: "BLOCKED" });
        }
        continue;
      }
      if (stage.stage === "preflight") {
        const launchId = stage.launchKey.endsWith(":preflight") ? stage.launchKey.slice(0, -":preflight".length) : ids.launch();
        if (await this.runPreflight(task, project, launchId) && task.taskClass !== "mechanical") {
          const current = this.records.getTask(task.id) as Task;
          const selection = this.selectTaskRoute(current);
          if (selection.chosen) await this.launchAttempt(current, project, "initial", [], launchId, selection);
        }
        continue;
      }
      if (stage.stage === "finalize") {
        const sourceAttempt = this.records.listAttempts(task.id).findLast((attempt) => attempt.state === "succeeded" && attempt.kind !== "review");
        if (!sourceAttempt || !task.worktreePath) continue;
        const finalized = await finalizeWorkspace(task.worktreePath, task);
        this.records.updateTaskFields(task.id, { result_revision: finalized.revision });
        this.finishStage(stage, { state: "succeeded", taskState: "CHECKING" });
        await this.scheduleNextCheck(this.records.getTask(task.id) as Task, project);
        continue;
      }
      if (stage.stage === "accept") {
        const blockers = this.records.getContinuation(task.id).openObligations.filter((item) => item.blocking);
        if (blockers.length === 0 && stage.revision === task.resultRevision) {
          if (stage.state === "reserved" || stage.state === "launching") {
            this.records.recordLaunchStarted(stage.id, stage.fencingToken);
          }
          this.finishStage(this.records.getStageRun(stage.id) ?? stage, { state: "succeeded" });
          this.records.updateTaskFields(task.id, { claimed_by: null, claimed_at: null });
        } else {
          this.finishStage(stage, {
            state: "waiting",
            failureClass: "CONTRACT",
            failureDetail: "Acceptance reservation no longer matches the revision or durable obligations.",
            taskState: "BLOCKED",
          });
        }
        continue;
      }
      // A reserved provider stage without an attempt may be in the crash window
      // after OS launch. Its status is ambiguous, so fencing forbids relaunch.
      if (!boundAttempt) {
        const detail = `Recovered ${stage.stage} reservation without a bound attempt; launch status is ambiguous.`;
        this.recordObligationOnce({
          taskId: task.id,
          kind: stage.stage === "review" ? "requirement_evidence" : "gate_failure",
          severity: "blocking",
          blocking: true,
          sourceKey: `launch-unknown:${stage.id}`,
          summary: detail,
          introducedRevision: stage.revision,
          evidenceRefs: [],
        });
        this.finishStage(stage, { state: "unknown", failureClass: "INFRA", failureDetail: detail, taskState: "BLOCKED" });
      }
    }
  }

  private async collectAttempt(task: Task, attempt: Attempt, adapter: WorkerAdapter): Promise<void> {
    if (!task.worktreePath) {
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass: "CONFIG", reason: "Task has no worktree path." });
      this.blockTask(task, "CONFIG", "Cannot collect a worker result without its recorded worktree.");
      return;
    }
    const resultArtifact = join(artifactDir(task.id, attempt.id), "worker-result.json");
    const worktreeResult = join(task.worktreePath, ".mabs", "result.json");
    // If a crash happened after preserving the contract result but before the
    // finalization transaction completed, restore only that attempt's envelope
    // long enough for the adapter to validate it again. It is removed before
    // any workspace diff or commit.
    if (!existsSync(worktreeResult) && existsSync(resultArtifact)) copyFileSync(resultArtifact, worktreeResult);
    const collected = await adapter.collectResult(this.handleOf(attempt), task.worktreePath);
    const output = collected.validation.output;
    if (existsSync(worktreeResult)) {
      copyFileSync(worktreeResult, resultArtifact);
    }
    const usage = collected.launch?.usage
      ? { ...collected.launch.usage, reported_model: collected.launch.reportedModel }
      : null;
    this.recordLaunchObservations(task, attempt, collected.launch);

    if ((collected.failureClass && output?.outcome !== "failed") || !collected.validation.ok || !output) {
      const reason = collected.error ?? collected.validation.violations.map((item) => `${item.path}: ${item.message}`).join("; ");
      const diagnosis = diagnoseFailure({
        stage: attempt.kind === "review" ? "review" : "implement",
        source: collected.failureClass === "CONTRACT" || (!collected.failureClass && !collected.validation.ok)
          ? "contract"
          : attempt.kind === "review" ? "review" : "worker",
        exitCode: collected.launch?.exitCode ?? null,
        timedOut: collected.launch?.timedOut ?? false,
        text: reason,
        legacyFailureClass: collected.failureClass,
        evidenceIds: [this.handleOf(attempt).completionPath],
      });
      const failure = collected.failureClass === "CONTRACT" ? "CONTRACT" : failureClassForCategory(diagnosis.category);
      this.records.finishAttempt({
        attemptId: attempt.id,
        state: "failed",
        failureClass: failure,
        reason,
        exitStatus: collected.launch?.exitCode ?? null,
        usage,
        outputPath: existsSync(resultArtifact) ? resultArtifact : undefined,
      });
      if (attempt.stageRunId) {
        const stage = this.records.getStageRun(attempt.stageRunId);
        if (stage && ["reserved", "launching", "running"].includes(stage.state)) {
          this.finishStage(stage, { state: "failed", failureClass: failure, failureDetail: reason, taskState: task.state });
        }
      }
      rmSync(worktreeResult, { force: true });
      if (attempt.kind === "review") await this.handleReviewFailure(task, failure, reason, attempt.adapter);
      else await this.handleFailure(task, failure, reason, attempt.adapter);
      return;
    }

    if (attempt.kind === "review") {
      // The contract envelope is controller plumbing, not a reviewer edit.
      // Remove it before enforcing the reviewer's read-only workspace policy.
      rmSync(worktreeResult, { force: true });
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
      if (attempt.stageRunId) {
        const stage = this.records.getStageRun(attempt.stageRunId);
        if (stage && ["reserved", "launching", "running"].includes(stage.state)) {
          this.finishStage(stage, { state: "waiting", failureClass: "CONTRACT", failureDetail: output.reason, taskState: "BLOCKED" });
        }
      }
      rmSync(worktreeResult, { force: true });
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
      const diagnosis = diagnoseFailure({
        stage: attempt.kind === "repair" ? "repair" : "implement",
        source: "worker",
        exitCode: collected.launch?.exitCode ?? 0,
        timedOut: collected.launch?.timedOut ?? false,
        text: `${output.reason}\n${output.summary}`,
        legacyFailureClass: collected.failureClass,
        evidenceIds: [resultArtifact],
      });
      const failure: FailureClass = failureClassForCategory(diagnosis.category);
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
      if (attempt.stageRunId) {
        const stage = this.records.getStageRun(attempt.stageRunId);
        if (stage && ["reserved", "launching", "running"].includes(stage.state)) {
          this.finishStage(stage, { state: "failed", failureClass: failure, failureDetail: output.reason, taskState: task.state });
        }
      }
      rmSync(worktreeResult, { force: true });
      await this.handleFailure(task, failure, output.reason, attempt.adapter);
      return;
    }

    rmSync(worktreeResult, { force: true });
    const attemptStage = attempt.stageRunId ? this.records.getStageRun(attempt.stageRunId) : null;
    const finalizeStage = this.reserveStage(
      this.records.getTask(task.id) as Task,
      "finalize",
      `${attempt.launchId}:finalize`,
      { attemptId: attempt.id, baseRevision: attempt.baseRevision, worktreePath: task.worktreePath },
    );
    if (finalizeStage.state === "reserved") this.records.recordLaunchStarted(finalizeStage.id, finalizeStage.fencingToken);
    let finalized: Awaited<ReturnType<typeof finalizeWorkspace>>;
    try {
      finalized = await finalizeWorkspace(task.worktreePath, task);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure: FailureClass = detail.startsWith("Worker changed files outside the allowed scope") ? "CONTRACT" : "INFRA";
      const reason = `Could not create the revision to check: ${detail}`;
      this.records.finishAttempt({ attemptId: attempt.id, state: "failed", outcome: output.outcome, failureClass: failure, reason, usage });
      if (["reserved", "launching", "running"].includes(finalizeStage.state)) {
        this.finishStage(finalizeStage, { state: "failed", failureClass: failure, failureDetail: reason, taskState: "BLOCKED" });
      }
      if (attemptStage && ["reserved", "launching", "running"].includes(attemptStage.state)) {
        this.finishStage(attemptStage, { state: "failed", failureClass: failure, failureDetail: reason, taskState: "BLOCKED" });
      }
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
    rmSync(worktreeResult, { force: true });
    if (attemptStage && ["reserved", "launching", "running"].includes(attemptStage.state)) {
      this.finishStage(attemptStage, { state: "succeeded", taskState: "RUNNING" });
    }
    if (attemptStage?.stage === "repair") {
      // The worker's claim is not resolution: review findings move to
      // addressed-pending-validation until a review of this revision confirms.
      for (const obligation of this.records.getContinuation(task.id).openObligations) {
        if (obligation.state !== "open" || obligation.sourceReviewId === null || obligation.kind !== "code_defect") continue;
        this.records.resolveObligation(
          { obligationId: obligation.id, state: "addressed_pending_validation", resolvedRevision: finalized.revision },
          [`attempt:${attempt.id}:repaired@${finalized.revision}`],
        );
      }
    }
    this.records.invalidateApprovals(task.id, "Task revision changed after implementation or repair.", finalized.revision);
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: attempt.id, kind: attempt.kind === "repair" ? "repair_complete" : "implementation_complete",
      summary: output.summary, baseRevision: attempt.baseRevision, resultRevision: finalized.revision,
      changedFiles: finalized.changedFiles, findings: output.follow_up.unresolved,
      unresolved: output.follow_up.decisions_requested, nextAction: output.follow_up.next_step,
      evidence: [resultArtifact, ...output.evidence.artifacts],
    });
    this.records.updateTaskFields(task.id, {
      result_revision: finalized.revision,
      result_summary: output.summary,
      blocked_reason: null,
      failure_class: null,
    });
    this.finishStage(this.records.getStageRun(finalizeStage.id) ?? finalizeStage, { state: "succeeded", taskState: "CHECKING" });
    const project = this.records.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project ${task.projectId}`);
    await this.scheduleNextCheck(this.records.getTask(task.id) as Task, project);
  }

  /**
   * Liveness (the process exists) and progress (the provider emitted events)
   * are separate observations. Only real provider events advance progress.
   */
  private observeProgress(task: Task, attempt: Attempt): void {
    const progress = readProgress(join(dirname(this.handleOf(attempt).completionPath), "progress.json"));
    if (!progress) return;
    if (progress.firstOutputAt && !this.firstOutputSeen.has(attempt.id)) {
      this.firstOutputSeen.add(attempt.id);
      const recorded = this.records.listEventsOfKind(task.id, "attempt.first_output").some((event) => event.attempt_id === attempt.id);
      if (!recorded) {
        this.records.recordEvent({
          kind: "attempt.first_output", projectId: task.projectId, taskId: task.id, attemptId: attempt.id,
          data: { at: progress.firstOutputAt, provider: progress.provider },
        });
      }
    }
    if (progress.lastEventAt && this.records.recordAttemptProgress(attempt.id, progress.lastEventAt)) {
      this.telemetry.emit({
        kind: "attempt.progress", at: progress.lastEventAt, taskId: task.id, attemptId: attempt.id,
        data: { provider: progress.provider, events: progress.events, lastEventType: progress.lastEventType, logBytes: progress.log.bytesWritten },
      });
    }
  }

  /**
   * Provider-reported settings and child-agent activity. Effort is never
   * reported by either harness, so it remains unknown rather than inferred.
   */
  private recordLaunchObservations(task: Task, attempt: Attempt, launch: CollectedResult["launch"]): void {
    if (!launch) return;
    const telemetry = launch.telemetry;
    if (telemetry) {
      const gaps = telemetryGap(telemetry);
      if (telemetry.stdoutTruncated) gaps.push("in-memory stdout copy reached its buffer limit");
      if (telemetry.stderrTruncated) gaps.push("in-memory stderr copy reached its buffer limit");
      if (gaps.length > 0) {
        this.records.recordEvent({
          kind: "telemetry.gap", projectId: task.projectId, taskId: task.id, attemptId: attempt.id,
          data: { gaps, log: telemetry.log, malformedLines: telemetry.malformedLines, events: telemetry.events },
        });
        this.telemetry.emit({ kind: "telemetry.gap", at: new Date().toISOString(), taskId: task.id, attemptId: attempt.id, data: { gaps } });
      }
    }
    this.records.recordReportedSettings(attempt.id, { reportedModel: launch.reportedModel, reportedEffort: null });
    const spawned = launch.delegation?.spawned ?? null;
    if (spawned !== null && spawned > 0) {
      this.records.recordEvent({
        kind: "delegation.policy_violation",
        projectId: task.projectId,
        taskId: task.id,
        attemptId: attempt.id,
        data: {
          spawned,
          source: launch.delegation?.source ?? null,
          policy: "disabled",
          note: "Provider reported native child agents despite the disabled launch policy; their usage is not separately admitted.",
        },
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
    const selection = this.selectReviewRoute(reviewing, decision.reviewerRoute, implementationAttempt.adapter);
    if (!selection.chosen) {
      this.deferReview(reviewing, decision.capacityAction, selection);
      return;
    }
    await this.launchAttempt(reviewing, project, "review", this.priorReviewFindings(reviewing), ids.launch(), selection);
  }

  /**
   * Required review coverage that cannot run right now is recorded as pending
   * or blocked, with the missing work named. It is never silently skipped.
   */
  private deferReview(task: Task, capacityAction: ReviewDecision["capacityAction"], selection: RouteSelection): void {
    const pending = capacityAction === "pending";
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
      data: { capacityAction, reason: selection.reason, revision: task.resultRevision },
    });
    this.blockTask(task, this.providerBlockClass(selection), reason);
  }

  /** Resume reviews deferred for capacity once an eligible provider is free. */
  private async resumePendingReviews(): Promise<void> {
    for (const task of this.records.listTasks({ state: "BLOCKED" })) {
      if (!task.blockedReason?.startsWith(REVIEW_PENDING_PREFIX)) continue;
      if (!task.resultRevision || !task.worktreePath) continue;
      const episode = this.records.getContinuation(task.id).episode;
      if (episode && episode.recoveriesConsumed >= episode.recoveryLimit) continue;
      const project = this.records.getProject(task.projectId);
      if (!project || project.status !== "active") continue;
      const implementer = this.records.listAttempts(task.id).findLast((attempt) => attempt.kind !== "review");
      const selection = this.selectReviewRoute(task, project.reviewPolicy.reviewerRoute, implementer?.adapter);
      if (!selection.chosen) continue;
      if (!this.admit(task, "model", selection.chosen.adapter).admitted) continue;
      const reviewing = this.records.transition(task.id, "REVIEWING", { blocked_reason: null, failure_class: null }, {
        reason: "review capacity became available; resuming the outstanding review",
        revision: task.resultRevision,
      });
      await this.launchAttempt(reviewing, project, "review", this.priorReviewFindings(reviewing), ids.launch(), selection);
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
    // Evidence is bound to what was reviewed. A review of an older revision or
    // under a different configuration is stale: record it, approve nothing,
    // and run the validation again.
    const packet = attempt.packetId ? this.records.getPacket(attempt.packetId) : undefined;
    const staleReason = attempt.baseRevision !== revision
      ? `reviewed ${attempt.baseRevision ?? "unknown"} but the task is now at ${revision}`
      : packet?.config_version && packet.config_version !== project.configVersion
        ? `reviewed under configuration ${String(packet.config_version)}, now ${project.configVersion}`
        : null;
    if (staleReason) {
      this.records.finishAttempt({
        attemptId: attempt.id, state: "failed", failureClass: "CONTRACT", reason: `Stale review evidence: ${staleReason}.`, usage,
        outputPath: existsSync(resultArtifact) ? resultArtifact : undefined,
      });
      rmSync(join(task.worktreePath, ".mabs", "result.json"), { force: true });
      if (attempt.stageRunId) {
        const stage = this.records.getStageRun(attempt.stageRunId);
        if (stage && ["reserved", "launching", "running"].includes(stage.state)) {
          this.finishStage(stage, { state: "failed", failureClass: "CONTRACT", failureDetail: `Stale review evidence: ${staleReason}.`, taskState: "REVIEWING" });
        }
      }
      this.records.recordEvent({ kind: "review.evidence_stale", projectId: project.id, taskId: task.id, attemptId: attempt.id,
        data: { reason: staleReason, revision } });
      const implementer = this.records.listAttempts(task.id).findLast((item) => item.kind !== "review");
      const selection = this.selectReviewRoute(task, project.reviewPolicy.reviewerRoute, implementer?.adapter);
      if (selection.chosen) await this.launchAttempt(this.records.getTask(task.id) as Task, project, "review", this.priorReviewFindings(task), ids.launch(), selection);
      else this.deferReview(task, project.reviewPolicy.capacityAction, selection);
      return;
    }
    const mandatory = this.records.listRequirements(task.projectId).filter((requirement) => requirement.mandatory).map((requirement) => requirement.id);
    const ownership = this.records.requirementOwnership(task.id);
    const items = triageReviewOutput({
      unresolved: output.follow_up.unresolved,
      decisionsRequested: output.follow_up.decisions_requested,
      addressedRequirements: output.addressed_requirements,
      mandatoryRequirements: mandatory,
      ownedRequirements: ownership?.requirementIds ?? null,
      blockingSeverities: project.reviewPolicy.blockingSeverities,
    });
    if (output.outcome === "failed" && items.length === 0) {
      items.push(...triageReviewOutput({
        unresolved: [`[major] ${output.reason || output.summary}`], decisionsRequested: [], addressedRequirements: [],
        mandatoryRequirements: [], ownedRequirements: [], blockingSeverities: project.reviewPolicy.blockingSeverities,
      }));
    }
    // Only blocking severities send the task back for repair; questions and
    // minor suggestions are retained as advice. An unfinished review is never
    // disguised as approval: a blocked outcome stays blocked.
    const blockingItems = items.filter((item) => item.blocking);
    const advisoryItems = items.filter((item) => !item.blocking);
    const findings = items.map((item) => item.text);
    const verdict = output.outcome === "blocked" ? "blocked" : blockingItems.length > 0 ? "request_changes" : "approved";
    const review = this.records.recordReview({
      taskId: task.id,
      attemptId: attempt.id,
      revision,
      verdict,
      summary: output.summary,
      findings,
      blockingFindings: blockingItems.map((item) => item.text),
      advisoryFindings: advisoryItems.map((item) => item.text),
      requirementsChecked: output.addressed_requirements,
      evidencePath: existsSync(resultArtifact) ? resultArtifact : null,
      policyVersion: project.reviewPolicy.version,
      contextFingerprint: this.records.reviewContextFingerprint(task.id),
    });
    const reviewEvidence = [review.evidencePath].filter((path): path is string => path !== null);
    for (const obligation of this.records.getContinuation(task.id).openObligations) {
      if (obligation.sourceKey.startsWith("review-recovery:")) {
        this.records.resolveObligation(
          { obligationId: obligation.id, state: "resolved", resolvedRevision: revision },
          [`review:${review.id}:collected`],
        );
      }
    }
    const restated = new Set<string>();
    if (verdict !== "blocked") {
      for (const item of items) {
        const obligation = this.upsertReviewObligation(task, review.id, revision, item, reviewEvidence);
        restated.add(obligation.id);
      }
      // A completed review of this revision that no longer reports an earlier
      // finding is the validation evidence for that finding's resolution.
      for (const obligation of this.records.getContinuation(task.id).openObligations) {
        const fromReview = obligation.sourceKey.startsWith("finding:") || obligation.sourceKey.startsWith("review:");
        if (!fromReview || restated.has(obligation.id)) continue;
        if (obligation.kind === "decision_needed") continue;
        this.records.resolveObligation(
          { obligationId: obligation.id, state: "resolved", resolvedRevision: revision },
          [`review:${review.id}:not-restated@${revision}`],
        );
      }
    }
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: attempt.id, kind: `review_${verdict}`, summary: output.summary,
      resultRevision: revision, changedFiles: this.records.changedFilesForTask(task.id), findings,
      unresolved: output.follow_up.decisions_requested,
      nextAction: verdict === "approved"
        ? advisoryItems.length > 0
          ? `Complete task. ${advisoryItems.length} advisory item(s) recorded without blocking acceptance.`
          : "Complete task."
        : verdict === "request_changes" ? "Repair blocking review findings and rerun checks." : output.follow_up.next_step,
      evidence: reviewEvidence,
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
    rmSync(join(task.worktreePath, ".mabs", "result.json"), { force: true });
    if (attempt.stageRunId) {
      const stage = this.records.getStageRun(attempt.stageRunId);
      if (stage && ["reserved", "launching", "running"].includes(stage.state)) {
        this.finishStage(stage, {
          state: verdict === "blocked" ? "waiting" : "succeeded",
          failureClass: verdict === "blocked" ? "CONTRACT" : null,
          failureDetail: verdict === "blocked" ? output.reason : null,
          taskState: verdict === "blocked" ? "BLOCKED" : "REVIEWING",
        });
      }
    }

    if (verdict === "blocked") {
      this.records.updateTaskFields(task.id, { claimed_by: null, claimed_at: null });
      return;
    }
    if (verdict === "approved") {
      await this.acceptTask(this.records.getTask(task.id) as Task, `Independent review ${review.id} approved ${revision}.`,
        this.records.gatesForRevision(task.id, revision), { status: "approved", reviewId: review.id });
      return;
    }

    const current = this.records.getTask(task.id) as Task;
    // A genuine ambiguity waits for the user; no worker guesses the answer.
    const decisionBlockers = this.records.getContinuation(task.id).openObligations.filter((item) =>
      item.blocking && (item.kind === "decision_needed" || item.kind === "requirement_evidence"),
    );
    const codeDefects = blockingItems.filter((item) => item.kind === "code_defect");
    if (decisionBlockers.length > 0 && codeDefects.length === 0) {
      this.blockTask(current, "CONTRACT", `Independent review is waiting on ${decisionBlockers.length} requirement decision/evidence obligation(s).`);
      return;
    }
    if (decisionBlockers.some((item) => item.kind === "decision_needed")) {
      this.blockTask(current, "CONTRACT", `Independent review is waiting on ${decisionBlockers.length} requirement decision/evidence obligation(s) before repair.`);
      return;
    }
    if (current.repairsUsed >= current.repairLimit) {
      this.records.transition(task.id, "FAILED", {
        failure_class: "CODE",
        blocked_reason: `Independent review found blocking changes after the repair limit was exhausted: ${codeDefects.map((item) => item.text).join("; ")}`,
        claimed_by: null,
        claimed_at: null,
      });
      return;
    }
    this.records.transition(task.id, "RUNNING", {
      repairs_used: current.repairsUsed + 1,
      claimed_by: null,
      claimed_at: null,
    }, { reason: "independent review requested changes", findings: blockingItems.map((item) => item.text), advisory: advisoryItems.map((item) => item.text) });
    await this.launchAttempt(this.records.getTask(task.id) as Task, project, "repair", [
      ...advisoryItems.map((item) => `${item.text} (advisory: optional, does not block acceptance)`),
    ]);
  }

  /**
   * One durable obligation per finding across reviews. A restated finding that
   * a repair claimed to address is reopened; one that recurs after it was
   * resolved gets a numbered recurrence rather than rewriting history.
   */
  private upsertReviewObligation(task: Task, reviewId: string, revision: string, item: ReviewItem, evidence: string[]): TaskObligation {
    const prior = this.records.obligationsForSourceKey(task.id, item.stableKey);
    const live = prior.findLast((obligation) => obligation.state === "open" || obligation.state === "addressed_pending_validation");
    if (live?.state === "open") return live;
    if (live?.state === "addressed_pending_validation") return this.records.reopenObligation(live.id, [`review:${reviewId}:restated@${revision}`]);
    return this.records.recordObligation({
      taskId: task.id,
      kind: item.kind,
      severity: item.blocking ? "blocking" : "advisory",
      blocking: item.blocking,
      sourceKey: prior.length === 0 ? item.stableKey : `${item.stableKey}:recurrence:${prior.length}`,
      summary: item.text,
      sourceReviewId: reviewId,
      introducedRevision: revision,
      evidenceRefs: evidence,
    });
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
      this.noteProviderFailure(failedAdapter, failure, reason);
      const project = this.records.getProject(current.projectId);
      if (!project) throw new Error(`Unknown project ${current.projectId}`);
      const implementer = this.records.listAttempts(current.id).findLast((attempt) => attempt.kind !== "review");
      const selection = this.selectReviewRoute(current, project.reviewPolicy.reviewerRoute, implementer?.adapter, failedAdapter);
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
    this.recordObligationOnce({
      taskId: current.id,
      kind: "requirement_evidence",
      severity: "blocking",
      blocking: true,
      sourceKey: `review-recovery:${current.resultRevision ?? "unknown"}:${failure}`,
      summary: `Independent review could not run: ${reason}`,
      introducedRevision: current.resultRevision,
      evidenceRefs: [latestAttempt?.outputPath].filter((path): path is string => path !== null),
    });
    this.blockTask(current, failure, `${REVIEW_RECOVERY_PREFIX} ${reason}`);
  }

  private async handleFailure(task: Task, failure: FailureClass, reason: string, failedAdapter: string): Promise<void> {
    const current = this.records.getTask(task.id) ?? task;
    const latestAttempt = this.records.listAttempts(task.id).at(-1);
    if (consumesRepairBudget(failure) && latestAttempt) {
      this.recordObligationOnce({
        taskId: current.id,
        kind: "code_defect",
        severity: "blocking",
        blocking: true,
        sourceKey: `attempt:${latestAttempt.id}:code-failure`,
        summary: reason,
        introducedRevision: current.resultRevision ?? latestAttempt.baseRevision,
        evidenceRefs: [latestAttempt.outputPath].filter((path): path is string => path !== null),
      });
    }
    this.records.recordCheckpoint({
      taskId: task.id, attemptId: latestAttempt?.id, kind: "attempt_failed",
      summary: `${failure}: ${reason}`, baseRevision: latestAttempt?.baseRevision ?? null,
      findings: [reason], nextAction: isProviderUnavailable(failure)
        ? "Retry with an eligible subscription provider when capacity is available."
        : consumesRepairBudget(failure) ? "Repair the reported failure without repeating the rejected approach." : "Resolve the operational blocker.",
      evidence: latestAttempt?.outputPath ? [latestAttempt.outputPath] : [],
    });
    if (isProviderUnavailable(failure)) {
      this.noteProviderFailure(failedAdapter, failure, reason);
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

  /**
   * Cool down the failed provider and, for quota, every provider sharing its
   * subscription quota domain: one exhausted account is exhausted for all of
   * its models.
   */
  private noteProviderFailure(failedAdapter: string, failure: FailureClass, reason: string): void {
    const affected = new Set([failedAdapter]);
    if (failure === "QUOTA") {
      const domains = new Set(quotaDomainsFor(this.capabilityRegistry, failedAdapter));
      for (const provider of this.adapters.keys()) {
        if (quotaDomainsFor(this.capabilityRegistry, provider).some((domain) => domains.has(domain))) affected.add(provider);
      }
    }
    for (const provider of affected) {
      this.records.noteProviderFailure(
        provider,
        failure,
        provider === failedAdapter ? reason : `Shared quota domain exhausted by ${failedAdapter}: ${reason}`,
        this.options.quotaCooldownMs,
      );
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

  // --- scheduling ----------------------------------------------------------

  schedulingLimits(): SchedulingLimits {
    const providerLimits: Record<string, number> = {};
    for (const provider of this.records.listProviderCapacity()) providerLimits[provider.provider] = provider.maxConcurrency;
    return {
      modelWorkers: Math.min(this.options.workerLimit, this.adaptive?.target ?? this.options.workerLimit),
      providerLimits,
      perProjectTasks: this.options.perProjectWorkerLimit,
      activeProjects: this.options.activeProjectLimit,
      gateJobs: this.options.gateLimit,
      childAgents: 0,
    };
  }

  private repoKeyFor(project: Project): string {
    let key = this.repoKeys.get(project.id);
    if (!key) {
      key = canonicalRepoKey(project.repoPath);
      this.repoKeys.set(project.id, key);
    }
    return key;
  }

  activeWork(): ActiveWork[] {
    return collectActiveWork(this.records, [ADMISSION_PENDING_PREFIX, REVIEW_PENDING_PREFIX], (projectId, repoPath) => {
      let key = this.repoKeys.get(projectId);
      if (!key) {
        key = canonicalRepoKey(repoPath);
        this.repoKeys.set(projectId, key);
      }
      return key;
    });
  }

  /** Ask the shared admission authority; record a denial only when its reasons change. */
  private admit(task: Task, kind: WorkKind, provider: string | null): AdmissionExplanation {
    const project = this.records.getProject(task.projectId) as Project;
    const explanation = evaluateAdmission({
      taskId: task.id, projectId: task.projectId, repoKey: this.repoKeyFor(project), kind, provider,
      executionMode: task.executionMode, writeScope: task.allowedScope, resources: task.resources,
    }, this.activeWork(), this.schedulingLimits());
    const previous = this.admissionExplanations.get(task.id);
    this.admissionExplanations.set(task.id, { ...explanation, kind, at: new Date().toISOString() });
    if (!explanation.admitted && previous?.reasons.join("|") !== explanation.reasons.join("|")) {
      this.records.recordEvent({
        kind: "admission.denied", projectId: task.projectId, taskId: task.id,
        data: { workKind: kind, provider, reasons: explanation.reasons, observed: explanation.observed, limits: explanation.limits },
      });
    }
    return explanation;
  }

  /** Feed the opt-in adaptive target: host backpressure or a provider in cooldown is pressure. */
  private observePressure(): void {
    if (!this.adaptive) return;
    const before = this.adaptive.target;
    const pressure = this.machineBackpressure() !== null ||
      this.records.listProviderCapacity().some((provider) => provider.state === "cooldown");
    const after = this.adaptive.observe(pressure);
    if (after !== before) {
      this.records.recordEvent({ kind: "scheduler.target_changed", data: { from: before, to: after, ceiling: this.adaptive.ceiling, pressure } });
    }
  }

  /**
   * In-flight model work (a repair or reroute) that could not be admitted
   * waits here without losing its purpose or its repair allocation.
   */
  private deferForAdmission(task: Task, kind: Attempt["kind"], explanation: AdmissionExplanation): void {
    const current = this.records.getTask(task.id) ?? task;
    const reason = explanation.reasons.join("; ");
    if (kind === "review") {
      this.records.recordEvent({ kind: "review.pending", projectId: current.projectId, taskId: current.id,
        data: { capacityAction: "pending", reason, revision: current.resultRevision } });
      if (current.state !== "BLOCKED") {
        this.records.transition(current.id, "BLOCKED", {
          blocked_reason: `${REVIEW_PENDING_PREFIX} ${reason}`, claimed_by: null, claimed_at: null,
        }, { reason: "review waiting for admission capacity" });
      }
      return;
    }
    const failed = this.records.listAttempts(current.id).at(-1);
    this.records.recordEvent({ kind: "admission.deferred", projectId: current.projectId, taskId: current.id,
      data: { attemptKind: kind, reasons: explanation.reasons } });
    if (current.state !== "BLOCKED") {
      this.records.transition(current.id, "BLOCKED", {
        blocked_reason: `${ADMISSION_PENDING_PREFIX} ${kind}: ${reason}`,
        // A reroute keeps the provider failure so its resume still excludes that provider.
        failure_class: kind === "reroute" ? failed?.failureClass ?? current.failureClass : current.failureClass,
        claimed_by: null, claimed_at: null,
      }, { reason: "in-flight work waiting for admission capacity", attemptKind: kind });
    }
  }

  private async resumeAdmissionPending(): Promise<void> {
    const waiting = this.records.listTasks({ state: "BLOCKED" }).filter((task) => task.blockedReason?.startsWith(ADMISSION_PENDING_PREFIX));
    const service = new Map([...this.records.projectSchedule()].map(([id, item]) => [id, item.dispatchCount]));
    for (const candidate of fairOrder(waiting.map((task) => ({ taskId: task.id, projectId: task.projectId, priority: task.priority, readySince: task.updatedAt })), service)) {
      const task = this.records.getTask(candidate.taskId);
      if (!task || task.state !== "BLOCKED" || !task.blockedReason?.startsWith(ADMISSION_PENDING_PREFIX)) continue;
      const project = this.records.getProject(task.projectId);
      if (!project || project.status !== "active") continue;
      const deferred = this.records.listEventsOfKind(task.id, "admission.deferred").at(-1);
      const kind = ((deferred ? JSON.parse(String(deferred.data)) : {}) as { attemptKind?: Attempt["kind"] }).attemptKind ?? "repair";
      const selection = this.selectTaskRoute(task);
      if (!selection.chosen) continue;
      if (!this.admit(task, "model", selection.chosen.adapter).admitted) continue;
      const resumed = this.records.transition(task.id, "RUNNING", { blocked_reason: null, claimed_by: null, claimed_at: null },
        { reason: "admission capacity available; resuming in-flight work", attemptKind: kind });
      await this.launchAttempt(resumed, project, kind, [], ids.launch(), selection);
    }
  }

  private promoteTasks(): void {
    const candidates = [
      ...this.records.listTasks({ state: "QUEUED" }),
      ...this.records.listTasks({ state: "BLOCKED" }).filter((task) => task.blockedReason?.startsWith("Dependency ")),
    ];
    for (const task of candidates) {
      const project = this.records.getProject(task.projectId);
      if (!project || project.status !== "active") continue;
      const dependencies = this.records.dependenciesOf(task.id).map((id) => this.records.getTask(id)).filter((item): item is Task => item !== null);
      // A prerequisite that failed, or is blocked on anything other than
      // in-flight capacity, can make no progress by itself: the dependent is
      // blocked with the reason instead of waiting silently in QUEUED.
      const failed = dependencies.find((dependency) => ["FAILED", "CANCELLED"].includes(dependency.state) ||
        (dependency.state === "BLOCKED" && !IN_FLIGHT_BLOCKED_PREFIXES.some((prefix) => dependency.blockedReason?.startsWith(prefix))));
      if (failed) {
        this.recordObligationOnce({
          taskId: task.id,
          kind: "requirement_evidence",
          severity: "blocking",
          blocking: true,
          sourceKey: `dependency:${failed.id}`,
          summary: `Dependency ${failed.id} must complete successfully; it is ${failed.state}.`,
          introducedRevision: failed.resultRevision,
          evidenceRefs: [`task:${failed.id}:${failed.state}`],
        });
        const reason = `Dependency ${failed.id} is ${failed.state}${failed.state === "BLOCKED" && failed.blockedReason ? `: ${failed.blockedReason}` : "."}`;
        if (task.state !== "BLOCKED") {
          this.records.transition(task.id, "BLOCKED", { blocked_reason: reason });
        }
      } else if (task.state === "BLOCKED" && !dependencies.every((dependency) => dependency.state === "DONE")) {
        // The prerequisite was retried or unblocked: wait for it again. Its
        // obligation stays open until it is DONE.
        this.records.transition(task.id, "QUEUED", { blocked_reason: null }, { reason: "dependency no longer blocked" });
      } else if (dependencies.every((dependency) => dependency.state === "DONE")) {
        for (const obligation of this.records.getContinuation(task.id).openObligations) {
          if (!obligation.sourceKey.startsWith("dependency:")) continue;
          const dependencyId = obligation.sourceKey.slice("dependency:".length);
          const dependency = this.records.getTask(dependencyId);
          if (dependency?.state === "DONE") {
            this.records.resolveObligation(
              { obligationId: obligation.id, state: "resolved", resolvedRevision: dependency.resultRevision },
              [`task:${dependency.id}:DONE`],
            );
          }
        }
        const remaining = this.records.getContinuation(task.id).openObligations.filter((item) => item.blocking);
        if (remaining.length === 0) this.records.transition(task.id, "READY", { blocked_reason: null, failure_class: null });
      }
    }
  }

  private async dispatchReadyTasks(): Promise<void> {
    this.backpressureReason = this.machineBackpressure();
    if (this.backpressureReason) return;
    // Bounded, fair scan: a task that cannot be admitted is skipped, never a
    // barrier for compatible work behind it.
    const ready = this.records.listTasks({ state: "READY" }).slice(0, READY_SCAN_LIMIT);
    const service = new Map([...this.records.projectSchedule()].map(([id, item]) => [id, item.dispatchCount]));
    const ordered = fairOrder(ready.map((task) => ({ taskId: task.id, projectId: task.projectId, priority: task.priority, readySince: task.updatedAt })), service);
    for (const candidate of ordered) {
      if (this.records.listRunningAttempts().length >= this.schedulingLimits().modelWorkers &&
          this.activeWork().filter((work) => work.kind === "gate").length >= this.options.gateLimit) break;
      const task = this.records.getTask(candidate.taskId);
      if (!task || task.state !== "READY") continue;
      const project = this.records.getProject(task.projectId);
      if (!project || project.status !== "active") continue;
      const readiness = this.records.recordGovernanceNeedsInput(project.id, task.id);
      if (!readiness.ready) continue;
      const continuation = this.records.getContinuation(task.id);
      if (continuation.episode && continuation.episode.repairsConsumed >= continuation.episode.repairLimit &&
          continuation.openObligations.some((item) => item.blocking && item.kind === "code_defect")) {
        this.blockTask(task, "CODE", "The active execution episode exhausted its repair budget; a new authorized episode is required.");
        continue;
      }
      if (task.taskClass === "mechanical") {
        if (!this.admit(task, "gate", null).admitted) continue;
        await this.dispatchMechanical(task, project);
        this.records.markProjectDispatched(project.id);
        continue;
      }
      const selection = this.selectTaskRoute(task);
      if (!selection.chosen) {
        if (selection.deferred.length === 0 && !await this.resumeOperationalTask(task, project)) {
          this.blockTask(task, this.providerBlockClass(selection), selection.reason);
        }
        continue;
      }
      if (!this.admit(task, "model", selection.chosen.adapter).admitted) continue;
      const resumed = await this.resumeOperationalTask(task, project);
      if (resumed === "waiting") continue;
      if (resumed) {
        this.records.markProjectDispatched(project.id);
        continue;
      }
      if (await this.dispatchInitial(task, project, selection)) this.records.markProjectDispatched(project.id);
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

  private providerBlockClass(selection: RouteSelection): FailureClass {
    if (selection.rejected.some((item) =>
      item.reason === "adapter is not installed" ||
      item.reason.startsWith("required tools are unavailable") ||
      item.reason.startsWith("capability ineligible"))) return "CONFIG";
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
    if (!workspace.needsDependencyIntegration) {
      for (const event of this.records.listEvents(task.id)) {
        if (event.kind !== "task.dependencies_integrated" || typeof event.data !== "string") continue;
        try {
          const prior = JSON.parse(event.data) as { revisions?: unknown; baseRevision?: unknown };
          const sameRevisions = Array.isArray(prior.revisions) &&
            prior.revisions.length === revisions.length &&
            prior.revisions.every((revision, index) => revision === revisions[index]);
          if (sameRevisions && typeof prior.baseRevision === "string" &&
              await workspaceContainsRevision(workspace.path, prior.baseRevision)) {
            return { ...workspace, baseRevision: prior.baseRevision };
          }
        } catch {
          // Ignore malformed historical evidence and safely attempt integration.
        }
      }
    }
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
      const prepareStage = this.reserveStage(claimed, "prepare_workspace", `${launchId}:prepare`, {
        projectId: project.id,
        taskId: claimed.id,
        dependencies: this.records.dependenciesOf(claimed.id),
      });
      this.records.recordLaunchStarted(prepareStage.id, prepareStage.fencingToken);
      const workspace = await this.prepareTaskWorkspace(project, claimed);
      this.records.updateTaskFields(task.id, {
        branch: workspace.branch,
        worktree_path: workspace.path,
        base_revision: workspace.baseRevision,
      });
      this.finishStage(prepareStage, { state: "succeeded", taskState: "RUNNING" });
      if (!await this.runPreflight(this.records.getTask(task.id) as Task, project, launchId)) return false;
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
      const prepareStage = this.reserveStage(claimed, "prepare_workspace", `${launchId}:prepare`, {
        projectId: project.id,
        taskId: claimed.id,
        dependencies: this.records.dependenciesOf(claimed.id),
      });
      this.records.recordLaunchStarted(prepareStage.id, prepareStage.fencingToken);
      const workspace = await this.prepareTaskWorkspace(project, claimed);
      this.records.updateTaskFields(task.id, {
        branch: workspace.branch,
        worktree_path: workspace.path,
        base_revision: workspace.baseRevision,
      });
      this.finishStage(prepareStage, { state: "succeeded", taskState: "RUNNING" });
      if (!await this.runPreflight(this.records.getTask(task.id) as Task, project, launchId)) return;
      const revision = await workspaceRevision(workspace.path);
      this.records.transition(task.id, "CHECKING", {
        result_revision: revision,
        result_summary: "Registered deterministic gates scheduled without model inference.",
      }, { routing: "deterministic; no model inference" });
      this.records.recordRouting({
        taskId: task.id,
        rule: this.routingPolicy.version,
        reason: "Mechanical task executed only registered deterministic gates.",
        eligible: [],
        chosen: "deterministic",
      });
      await this.scheduleNextCheck(this.records.getTask(task.id) as Task, project);
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
    stageOptions: { consumeRecovery?: boolean } = {},
  ): Promise<void> {
    requireProjectReadiness({ kind: "project", id: project.id }, project.governance, project.reviewPolicy);
    if (!task.worktreePath || !task.branch || !task.baseRevision) throw new Error(`Task ${task.id} has no prepared workspace`);
    const selection = routeSelection ?? this.selectTaskRoute(task);
    if (!selection.chosen) {
      // A provider at its concurrency limit is a capacity wait, not a fault:
      // the in-flight work waits for admission instead of failing the tick.
      if (selection.deferred.length > 0) {
        this.deferForAdmission(task, kind, { admitted: false, reasons: [selection.reason], limits: {}, observed: {} });
        return;
      }
      throw new Error(selection.reason);
    }
    const candidate: RouteCandidate = selection.chosen;
    // A trial's authorization and budgets hold at every launch, not only when
    // its task was created.
    const trialRefusal = trialLaunchRefusal(this.records, task.id);
    if (trialRefusal) {
      this.blockTask(task, "CONFIG", `${trialRefusal} The trial ends interrupted.`);
      return;
    }
    // Every launch path, not only initial dispatch, passes the same admission.
    const admission = this.admit(task, "model", candidate.adapter);
    if (!admission.admitted) {
      this.deferForAdmission(task, kind, admission);
      return;
    }
    const adapter = this.requireAdapter(candidate.adapter);
    const execution: ExecutionSelection = {
      harness: adapter.name,
      model: candidate.model,
      effort: candidate.effort,
      authMode: adapter.authMode,
    };
    const priorAttempt = this.records.listAttempts(task.id).at(-1);
    const priorStage = priorAttempt?.stageRunId ? this.records.getStageRun(priorAttempt.stageRunId) : null;
    const executionStage: ExecutionStage = kind === "review"
      ? "review"
      : kind === "repair" || (kind === "reroute" && priorStage?.stage === "repair")
        ? "repair"
        : "implement";
    const stage = this.reserveStage(task, executionStage, `${launchId}:${executionStage}`, {
      kind,
      adapter: adapter.name,
      model: execution.model,
      effort: execution.effort,
      revision: executionStage === "review" ? task.resultRevision : task.baseRevision,
      obligations: this.records.getContinuation(task.id).openObligations.map((item) => item.id),
    }, {
      revision: executionStage === "review" ? task.resultRevision : task.baseRevision,
      consumeRepair: kind !== "reroute",
      consumeRecovery: stageOptions.consumeRecovery,
    });
    const lease = this.records.reserveAdmission({
      stageRunId: stage.id,
      controllerId: this.options.controllerId,
      provider: adapter.name,
      quotaDomain: selection.quotaDomain ?? adapter.authMode,
      resources: ["model-worker", `provider:${adapter.name}`, `quota:${selection.quotaDomain ?? adapter.authMode}`, `worktree:${task.id}`],
    });
    this.records.activateAdmission(lease.id, lease.fencingToken);
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
    if (executionStage === "repair" && task.resultRevision && task.resultRevision !== task.baseRevision) {
      // A repair works from the change it is repairing, not from the task text alone.
      const deltaPath = join(dir, "repair-delta.patch");
      writeFileSync(deltaPath, await workspaceDiff(task.worktreePath, task.baseRevision, task.resultRevision), { mode: 0o600 });
      reviewArtifacts.push(deltaPath);
    }
    // A reroute is caused by the provider, not the code: its reason is carried
    // as the operational failure and never becomes a code finding.
    const operational = kind === "reroute";
    let packet: ContextPacket;
    try {
      packet = buildContextPacket({
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
        previousFindings: operational ? [] : previousFindings,
        operationalFailure: operational ? previousFindings.join("\n") || null : null,
        obligations: this.records.getContinuation(task.id).openObligations,
        purpose: executionStage === "review" ? "review" : executionStage === "repair" ? "repair" : "implementation",
        additionalArtifacts: reviewArtifacts,
      });
    } catch (error) {
      if (!(error instanceof ContextBudgetExceededError)) {
        // Nothing launched. Release the stage and its admission lease now; left
        // reserved, restart reconciliation would mistake it for a crashed launch.
        const detail = error instanceof Error ? error.message : String(error);
        this.finishStage(stage, { state: "failed", failureClass: "INFRA", failureDetail: detail, taskState: "BLOCKED" });
        this.blockTask(this.records.getTask(task.id) ?? task, "INFRA", `Context packet could not be built: ${detail}`);
        return;
      }
      this.recordObligationOnce({
        taskId: task.id,
        kind: "decision_needed",
        severity: "blocking",
        blocking: true,
        sourceKey: `context-budget:${project.configVersion}:${executionStage}`,
        summary: error.message,
        introducedRevision: task.resultRevision ?? task.baseRevision,
        evidenceRefs: [],
      });
      this.finishStage(stage, { state: "waiting", failureClass: "CONFIG", failureDetail: error.message, taskState: "BLOCKED" });
      this.blockTask(this.records.getTask(task.id) ?? task, "CONFIG", error.message);
      return;
    }
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
      skillVersions: packet.guidance,
      stageRunId: stage.id,
      requestedModel: execution.model,
      configuredModel: execution.model,
      requestedEffort: execution.effort,
      configuredEffort: execution.effort,
      engineVersion: ENGINE_REVISION,
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
      capabilityRegistryVersion: selection.capabilityRegistryVersion,
      configVersion: project.configVersion,
      requestedSelection: selection.requested,
      effectiveSelection: { adapter: adapter.name, model: execution.model, effort: execution.effort, delegation: DISABLED_DELEGATION.mode },
      eligibilityEvidence: selection.eligibility,
      fallbackReason: selection.fallbackReason,
      escalationReason: selection.escalationReason,
      quotaDomain: selection.quotaDomain,
      decision: selection.decision,
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
        effort: execution.effort,
        delegation: DISABLED_DELEGATION,
        timeoutMs: this.options.workerTimeoutMs,
        evidencePath,
        completionPath,
      });
      this.records.setAttemptProcess(attempt.id, handle.pid, handle.sessionId);
      this.records.recordLaunchStarted(stage.id, stage.fencingToken, { attemptId: attempt.id });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const diagnosis = diagnoseFailure({
        stage: executionStage,
        source: kind === "review" ? "review" : "worker",
        exitCode: null,
        text: reason,
      });
      const failure = failureClassForCategory(diagnosis.category);
      this.records.finishAttempt({ attemptId, state: "failed", failureClass: failure, reason });
      try { this.records.consumeRecovery(stage.episodeId, stage.id, reason); } catch { /* bounded exhaustion is enforced before another automatic resume */ }
      this.finishStage(stage, { state: "failed", failureClass: failure, failureDetail: reason, taskState: task.state });
      if (kind === "review") await this.handleReviewFailure(task, failure, reason, adapter.name);
      else await this.handleFailure(task, failure, reason, adapter.name);
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
