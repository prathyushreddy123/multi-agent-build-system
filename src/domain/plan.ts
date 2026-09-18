import type { Ambiguity, ChangeRisk, Complexity, TaskClass } from "../routing/router.ts";
import type { Records, Task } from "../store/records.ts";

export type ExecutionMode = "single" | "sequential" | "parallel" | "mixed";

export interface PlannedTask {
  key: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
  role?: string;
  taskClass?: TaskClass;
  complexity?: Complexity;
  ambiguity?: Ambiguity;
  changeRisk?: ChangeRisk;
  language?: string | null;
  domain?: string | null;
  contextSize?: Complexity;
  requiredTools?: string[];
  allowedScope?: string[];
  executionMode: ExecutionMode;
  executionReason: string;
  priority?: number;
}

export interface ExecutionPlan {
  objective: string;
  mode: ExecutionMode;
  reason: string;
  assumptions?: string[];
  milestones?: string[];
  tasks: PlannedTask[];
}

export interface PlanValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  topologicalOrder: string[];
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const normalize = (scope: string) => scope.replace(/^\.\//, "").replace(/\/$/, "");
  return left.some((a) => right.some((b) => {
    const x = normalize(a);
    const y = normalize(b);
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}

function hasDependencyPath(from: string, to: string, dependencies: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const visit = (key: string): boolean => {
    if (key === to) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return (dependencies.get(key) ?? []).some(visit);
  };
  return visit(from);
}

/** Validate graph safety and parallel edit independence without model inference. */
export function validateExecutionPlan(plan: ExecutionPlan): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof plan?.objective !== "string" || !plan.objective.trim()) errors.push("Plan objective is required.");
  if (typeof plan?.reason !== "string" || !plan.reason.trim()) errors.push("Execution-mode reason is required.");
  if (typeof plan?.mode !== "string" || !["single", "sequential", "parallel", "mixed"].includes(plan.mode)) {
    errors.push(`Unknown plan execution mode: ${String(plan?.mode)}`);
  }
  if (plan?.assumptions !== undefined && (!Array.isArray(plan.assumptions) || plan.assumptions.some((item) => typeof item !== "string"))) {
    errors.push("Plan assumptions must be an array of strings.");
  }
  if (plan?.milestones !== undefined && (!Array.isArray(plan.milestones) || plan.milestones.some((item) => typeof item !== "string"))) {
    errors.push("Plan milestones must be an array of strings.");
  }
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (!Array.isArray(plan?.tasks)) errors.push("Plan tasks must be an array.");
  else if (tasks.length === 0) errors.push("Plan must contain at least one task.");

  const byKey = new Map<string, PlannedTask>();
  for (const [index, task] of tasks.entries()) {
    const key = typeof task?.key === "string" ? task.key : "";
    const label = key || `task[${index}]`;
    if (!key.trim()) errors.push("Every task requires a non-empty key.");
    else if (byKey.has(key)) errors.push(`Duplicate task key: ${key}`);
    else byKey.set(key, task);
    if (typeof task?.title !== "string" || !task.title.trim()) errors.push(`${label}: title is required.`);
    if (typeof task?.objective !== "string" || !task.objective.trim()) errors.push(`${label}: objective is required.`);
    if (!Array.isArray(task?.acceptanceCriteria) || task.acceptanceCriteria.length === 0 || task.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())) {
      errors.push(`${label}: at least one non-empty acceptance criterion is required.`);
    }
    if (typeof task?.executionMode !== "string" || !["single", "sequential", "parallel", "mixed"].includes(task.executionMode)) {
      errors.push(`${label}: unknown execution mode ${String(task?.executionMode)}.`);
    }
    if (typeof task?.executionReason !== "string" || !task.executionReason.trim()) errors.push(`${label}: execution reason is required.`);
    if (task?.allowedScope !== undefined) {
      const invalidScope = !Array.isArray(task.allowedScope) || task.allowedScope.some((scope) => {
        if (typeof scope !== "string") return true;
        const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "");
        return !normalized || normalized.startsWith("/") || normalized.split("/").includes("..");
      });
      if (invalidScope) errors.push(`${label}: allowedScope must contain only repository-relative paths.`);
    }
  }

  const dependencies = new Map<string, string[]>();
  for (const task of byKey.values()) {
    if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.some((dependency) => typeof dependency !== "string"))) {
      errors.push(`${task.key}: dependsOn must contain only task keys.`);
      dependencies.set(task.key, []);
      continue;
    }
    const deps = [...new Set(task.dependsOn ?? [])];
    dependencies.set(task.key, deps);
    for (const dependency of deps) {
      if (!byKey.has(dependency)) errors.push(`${task.key}: unknown dependency ${dependency}.`);
      if (dependency === task.key) errors.push(`${task.key}: task cannot depend on itself.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (key: string, path: string[]): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      errors.push(`Dependency cycle: ${[...path, key].join(" -> ")}`);
      return;
    }
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (byKey.has(dependency)) visit(dependency, [...path, key]);
    }
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  };
  for (const key of byKey.keys()) visit(key, []);

  const parallel = [...byKey.values()].filter((task) => task.executionMode === "parallel" || plan.mode === "parallel");
  for (let i = 0; i < parallel.length; i += 1) {
    for (let j = i + 1; j < parallel.length; j += 1) {
      const left = parallel[i] as PlannedTask;
      const right = parallel[j] as PlannedTask;
      const ordered = hasDependencyPath(left.key, right.key, dependencies) || hasDependencyPath(right.key, left.key, dependencies);
      if (!ordered && scopesOverlap(left.allowedScope ?? [], right.allowedScope ?? [])) {
        errors.push(`${left.key} and ${right.key}: parallel edit scopes overlap; make them sequential or provide disjoint allowedScope values.`);
      }
    }
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings, topologicalOrder: order };
}

export function applyExecutionPlan(records: Records, projectId: string, plan: ExecutionPlan): Task[] {
  const validation = validateExecutionPlan(plan);
  if (!validation.valid) throw new Error(`Invalid execution plan:\n${validation.errors.join("\n")}`);
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  return records.store.tx(() => {
    const created = new Map<string, Task>();
    for (const key of validation.topologicalOrder) {
      const item = byKey.get(key) as PlannedTask;
      const task = records.createTask({
        projectId,
        title: item.title,
        objective: item.objective,
        acceptanceCriteria: item.acceptanceCriteria,
        role: item.role,
        taskClass: item.taskClass,
        complexity: item.complexity,
        ambiguity: item.ambiguity,
        changeRisk: item.changeRisk,
        language: item.language,
        domain: item.domain,
        contextSize: item.contextSize,
        requiredTools: item.requiredTools,
        allowedScope: item.allowedScope,
        priority: item.priority,
        dependsOn: (item.dependsOn ?? []).map((dependency) => (created.get(dependency) as Task).id),
        executionMode: item.executionMode,
        executionReason: item.executionReason,
      });
      created.set(key, task);
    }
    const tasks = validation.topologicalOrder.map((key) => created.get(key) as Task);
    records.recordExecutionPlan({
      projectId,
      objective: plan.objective,
      mode: plan.mode,
      reason: plan.reason,
      assumptions: plan.assumptions,
      milestones: plan.milestones,
      tasks: validation.topologicalOrder.map((key) => ({ taskId: (created.get(key) as Task).id, key })),
    });
    return tasks;
  });
}
