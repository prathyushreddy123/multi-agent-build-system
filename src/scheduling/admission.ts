/**
 * One admission authority for every kind of work.
 *
 * Initial dispatch, repair, reroute, review, and check jobs all ask the same
 * question here before a process exists, so a cap that holds for one path
 * holds for all of them. The evaluator is pure: callers pass the currently
 * active work and limits, and receive an explanation that says exactly which
 * limit or lock refused the work.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { scopesOverlap } from "../domain/plan.ts";
import type { Records } from "../store/records.ts";
import type { AdmissionExplanation } from "./types.ts";

export const SCHEDULING_POLICY_VERSION = "mabs.scheduling.v2";

export type WorkKind = "model" | "gate";

export interface SchedulingLimits {
  /** Total concurrent model workers. The production value remains 1. */
  modelWorkers: number;
  providerLimits: Record<string, number>;
  /** Concurrent slot-holding tasks per project. */
  perProjectTasks: number;
  activeProjects: number;
  /** Concurrent check jobs; separate from model workers because checks use CPU and memory too. */
  gateJobs: number;
  /** Native child agents admitted per model worker. Delegation is disabled, so this is 0. */
  childAgents: 0;
}

/** Something already holding capacity or a lock. */
export interface ActiveWork {
  taskId: string;
  projectId: string;
  /** Canonical repository identity; two projects on one repository share it. */
  repoKey: string;
  /** Null for a task that holds its workspace but runs no process right now. */
  kind: WorkKind | null;
  provider: string | null;
  executionMode: string;
  writeScope: string[];
  resources: string[];
}

export interface AdmissionRequest {
  taskId: string;
  projectId: string;
  repoKey: string;
  kind: WorkKind;
  provider: string | null;
  executionMode: string;
  writeScope: string[];
  resources: string[];
}

/**
 * The canonical identity of a repository path. Symlinks and relative paths
 * that reach one checkout resolve to one key, so a second project registered
 * on the same repository cannot bypass its write lock.
 */
export function canonicalRepoKey(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return resolve(repoPath);
  }
}

const EXCLUSIVE_MODES = new Set(["single", "sequential"]);

export function evaluateAdmission(request: AdmissionRequest, active: readonly ActiveWork[], limits: SchedulingLimits): AdmissionExplanation {
  const reasons: string[] = [];
  const others = active.filter((work) => work.taskId !== request.taskId);
  const model = others.filter((work) => work.kind === "model");
  const gates = others.filter((work) => work.kind === "gate");
  const projectTasks = new Set(others.filter((work) => work.projectId === request.projectId).map((work) => work.taskId)).size;
  const observed: Record<string, number> = {
    modelWorkers: model.length,
    gateJobs: gates.length,
    projectTasks,
    activeProjects: new Set(others.map((work) => work.projectId)).size,
  };

  if (request.kind === "model") {
    if (model.length >= limits.modelWorkers) reasons.push(`model worker cap ${limits.modelWorkers} reached`);
    if (request.provider) {
      const limit = limits.providerLimits[request.provider];
      const onProvider = model.filter((work) => work.provider === request.provider).length;
      observed[`provider:${request.provider}`] = onProvider;
      if (limit !== undefined && onProvider >= limit) reasons.push(`provider ${request.provider} cap ${limit} reached`);
    }
  } else if (gates.length >= limits.gateJobs) {
    reasons.push(`check job cap ${limits.gateJobs} reached`);
  }

  // Project caps apply to new tasks taking a slot; a task already holding one
  // (its own repair, review, or check) is never counted against itself.
  const holdsSlot = active.some((work) => work.taskId === request.taskId);
  if (!holdsSlot) {
    if (projectTasks >= limits.perProjectTasks) reasons.push(`project task cap ${limits.perProjectTasks} reached`);
    const projects = new Set(others.map((work) => work.projectId));
    if (!projects.has(request.projectId) && projects.size >= limits.activeProjects) {
      reasons.push(`active project cap ${limits.activeProjects} reached`);
    }
  }

  for (const work of others) {
    if (work.repoKey !== request.repoKey) continue;
    if (EXCLUSIVE_MODES.has(work.executionMode) || EXCLUSIVE_MODES.has(request.executionMode)) {
      reasons.push(`repository is held by ${work.taskId} (${work.executionMode === request.executionMode ? work.executionMode : "exclusive"} execution)`);
    } else if (scopesOverlap(request.writeScope, work.writeScope)) {
      reasons.push(`write scope overlaps ${work.taskId} in the same repository`);
    }
  }
  for (const resource of request.resources) {
    const holder = others.find((work) => work.resources.includes(resource));
    if (holder) reasons.push(`resource ${resource} is held by ${holder.taskId}`);
  }

  return {
    admitted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    limits: {
      modelWorkers: limits.modelWorkers,
      gateJobs: limits.gateJobs,
      perProjectTasks: limits.perProjectTasks,
      activeProjects: limits.activeProjects,
      childAgents: limits.childAgents,
    },
    observed,
  };
}

