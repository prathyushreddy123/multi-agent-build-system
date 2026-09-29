/**
 * Native operator views: read-only projections of authoritative records.
 *
 * Every view states what is unknown instead of filling it in: a missing
 * governance decision is an actionable question, a provider that reports no
 * effort shows "unknown", missing usage is counted as missing, and an accepted
 * task whose review was not required is never labeled approved. Views are
 * bounded and paginated; none needs a network service.
 */
import { evaluateProjectReadiness } from "../domain/project-policy.ts";
import { curatorRecommendations } from "../curator/service.ts";
import { listExperiments } from "../optimization/experiments.ts";
import { collectActiveWork, canonicalRepoKey, evaluateAdmission } from "../scheduling/admission.ts";
import type { Records, Task } from "../store/records.ts";
import { dirname, join } from "node:path";

import { attemptHealth } from "../telemetry/health.ts";
import { readProgress } from "../telemetry/stream.ts";
import { normalizeAttemptUsage, subtotalOf } from "../usage/summary.ts";

export const VIEWS_VERSION = "mabs.operator-views.v1";
const UNKNOWN = "unknown (not reported by the provider)";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

function page<T>(items: T[], limit = 50, offset = 0): Page<T> {
  const boundedLimit = Math.min(Math.max(1, limit), 500);
  const boundedOffset = Math.max(0, offset);
  return { items: items.slice(boundedOffset, boundedOffset + boundedLimit), total: items.length, limit: boundedLimit, offset: boundedOffset };
}

/** Projects that cannot run new implementation, each with the exact question and command to answer it. */
export function governancePrompts(records: Records) {
  return records.listProjects().flatMap((project) => {
    const readiness = evaluateProjectReadiness(project.governance, project.reviewPolicy);
    if (readiness.ready) return [];
    return [{
      projectId: project.id,
      projectName: project.name,
      missing: readiness.missing,
      conflicts: readiness.conflicts,
      questions: readiness.questions.map((question) => ({ ...question, default: null })),
      // Nothing is assumed: the command is shown with the choice left for the person.
      answerWith: `mabs project governance ${project.id} --type=<${["personal", "client", "other"].join("|")}> --review=<off|risk|required> --version=${project.governance.version}`,
    }];
  });
}

export type ReviewLabel = "approved" | "not_required" | "pending" | "changes_requested" | "blocked" | "not_yet_decided";

function reviewStatus(records: Records, task: Task): { status: ReviewLabel; reviewId: string | null; label: string } {
  const accepted = records.listEventsOfKind(task.id, "task.accepted").at(-1);
  if (accepted) {
    const review = (JSON.parse(String(accepted.data)) as { review?: { status?: string; reviewId?: string | null } }).review;
    if (review?.status === "approved") return { status: "approved", reviewId: review.reviewId ?? null, label: "Independent review approved this revision." };
    if (review?.status === "not_required") return { status: "not_required", reviewId: null, label: "Review was not required by policy; this is not an approval." };
  }
  if (task.blockedReason?.startsWith("Review pending:")) return { status: "pending", reviewId: null, label: task.blockedReason };
  const latest = records.reviewsForTask(task.id).at(-1);
  if (latest?.verdict === "request_changes") return { status: "changes_requested", reviewId: latest.id, label: latest.summary };
  if (latest?.verdict === "blocked") return { status: "blocked", reviewId: latest.id, label: latest.summary };
  if (latest?.verdict === "approved") return { status: "approved", reviewId: latest.id, label: "Independent review approved a revision." };
  return { status: "not_yet_decided", reviewId: null, label: "No review decision has been recorded yet." };
}

