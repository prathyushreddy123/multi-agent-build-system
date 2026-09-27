import type { Records } from "../store/records.ts";
import { normalizeAttemptUsage, subtotalOf, summarizeDurations, type NormalizedAttemptUsage } from "../usage/summary.ts";
import type { UsageCohortCoverage } from "../usage/types.ts";

export interface RoutingOutcome {
  taskClass: string;
  role: string;
  adapter: string;
  model: string | null;
  effort: string | null;
  attempts: number;
  succeededAttempts: number;
  tasks: number;
  /**
   * Tasks this route actually delivered: the route produced the revision the
   * task was accepted on (or, for review attempts, completed the review of it).
   */
  acceptedTasks: number;
  /**
   * Tasks that were accepted later but not by this route. A failed route is
   * counted here, never as an acceptance, so two route groups cannot both claim
   * to have delivered the same task.
   */
  contributedTasks: number;
  /** Accepted tasks whose delivering revision could not be matched from records. */
  unverifiedAcceptedTasks: number;
  repairs: number;
  reviewChangeRequests: number;
  failures: number;
  /** Sum of completed attempt durations (`ended_at - started_at`), failures included. */
  executionMs: number;
  measuredDurationAttempts: number;
  runningDurationAttempts: number;
  missingDurationAttempts: number;
  invalidDurationAttempts: number;
  /** Known provider-reported subtotals. Null means nothing was measured. */
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  reportedUsageAttempts: number;
  usageCoverage: UsageCohortCoverage;
  completeUsageAttempts: number;
  partialUsageAttempts: number;
  missingUsageAttempts: number;
  malformedUsageAttempts: number;
  usageConflicts: string[];
}

interface Group {
  taskClass: string;
  role: string;
  adapter: string;
  model: string | null;
  effort: string | null;
  attempts: number;
  succeededAttempts: number;
  repairs: number;
  reviewChangeRequests: number;
  failures: number;
  taskIds: Set<string>;
  deliveredTaskIds: Set<string>;
  unverifiedTaskIds: Set<string>;
  doneTaskIds: Set<string>;
  usage: NormalizedAttemptUsage[];
  durations: Array<{ attemptId: string; startedAt: unknown; endedAt: unknown; state: string | null }>;
}

const ATTEMPT_QUERY =
  `SELECT a.*, t.task_class, t.state task_state, t.result_revision task_result_revision
   FROM attempts a JOIN tasks t ON t.id = a.task_id`;

/**
 * Aggregate observed routing outcomes.
 *
 * Nothing here is estimated: usage keeps its normalized coverage, duration comes
 * from recorded `ended_at`, and acceptance is separated from mere contribution
 * so a failed Opus/Codex route does not become successful because another
 * worker finished the task afterwards.
 */
