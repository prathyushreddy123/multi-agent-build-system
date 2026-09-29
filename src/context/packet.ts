import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ids } from "../core/ids.ts";
import { artifactDir } from "../core/paths.ts";
import { CONTRACT_VERSION } from "../domain/contract.ts";
import type { WorkerInput, WorkerRole } from "../domain/contract.ts";
import type { TaskObligation } from "../domain/execution.ts";
import { lessonsForTask } from "../incidents/lessons.ts";
import { assembleWorkerPrompt } from "../prompts/roles.ts";
import { guidanceForAttempt, guidanceText } from "../prompts/versions.ts";
import type { Project, Records, Task, TaskCheckpoint } from "../store/records.ts";
import type { Workspace } from "../workspace/git.ts";
import { estimateTokens, retrieveContext, type RetrievedFile } from "./retrieval.ts";

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
  purpose: PacketPurpose;
  /** Guidance versions actually rendered into this prompt. */
  guidance: string[];
  accounting: PromptAccounting;
}

export type PacketPurpose = "implementation" | "repair" | "review";

/** Byte-derived estimate; recorded with every packet so a later estimator cannot be confused with it. */
export const CONTEXT_ESTIMATOR_VERSION = "utf8-bytes-div4.v1";
/** Inline omission entries; the complete inventory is always written to disk when larger. */
const INLINE_OMISSIONS = 20;

export interface PromptAccounting {
  budgetPolicy: "mabs.budget.v1" | "mabs.budget.v2";
  estimatorVersion: string;
  /** UTF-8 bytes of the exact string handed to the adapter. */
  promptBytes: number;
  promptTokenEstimate: number;
  budgetTokens: number;
  /** Serialized bytes per prompt section; `instructions` is everything outside the worker input. */
  sectionBytes: Record<string, number>;
  mandatoryCount: number;
  optionalCount: number;
  contentFingerprint: string;
}

/**
 * Under the complete-prompt budget, the records a worker cannot safely go
 * without (requirements, acceptance criteria, obligations, the contract) do
 * not fit. Truncating them silently would hand the worker a different task;
 * preparation stops and asks for an explicit adjustment instead.
 */
export class ContextBudgetExceededError extends Error {
  readonly mandatoryTokens: number;
  readonly budgetTokens: number;