/** One task's quality, review, usage-coverage, and provenance evidence. */
export function taskScorecard(records: Records, taskId: string) {
  const task = records.getTask(taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  const project = records.getProject(task.projectId);
  const normalized = records.listAttempts(task.id).map((attempt) => ({
    attempt, usage: normalizeAttemptUsage({ attemptId: attempt.id, adapter: attempt.adapter, raw: attempt.usage }),
  }));
  const attempts = normalized.map(({ attempt, usage }) => {
    const progress = attempt.state === "running" && attempt.outputPath ? readProgress(join(dirname(attempt.outputPath), "progress.json")) : null;
    return {
      id: attempt.id,
      kind: attempt.kind,
      state: attempt.state,
      adapter: attempt.adapter,
      model: { requested: attempt.requestedModel, configured: attempt.configuredModel ?? "provider default", reported: attempt.reportedModel ?? UNKNOWN },
      effort: { requested: attempt.requestedEffort, configured: attempt.configuredEffort ?? "provider default", reported: attempt.reportedEffort ?? UNKNOWN },
      usage: {
        coverage: usage.coverage, knownInputEvents: usage.knownInputEvents, outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
        cachedInputTokens: usage.cachedInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens,
      },
      health: attemptHealth({ state: attempt.state, startedAt: attempt.startedAt, lastEventAt: progress?.lastEventAt ?? attempt.lastProgressAt }),
      resumedSession: attempt.parentSessionId !== null,
      durationMs: attempt.endedAt ? Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt) : null,
      engineVersion: attempt.engineVersion ?? "unrecorded",
      promptVersion: attempt.promptVersion ?? "unrecorded",
      failureClass: attempt.failureClass,
    };
  });
  const coverage = { attempts: attempts.length, complete: 0, partial: 0, missing: 0, malformed: 0 };
  for (const attempt of attempts) coverage[attempt.usage.coverage] += 1;
  const obligations = records.listObligations(task.id);
  const routing = records.routingForTask(task.id);
  return {
    version: VIEWS_VERSION,
    task: { id: task.id, title: task.title, state: task.state, projectId: task.projectId, resultRevision: task.resultRevision },
    governance: project ? evaluateProjectReadiness(project.governance, project.reviewPolicy) : null,
    review: reviewStatus(records, task),
    quality: task.resultRevision ? records.qualityCoverage(task.id, task.resultRevision) : null,
    attempts,
    usageCoverage: coverage,
    // Per provider: Claude and Codex input events follow different semantics and are never added together.
    usageByProvider: Object.fromEntries([...new Set(normalized.map(({ attempt }) => attempt.adapter))].map((adapter) => [adapter,
      subtotalOf(normalized.filter(({ attempt }) => attempt.adapter === adapter).map(({ attempt, usage }) => ({ attemptId: attempt.id, usage })))])),
    obligations: {
      open: obligations.filter((item) => item.state === "open" || item.state === "addressed_pending_validation").length,
      blocking: obligations.filter((item) => item.blocking && (item.state === "open" || item.state === "addressed_pending_validation")).length,
      resolved: obligations.filter((item) => item.state === "resolved").length,
    },
    provenance: {
      engineVersions: [...new Set(attempts.map((attempt) => attempt.engineVersion))],
      promptVersions: [...new Set(attempts.map((attempt) => attempt.promptVersion))],
      configVersions: [...new Set(records.packetsForTask(task.id).map((packet) => String(packet.config_version ?? "unrecorded")))],
      capabilityRegistryVersions: [...new Set(routing.map((row) => String(row.capability_registry_version ?? "unrecorded")))],
    },
  };
}

