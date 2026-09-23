/**
 * Phase 3 — read-only task and step view.
 *
 * Everything here is derived from records the controller already writes. This
 * module never schedules work, claims a task, or changes task state, and it
 * adds no second store: it reads `tasks`, `attempts`, `task_checkpoints`,
 * `gate_results`, `review_results`, `events`, `approvals`, and
 * `controller_health`.
 *
 * Two rules shape the output:
 *  - the detailed state machine is preserved. A task is grouped for display,
 *    and its real state (CHECKING, REVIEWING, AWAITING_APPROVAL) is always
 *    carried alongside the group;
 *  - anything not recorded is reported as unavailable. No step is inferred
 *    from a worker's prose, and no completion is estimated.
 */
import { existsSync } from "node:fs";

import type { TaskState } from "../domain/states.ts";
import { TERMINAL_STATES } from "../domain/states.ts";
import type { Attempt, Records, Task } from "../store/records.ts";

export const DEFAULT_STALE_MS = 10 * 60_000;
export const CONTROLLER_STALE_MS = 60_000;

/** Display grouping. It never replaces the underlying state. */
export type TaskGroup = "completed" | "active" | "ready" | "waiting" | "blocked" | "failed";

export const TASK_GROUPS: readonly TaskGroup[] = ["active", "ready", "waiting", "blocked", "failed", "completed"];

export function groupForState(state: TaskState): TaskGroup {
  switch (state) {
    case "DONE": return "completed";
    case "RUNNING": case "CHECKING": case "REVIEWING": return "active";
    case "READY": return "ready";
    case "QUEUED": case "AWAITING_APPROVAL": return "waiting";
    case "BLOCKED": return "blocked";
    case "FAILED": case "CANCELLED": return "failed";
  }
}

export type StepSource = "attempt" | "checkpoint" | "gate" | "review";

export type StepStatus = "running" | "completed" | "failed" | "blocked" | "skipped";

export interface TaskStep {
  /** Stable across refreshes, so a repeated read can never duplicate a row. */
  id: string;
  source: StepSource;
  /** The execution this step belongs to. */
  attemptId: string | null;
  attemptNumber: number | null;
  sequence: number;
  at: string;
  kind: string;
  status: StepStatus;
  summary: string;
  detail: string | null;
  evidencePaths: string[];
  /** Evidence referenced but no longer on disk. */
  missingEvidence: string[];
  /**
   * Evidence record IDs this step points at. Open one directly with
   * `mabs logs <task> --evidence=<id>`, so a summary is never a dead end.
   */
  evidenceRefs: string[];
  durationMs: number | null;
}

export type DeliveryState = "not requested" | "approval pending" | "approved" | "rejected" | "consumed";

export interface TaskRow {
  taskId: string;
  projectId: string;
  projectName: string;
  title: string;
  /** The authoritative state, never collapsed into the group. */
  state: TaskState;
  group: TaskGroup;
  taskClass: string;
  planId: string | null;
  planObjective: string | null;
  /** Provider and model actually selected for the latest attempt, when recorded. */
  provider: string | null;
  model: string | null;
  attemptId: string | null;
  attemptNumber: number | null;
  attemptKind: string | null;
  attemptState: string | null;
  /** How long the current attempt has been running, or how long since the last change. */
  elapsedMs: number | null;
  elapsedOf: "attempt" | "last-update";
  blockedReason: string | null;
  failureClass: string | null;
  dependsOn: string[];
  /** Dependencies that are not DONE yet. */
  waitingOn: string[];
  lastUpdate: string;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  /** The worker heartbeat is older than the threshold. Not proof of failure. */
  staleHeartbeat: boolean;
  repairsUsed: number;
  repairLimit: number;
  steps: TaskStep[];
  /** Whether step data exists for this task, and what is missing. */
  stepInstrumentation: "recorded" | "none";
  stepGaps: string[];
  checks: { name: string; status: string; required: boolean; revision: string }[];
  review: { verdict: string; at: string; blockingFindings: number } | null;
  resultRevision: string | null;
  /** Task completion is not delivery. These stay separate. */
  delivery: DeliveryState;
  deliveryDetail: string | null;
}