  constructor(mandatoryTokens: number, budgetTokens: number) {
    super(
      `Mandatory prompt content needs about ${mandatoryTokens} tokens, above the ${budgetTokens}-token complete-prompt budget. ` +
      "Nothing was truncated; raise controllerSettings.contextBudgetTokens through a configuration activation or narrow the task.",
    );
    this.name = "ContextBudgetExceededError";
    this.mandatoryTokens = mandatoryTokens;
    this.budgetTokens = budgetTokens;
  }
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The latest checkpoint that records task progress. Operational failures
 * (quota, auth, environment) are not progress: a reroute after a quota stop
 * must still see the repair findings recorded before it.
 */
function progressCheckpoint(checkpoints: TaskCheckpoint[]): TaskCheckpoint | null {
  return checkpoints.findLast((checkpoint) => checkpoint.kind !== "attempt_failed") ?? null;
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
  purpose?: PacketPurpose;
  additionalArtifacts?: string[];
  /** Open durable obligations; defaults to the task's continuation. */
  obligations?: TaskObligation[];
  /** Most recent operational failure text, carried separately from code findings. */
  operationalFailure?: string | null;
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
  const checkpoint = progressCheckpoint(input.records.checkpointsForTask(input.task.id));
  const obligations = (input.obligations ?? input.records.getContinuation(input.task.id).openObligations).map((item) => ({
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    blocking: item.blocking,
    summary: item.summary,
  }));
  // Each obligation appears once, in context.obligations. Any other copy of the
  // same text (a failure reason, a checkpoint finding) becomes a reference.
  const obligationByText = new Map(obligations.map((item) => [normalizedText(item.summary), item.id]));
  const seenFindings = new Set<string>();
  const previousFindings: string[] = [];
  // A person's answer to a blocking decision is authoritative input for every
  // later attempt, so it is carried explicitly rather than left in the journal.
  const answered = input.records.listObligations(input.task.id).filter((item) => item.kind === "decision_needed" && item.state === "resolved");
  const decisions = input.records.listEventsOfKind(input.task.id, "obligation.decided")
    .flatMap((event) => {
      try {
        const data = JSON.parse(String(event.data)) as { obligationId?: string; answer?: string; decidedBy?: string };
        const obligation = answered.find((item) => item.id === data.obligationId);
        return obligation && data.answer ? [`User decision (${data.decidedBy ?? "unknown"}) on "${obligation.summary}": ${data.answer}`] : [];
      } catch {
        return [];
      }
    });
  for (const finding of [
    ...decisions,
    ...(input.previousFindings ?? []),
    ...dependencyTasks.map((task) => `${task.id}: ${task.resultSummary ?? `state=${task.state}`}`),
    ...(checkpoint ? checkpoint.findings : []),
  ]) {
    const key = normalizedText(finding);
    if (!key || obligationByText.has(key) || seenFindings.has(key)) continue;
    seenFindings.add(key);
    previousFindings.push(finding);
  }
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
    findings: checkpoint.findings.map((finding) => {
      const obligationId = obligationByText.get(normalizedText(finding));
      return obligationId ? `See obligation ${obligationId}.` : finding;
    }),
    unresolved: checkpoint.unresolved,
    next_action: checkpoint.nextAction,
    evidence: checkpoint.evidence,
  } : null;
  const contextBudget = input.project.controllerSettings.contextBudgetTokens ?? 12_000;
  const budgetPolicy = input.project.controllerSettings.contextBudgetPolicy ?? "mabs.budget.v1";
  const fixedContextEstimate = estimateTokens(JSON.stringify({
    requirements: requirements.map(({ id, text }) => ({ id, text })),
    obligations,
    previousFindings,
    artifacts,
    checkpoint: checkpointContext,
  }));
  const selectedGuidance = guidanceForAttempt(input.task, purpose === "review" ? "review" : purpose === "repair" ? "repair" : "initial");
  const role: WorkerRole = purpose === "review" ? "reviewer" : roleOf(input.task.role);
  const lessons = lessonsForTask(input.records, input.task, purpose)
    .map((lesson) => ({ incident_id: lesson.incidentId, status: lesson.status, text: lesson.text }));
  const dir = artifactDir(input.task.id, input.attemptId);

  const composeInput = (files: RetrievedFile[], omitted: { path: string; reason: string }[], inspected: string | null,
    sourceWorkspace: string, derivedEstimate: number): WorkerInput => ({
    identity: {
      project_id: input.project.id,
      task_id: input.task.id,
      attempt_id: input.attemptId,
      role,
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
      head_revision: inspected,
      branch: input.workspace.branch,
      // Relative to worktree_path: the absolute root is stated once, not per path.
      allowed_scope: input.task.allowedScope.length > 0 ? input.task.allowedScope : ["."],
      // Only what the worker can actually do: implementers get the registered-check
      // tool when checks exist; reviewers read the controller's gate evidence instead.
      allowed_actions: purpose === "review" ? ["read"] : input.project.checkCommands.length > 0 ? ["read", "edit", "run_checks"] : ["read", "edit"],
      forbidden_actions: purpose === "review"
        ? ["edit", "git_commit", "push", "merge", "deploy", "delete_shared_data", "change_scope"]
        : ["git_commit (controller-owned)", "push", "merge", "deploy", "delete_shared_data", "change_scope"],
      checks: input.project.checkCommands.map((check) => ({
        name: check.name,
        command: `${check.cwd ? `(cd ${check.cwd}) ` : ""}${check.command.join(" ")}`,
        required: check.required,
      })),
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
      obligations,
      // Relative to source_workspace. The packet record keeps the absolute
      // manifest; the prompt does not repeat it as a separate list.
      file_context: files.map((file) => ({
        path: file.path,
        reason: file.reason,
        excerpt: file.excerpt,
        excerpt_truncated: file.excerptTruncated,
        estimated_tokens: file.estimatedTokens,
      })),
      previous_findings: previousFindings,
      lessons,
      last_operational_failure: input.operationalFailure ?? null,
      artifacts,
      checkpoint: checkpointContext,
      config_version: input.project.configVersion,
      source_workspace: sourceWorkspace,
      inspected_revision: inspected,
      derived_token_estimate: derivedEstimate,
      context_budget_tokens: contextBudget,
      omissions: omitted.length > INLINE_OMISSIONS ? omitted.slice(0, INLINE_OMISSIONS) : omitted,
      omission_inventory: omitted.length > INLINE_OMISSIONS ? { path: join(dir, "omitted-files.json"), total: omitted.length } : null,
    },
  });
  const render = (workerInput: WorkerInput) => assembleWorkerPrompt({
    purpose,
    workerInput,
    projectAddendum: promptAddendum,
    guidance: guidanceText(selectedGuidance),
  });