/** Why each waiting task is waiting, from durable state only. */
export function queueExplanations(records: Records, options: { limit?: number; offset?: number; modelWorkers?: number } = {}) {
  const active = collectActiveWork(records, ["Admission pending:", "Review pending:"]);
  const providerLimits: Record<string, number> = {};
  for (const provider of records.listProviderCapacity()) providerLimits[provider.provider] = provider.maxConcurrency;
  const waiting = [
    ...records.listTasks({ state: "READY" }),
    ...records.listTasks({ state: "QUEUED" }),
    ...records.listTasks({ state: "BLOCKED" }),
  ];
  const items = waiting.map((task) => {
    const project = records.getProject(task.projectId);
    const reasons: string[] = [];
    let category = "unknown";
    if (project) {
      const readiness = evaluateProjectReadiness(project.governance, project.reviewPolicy);
      if (!readiness.ready) {
        category = "needs_input";
        reasons.push(`Project governance needs a decision: ${[...readiness.missing, ...readiness.conflicts].join(", ")}.`);
      }
    }
    const pendingDependencies = records.dependenciesOf(task.id).filter((id) => records.getTask(id)?.state !== "DONE");
    if (task.state === "QUEUED" && pendingDependencies.length > 0) {
      category = category === "unknown" ? "dependency" : category;
      reasons.push(`Waiting on ${pendingDependencies.length} dependenc${pendingDependencies.length === 1 ? "y" : "ies"}: ${pendingDependencies.join(", ")}.`);
    }
    if (task.state === "BLOCKED") {
      category = task.blockedReason?.startsWith("Admission pending:") || task.blockedReason?.startsWith("Review pending:") ? "capacity" : "blocked";
      reasons.push(task.blockedReason ?? "Blocked without a recorded reason.");
    }
    if (task.state === "READY" && project) {
      const explanation = evaluateAdmission({
        taskId: task.id, projectId: task.projectId, repoKey: canonicalRepoKey(project.repoPath),
        kind: task.taskClass === "mechanical" ? "gate" : "model", provider: null,
        executionMode: task.executionMode, writeScope: task.allowedScope, resources: task.resources,
      }, active, {
        modelWorkers: options.modelWorkers ?? 1, providerLimits, perProjectTasks: options.modelWorkers ?? 1,
        activeProjects: 2, gateJobs: 2, childAgents: 0,
      });
      if (!explanation.admitted) {
        category = category === "unknown" ? "capacity" : category;
        reasons.push(...explanation.reasons);
      } else if (category === "unknown") {
        category = "admissible";
        reasons.push("Admissible now; it starts on the next controller tick if the controller is running.");
      }
    }
    return { taskId: task.id, projectId: task.projectId, title: task.title, state: task.state, category, reasons };
  });
  return page(items, options.limit, options.offset);
}

/** A bounded, paged task timeline with evidence references. Newest first. */
export function taskTimeline(records: Records, taskId: string, options: { limit?: number; offset?: number } = {}) {
  const rows = records.store.all("SELECT id, at, kind, attempt_id, data FROM events WHERE task_id = ? ORDER BY rowid DESC LIMIT 5000", taskId);
  return page(rows.map((row) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(String(row.data)) as Record<string, unknown>; } catch { /* malformed legacy payload stays opaque */ }
    const evidence = Object.entries(data)
      .filter(([key, value]) => typeof value === "string" && /(path|evidence)/i.test(key) && (value as string).startsWith("/"))
      .map(([, value]) => value as string);
    return { id: row.id as string, at: row.at as string, kind: row.kind as string, attemptId: (row.attempt_id as string) ?? null, data, evidence };
  }), options.limit, options.offset);
}

/** Incidents, remedies, experiments, and proposals for one project. Read-only. */
export function improvementBoard(records: Records, projectId: string) {
  if (!records.getProject(projectId)) throw new Error(`Unknown project ${projectId}`);
  return {
    version: VIEWS_VERSION,
    incidents: records.listIncidents({ projectId }).map((incident) => ({
      id: incident.id, category: incident.category, symptom: incident.symptom, lifecycle: incident.lifecycle,
      lesson: incident.confidence === "verified" ? `verified: ${incident.confirmedCause}` : incident.hypothesis ? `hypothesis (${incident.confidence}): ${incident.hypothesis}` : "no lesson recorded",
      occurrences: records.incidentOccurrences(incident.id).length,
    })),
    recommendations: curatorRecommendations(records, projectId),
    experiments: listExperiments(records, projectId).map((experiment) => ({
      id: experiment.id, name: experiment.name, status: experiment.status, conclusion: experiment.conclusion,
    })),
    proposals: records.listCuratorProposals(projectId).map((proposal) => ({ id: proposal.id, title: proposal.title, status: proposal.status })),
  };
}