export function routingOutcomes(records: Records, projectId?: string): RoutingOutcome[] {
  const attempts = projectId
    ? records.store.all(`${ATTEMPT_QUERY} WHERE t.project_id = ? ORDER BY a.started_at`, projectId)
    : records.store.all(`${ATTEMPT_QUERY} ORDER BY a.started_at`);
  const groups = new Map<string, Group>();
  for (const attempt of attempts) {
    const role = attempt.kind === "review" ? "review" : "implementation";
    const key = [attempt.task_class, role, attempt.adapter, attempt.model ?? "", attempt.effort ?? ""].join("\0");
    let group = groups.get(key);
    if (!group) {
      group = {
        taskClass: String(attempt.task_class), role, adapter: String(attempt.adapter),
        model: (attempt.model as string) ?? null, effort: (attempt.effort as string) ?? null,
        attempts: 0, succeededAttempts: 0, repairs: 0, reviewChangeRequests: 0, failures: 0,
        taskIds: new Set(), deliveredTaskIds: new Set(), unverifiedTaskIds: new Set(),
        doneTaskIds: new Set(), usage: [], durations: [],
      };
      groups.set(key, group);
    }
    const attemptId = String(attempt.id);
    const taskId = String(attempt.task_id);
    group.attempts += 1;
    group.taskIds.add(taskId);
    if (attempt.kind === "repair") group.repairs += 1;
    if (attempt.state === "succeeded") group.succeededAttempts += 1;
    if (attempt.state === "failed") group.failures += 1;

    if (attempt.task_state === "DONE") {
      group.doneTaskIds.add(taskId);
      if (attempt.state === "succeeded") {
        const taskRevision = (attempt.task_result_revision as string) ?? null;
        const attemptRevision = (attempt.result_revision as string) ?? null;
        if (role === "review") {
          // A review produces a verdict, not a revision. Credit it only when it
          // reviewed the revision the task was accepted on.
          const reviewedRevision = (attempt.base_revision as string) ?? null;
          if (taskRevision === null || reviewedRevision === taskRevision) group.deliveredTaskIds.add(taskId);
          if (taskRevision === null) group.unverifiedTaskIds.add(taskId);
        } else if (taskRevision !== null && attemptRevision !== null) {
          if (taskRevision === attemptRevision) group.deliveredTaskIds.add(taskId);
        } else {
          // Records do not tie this successful attempt to the accepted revision.
          group.deliveredTaskIds.add(taskId);
          group.unverifiedTaskIds.add(taskId);
        }
      }
    }

    group.usage.push({
      attemptId,
      usage: normalizeAttemptUsage({
        attemptId,
        adapter: String(attempt.adapter),
        raw: attempt.usage_json,
        reportedModel: (attempt.reported_model as string) ?? null,
        providerSchemaVersion: (attempt.cli_version as string) ?? null,
      }),
    });
    group.durations.push({
      attemptId,
      startedAt: attempt.started_at,
      endedAt: attempt.ended_at,
      state: (attempt.state as string) ?? null,
    });

    if (role === "review") {
      const changes = records.store.get(
        "SELECT count(*) total FROM review_results WHERE attempt_id = ? AND verdict = 'request_changes'", attempt.id,
      );
      group.reviewChangeRequests += Number(changes?.total ?? 0);
    }
  }

  return [...groups.values()].map((group): RoutingOutcome => {
    const usage = subtotalOf(group.usage);
    const duration = summarizeDurations(group.durations);
    const contributed = [...group.doneTaskIds].filter((taskId) => !group.deliveredTaskIds.has(taskId));
    return {
      taskClass: group.taskClass,
      role: group.role,
      adapter: group.adapter,
      model: group.model,
      effort: group.effort,
      attempts: group.attempts,
      succeededAttempts: group.succeededAttempts,
      tasks: group.taskIds.size,
      acceptedTasks: group.deliveredTaskIds.size,
      contributedTasks: contributed.length,
      unverifiedAcceptedTasks: group.unverifiedTaskIds.size,
      repairs: group.repairs,
      reviewChangeRequests: group.reviewChangeRequests,
      failures: group.failures,
      executionMs: duration.milliseconds,
      measuredDurationAttempts: duration.measuredAttempts,
      runningDurationAttempts: duration.runningAttempts.length,
      missingDurationAttempts: duration.missingAttempts.length,
      invalidDurationAttempts: duration.invalidAttempts.length,
      reportedInputTokens: usage.knownInputEvents,
      reportedOutputTokens: usage.knownOutputTokens,
      reportedUsageAttempts: usage.measuredAttempts,
      usageCoverage: usage.coverage,
      completeUsageAttempts: usage.completeAttempts,
      partialUsageAttempts: usage.partialAttempts,
      missingUsageAttempts: usage.missingAttempts.length,
      malformedUsageAttempts: usage.malformedAttempts.length,
      usageConflicts: usage.conflicts,
    };
  }).sort((left, right) =>
    left.taskClass.localeCompare(right.taskClass)
    || left.role.localeCompare(right.role)
    || left.adapter.localeCompare(right.adapter)
    || (left.model ?? "").localeCompare(right.model ?? "")
    || (left.effort ?? "").localeCompare(right.effort ?? ""));
}