export interface ControllerFreshness {
  state: "running" | "stopped" | "degraded" | "unknown";
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  /** The controller has not reported recently enough to trust its figures. */
  stale: boolean;
  reason: string;
  activeWorkers: number | null;
  workerLimit: number | null;
  queueDepth: number | null;
  backpressureReason: string | null;
}

export interface ProviderView {
  provider: string;
  /** "unknown" whenever no health or capacity record supports a claim. */
  availability: "available" | "cooldown" | "unavailable" | "unknown";
  maxConcurrency: number | null;
  blockedUntil: string | null;
  reason: string | null;
}

export interface ProgressSnapshot {
  generatedAt: string;
  controller: ControllerFreshness;
  /** Counts of what is recorded. Never an estimate of work remaining. */
  counts: Record<TaskGroup, number> & { total: number };
  stateCounts: Record<string, number>;
  tasks: TaskRow[];
  providers: ProviderView[];
  /** Anything the display could not establish, in plain language. */
  notes: string[];
}

// --------------------------------------------------------------------------
// steps
// --------------------------------------------------------------------------

function checkEvidence(paths: (string | null | undefined)[]): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    if (existsSync(path)) present.push(path);
    else missing.push(path);
  }
  return { present, missing };
}

function attemptStatus(attempt: Attempt): StepStatus {
  switch (attempt.state) {
    case "running": return "running";
    case "succeeded": return attempt.outcome === "blocked" ? "blocked" : "completed";
    case "cancelled": return "failed";
    default: return "failed";
  }
}

/**
 * Assemble the recorded steps for one task.
 *
 * Every step comes from a durable record and carries a stable id, so polling
 * the same task repeatedly can never duplicate or reorder history. A retry adds
 * a new attempt's steps; it never overwrites the previous attempt's.
 */
