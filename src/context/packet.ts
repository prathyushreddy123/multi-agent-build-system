import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ids } from "../core/ids.ts";
import { artifactDir } from "../core/paths.ts";
import { CONTRACT_VERSION, WORKER_OUTPUT_SCHEMA } from "../domain/contract.ts";
import type { WorkerInput, WorkerRole } from "../domain/contract.ts";
import type { Project, Records, Task } from "../store/records.ts";
import type { Workspace } from "../workspace/git.ts";

export interface ExecutionSelection {
  harness: string;
  model: string | null;
  effort: string | null;
  authMode: string;
}

export interface ContextPacket {
  id: string;
  input: WorkerInput;
  manifestPath: string;
  prompt: string;
}

function roleOf(value: string): WorkerRole {
  const roles: WorkerRole[] = ["implementer", "reviewer", "researcher", "troubleshooter", "curator"];
  if (!roles.includes(value as WorkerRole)) throw new Error(`Unsupported worker role: ${value}`);
  return value as WorkerRole;
}

/** Build a deterministic, project-owned handoff rather than relying on provider chat history. */
export function buildContextPacket(input: {
  records: Records;
  project: Project;
  task: Task;
  attemptId: string;
  workspace: Workspace;
  execution: ExecutionSelection;
  previousFindings?: string[];
  purpose?: "implementation" | "review";
  additionalArtifacts?: string[];
}): ContextPacket {
  const packetId = ids.packet();
  const requirements = input.records.listRequirements(input.project.id);
  const dependencyTasks = input.records.dependenciesOf(input.task.id)
    .map((id) => input.records.getTask(id))
    .filter((task): task is Task => task !== null);
  const purpose = input.purpose ?? "implementation";
  const artifacts = [
    ...dependencyTasks.flatMap((task) =>
      input.records.listAttempts(task.id).map((attempt) => attempt.outputPath).filter((path): path is string => path !== null),
    ),
    ...(input.additionalArtifacts ?? []),
  ];
  const previousFindings = [
    ...(input.previousFindings ?? []),
    ...dependencyTasks.map((task) => `${task.id}: ${task.resultSummary ?? `state=${task.state}`}`),
  ];
  const warnings: string[] = [];
  if (requirements.filter((requirement) => requirement.mandatory).length === 0) {
    warnings.push("Project has no mandatory requirements with stable IDs.");
  }

  const workerInput: WorkerInput = {
    identity: {
      project_id: input.project.id,
      task_id: input.task.id,
      attempt_id: input.attemptId,
      role: purpose === "review" ? "reviewer" : roleOf(input.task.role),
      contract_version: CONTRACT_VERSION,
    },
    task: {
      objective: purpose === "review"
        ? `Independently review revision ${input.task.resultRevision ?? input.workspace.baseRevision} for task: ${input.task.objective}`
        : input.task.objective,
      acceptance_criteria: purpose === "review"
        ? [
            "Inspect the actual diff, surrounding code, registered gate evidence, and authoritative requirements.",
            "Report every actionable finding in follow_up.unresolved with a [critical], [major], or [minor] prefix.",
            "Return outcome=completed when the review was performed, even when changes are requested; use blocked only when review evidence is unavailable.",
          ]
        : input.task.acceptanceCriteria,
      dependencies: dependencyTasks.map((task) => task.id),
      profile: {
        task_class: input.task.taskClass,
        complexity: input.task.complexity,
        ambiguity: input.task.ambiguity,
        change_risk: input.task.changeRisk,
        language: input.task.language,
        domain: input.task.domain,
        context_size: input.task.contextSize,
        required_tools: input.task.requiredTools,
        execution_mode: input.task.executionMode,
        execution_reason: input.task.executionReason,
      },
      deadline_at: input.task.deadlineAt,
      repairs_used: input.task.repairsUsed,
      repair_limit: input.task.repairLimit,
    },
    workspace: {
      worktree_path: input.workspace.path,
      base_revision: input.workspace.baseRevision,
      branch: input.workspace.branch,
      allowed_scope: input.task.allowedScope.length > 0
        ? input.task.allowedScope.map((scope) => join(input.workspace.path, scope))
        : [input.workspace.path],
      allowed_actions: purpose === "review" ? ["read", "run_checks"] : ["read", "edit", "run_checks"],
      forbidden_actions: purpose === "review"
        ? ["edit", "git_commit", "push", "merge", "deploy", "delete_shared_data", "change_scope"]
        : ["git_commit (controller-owned)", "push", "merge", "deploy", "delete_shared_data", "change_scope"],
    },
    execution: {
      harness: input.execution.harness,
      model: input.execution.model,
      effort: input.execution.effort,
      auth_mode: input.execution.authMode,
    },
    context: {
      packet_id: packetId,
      requirements: requirements.map(({ id, text }) => ({ id, text })),
      files: [],
      previous_findings: previousFindings,
      artifacts,
      config_version: input.project.configVersion,
    },
  };

  const dir = artifactDir(input.task.id, input.attemptId);
  const manifestPath = join(dir, "context.json");
  writeFileSync(manifestPath, JSON.stringify({ packet_id: packetId, warnings, worker_input: workerInput }, null, 2), { mode: 0o600 });
  input.records.recordPacket({
    id: packetId,
    taskId: input.task.id,
    attemptId: input.attemptId,
    requirementIds: requirements.map((requirement) => requirement.id),
    omitted: [],
    files: [],
    artifacts,
    baseRevision: input.workspace.baseRevision,
    tokenEstimate: null,
    manifestPath,
    warnings,
  });

  const prompt = [
    "You are a MABS worker. Follow the supplied contract exactly.",
    "Work only in the assigned worktree. Do not push, merge, deploy, or broaden scope.",
    purpose === "review"
      ? "This is an independent, read-only review. Do not edit tracked files. Inspect evidence directly instead of relying on the implementer's summary."
      : "Do not run git commit. Linked-worktree Git metadata may be outside your sandbox; after you report completed, the controller creates the required local commit and binds checks to it.",
    purpose === "review"
      ? "Put actionable findings in follow_up.unresolved and prefix each with [critical], [major], or [minor]. Leave unresolved empty only when the revision is acceptable."
      : "A task acceptance criterion requiring a local commit is therefore a controller postcondition, not a reason to report blocked.",
    "Treat project requirements and acceptance criteria as authoritative.",
    "Worker input:",
    JSON.stringify(workerInput, null, 2),
    "",
    "When finished, create .mabs/result.json in the worktree containing exactly one JSON object matching this schema:",
    JSON.stringify(WORKER_OUTPUT_SCHEMA),
    "Use null for unknown usage; never invent measurements.",
    "Your final message must contain the same JSON object and no additional prose.",
  ].join("\n");

  return { id: packetId, input: workerInput, manifestPath, prompt };
}
