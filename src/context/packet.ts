import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ids } from "../core/ids.ts";
import { artifactDir } from "../core/paths.ts";
import { CONTRACT_VERSION } from "../domain/contract.ts";
import type { WorkerInput, WorkerRole } from "../domain/contract.ts";
import { assembleWorkerPrompt } from "../prompts/roles.ts";
import { guidanceForAttempt, guidanceText } from "../prompts/versions.ts";
import type { Project, Records, Task } from "../store/records.ts";
import type { Workspace } from "../workspace/git.ts";
import { estimateTokens, retrieveContext } from "./retrieval.ts";

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
  const promptAddendum = purpose === "review"
    ? input.project.promptProfile.reviewAddendum
    : input.task.role === "researcher"
      ? input.project.promptProfile.researchAddendum
      : input.project.promptProfile.implementationAddendum;
  const artifacts = [
    ...dependencyTasks.flatMap((task) =>
      input.records.listAttempts(task.id).map((attempt) => attempt.outputPath).filter((path): path is string => path !== null),
    ),
    ...(input.additionalArtifacts ?? []),
  ];
  const checkpoint = input.records.latestCheckpoint(input.task.id);
  const previousFindings = [
    ...(input.previousFindings ?? []),
    ...dependencyTasks.map((task) => `${task.id}: ${task.resultSummary ?? `state=${task.state}`}`),
    ...(checkpoint ? checkpoint.findings : []),
  ];
  const warnings: string[] = [];
  if (requirements.filter((requirement) => requirement.mandatory).length === 0) {
    warnings.push("Project has no mandatory requirements with stable IDs.");
  }
  const checkpointContext = checkpoint ? {
    id: checkpoint.id,
    kind: checkpoint.kind,
    summary: checkpoint.summary,
    result_revision: checkpoint.resultRevision,
    changed_files: checkpoint.changedFiles,
    findings: checkpoint.findings,
    unresolved: checkpoint.unresolved,
    next_action: checkpoint.nextAction,
    evidence: checkpoint.evidence,
  } : null;
  const fixedContextEstimate = estimateTokens(JSON.stringify({
    requirements: requirements.map(({ id, text }) => ({ id, text })),
    previousFindings,
    artifacts,
    checkpoint: checkpointContext,
  }));
  const contextBudget = input.project.controllerSettings.contextBudgetTokens ?? 12_000;
  const retrieval = retrieveContext({
    project: input.project,
    task: input.task,
    sourceWorkspace: input.workspace.path,
    requirementTexts: requirements.map((requirement) => requirement.text),
    dependencyFiles: dependencyTasks.flatMap((task) => input.records.changedFilesForTask(task.id)),
    budgetTokens: Math.max(0, contextBudget - fixedContextEstimate),
  });
  warnings.push(...retrieval.warnings);
  // A packet must never claim one revision while its excerpts came from
  // another. Reviews fail closed; implementation packets are relabeled with the
  // revision actually inspected and record the drift.
  const inspectedRevision = retrieval.inspectedRevision;
  const revisionMatches = inspectedRevision !== null && inspectedRevision === input.workspace.baseRevision;
  if (!revisionMatches) {
    if (purpose === "review") {
      throw new Error(
        `Review packet would misreport its revision: ${input.workspace.path} is at ${inspectedRevision ?? "an unreadable revision"}, ` +
        `not the revision under review ${input.workspace.baseRevision}.`,
      );
    }
    warnings.push(
      `Context excerpts were read from ${input.workspace.path} at ${inspectedRevision ?? "an unreadable revision"}, ` +
      `which differs from the attempt base revision ${input.workspace.baseRevision}.`,
    );
  }
  if (fixedContextEstimate > contextBudget) {
    warnings.push("Mandatory requirements and retained checkpoint context exceed the configured context budget; mandatory records were preserved.");
  }
  const derivedTokenEstimate = fixedContextEstimate + retrieval.estimatedTokens;

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
      head_revision: inspectedRevision,
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
      files: retrieval.files.map((file) => file.absolutePath),
      file_context: retrieval.files.map((file) => ({
        path: file.absolutePath,
        reason: file.reason,
        excerpt: file.excerpt,
        excerpt_truncated: file.excerptTruncated,
        estimated_tokens: file.estimatedTokens,
      })),
      previous_findings: previousFindings,
      artifacts,
      checkpoint: checkpointContext,
      config_version: input.project.configVersion,
      source_workspace: retrieval.sourceWorkspace,
      inspected_revision: inspectedRevision,
      derived_token_estimate: derivedTokenEstimate,
      context_budget_tokens: contextBudget,
      omissions: retrieval.omitted,
    },
  };

  const dir = artifactDir(input.task.id, input.attemptId);
  const manifestPath = join(dir, "context.json");
  writeFileSync(manifestPath, JSON.stringify({
    packet_id: packetId,
    estimate_kind: "derived_utf8_bytes_divided_by_four",
    warnings,
    retrieval,
    worker_input: workerInput,
  }, null, 2), { mode: 0o600 });
  const priorPackets = input.records.packetsForTask(input.task.id);
  const previousProviderPacket = [...priorPackets].reverse().find((packet) => typeof packet.provider === "string");
  const refetched = previousProviderPacket && previousProviderPacket.provider !== input.execution.harness
    ? retrieval.files.filter((file) => (previousProviderPacket.files as string[]).some((path) => path.endsWith(`/${file.path}`)))
    : [];
  input.records.recordPacket({
    id: packetId,
    taskId: input.task.id,
    attemptId: input.attemptId,
    requirementIds: requirements.map((requirement) => requirement.id),
    omitted: retrieval.omitted.map((item) => `${item.path}: ${item.reason}`),
    files: retrieval.files.map((file) => file.absolutePath),
    artifacts,
    baseRevision: input.workspace.baseRevision,
    sourceWorkspace: retrieval.sourceWorkspace,
    inspectedRevision,
    configVersion: input.project.configVersion,
    provider: input.execution.harness,
    checkpointId: checkpoint?.id ?? null,
    tokenEstimate: derivedTokenEstimate,
    budgetTokens: contextBudget,
    manifestPath,
    warnings,
    fileDetails: [
      ...retrieval.files.map((file) => ({
        path: file.path, reason: file.reason, included: true, sizeBytes: file.sizeBytes,
        estimatedTokens: file.estimatedTokens, excerptTruncated: file.excerptTruncated,
      })),
      ...retrieval.omitted.map((file) => ({ path: file.path, reason: "not included", included: false, omissionReason: file.reason })),
    ],
  });
  if (retrieval.omitted.some((item) => item.reason.includes("budget"))) {
    input.records.recordEvent({ kind: "context.compressed", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
      data: { packetId, omitted: retrieval.omitted.length, budgetTokens: contextBudget, estimateKind: "derived" } });
  }
  if (!revisionMatches) {
    input.records.recordEvent({ kind: "context.revision_drift", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
      data: { packetId, sourceWorkspace: retrieval.sourceWorkspace, inspectedRevision, attemptBaseRevision: input.workspace.baseRevision } });
  }
  if (refetched && refetched.length > 0) {
    input.records.recordEvent({ kind: "context.refetched", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
      data: { packetId, providerFrom: previousProviderPacket?.provider, providerTo: input.execution.harness, files: refetched.map((file) => file.path) } });
  }

  const selectedGuidance = guidanceForAttempt(input.task, purpose === "review" ? "review" : "initial");
  const prompt = assembleWorkerPrompt({
    purpose,
    workerInput,
    projectAddendum: promptAddendum,
    guidance: guidanceText(selectedGuidance),
  });

  return { id: packetId, input: workerInput, manifestPath, prompt };
}