export function stepsForTask(records: Records, taskId: string): TaskStep[] {
  const attempts = records.listAttempts(taskId);
  const attemptNumber = new Map(attempts.map((attempt) => [attempt.id, attempt.attemptNumber]));
  const steps: TaskStep[] = [];

  for (const attempt of attempts) {
    const evidence = checkEvidence([attempt.outputPath]);
    steps.push({
      id: `attempt:${attempt.id}`,
      source: "attempt",
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      sequence: 0,
      at: attempt.startedAt,
      kind: `${attempt.kind}_attempt`,
      status: attemptStatus(attempt),
      summary: `Attempt ${attempt.attemptNumber} (${attempt.kind}) on ${attempt.adapter}${attempt.model ? ` / ${attempt.model}` : ""}`,
      detail: attempt.reason,
      evidencePaths: evidence.present,
      missingEvidence: evidence.missing,
      // A worker result is only referenced when the attempt actually recorded
      // an output path; the transcript and completion envelope are conventional
      // per-attempt paths the Logs surface always lists.
      evidenceRefs: [
        ...(attempt.outputPath ? [`result:${attempt.id}`] : []),
        `transcript:${attempt.id}`,
        `completion:${attempt.id}`,
      ],
      durationMs: attempt.endedAt ? Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt) : null,
    });
  }

  for (const checkpoint of records.checkpointsForTask(taskId)) {
    const evidence = checkEvidence(checkpoint.evidence);
    const failed = /failed|blocked/.test(checkpoint.kind);
    steps.push({
      id: `checkpoint:${checkpoint.id}`,
      source: "checkpoint",
      attemptId: checkpoint.attemptId,
      attemptNumber: checkpoint.attemptId ? attemptNumber.get(checkpoint.attemptId) ?? null : null,
      sequence: 1,
      at: checkpoint.createdAt,
      kind: checkpoint.kind,
      status: failed ? (checkpoint.kind.includes("blocked") ? "blocked" : "failed") : "completed",
      summary: checkpoint.summary,
      detail: checkpoint.nextAction,
      evidencePaths: evidence.present,
      missingEvidence: evidence.missing,
      evidenceRefs: checkpoint.attemptId ? [`transcript:${checkpoint.attemptId}`] : [],
      durationMs: null,
    });
  }

  for (const gate of records.gatesForTask(taskId)) {
    const evidence = checkEvidence([gate.evidencePath]);
    steps.push({
      id: `gate:${gate.id}`,
      source: "gate",
      attemptId: gate.attemptId,
      attemptNumber: gate.attemptId ? attemptNumber.get(gate.attemptId) ?? null : null,
      sequence: 2,
      at: gate.createdAt,
      kind: `check:${gate.name}`,
      status: gate.status === "PASS" ? "completed" : gate.status === "SKIPPED" ? "skipped" : "failed",
      summary: `${gate.name} ${gate.status}${gate.required ? "" : " (advisory)"}`,
      detail: gate.command,
      evidencePaths: evidence.present,
      missingEvidence: evidence.missing,
      evidenceRefs: gate.evidencePath ? [`check:${gate.id}`] : [],
      durationMs: gate.durationMs,
    });
  }

  for (const review of records.reviewsForTask(taskId)) {
    const evidence = checkEvidence([review.evidencePath]);
    steps.push({
      id: `review:${review.id}`,
      source: "review",
      attemptId: review.attemptId,
      attemptNumber: attemptNumber.get(review.attemptId) ?? null,
      sequence: 3,
      at: review.createdAt,
      kind: `review:${review.verdict}`,
      status: review.verdict === "approved" ? "completed" : review.verdict === "blocked" ? "blocked" : "failed",
      summary: review.summary,
      detail: review.blockingFindings.length > 0 ? `${review.blockingFindings.length} blocking finding(s)` : null,
      evidencePaths: evidence.present,
      missingEvidence: evidence.missing,
      evidenceRefs: review.evidencePath ? [`review:${review.id}`] : [],
      durationMs: null,
    });
  }

  // Deduplicate on the stable id, then order by time with the per-kind sequence
  // breaking ties inside a single timestamp.
  const unique = new Map(steps.map((step) => [step.id, step]));
  return [...unique.values()].sort((left, right) => {
    const byTime = Date.parse(left.at) - Date.parse(right.at);
    if (byTime !== 0) return byTime;
    if (left.attemptNumber !== right.attemptNumber) return (left.attemptNumber ?? 0) - (right.attemptNumber ?? 0);
    return left.sequence - right.sequence;
  });
}

/**
 * What step data is missing for this task.
 *
 * The controller records a checkpoint at every boundary it owns, so the gap is
 * not "no steps": it is progress *inside* a running attempt, which no executor
 * currently reports. That is stated rather than filled in.
 */
function stepGapsFor(task: Task, attempts: Attempt[], steps: TaskStep[]): string[] {
  const gaps: string[] = [];
  if (attempts.some((attempt) => attempt.state === "running")) {
    gaps.push(
      "Progress inside the running attempt is not instrumented. The worker reports its result at the end, " +
      "so only the attempt's start and heartbeat are known while it runs.",
    );
  }
  if (attempts.length === 0 && !TERMINAL_STATES.includes(task.state)) {
    gaps.push("No attempt has started yet, so there are no recorded steps.");
  }
  const missing = steps.flatMap((step) => step.missingEvidence);
  if (missing.length > 0) {
    gaps.push(`${missing.length} evidence file(s) referenced by a step are no longer on disk.`);
  }
  return gaps;
}

// --------------------------------------------------------------------------
// snapshot
// --------------------------------------------------------------------------

