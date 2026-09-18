import { fromJson } from "../store/db.ts";
import type { Records } from "../store/records.ts";

export interface RoutingOutcome {
  taskClass: string;
  role: string;
  adapter: string;
  model: string | null;
  effort: string | null;
  attempts: number;
  tasks: number;
  acceptedTasks: number;
  repairs: number;
  reviewChangeRequests: number;
  failures: number;
  executionMs: number;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  reportedUsageAttempts: number;
}

/** Aggregates observed outcomes only. Null usage remains unknown rather than estimated. */
export function routingOutcomes(records: Records, projectId?: string): RoutingOutcome[] {
  const attempts = projectId
    ? records.store.all(
        `SELECT a.*, t.task_class, t.state task_state FROM attempts a JOIN tasks t ON t.id = a.task_id
         WHERE t.project_id = ? ORDER BY a.started_at`, projectId,
      )
    : records.store.all(
        `SELECT a.*, t.task_class, t.state task_state FROM attempts a JOIN tasks t ON t.id = a.task_id ORDER BY a.started_at`,
      );
  const groups = new Map<string, RoutingOutcome & { taskIds: Set<string>; acceptedIds: Set<string>; usageComplete: boolean }>();
  for (const attempt of attempts) {
    const role = attempt.kind === "review" ? "review" : "implementation";
    const key = [attempt.task_class, role, attempt.adapter, attempt.model ?? "", attempt.effort ?? ""].join("\0");
    let group = groups.get(key);
    if (!group) {
      group = {
        taskClass: String(attempt.task_class), role, adapter: String(attempt.adapter),
        model: (attempt.model as string) ?? null, effort: (attempt.effort as string) ?? null,
        attempts: 0, tasks: 0, acceptedTasks: 0, repairs: 0, reviewChangeRequests: 0,
        failures: 0, executionMs: 0, reportedInputTokens: 0, reportedOutputTokens: 0,
        reportedUsageAttempts: 0, taskIds: new Set(), acceptedIds: new Set(), usageComplete: true,
      };
      groups.set(key, group);
    }
    group.attempts += 1;
    group.taskIds.add(String(attempt.task_id));
    if (attempt.task_state === "DONE") group.acceptedIds.add(String(attempt.task_id));
    if (attempt.kind === "repair") group.repairs += 1;
    if (attempt.state === "failed") group.failures += 1;
    if (attempt.started_at && attempt.finished_at) {
      group.executionMs += Math.max(0, new Date(String(attempt.finished_at)).getTime() - new Date(String(attempt.started_at)).getTime());
    }
    const usage = fromJson<Record<string, unknown>>(attempt.usage_json, {});
    if (typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
      group.reportedInputTokens = (group.reportedInputTokens ?? 0) + usage.input_tokens;
      group.reportedOutputTokens = (group.reportedOutputTokens ?? 0) + usage.output_tokens;
      group.reportedUsageAttempts += 1;
    } else {
      group.usageComplete = false;
    }
    if (role === "review") {
      const changes = records.store.get(
        "SELECT count(*) total FROM review_results WHERE attempt_id = ? AND verdict = 'request_changes'", attempt.id,
      );
      group.reviewChangeRequests += Number(changes?.total ?? 0);
    }
  }
  return [...groups.values()].map(({ taskIds, acceptedIds, usageComplete, ...group }) => ({
    ...group,
    tasks: taskIds.size,
    acceptedTasks: acceptedIds.size,
    reportedInputTokens: usageComplete ? group.reportedInputTokens : null,
    reportedOutputTokens: usageComplete ? group.reportedOutputTokens : null,
  })).sort((left, right) => left.taskClass.localeCompare(right.taskClass) || left.role.localeCompare(right.role) || left.adapter.localeCompare(right.adapter));
}