  // Under the complete-prompt policy, everything except optional file context
  // is mandatory and is measured as the rendered string, not as a subset.
  let retrievalBudget = Math.max(0, contextBudget - fixedContextEstimate);
  if (budgetPolicy === "mabs.budget.v2") {
    const skeletonTokens = estimateTokens(render(composeInput([], [], input.workspace.baseRevision, input.workspace.path, 0)));
    if (skeletonTokens > contextBudget) {
      input.records.recordEvent({
        kind: "context.mandatory_overflow",
        projectId: input.project.id,
        taskId: input.task.id,
        attemptId: input.attemptId,
        data: { packetId, mandatoryTokens: skeletonTokens, budgetTokens: contextBudget, estimatorVersion: CONTEXT_ESTIMATOR_VERSION },
      });
      throw new ContextBudgetExceededError(skeletonTokens, contextBudget);
    }
    retrievalBudget = contextBudget - skeletonTokens;
  }
  const retrieval = retrieveContext({
    project: input.project,
    task: input.task,
    sourceWorkspace: input.workspace.path,
    requirementTexts: requirements.map((requirement) => requirement.text),
    dependencyFiles: dependencyTasks.flatMap((task) => input.records.changedFilesForTask(task.id)),
    budgetTokens: retrievalBudget,
  });
  warnings.push(...retrieval.warnings);
  // A packet must never claim one revision while its excerpts came from
  // another. Reviews fail closed; implementation packets are relabeled with the
  // revision actually inspected and record the drift.
  const inspectedRevision = retrieval.inspectedRevision;
  const revisionMatches = inspectedRevision !== null && inspectedRevision === input.workspace.baseRevision;
  if (!revisionMatches) {
    if (purpose === "review") {
      input.records.recordEvent({ kind: "context.revision_drift", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
        data: { packetId, sourceWorkspace: retrieval.sourceWorkspace, inspectedRevision, attemptBaseRevision: input.workspace.baseRevision, failedClosed: true } });
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
  if (budgetPolicy === "mabs.budget.v1" && fixedContextEstimate > contextBudget) {
    warnings.push("Mandatory requirements and retained checkpoint context exceed the configured context budget; mandatory records were preserved.");
  }
  const files = [...retrieval.files];
  const omitted = [...retrieval.omitted];
  let workerInput = composeInput(files, omitted, inspectedRevision, retrieval.sourceWorkspace,
    fixedContextEstimate + files.reduce((total, file) => total + file.estimatedTokens, 0));
  let prompt = render(workerInput);
  // JSON escaping and per-file framing are only known once rendered. Under v2
  // the rendered string is authoritative, so optional files are shed, lowest
  // relevance first, until the exact prompt fits.
  if (budgetPolicy === "mabs.budget.v2") {
    while (estimateTokens(prompt) > contextBudget && files.length > 0) {
      const dropped = files.reduce((lowest, file) => (file.score < lowest.score ? file : lowest));
      files.splice(files.indexOf(dropped), 1);
      omitted.push({ path: dropped.path, reason: "complete-prompt budget exhausted after rendering" });
      workerInput = composeInput(files, omitted, inspectedRevision, retrieval.sourceWorkspace,
        fixedContextEstimate + files.reduce((total, file) => total + file.estimatedTokens, 0));
      prompt = render(workerInput);
    }
  }
  if (omitted.some((item) => item.reason.includes("budget")) && !warnings.some((warning) => warning.includes("omitted"))) {
    warnings.push("Optional file context was omitted to stay within the configured budget.");
  }
  const derivedTokenEstimate = workerInput.context.derived_token_estimate;

  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const workerInputBytes = Buffer.byteLength(JSON.stringify(workerInput, null, 2), "utf8");
  const sectionBytes = {
    instructions: promptBytes - workerInputBytes,
    worker_input: workerInputBytes,
    requirements: Buffer.byteLength(JSON.stringify(workerInput.context.requirements), "utf8"),
    obligations: Buffer.byteLength(JSON.stringify(workerInput.context.obligations), "utf8"),
    previous_findings: Buffer.byteLength(JSON.stringify(workerInput.context.previous_findings), "utf8"),
    checkpoint: Buffer.byteLength(JSON.stringify(workerInput.context.checkpoint), "utf8"),
    file_context: Buffer.byteLength(JSON.stringify(workerInput.context.file_context), "utf8"),
    omissions: Buffer.byteLength(JSON.stringify(workerInput.context.omissions), "utf8"),
  };
  const accounting: PromptAccounting = {
    budgetPolicy,
    estimatorVersion: CONTEXT_ESTIMATOR_VERSION,
    promptBytes,
    promptTokenEstimate: estimateTokens(prompt),
    budgetTokens: contextBudget,
    sectionBytes,
    mandatoryCount: requirements.length + obligations.length + workerInput.task.acceptance_criteria.length,
    optionalCount: files.length,
    contentFingerprint: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
  };

  const manifestPath = join(dir, "context.json");
  if (workerInput.context.omission_inventory) {
    writeFileSync(workerInput.context.omission_inventory.path, JSON.stringify({ packet_id: packetId, omitted }, null, 2), { mode: 0o600 });
  }
  writeFileSync(manifestPath, JSON.stringify({
    packet_id: packetId,
    estimate_kind: "derived_utf8_bytes_divided_by_four",
    purpose,
    accounting,
    warnings,
    retrieval: { ...retrieval, files, omitted },
    worker_input: workerInput,
  }, null, 2), { mode: 0o600 });
  const priorPackets = input.records.packetsForTask(input.task.id);
  const previousProviderPacket = [...priorPackets].reverse().find((packet) => typeof packet.provider === "string");
  const refetched = previousProviderPacket && previousProviderPacket.provider !== input.execution.harness
    ? files.filter((file) => (previousProviderPacket.files as string[]).some((path) => path.endsWith(`/${file.path}`)))
    : [];
  input.records.recordPacket({
    id: packetId,
    taskId: input.task.id,
    attemptId: input.attemptId,
    requirementIds: requirements.map((requirement) => requirement.id),
    omitted: omitted.map((item) => `${item.path}: ${item.reason}`),
    files: files.map((file) => file.absolutePath),
    artifacts,
    baseRevision: input.workspace.baseRevision,
    sourceWorkspace: retrieval.sourceWorkspace,
    inspectedRevision,
    configVersion: input.project.configVersion,
    provider: input.execution.harness,
    checkpointId: checkpoint?.id ?? null,
    // v1 keeps its historical meaning (context records only); v2 budgets and
    // reports the complete prompt. prompt_token_estimate is always complete.
    tokenEstimate: budgetPolicy === "mabs.budget.v2" ? accounting.promptTokenEstimate : derivedTokenEstimate,
    budgetTokens: contextBudget,
    manifestPath,
    warnings,
    purpose,
    accounting,
    fileDetails: [
      ...files.map((file) => ({
        path: file.path, reason: file.reason, included: true, sizeBytes: file.sizeBytes,
        estimatedTokens: file.estimatedTokens, excerptTruncated: file.excerptTruncated,
      })),
      ...omitted.map((file) => ({ path: file.path, reason: "not included", included: false, omissionReason: file.reason })),
    ],
  });
  if (omitted.some((item) => item.reason.includes("budget"))) {
    input.records.recordEvent({ kind: "context.compressed", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
      data: { packetId, omitted: omitted.length, budgetTokens: contextBudget, estimateKind: "derived", budgetPolicy } });
  }
  if (!revisionMatches) {
    input.records.recordEvent({ kind: "context.revision_drift", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
      data: { packetId, sourceWorkspace: retrieval.sourceWorkspace, inspectedRevision, attemptBaseRevision: input.workspace.baseRevision } });
  }
  if (refetched && refetched.length > 0) {
    input.records.recordEvent({ kind: "context.refetched", projectId: input.project.id, taskId: input.task.id, attemptId: input.attemptId,
      data: { packetId, providerFrom: previousProviderPacket?.provider, providerTo: input.execution.harness, files: refetched.map((file) => file.path) } });
  }

  return { id: packetId, input: workerInput, manifestPath, prompt, purpose, guidance: selectedGuidance, accounting };
}