function deliveryFor(records: Records, task: Task): { delivery: DeliveryState; detail: string | null } {
  const approvals = records.listApprovals().filter((approval) => approval.taskId === task.id);
  const outward = approvals.filter((approval) => ["merge", "push_branch", "deploy", "publish", "release"].includes(approval.action));
  if (outward.length === 0) return { delivery: "not requested", detail: null };
  const latest = outward[outward.length - 1];
  if (!latest) return { delivery: "not requested", detail: null };
  const state: DeliveryState =
    latest.state === "pending" ? "approval pending"
      : latest.state === "approved" ? "approved"
        : latest.state === "consumed" ? "consumed"
          : latest.state === "rejected" ? "rejected"
            : "not requested";
  return { delivery: state, detail: `${latest.action} → ${latest.target} (${latest.state})` };
}

function planIndex(records: Records): Map<string, { id: string; objective: string }> {
  const index = new Map<string, { id: string; objective: string }>();
  for (const record of records.listExecutionPlans()) {
    const detail = records.getExecutionPlan(record.id);
    if (!detail) continue;
    for (const item of detail.items) index.set(item.task.id, { id: record.id, objective: record.objective });
  }
  return index;
}

export function controllerFreshness(records: Records, now = Date.now()): ControllerFreshness {
  const health = records.latestHealth();
  if (!health) {
    return {
      state: "unknown", heartbeatAt: null, heartbeatAgeMs: null, stale: true,
      reason: "No controller has reported health. Task state shown here is the last thing written to the store.",
      activeWorkers: null, workerLimit: null, queueDepth: null, backpressureReason: null,
    };
  }
  const heartbeatAt = (health.heartbeat_at as string | null) ?? null;
  const ageMs = heartbeatAt ? now - Date.parse(heartbeatAt) : null;
  const stale = ageMs === null || ageMs > CONTROLLER_STALE_MS;
  const state = (health.state as ControllerFreshness["state"]) ?? "unknown";
  return {
    state,
    heartbeatAt,
    heartbeatAgeMs: ageMs === null ? null : Math.round(ageMs),
    stale,
    reason: stale
      ? `The controller last reported ${ageMs === null ? "never" : `${Math.round(ageMs / 1000)}s ago`}; these figures may be out of date.`
      : `Controller ${state}.`,
    activeWorkers: health.active_workers === undefined ? null : Number(health.active_workers),
    workerLimit: health.worker_limit === undefined ? null : Number(health.worker_limit),
    queueDepth: health.queue_depth === undefined ? null : Number(health.queue_depth),
    backpressureReason: (health.backpressure_reason as string | null) ?? null,
  };
}

export interface SnapshotOptions {
  projectId?: string | null;
  taskId?: string | null;
  /** Include recorded steps for every row. Off for the list view. */
  withSteps?: boolean;
  staleMs?: number;
  now?: number;
  limit?: number;
}