export interface FairnessCandidate {
  taskId: string;
  projectId: string;
  priority: number;
  readySince: string;
}

/**
 * Order ready work across projects. A project's position improves with the age
 * of its oldest waiting task and worsens with the service it already received,
 * so a project with long tasks cannot starve one with short tasks. Within a
 * project, priority then age. Projects are interleaved round-robin in that order.
 */
export function fairOrder(
  candidates: readonly FairnessCandidate[],
  serviceByProject: ReadonlyMap<string, number>,
  now = Date.now(),
  agingMs = 10 * 60_000,
): FairnessCandidate[] {
  const byProject = new Map<string, FairnessCandidate[]>();
  for (const candidate of candidates) {
    const list = byProject.get(candidate.projectId) ?? [];
    list.push(candidate);
    byProject.set(candidate.projectId, list);
  }
  for (const list of byProject.values()) {
    list.sort((left, right) => left.priority - right.priority || Date.parse(left.readySince) - Date.parse(right.readySince) || left.taskId.localeCompare(right.taskId));
  }
  const score = (projectId: string) => {
    const oldest = Math.min(...(byProject.get(projectId) ?? []).map((item) => Date.parse(item.readySince)));
    const aging = Number.isFinite(oldest) ? Math.floor(Math.max(0, now - oldest) / agingMs) : 0;
    return (serviceByProject.get(projectId) ?? 0) - aging;
  };
  const projects = [...byProject.keys()].sort((left, right) => score(left) - score(right) || left.localeCompare(right));
  const ordered: FairnessCandidate[] = [];
  for (let round = 0; ordered.length < candidates.length; round += 1) {
    for (const projectId of projects) {
      const item = byProject.get(projectId)?.[round];
      if (item) ordered.push(item);
    }
  }
  return ordered;
}

/**
 * Opt-in adaptive model-worker target with hysteresis. Pressure (host load,
 * quota trouble) lowers the target by one immediately; the target rises by one
 * only after a sustained healthy streak. It never exceeds the approved ceiling
 * and only affects new admissions: running work is never stopped to shrink it.
 */
export class AdaptiveConcurrency {
  readonly ceiling: number;
  readonly floor: number;
  private readonly raiseAfter: number;
  private current: number;
  private healthyStreak = 0;

  constructor(ceiling: number, options: { floor?: number; raiseAfterHealthyTicks?: number } = {}) {
    this.ceiling = ceiling;
    this.floor = Math.min(ceiling, Math.max(1, options.floor ?? 1));
    this.raiseAfter = Math.max(1, options.raiseAfterHealthyTicks ?? 30);
    this.current = ceiling;
  }

  get target(): number {
    return this.current;
  }

  observe(pressure: boolean): number {
    if (pressure) {
      this.healthyStreak = 0;
      this.current = Math.max(this.floor, this.current - 1);
    } else {
      this.healthyStreak += 1;
      if (this.healthyStreak >= this.raiseAfter && this.current < this.ceiling) {
        this.current += 1;
        this.healthyStreak = 0;
      }
    }
    return this.current;
  }
}

/**
 * Everything currently holding capacity or a lock, read from durable state so
 * a restart can neither leak nor forget a slot. `waitingPrefixes` names the
 * blocked reasons of in-flight work that keeps its locks while it waits.
 */
export function collectActiveWork(records: Records, waitingPrefixes: readonly string[], repoKeyFor: (projectId: string, repoPath: string) => string = (_id, path) => canonicalRepoKey(path)): ActiveWork[] {
  const work: ActiveWork[] = [];
  const running = records.listRunningAttempts();
  const checks = records.listActiveStageRuns().filter((stage) => stage.stage === "check" && (stage.state === "launching" || stage.state === "running"));
  const holders = [
    ...records.listTasks({ state: "RUNNING" }),
    ...records.listTasks({ state: "CHECKING" }),
    ...records.listTasks({ state: "REVIEWING" }),
    ...records.listTasks({ state: "BLOCKED" }).filter((task) => waitingPrefixes.some((prefix) => task.blockedReason?.startsWith(prefix))),
  ];
  const seen = new Set<string>();
  for (const task of holders) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const project = records.getProject(task.projectId);
    if (!project) continue;
    const base = {
      taskId: task.id, projectId: task.projectId, repoKey: repoKeyFor(project.id, project.repoPath),
      executionMode: task.executionMode, writeScope: task.allowedScope, resources: task.resources,
    };
    const attempts = running.filter((attempt) => attempt.taskId === task.id);
    const taskChecks = checks.filter((stage) => stage.taskId === task.id);
    for (const attempt of attempts) work.push({ ...base, kind: "model", provider: attempt.adapter });
    for (let index = 0; index < taskChecks.length; index += 1) work.push({ ...base, kind: "gate", provider: null });
    if (attempts.length === 0 && taskChecks.length === 0) work.push({ ...base, kind: null, provider: null });
  }
  return work;
}