/** Build the whole read-only view in one pass. */
export function buildProgressSnapshot(records: Records, options: SnapshotOptions = {}): ProgressSnapshot {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const plans = planIndex(records);

  const tasks = (options.taskId
    ? [records.getTask(options.taskId)].filter((task): task is Task => task !== null)
    : records.listTasks(options.projectId ? { projectId: options.projectId } : {}))
    .slice(0, options.limit ?? 500);

  const rows: TaskRow[] = tasks.map((task) => {
    const project = records.getProject(task.projectId);
    const attempts = records.listAttempts(task.id);
    const latest = attempts[attempts.length - 1] ?? null;
    const running = attempts.find((attempt) => attempt.state === "running") ?? null;
    const reference = running ?? latest;

    const heartbeatAt = running?.heartbeatAt ?? running?.startedAt ?? null;
    const heartbeatAgeMs = heartbeatAt ? now - Date.parse(heartbeatAt) : null;

    const dependsOn = records.dependenciesOf(task.id);
    const waitingOn = dependsOn.filter((id) => records.getTask(id)?.state !== "DONE");

    const steps = options.withSteps ? stepsForTask(records, task.id) : [];
    const delivery = deliveryFor(records, task);
    const plan = plans.get(task.id) ?? null;
    const review = records.reviewsForTask(task.id).at(-1) ?? null;

    return {
      taskId: task.id,
      projectId: task.projectId,
      projectName: project?.name ?? task.projectId,
      title: task.title,
      state: task.state,
      group: groupForState(task.state),
      taskClass: task.taskClass,
      planId: plan?.id ?? null,
      planObjective: plan?.objective ?? null,
      // Provider and model are reported only when an attempt recorded them.
      provider: reference?.adapter ?? null,
      model: reference?.model ?? null,
      attemptId: reference?.id ?? null,
      attemptNumber: reference?.attemptNumber ?? null,
      attemptKind: reference?.kind ?? null,
      attemptState: reference?.state ?? null,
      elapsedMs: running
        ? now - Date.parse(running.startedAt)
        : Math.max(0, now - Date.parse(task.updatedAt)),
      elapsedOf: running ? "attempt" : "last-update",
      blockedReason: task.blockedReason,
      failureClass: task.failureClass,
      dependsOn,
      waitingOn,
      lastUpdate: task.updatedAt,
      heartbeatAt,
      heartbeatAgeMs: heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs),
      staleHeartbeat: heartbeatAgeMs !== null && heartbeatAgeMs > staleMs,
      repairsUsed: task.repairsUsed,
      repairLimit: task.repairLimit,
      steps,
      stepInstrumentation: steps.length > 0 ? "recorded" : "none",
      stepGaps: options.withSteps ? stepGapsFor(task, attempts, steps) : [],
      checks: records.gatesForTask(task.id).map((gate) => ({
        name: gate.name, status: gate.status, required: gate.required, revision: gate.revision,
      })),
      review: review ? { verdict: review.verdict, at: review.createdAt, blockingFindings: review.blockingFindings.length } : null,
      resultRevision: task.resultRevision,
      delivery: delivery.delivery,
      deliveryDetail: delivery.detail,
    };
  });

  const counts = { completed: 0, active: 0, ready: 0, waiting: 0, blocked: 0, failed: 0, total: rows.length };
  const stateCounts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.group] += 1;
    stateCounts[row.state] = (stateCounts[row.state] ?? 0) + 1;
  }

  const capacities = new Map(records.listProviderCapacity().map((capacity) => [capacity.provider, capacity]));
  const observed = new Set([...capacities.keys(), ...rows.map((row) => row.provider).filter((name): name is string => Boolean(name))]);
  const providers: ProviderView[] = [...observed].sort().map((provider) => {
    const capacity = capacities.get(provider);
    // Without a capacity or health record there is nothing to base a claim on.
    if (!capacity) {
      return { provider, availability: "unknown", maxConcurrency: null, blockedUntil: null, reason: "No capacity or health record." };
    }
    return {
      provider,
      availability: capacity.state,
      maxConcurrency: capacity.maxConcurrency,
      blockedUntil: capacity.blockedUntil,
      reason: capacity.reason,
    };
  });

  const controller = controllerFreshness(records, now);
  const notes: string[] = [];
  if (controller.stale) notes.push(controller.reason);
  const stale = rows.filter((row) => row.staleHeartbeat);
  if (stale.length > 0) {
    notes.push(
      `${stale.length} running attempt(s) have a stale heartbeat. That is not proof of failure; ` +
      "inspect the worktree and evidence before retrying.",
    );
  }
  const unknownProviders = providers.filter((provider) => provider.availability === "unknown");
  if (unknownProviders.length > 0) {
    notes.push(`Availability is unknown for ${unknownProviders.map((provider) => provider.provider).join(", ")}.`);
  }
  if (options.withSteps) {
    for (const gap of new Set(rows.flatMap((row) => row.stepGaps))) notes.push(gap);
  }

  return {
    generatedAt: new Date(now).toISOString(),
    controller,
    counts,
    stateCounts,
    tasks: rows,
    providers,
    notes,
  };
}
