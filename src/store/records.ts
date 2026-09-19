import { Store, nowIso, toJson, fromJson } from "./db.ts";
import type { ConfigActivation, CuratorEvaluation, CuratorProposal, EvaluationCase, EvaluationMetrics, ProposalStatus } from "../curator/types.ts";
import type { Row } from "./db.ts";
import { ids } from "../core/ids.ts";
import { DEFAULT_CONTROLLER_SETTINGS, DEFAULT_PROMPT_PROFILE, normalizeProjectConfig, validateProjectConfig } from "../domain/config.ts";
import type { ProjectConfigSnapshot, ProjectControllerSettings, PromptProfile, RoutingOverrides } from "../domain/config.ts";
import { assertTransition } from "../domain/states.ts";
import type { TaskState } from "../domain/states.ts";
import { evaluate } from "../domain/policy.ts";
import type { Action, ApprovalBinding, ProjectApprovalPolicy } from "../domain/policy.ts";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_MODES,
  classifyFindings,
  normalizeReviewPolicy,
  reviewPolicyNormalizationNotes,
  reviewRequiredFor,
} from "../review/policy.ts";
import type { ReviewPolicy } from "../review/policy.ts";
import { QUALITY_COVERAGE_GATE } from "../gates/runner.ts";
import type { FailureClass } from "../core/failure.ts";
import { TASK_CLASSES } from "../routing/router.ts";
import type { Ambiguity, ChangeRisk, Complexity, TaskClass } from "../routing/router.ts";

export type ProjectStatus = "active" | "paused" | "archived";

export type { ReviewPolicy } from "../review/policy.ts";
export { DEFAULT_REVIEW_POLICY } from "../review/policy.ts";

export interface GateSpec {
  name: string;
  command: string[];
  required: boolean;
  timeoutMs?: number;
  cwd?: string;
  versionCommand?: string[];
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  status: ProjectStatus;
  routingProfile: string;
  approvalPolicy: ProjectApprovalPolicy;
  reviewPolicy: ReviewPolicy;
  routingOverrides: RoutingOverrides;
  promptProfile: PromptProfile;
  controllerSettings: ProjectControllerSettings;
  checkCommands: GateSpec[];
  configVersion: string;
  goal: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  role: string;
  taskClass: TaskClass;
  complexity: Complexity;
  ambiguity: Ambiguity;
  changeRisk: ChangeRisk;
  language: string | null;
  domain: string | null;
  contextSize: Complexity;
  requiredTools: string[];
  allowedScope: string[];
  state: TaskState;
  priority: number;
  executionMode: string;
  executionReason: string | null;
  inScopeActions: Action[];
  repairLimit: number;
  repairsUsed: number;
  deadlineAt: string | null;
  branch: string | null;
  worktreePath: string | null;
  baseRevision: string | null;
  resultRevision: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  blockedReason: string | null;
  failureClass: FailureClass | null;
  resultSummary: string | null;
  reviewOfTaskId: string | null;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  taskId: string;
  launchId: string;
  attemptNumber: number;
  kind: "initial" | "repair" | "review" | "reroute";
  adapter: string;
  model: string | null;
  effort: string | null;
  authMode: string | null;
  state: "running" | "succeeded" | "failed" | "cancelled";
  pid: number | null;
  sessionId: string | null;
  worktreePath: string | null;
  baseRevision: string | null;
  resultRevision: string | null;
  outcome: string | null;
  failureClass: FailureClass | null;
  reason: string | null;
  exitStatus: number | null;
  usage: Record<string, unknown> | null;
  outputPath: string | null;
  packetId: string | null;
  startedAt: string;
  heartbeatAt: string | null;
  endedAt: string | null;
}

export type GateStatus = "PASS" | "FAIL" | "ERROR" | "SKIPPED";

export interface GateResult {
  id: string;
  taskId: string;
  attemptId: string | null;
  name: string;
  status: GateStatus;
  required: boolean;
  command: string;
  toolVersion: string | null;
  revision: string;
  evidencePath: string | null;
  durationMs: number | null;
  waiverId: string | null;
  createdAt: string;
}

export type ApprovalState = "pending" | "approved" | "rejected" | "invalidated" | "consumed";

export interface Approval {
  id: string;
  projectId: string;
  taskId: string | null;
  action: Action;
  target: string;
  revision: string;
  configVersion: string;
  state: ApprovalState;
  reason: string | null;
  evidence: Record<string, unknown>;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  consumedAt: string | null;
}

export interface ReviewResult {
  id: string;
  taskId: string;
  attemptId: string;
  revision: string;
  verdict: "approved" | "request_changes" | "blocked";
  summary: string;
  /** Every finding, whatever its severity. Evidence is never discarded. */
  findings: string[];
  /** The subset that forces another repair cycle under the project's policy. */
  blockingFindings: string[];
  /** Retained suggestions that did not block acceptance. */
  advisoryFindings: string[];
  requirementsChecked: string[];
  evidencePath: string | null;
  createdAt: string;
}

export interface ExecutionPlanRecord {
  id: string;
  projectId: string;
  objective: string;
  mode: string;
  reason: string;
  assumptions: string[];
  milestones: string[];
  version: number;
  state: "active" | "superseded" | "completed";
  createdAt: string;
  updatedAt: string;
}

export interface Feedback {
  id: string;
  projectId: string;
  taskId: string | null;
  planId: string | null;
  kind: "comment" | "question" | "request_change" | "priority";
  body: string;
  state: "pending" | "applied" | "answered" | "rejected";
  response: string | null;
  linkedTaskId: string | null;
  submittedForVersion: number;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  attemptId: string | null;
  kind: string;
  summary: string;
  baseRevision: string | null;
  resultRevision: string | null;
  changedFiles: string[];
  findings: string[];
  unresolved: string[];
  nextAction: string | null;
  evidence: string[];
  createdAt: string;
}

export interface ProviderCapacity {
  provider: string;
  state: "available" | "cooldown" | "unavailable";
  maxConcurrency: number;
  blockedUntil: string | null;
  reason: string | null;
  errorCount: number;
  updatedAt: string;
}

function toProviderCapacity(row: Row): ProviderCapacity {
  return {
    provider: row.provider as string,
    state: row.state as ProviderCapacity["state"],
    maxConcurrency: Number(row.max_concurrency ?? 1),
    blockedUntil: (row.blocked_until as string) ?? null,
    reason: (row.reason as string) ?? null,
    errorCount: Number(row.error_count ?? 0),
    updatedAt: row.updated_at as string,
  };
}

function toProject(row: Row): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    repoPath: row.repo_path as string,
    baseBranch: row.base_branch as string,
    status: row.status as ProjectStatus,
    routingProfile: row.routing_profile as string,
    approvalPolicy: fromJson<ProjectApprovalPolicy>(row.approval_policy, { overrides: {}, standing: [] }),
    reviewPolicy: fromJson<ReviewPolicy>(row.review_policy, DEFAULT_REVIEW_POLICY),
    routingOverrides: fromJson<RoutingOverrides>(row.routing_overrides, {}),
    promptProfile: fromJson<PromptProfile>(row.prompt_profile, DEFAULT_PROMPT_PROFILE),
    controllerSettings: {
      ...DEFAULT_CONTROLLER_SETTINGS,
      ...fromJson<Partial<ProjectControllerSettings>>(row.controller_settings, {}),
    },
    checkCommands: fromJson<GateSpec[]>(row.check_commands, []),
    configVersion: row.config_version as string,
    goal: (row.goal as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toTask(row: Row): Task {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    objective: row.objective as string,
    acceptanceCriteria: fromJson<string[]>(row.acceptance_criteria, []),
    role: row.role as string,
    taskClass: row.task_class as TaskClass,
    complexity: row.complexity as Complexity,
    ambiguity: row.ambiguity as Ambiguity,
    changeRisk: row.change_risk as ChangeRisk,
    language: (row.language as string) ?? null,
    domain: (row.domain as string) ?? null,
    contextSize: row.context_size as Complexity,
    requiredTools: fromJson<string[]>(row.required_tools, []),
    allowedScope: fromJson<string[]>(row.allowed_scope, []),
    state: row.state as TaskState,
    priority: Number(row.priority ?? 100),
    executionMode: row.execution_mode as string,
    executionReason: (row.execution_reason as string) ?? null,
    inScopeActions: fromJson<Action[]>(row.in_scope_actions, []),
    repairLimit: Number(row.repair_limit ?? 2),
    repairsUsed: Number(row.repairs_used ?? 0),
    deadlineAt: (row.deadline_at as string) ?? null,
    branch: (row.branch as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    baseRevision: (row.base_revision as string) ?? null,
    resultRevision: (row.result_revision as string) ?? null,
    claimedBy: (row.claimed_by as string) ?? null,
    claimedAt: (row.claimed_at as string) ?? null,
    blockedReason: (row.blocked_reason as string) ?? null,
    failureClass: (row.failure_class as FailureClass) ?? null,
    resultSummary: (row.result_summary as string) ?? null,
    reviewOfTaskId: (row.review_of_task_id as string) ?? null,
    recordVersion: Number(row.record_version ?? 1),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toAttempt(row: Row): Attempt {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    launchId: row.launch_id as string,
    attemptNumber: Number(row.attempt_number ?? 1),
    kind: row.kind as Attempt["kind"],
    adapter: row.adapter as string,
    model: (row.model as string) ?? null,
    effort: (row.effort as string) ?? null,
    authMode: (row.auth_mode as string) ?? null,
    state: row.state as Attempt["state"],
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    sessionId: (row.session_id as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    baseRevision: (row.base_revision as string) ?? null,
    resultRevision: (row.result_revision as string) ?? null,
    outcome: (row.outcome as string) ?? null,
    failureClass: (row.failure_class as FailureClass) ?? null,
    reason: (row.reason as string) ?? null,
    exitStatus: row.exit_status === null || row.exit_status === undefined ? null : Number(row.exit_status),
    usage: fromJson<Record<string, unknown> | null>(row.usage_json, null),
    outputPath: (row.output_path as string) ?? null,
    packetId: (row.packet_id as string) ?? null,
    startedAt: row.started_at as string,
    heartbeatAt: (row.heartbeat_at as string) ?? null,
    endedAt: (row.ended_at as string) ?? null,
  };
}

function toApproval(row: Row): Approval {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    taskId: (row.task_id as string) ?? null,
    action: row.action as Action,
    target: row.target as string,
    revision: row.revision as string,
    configVersion: row.config_version as string,
    state: row.state as ApprovalState,
    reason: (row.reason as string) ?? null,
    evidence: fromJson<Record<string, unknown>>(row.evidence, {}),
    requestedAt: row.requested_at as string,
    decidedAt: (row.decided_at as string) ?? null,
    decidedBy: (row.decided_by as string) ?? null,
    consumedAt: (row.consumed_at as string) ?? null,
  };
}

function toReview(row: Row): ReviewResult {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    attemptId: row.attempt_id as string,
    revision: row.revision as string,
    verdict: row.verdict as ReviewResult["verdict"],
    summary: row.summary as string,
    findings: fromJson<string[]>(row.findings, []),
    blockingFindings: fromJson<string[] | null>(row.blocking_findings, null) ?? fromJson<string[]>(row.findings, []),
    advisoryFindings: fromJson<string[]>(row.advisory_findings, []),
    requirementsChecked: fromJson<string[]>(row.requirements_checked, []),
    evidencePath: (row.evidence_path as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function toPlan(row: Row): ExecutionPlanRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    objective: row.objective as string,
    mode: row.mode as string,
    reason: row.reason as string,
    assumptions: fromJson<string[]>(row.assumptions, []),
    milestones: fromJson<string[]>(row.milestones, []),
    version: Number(row.version),
    state: row.state as ExecutionPlanRecord["state"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toFeedback(row: Row): Feedback {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    taskId: (row.task_id as string) ?? null,
    planId: (row.plan_id as string) ?? null,
    kind: row.kind as Feedback["kind"],
    body: row.body as string,
    state: row.state as Feedback["state"],
    response: (row.response as string) ?? null,
    linkedTaskId: (row.linked_task_id as string) ?? null,
    submittedForVersion: Number(row.submitted_for_version),
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string) ?? null,
  };
}

function toProposal(row: Row): CuratorProposal {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    rationale: row.rationale as string,
    fingerprint: row.fingerprint as string,
    evidenceFingerprint: row.evidence_fingerprint as string,
    status: row.status as ProposalStatus,
    baseConfigVersion: row.base_config_version as string,
    proposedConfigVersion: row.proposed_config_version as string,
    branch: (row.branch as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    baseRevision: (row.base_revision as string) ?? null,
    resultRevision: (row.result_revision as string) ?? null,
    diffPath: (row.diff_path as string) ?? null,
    proposedBy: row.proposed_by as string,
    rejectionReason: (row.rejection_reason as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toEvaluation(row: Row): CuratorEvaluation {
  return {
    id: row.id as string,
    proposalId: row.proposal_id as string,
    suiteVersion: row.suite_version as string,
    status: row.status as CuratorEvaluation["status"],
    baselineMetrics: fromJson<EvaluationMetrics>(row.baseline_metrics, {} as EvaluationMetrics),
    candidateMetrics: fromJson<EvaluationMetrics>(row.candidate_metrics, {} as EvaluationMetrics),
    cases: fromJson<EvaluationCase[]>(row.case_results, []),
    errors: fromJson<string[]>(row.errors, []),
    evidencePath: (row.evidence_path as string) ?? null,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string,
  };
}

function toCheckpoint(row: Row): TaskCheckpoint {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    attemptId: (row.attempt_id as string) ?? null,
    kind: row.kind as string,
    summary: row.summary as string,
    baseRevision: (row.base_revision as string) ?? null,
    resultRevision: (row.result_revision as string) ?? null,
    changedFiles: fromJson<string[]>(row.changed_files, []),
    findings: fromJson<string[]>(row.findings, []),
    unresolved: fromJson<string[]>(row.unresolved, []),
    nextAction: (row.next_action as string) ?? null,
    evidence: fromJson<string[]>(row.evidence, []),
    createdAt: row.created_at as string,
  };
}

function toActivation(row: Row): ConfigActivation {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    proposalId: (row.proposal_id as string) ?? null,
    action: row.action as ConfigActivation["action"],
    fromConfigVersion: row.from_config_version as string,
    toConfigVersion: row.to_config_version as string,
    sourceConfigVersion: (row.source_config_version as string) ?? null,
    approvalId: row.approval_id as string,
    activatedBy: row.activated_by as string,
    reason: row.reason as string,
    createdAt: row.created_at as string,
  };
}

const TASK_MUTABLE_COLUMNS = new Set([
  "role",
  "task_class",
  "complexity",
  "ambiguity",
  "change_risk",
  "language",
  "domain",
  "context_size",
  "required_tools",
  "allowed_scope",
  "priority",
  "execution_mode",
  "execution_reason",
  "in_scope_actions",
  "repair_limit",
  "repairs_used",
  "deadline_at",
  "branch",
  "worktree_path",
  "base_revision",
  "result_revision",
  "claimed_by",
  "claimed_at",
  "blocked_reason",
  "failure_class",
  "result_summary",
]);

function assertTaskFields(fields: Record<string, unknown>): void {
  const invalid = Object.keys(fields).filter((key) => !TASK_MUTABLE_COLUMNS.has(key));
  if (invalid.length > 0) throw new Error(`Invalid task field(s): ${invalid.join(", ")}`);
}

function toGate(row: Row): GateResult {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    attemptId: (row.attempt_id as string) ?? null,
    name: row.name as string,
    status: row.status as GateStatus,
    required: Number(row.required) === 1,
    command: row.command as string,
    toolVersion: (row.tool_version as string) ?? null,
    revision: row.revision as string,
    evidencePath: (row.evidence_path as string) ?? null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    waiverId: (row.waiver_id as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export interface EventInput {
  kind: string;
  projectId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  data?: Record<string, unknown>;
}

/** Typed data access over the SQLite store. */
export class Records {
  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  // --- events -------------------------------------------------------------

  recordEvent(input: EventInput): string {
    const id = ids.event();
    this.store.run(
      "INSERT INTO events(id, at, project_id, task_id, attempt_id, kind, data) VALUES(?,?,?,?,?,?,?)",
      id,
      nowIso(),
      input.projectId ?? null,
      input.taskId ?? null,
      input.attemptId ?? null,
      input.kind,
      toJson(input.data ?? {}),
    );
    return id;
  }

  listEvents(taskId: string, limit = 200): Row[] {
    return this.store.all("SELECT * FROM events WHERE task_id = ? ORDER BY rowid DESC LIMIT ?", taskId, limit);
  }

  recentEvents(limit = 100): Row[] {
    return this.store.all("SELECT * FROM events ORDER BY rowid DESC LIMIT ?", limit);
  }

  // --- projects -----------------------------------------------------------

  createProject(input: {
    name: string;
    repoPath: string;
    baseBranch?: string;
    goal?: string;
    checkCommands?: GateSpec[];
    approvalPolicy?: ProjectApprovalPolicy;
    reviewPolicy?: ReviewPolicy;
    routingOverrides?: RoutingOverrides;
    promptProfile?: PromptProfile;
    controllerSettings?: ProjectControllerSettings;
    routingProfile?: string;
  }): Project {
    const requestedReviewPolicy = input.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
    if (!REVIEW_MODES.includes(requestedReviewPolicy.mode)) throw new Error(`Invalid review mode: ${requestedReviewPolicy.mode}`);
    if (requestedReviewPolicy.skipTaskClasses.some((taskClass) => !TASK_CLASSES.includes(taskClass))) throw new Error("Review policy contains an unknown task class");
    const reviewPolicy = normalizeReviewPolicy(requestedReviewPolicy);
    const normalizationNotes = reviewPolicyNormalizationNotes(requestedReviewPolicy, reviewPolicy);
    const id = ids.project();
    const at = nowIso();
    const configVersion = ids.config();
    return this.store.tx(() => {
      this.store.run(
        `INSERT INTO projects(id, name, repo_path, base_branch, status, routing_profile, approval_policy,
           review_policy, routing_overrides, prompt_profile, controller_settings, check_commands,
           config_version, goal, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.name,
        input.repoPath,
        input.baseBranch ?? "main",
        "active",
        input.routingProfile ?? "default",
        toJson(input.approvalPolicy ?? { overrides: {}, standing: [] }),
        toJson(reviewPolicy),
        toJson(input.routingOverrides ?? {}),
        toJson(input.promptProfile ?? DEFAULT_PROMPT_PROFILE),
        toJson(input.controllerSettings ?? DEFAULT_CONTROLLER_SETTINGS),
        toJson(input.checkCommands ?? []),
        configVersion,
        input.goal ?? null,
        at,
        at,
      );
      const project = this.getProject(id) as Project;
      const initialConfig: ProjectConfigSnapshot = {
        routingProfile: project.routingProfile,
        routingOverrides: project.routingOverrides,
        approvalPolicy: project.approvalPolicy,
        reviewPolicy: project.reviewPolicy,
        checkCommands: project.checkCommands,
        promptProfile: project.promptProfile,
        controllerSettings: project.controllerSettings,
      };
      this.store.run(
        `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, active, created_at)
         VALUES(?,?,NULL,'project-registration','snapshot',?,1,?)`,
        configVersion, id, toJson(initialConfig), at,
      );
      this.recordEvent({ kind: "project.registered", projectId: id, data: { name: input.name, repoPath: input.repoPath, reviewPolicy } });
      if (normalizationNotes.length > 0) {
        this.recordEvent({ kind: "project.review_policy_normalized", projectId: id, data: { requested: requestedReviewPolicy, stored: reviewPolicy, notes: normalizationNotes } });
      }
      return project;
    });
  }

  getProject(id: string): Project | null {
    const row = this.store.get("SELECT * FROM projects WHERE id = ?", id);
    return row ? toProject(row) : null;
  }

  findProjectByName(name: string): Project | null {
    const row = this.store.get("SELECT * FROM projects WHERE name = ?", name);
    return row ? toProject(row) : null;
  }

  listProjects(status?: ProjectStatus): Project[] {
    const rows = status
      ? this.store.all("SELECT * FROM projects WHERE status = ? ORDER BY name", status)
      : this.store.all("SELECT * FROM projects ORDER BY name");
    return rows.map(toProject);
  }

  private recordCurrentProjectConfig(projectId: string, configVersion: string, source: string, parentId: string | null): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    const parentExists = parentId && this.store.get("SELECT id FROM config_versions WHERE id = ?", parentId) ? parentId : null;
    const payload: ProjectConfigSnapshot = {
      routingProfile: project.routingProfile,
      routingOverrides: project.routingOverrides,
      approvalPolicy: project.approvalPolicy,
      reviewPolicy: project.reviewPolicy,
      checkCommands: project.checkCommands,
      promptProfile: project.promptProfile,
      controllerSettings: project.controllerSettings,
    };
    this.store.run("UPDATE config_versions SET active = 0 WHERE project_id = ?", projectId);
    this.store.run(
      `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, active, created_at)
       VALUES(?,?,?,?, 'snapshot', ?,1,?)`,
      configVersion, projectId, parentExists, source, toJson(payload), nowIso(),
    );
  }

  setProjectStatus(id: string, status: ProjectStatus): void {
    this.store.tx(() => {
      this.store.run("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), id);
      this.recordEvent({ kind: "project.status", projectId: id, data: { status } });
    });
  }

  setProjectBaseBranch(id: string, baseBranch: string): string {
    if (!baseBranch.trim()) throw new Error("Base branch is required");
    const parentId = this.getProject(id)?.configVersion ?? null;
    const configVersion = ids.config();
    this.store.tx(() => {
      this.store.run(
        "UPDATE projects SET base_branch = ?, config_version = ?, updated_at = ? WHERE id = ?",
        baseBranch, configVersion, nowIso(), id,
      );
      this.invalidateProjectApprovals(id, `Target branch changed to ${baseBranch}.`);
      this.recordCurrentProjectConfig(id, configVersion, "target-branch-change", parentId);
      this.recordEvent({ kind: "project.base_branch_updated", projectId: id, data: { baseBranch, configVersion } });
    });
    return configVersion;
  }

  updateProjectChecks(id: string, checks: GateSpec[]): string {
    const parentId = this.getProject(id)?.configVersion ?? null;
    const configVersion = ids.config();
    this.store.tx(() => {
      this.store.run(
        "UPDATE projects SET check_commands = ?, config_version = ?, updated_at = ? WHERE id = ?",
        toJson(checks),
        configVersion,
        nowIso(),
        id,
      );
      this.invalidateProjectApprovals(id, "Quality configuration changed.");
      this.recordCurrentProjectConfig(id, configVersion, "quality-check-change", parentId);
      this.recordEvent({ kind: "project.checks_updated", projectId: id, data: { count: checks.length, configVersion } });
    });
    return configVersion;
  }

  setProjectPolicy(id: string, policy: ProjectApprovalPolicy): string {
    const parentId = this.getProject(id)?.configVersion ?? null;
    const configVersion = ids.config();
    this.store.tx(() => {
      this.store.run(
        "UPDATE projects SET approval_policy = ?, config_version = ?, updated_at = ? WHERE id = ?",
        toJson(policy),
        configVersion,
        nowIso(),
        id,
      );
      this.invalidateProjectApprovals(id, "Approval policy changed.");
      this.recordCurrentProjectConfig(id, configVersion, "approval-policy-change", parentId);
      this.recordEvent({ kind: "project.policy_updated", projectId: id, data: { configVersion } });
    });
    return configVersion;
  }

  setProjectReviewPolicy(id: string, requested: ReviewPolicy): string {
    if (!REVIEW_MODES.includes(requested.mode)) throw new Error(`Invalid review mode: ${requested.mode}`);
    const invalid = requested.skipTaskClasses.filter((taskClass) => !TASK_CLASSES.includes(taskClass));
    if (invalid.length > 0) throw new Error(`Unknown review task classes: ${invalid.join(", ")}`);
    const policy = normalizeReviewPolicy(requested);
    const notes = reviewPolicyNormalizationNotes(requested, policy);
    const parentId = this.getProject(id)?.configVersion ?? null;
    const configVersion = ids.config();
    this.store.tx(() => {
      this.store.run(
        "UPDATE projects SET review_policy = ?, config_version = ?, updated_at = ? WHERE id = ?",
        toJson(policy), configVersion, nowIso(), id,
      );
      this.invalidateProjectApprovals(id, "Review policy changed.");
      this.recordCurrentProjectConfig(id, configVersion, "review-policy-change", parentId);
      this.recordEvent({ kind: "project.review_policy_updated", projectId: id, data: { configVersion, policy, notes } });
    });
    return configVersion;
  }

  // --- requirements -------------------------------------------------------

  addRequirement(projectId: string, id: string, text: string, mandatory = true): void {
    this.store.run(
      "INSERT INTO requirements(id, project_id, text, mandatory, created_at) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(project_id, id) DO UPDATE SET text = excluded.text, mandatory = excluded.mandatory",
      id,
      projectId,
      text,
      mandatory ? 1 : 0,
      nowIso(),
    );
  }

  listRequirements(projectId: string): { id: string; text: string; mandatory: boolean }[] {
    return this.store
      .all("SELECT id, text, mandatory FROM requirements WHERE project_id = ? ORDER BY id", projectId)
      .map((row) => ({ id: row.id as string, text: row.text as string, mandatory: Number(row.mandatory) === 1 }));
  }

  // --- tasks --------------------------------------------------------------

  createTask(input: {
    projectId: string;
    title: string;
    objective: string;
    acceptanceCriteria?: string[];
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
    priority?: number;
    dependsOn?: string[];
    deadlineAt?: string | null;
    repairLimit?: number;
    inScopeActions?: Action[];
    executionMode?: string;
    executionReason?: string | null;
    reviewOfTaskId?: string | null;
  }): Task {
    const id = ids.task();
    const at = nowIso();
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    const defaultRepairLimit = this.getProject(input.projectId)?.controllerSettings.defaultRepairLimit ?? 2;
    const role = input.role ?? "implementer";
    const taskClass = input.taskClass ?? (role === "reviewer" ? "review" : role === "researcher" ? "research" : role === "troubleshooter" ? "troubleshooting" : "small_implementation");
    if (!TASK_CLASSES.includes(taskClass)) throw new Error(`Unknown task class: ${taskClass}`);
    if (!["low", "medium", "high"].includes(input.complexity ?? "medium")) throw new Error(`Invalid complexity: ${input.complexity}`);
    if (!["low", "medium", "high"].includes(input.ambiguity ?? "low")) throw new Error(`Invalid ambiguity: ${input.ambiguity}`);
    if (!["low", "medium", "high"].includes(input.changeRisk ?? "medium")) throw new Error(`Invalid change risk: ${input.changeRisk}`);
    if (!["low", "medium", "high"].includes(input.contextSize ?? "medium")) throw new Error(`Invalid context size: ${input.contextSize}`);
    if (!["single", "sequential", "parallel", "mixed"].includes(input.executionMode ?? "single")) {
      throw new Error(`Invalid execution mode: ${input.executionMode}`);
    }
    for (const scope of input.allowedScope ?? []) {
      const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
        throw new Error(`Allowed scope must be a repository-relative path: ${scope}`);
      }
    }
    return this.store.tx(() => {
      for (const dependencyId of dependsOn) {
        const dependency = this.getTask(dependencyId);
        if (!dependency) throw new Error(`Unknown dependency ${dependencyId}`);
        if (dependency.projectId !== input.projectId) {
          throw new Error(`Dependency ${dependencyId} belongs to another project`);
        }
      }
      this.store.run(
        `INSERT INTO tasks(id, project_id, title, objective, acceptance_criteria, role, task_class,
           complexity, ambiguity, change_risk, language, domain, context_size, required_tools, allowed_scope,
           state, priority, execution_mode, execution_reason, in_scope_actions, repair_limit, repairs_used,
           deadline_at, review_of_task_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.title,
        input.objective,
        toJson(input.acceptanceCriteria ?? []),
        role,
        taskClass,
        input.complexity ?? "medium",
        input.ambiguity ?? "low",
        input.changeRisk ?? "medium",
        input.language ?? null,
        input.domain ?? null,
        input.contextSize ?? "medium",
        toJson(input.requiredTools ?? []),
        toJson(input.allowedScope ?? []),
        "QUEUED",
        input.priority ?? 100,
        input.executionMode ?? "single",
        input.executionReason ?? null,
        toJson(input.inScopeActions ?? []),
        input.repairLimit ?? defaultRepairLimit,
        0,
        input.deadlineAt ?? null,
        input.reviewOfTaskId ?? null,
        at,
        at,
      );
      for (const dep of dependsOn) {
        this.store.run("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on_id) VALUES(?,?)", id, dep);
      }
      this.recordEvent({
        kind: "task.created",
        projectId: input.projectId,
        taskId: id,
        data: { title: input.title, dependsOn, taskClass, executionMode: input.executionMode ?? "single" },
      });
      return this.getTask(id) as Task;
    });
  }

  getTask(id: string): Task | null {
    const row = this.store.get("SELECT * FROM tasks WHERE id = ?", id);
    return row ? toTask(row) : null;
  }

  listTasks(filter: { projectId?: string; state?: TaskState; limit?: number } = {}): Task[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.state) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 500);
    return this.store
      .all(`SELECT * FROM tasks ${where} ORDER BY priority ASC, created_at ASC LIMIT ?`, ...params)
      .map(toTask);
  }

  dependenciesOf(taskId: string): string[] {
    return this.store
      .all("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", taskId)
      .map((row) => row.depends_on_id as string);
  }

  dependentsOf(taskId: string): string[] {
    return this.store
      .all("SELECT task_id FROM task_dependencies WHERE depends_on_id = ?", taskId)
      .map((row) => row.task_id as string);
  }

  /**
   * Validated state transition plus its event, in one transaction.
   * `fields` carries the columns that change with the state.
   */
  transition(taskId: string, to: TaskState, fields: Partial<Record<string, unknown>> = {}, eventData: Record<string, unknown> = {}): Task {
    assertTaskFields(fields);
    return this.store.tx(() => {
      const current = this.getTask(taskId);
      if (!current) throw new Error(`Unknown task ${taskId}`);
      if (current.state !== to) assertTransition(current.state, to);

      const columns = ["state = ?", "updated_at = ?", "record_version = record_version + 1"];
      const params: unknown[] = [to, nowIso()];
      for (const [key, value] of Object.entries(fields)) {
        columns.push(`${key} = ?`);
        params.push(value ?? null);
      }
      params.push(taskId);
      this.store.run(`UPDATE tasks SET ${columns.join(", ")} WHERE id = ?`, ...params);
      this.recordEvent({
        kind: "task.state",
        projectId: current.projectId,
        taskId,
        data: { from: current.state, to, ...eventData },
      });
      return this.getTask(taskId) as Task;
    });
  }

  updateTaskFields(taskId: string, fields: Record<string, unknown>): void {
    assertTaskFields(fields);
    const columns = Object.keys(fields).map((key) => `${key} = ?`);
    if (columns.length === 0) return;
    const params = [...Object.values(fields).map((v) => v ?? null), nowIso(), taskId];
    this.store.run(`UPDATE tasks SET ${columns.join(", ")}, updated_at = ?, record_version = record_version + 1 WHERE id = ?`, ...params);
  }

  /**
   * Atomic claim. The UPDATE only succeeds for a task that is still READY and
   * unclaimed, so two controller loops can never own the same task.
   */
  claimTask(taskId: string, launchId: string): Task | null {
    return this.store.tx(() => {
      const result = this.store.db
        .prepare("UPDATE tasks SET claimed_by = ?, claimed_at = ?, updated_at = ?, record_version = record_version + 1 WHERE id = ? AND state = 'READY' AND claimed_by IS NULL")
        .run(launchId, nowIso(), nowIso(), taskId);
      if (Number(result.changes) !== 1) return null;
      const task = this.getTask(taskId) as Task;
      this.recordEvent({ kind: "task.claimed", projectId: task.projectId, taskId, data: { launchId } });
      return task;
    });
  }

  releaseClaim(taskId: string): void {
    this.store.run(
      "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL, updated_at = ?, record_version = record_version + 1 WHERE id = ?",
      nowIso(),
      taskId,
    );
  }

  /** Explicit operator retry with optimistic version checking. */
  retryTask(taskId: string, expectedVersion: number): Task {
    return this.store.tx(() => {
      const current = this.getTask(taskId);
      if (!current) throw new Error(`Unknown task ${taskId}`);
      if (current.recordVersion !== expectedVersion) {
        throw new Error(`Task ${taskId} changed since version ${expectedVersion}; current version is ${current.recordVersion}`);
      }
      if (current.state !== "BLOCKED" && current.state !== "FAILED") {
        throw new Error(`Task ${taskId} is ${current.state}; only BLOCKED or FAILED tasks can be retried`);
      }
      assertTransition(current.state, "READY");
      const at = nowIso();
      this.store.run(
        `UPDATE tasks SET state = 'READY', claimed_by = NULL, claimed_at = NULL, blocked_reason = NULL,
           failure_class = NULL, updated_at = ?, record_version = record_version + 1
         WHERE id = ? AND record_version = ?`,
        at,
        taskId,
        expectedVersion,
      );
      this.recordEvent({
        kind: "task.retry_requested",
        projectId: current.projectId,
        taskId,
        data: { from: current.state, expectedVersion },
      });
      return this.getTask(taskId) as Task;
    });
  }

  // --- attempts -----------------------------------------------------------

  startAttempt(input: {
    id?: string;
    taskId: string;
    launchId: string;
    kind: Attempt["kind"];
    adapter: string;
    model?: string | null;
    effort?: string | null;
    authMode?: string | null;
    worktreePath?: string | null;
    baseRevision?: string | null;
    packetId?: string | null;
    outputPath?: string | null;
  }): Attempt {
    const id = input.id ?? ids.attempt();
    const at = nowIso();
    return this.store.tx(() => {
      const previous = this.store.get("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?", input.taskId);
      const attemptNumber = Number(previous?.n ?? 0) + 1;
      this.store.run(
        `INSERT INTO attempts(id, task_id, launch_id, attempt_number, kind, adapter, model, effort, auth_mode,
           state, worktree_path, base_revision, packet_id, output_path, started_at, heartbeat_at)
         VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?)`,
        id,
        input.taskId,
        input.launchId,
        attemptNumber,
        input.kind,
        input.adapter,
        input.model ?? null,
        input.effort ?? null,
        input.authMode ?? null,
        input.worktreePath ?? null,
        input.baseRevision ?? null,
        input.packetId ?? null,
        input.outputPath ?? null,
        at,
        at,
      );
      this.recordEvent({
        kind: "attempt.started",
        taskId: input.taskId,
        attemptId: id,
        data: { adapter: input.adapter, model: input.model ?? null, kind: input.kind, launchId: input.launchId },
      });
      return this.getAttempt(id) as Attempt;
    });
  }

  getAttempt(id: string): Attempt | null {
    const row = this.store.get("SELECT * FROM attempts WHERE id = ?", id);
    return row ? toAttempt(row) : null;
  }

  listAttempts(taskId: string): Attempt[] {
    return this.store.all("SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_number", taskId).map(toAttempt);
  }

  listRunningAttempts(): Attempt[] {
    return this.store.all("SELECT * FROM attempts WHERE state = 'running' ORDER BY started_at").map(toAttempt);
  }

  setAttemptProcess(id: string, pid: number | null, sessionId: string | null): void {
    this.store.run("UPDATE attempts SET pid = ?, session_id = ? WHERE id = ?", pid, sessionId, id);
  }

  heartbeat(id: string): void {
    this.store.run("UPDATE attempts SET heartbeat_at = ? WHERE id = ?", nowIso(), id);
  }

  finishAttempt(input: {
    attemptId: string;
    state: Attempt["state"];
    outcome?: string | null;
    failureClass?: FailureClass | null;
    reason?: string | null;
    exitStatus?: number | null;
    resultRevision?: string | null;
    usage?: Record<string, unknown> | null;
    outputPath?: string | null;
  }): void {
    this.store.tx(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${input.attemptId}`);
      this.store.run(
        `UPDATE attempts SET state = ?, outcome = ?, failure_class = ?, reason = ?, exit_status = ?,
           result_revision = ?, usage_json = ?, output_path = COALESCE(?, output_path), ended_at = ?
         WHERE id = ?`,
        input.state,
        input.outcome ?? null,
        input.failureClass ?? null,
        input.reason ?? null,
        input.exitStatus ?? null,
        input.resultRevision ?? null,
        input.usage ? toJson(input.usage) : null,
        input.outputPath ?? null,
        nowIso(),
        input.attemptId,
      );
      this.recordEvent({
        kind: "attempt.finished",
        taskId: attempt.taskId,
        attemptId: input.attemptId,
        data: {
          state: input.state,
          outcome: input.outcome ?? null,
          failureClass: input.failureClass ?? null,
          reason: input.reason ?? null,
        },
      });
    });
  }

  // --- gates --------------------------------------------------------------

  recordGate(input: Omit<GateResult, "id" | "createdAt">): GateResult {
    const id = ids.gate();
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO gate_results(id, task_id, attempt_id, name, status, required, command, tool_version,
           revision, evidence_path, duration_ms, waiver_id, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.taskId,
        input.attemptId,
        input.name,
        input.status,
        input.required ? 1 : 0,
        input.command,
        input.toolVersion,
        input.revision,
        input.evidencePath,
        input.durationMs,
        input.waiverId,
        nowIso(),
      );
      this.recordEvent({
        kind: "gate.result",
        taskId: input.taskId,
        attemptId: input.attemptId,
        data: { name: input.name, status: input.status, revision: input.revision },
      });
    });
    return toGate(this.store.get("SELECT * FROM gate_results WHERE id = ?", id) as Row);
  }

  /** Gate results for one revision. Passing an earlier revision is not evidence for a new one. */
  gatesForRevision(taskId: string, revision: string): GateResult[] {
    return this.store
      .all("SELECT * FROM gate_results WHERE task_id = ? AND revision = ? ORDER BY created_at", taskId, revision)
      .map(toGate);
  }

  gatesForTask(taskId: string): GateResult[] {
    return this.store.all("SELECT * FROM gate_results WHERE task_id = ? ORDER BY created_at", taskId).map(toGate);
  }

  waiveGate(gateId: string, approvalId: string): void {
    this.store.tx(() => {
      const gateRow = this.store.get("SELECT * FROM gate_results WHERE id = ?", gateId);
      if (!gateRow) throw new Error(`Unknown gate ${gateId}`);
      const gate = toGate(gateRow);
      const task = this.getTask(gate.taskId);
      const project = task ? this.getProject(task.projectId) : null;
      const approval = this.getApproval(approvalId);
      if (!task || !project || !approval || approval.state !== "approved" || approval.taskId !== task.id ||
          approval.action !== "waive_required_gate" || approval.target !== gate.id ||
          approval.revision !== gate.revision || approval.configVersion !== project.configVersion) {
        throw new Error("Gate waiver requires a matching approved action, target, revision, and configuration");
      }
      this.store.run("UPDATE gate_results SET waiver_id = ? WHERE id = ?", approvalId, gateId);
      this.markApprovalConsumed(approvalId);
      this.recordEvent({
        kind: "gate.waived",
        projectId: task.projectId,
        taskId: task.id,
        data: { gateId, approvalId, revision: gate.revision },
      });
    });
  }

  // --- approvals ----------------------------------------------------------

  /**
   * Whether this revision has configured quality evidence, and whether an
   * explicit waiver stands in for it. "Not configured" is reported as its own
   * state so readiness can never be inferred from an empty gate list.
   */
  qualityCoverage(taskId: string, revision: string): {
    coverage: "configured" | "not_configured";
    status: "passed" | "failed" | "not_configured";
    requiredConfigured: number;
    missing: string[];
    failing: string[];
    waiver: Approval | null;
  } {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const project = this.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project ${task.projectId}`);
    const required = project.checkCommands.filter((spec) => spec.required);
    const gates = this.gatesForRevision(taskId, revision);
    const missing = required.filter((spec) => !gates.some((gate) => gate.name === spec.name)).map((spec) => spec.name);
    const failing = gates.filter((gate) => gate.required && gate.status !== "PASS" && gate.waiverId === null).map((gate) => gate.name);
    const waiver = this.listApprovals("approved").find((approval) =>
      approval.taskId === taskId &&
      approval.action === "waive_required_gate" &&
      approval.target === `${QUALITY_COVERAGE_GATE}:${revision}`,
    ) ?? null;
    return {
      coverage: required.length === 0 ? "not_configured" : "configured",
      status: required.length === 0 ? "not_configured" : missing.length + failing.length === 0 ? "passed" : "failed",
      requiredConfigured: required.length,
      missing,
      failing,
      waiver,
    };
  }

  prepareApproval(input: { taskId: string; action: Action; target: string; reason: string }): {
    required: boolean;
    policyReason: string;
    approval: Approval | null;
  } {
    const task = this.getTask(input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    const project = this.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project ${task.projectId}`);
    if (!task.resultRevision) throw new Error(`Task ${task.id} has no result revision to approve`);
    const gates = this.gatesForRevision(task.id, task.resultRevision);
    const missingGates = project.checkCommands.filter((spec) => spec.required && !gates.some((gate) => gate.name === spec.name));
    const failedGates = gates.filter((gate) => gate.required && gate.status !== "PASS" && gate.waiverId === null);
    const coverage = this.qualityCoverage(task.id, task.resultRevision);
    const coverageWaiverTarget = `${QUALITY_COVERAGE_GATE}:${task.resultRevision}`;
    if (input.action === "waive_required_gate") {
      const waivesCoverage = input.target === coverageWaiverTarget && coverage.coverage === "not_configured";
      if (!waivesCoverage && !failedGates.some((gate) => gate.id === input.target)) {
        throw new Error(
          `Cannot prepare gate waiver: ${input.target} is neither a failing required gate nor the unconfigured-coverage waiver ` +
          `${coverageWaiverTarget} for ${task.resultRevision}`,
        );
      }
    } else if (missingGates.length > 0 || failedGates.length > 0) {
      throw new Error(`Cannot prepare ${input.action}: required quality gates are missing or failing for ${task.resultRevision}`);
    } else if (coverage.coverage === "not_configured" && coverage.waiver === null) {
      throw new Error(
        `Cannot prepare ${input.action}: this project has no configured required quality checks, so ${task.resultRevision} ` +
        `has no quality evidence. Register checks, or record an explicit waiver approval for ${coverageWaiverTarget}.`,
      );
    }
    const reviewRequired = input.action !== "waive_required_gate" && reviewRequiredFor(project.reviewPolicy, task);
    const approvedReview = this.reviewsForTask(task.id).some((review) => review.revision === task.resultRevision && review.verdict === "approved");
    if (reviewRequired && !approvedReview) {
      throw new Error(`Cannot prepare ${input.action}: independent review has not approved ${task.resultRevision}`);
    }
    const policy = evaluate({ action: input.action, policy: project.approvalPolicy, inScope: task.inScopeActions.includes(input.action) });
    if (!policy.requiresApproval) return { required: false, policyReason: policy.reason, approval: null };
    const approval = this.requestApproval({
      projectId: project.id,
      taskId: task.id,
      binding: { action: input.action, target: input.target, revision: task.resultRevision, configVersion: project.configVersion },
      reason: input.reason,
      evidence: {
        gates,
        qualityCoverage: { ...coverage, waiver: coverage.waiver?.id ?? null },
        review: this.reviewsForTask(task.id).findLast((review) => review.revision === task.resultRevision) ?? null,
      },
    });
    return { required: true, policyReason: policy.reason, approval };
  }

  requestApproval(input: {
    projectId: string;
    taskId?: string | null;
    binding: ApprovalBinding;
    reason: string;
    evidence?: Record<string, unknown>;
  }): Approval {
    const id = ids.approval();
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO approvals(id, project_id, task_id, action, target, revision, config_version, state,
           reason, evidence, requested_at)
         VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`,
        id,
        input.projectId,
        input.taskId ?? null,
        input.binding.action,
        input.binding.target,
        input.binding.revision,
        input.binding.configVersion,
        input.reason,
        toJson(input.evidence ?? {}),
        nowIso(),
      );
      this.recordEvent({
        kind: "approval.requested",
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        data: { approvalId: id, ...input.binding, reason: input.reason },
      });
    });
    return this.getApproval(id) as Approval;
  }

  getApproval(id: string): Approval | null {
    const row = this.store.get("SELECT * FROM approvals WHERE id = ?", id);
    return row ? toApproval(row) : null;
  }

  listApprovals(state?: ApprovalState): Approval[] {
    const rows = state
      ? this.store.all("SELECT * FROM approvals WHERE state = ? ORDER BY requested_at DESC", state)
      : this.store.all("SELECT * FROM approvals ORDER BY requested_at DESC LIMIT 200");
    return rows.map(toApproval);
  }

  decideApproval(id: string, state: "approved" | "rejected", decidedBy: string, reason?: string): Approval {
    let staleReason: string | null = null;
    const result = this.store.tx(() => {
      const approval = this.getApproval(id);
      if (!approval) throw new Error(`Unknown approval ${id}`);
      if (approval.state !== "pending") {
        throw new Error(`Approval ${id} is ${approval.state}; only a pending approval can be decided`);
      }
      if (state === "approved") {
        const project = this.getProject(approval.projectId);
        const task = approval.taskId ? this.getTask(approval.taskId) : null;
        const drift: string[] = [];
        if (!project || project.configVersion !== approval.configVersion) drift.push("project configuration changed");
        if (task?.resultRevision && task.resultRevision !== approval.revision) drift.push("task revision changed");
        if (approval.action === "merge" && project && approval.target !== project.baseBranch) drift.push("target branch changed");
        if (drift.length > 0) {
          staleReason = drift.join("; ");
          this.store.run("UPDATE approvals SET state = 'invalidated', decided_at = ?, decided_by = ? WHERE id = ?", nowIso(), decidedBy, id);
          this.recordEvent({
            kind: "approval.invalidated",
            projectId: approval.projectId,
            taskId: approval.taskId,
            data: { approvalId: id, reason: staleReason },
          });
          return this.getApproval(id) as Approval;
        }
      }
      this.store.run(
        "UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, reason = COALESCE(?, reason) WHERE id = ?",
        state,
        nowIso(),
        decidedBy,
        reason ?? null,
        id,
      );
      this.recordEvent({
        kind: `approval.${state}`,
        projectId: approval.projectId,
        taskId: approval.taskId,
        data: { approvalId: id, decidedBy, reason: reason ?? null },
      });
      return this.getApproval(id) as Approval;
    });
    if (staleReason) throw new Error(`Approval ${id} is stale and was invalidated: ${staleReason}`);
    return result;
  }

  markApprovalConsumed(id: string): void {
    this.store.tx(() => {
      const approval = this.getApproval(id);
      if (!approval) throw new Error(`Unknown approval ${id}`);
      if (approval.state !== "approved") {
        throw new Error(`Approval ${id} is ${approval.state}; only an approved decision can be consumed`);
      }
      this.store.run("UPDATE approvals SET state = 'consumed', consumed_at = ? WHERE id = ?", nowIso(), id);
      this.recordEvent({
        kind: "approval.consumed",
        projectId: approval.projectId,
        taskId: approval.taskId,
        data: { approvalId: id },
      });
    });
  }

  invalidateProjectApprovals(projectId: string, reason: string): number {
    return this.store.tx(() => {
      const open = this.store.all(
        "SELECT * FROM approvals WHERE project_id = ? AND state IN ('pending','approved')",
        projectId,
      ).map(toApproval);
      for (const approval of open) {
        this.store.run("UPDATE approvals SET state = 'invalidated', decided_at = ? WHERE id = ?", nowIso(), approval.id);
        this.recordEvent({
          kind: "approval.invalidated",
          projectId,
          taskId: approval.taskId,
          data: { approvalId: approval.id, reason },
        });
      }
      return open.length;
    });
  }

  /** Invalidate approvals whose bound revision or configuration no longer matches. */
  invalidateApprovals(taskId: string, reason: string, keepRevision?: string): number {
    return this.store.tx(() => {
      const open = this.store
        .all("SELECT * FROM approvals WHERE task_id = ? AND state IN ('pending','approved')", taskId)
        .map(toApproval);
      let count = 0;
      for (const approval of open) {
        if (keepRevision && approval.revision === keepRevision) continue;
        this.store.run("UPDATE approvals SET state = 'invalidated', decided_at = ? WHERE id = ?", nowIso(), approval.id);
        this.recordEvent({
          kind: "approval.invalidated",
          projectId: approval.projectId,
          taskId,
          data: { approvalId: approval.id, reason },
        });
        count += 1;
      }
      return count;
    });
  }

  findApprovalFor(taskId: string, binding: ApprovalBinding): Approval | null {
    const row = this.store.get(
      `SELECT * FROM approvals WHERE task_id = ? AND action = ? AND target = ? AND revision = ?
         AND config_version = ? AND state = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      taskId,
      binding.action,
      binding.target,
      binding.revision,
      binding.configVersion,
    );
    return row ? toApproval(row) : null;
  }

  // --- curated configuration ----------------------------------------------

  getConfigVersion(id: string): (Row & { payload: ProjectConfigSnapshot }) | null {
    const row = this.store.get("SELECT * FROM config_versions WHERE id = ?", id);
    return row ? { ...row, payload: normalizeProjectConfig(fromJson<ProjectConfigSnapshot>(row.payload, {} as ProjectConfigSnapshot)) } : null;
  }

  listConfigVersions(projectId: string): (Row & { payload: ProjectConfigSnapshot })[] {
    return this.store.all(
      "SELECT * FROM config_versions WHERE project_id = ? ORDER BY created_at DESC",
      projectId,
    ).map((row) => ({
      ...row,
      payload: normalizeProjectConfig(fromJson<ProjectConfigSnapshot>(row.payload, {} as ProjectConfigSnapshot)),
    }));
  }

  ensureProjectConfigVersion(projectId: string, payload: ProjectConfigSnapshot): string {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    const existing = this.store.get("SELECT * FROM config_versions WHERE id = ?", project.configVersion);
    if (!existing) {
      this.store.run(
        `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, active, created_at)
         VALUES(?,?,NULL,'migration-snapshot','snapshot',?,1,?)`,
        project.configVersion, projectId, toJson(payload), nowIso(),
      );
    } else if (existing.project_id === null || existing.project_id === undefined) {
      this.store.run(
        "UPDATE config_versions SET project_id = ?, payload = ?, active = 1 WHERE id = ?",
        projectId, toJson(payload), project.configVersion,
      );
    }
    return project.configVersion;
  }

  createCuratorProposal(input: {
    projectId: string;
    title: string;
    rationale: string;
    fingerprint: string;
    evidenceFingerprint: string;
    config: ProjectConfigSnapshot;
    proposedBy: string;
  }): CuratorProposal {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Unknown project ${input.projectId}`);
    const duplicate = this.store.get(
      `SELECT * FROM curator_proposals WHERE project_id = ? AND fingerprint = ? AND evidence_fingerprint = ?
       AND status IN ('proposed','evaluated','rejected','activated') ORDER BY created_at DESC LIMIT 1`,
      input.projectId, input.fingerprint, input.evidenceFingerprint,
    );
    if (duplicate) {
      throw new Error(`Equivalent curator proposal ${String(duplicate.id)} already ended in status ${String(duplicate.status)}; new evidence is required`);
    }
    const proposalId = ids.proposal();
    const configVersion = ids.config();
    const at = nowIso();
    return this.store.tx(() => {
      const parentExists = this.store.get("SELECT id FROM config_versions WHERE id = ?", project.configVersion);
      this.store.run(
        `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, active, created_at)
         VALUES(?,?,?,?, 'curator-proposal', ?,0,?)`,
        configVersion, project.id, parentExists ? project.configVersion : null, `proposal:${proposalId}`, toJson(input.config), at,
      );
      this.store.run(
        `INSERT INTO curator_proposals(id, project_id, title, rationale, fingerprint, evidence_fingerprint,
           status, base_config_version, proposed_config_version, proposed_by, created_at, updated_at)
         VALUES(?,?,?,?,?,?,'draft',?,?,?,?,?)`,
        proposalId, project.id, input.title, input.rationale, input.fingerprint, input.evidenceFingerprint,
        project.configVersion, configVersion, input.proposedBy, at, at,
      );
      this.recordEvent({
        kind: "curator.proposal_created",
        projectId: project.id,
        data: { proposalId, configVersion, fingerprint: input.fingerprint, evidenceFingerprint: input.evidenceFingerprint },
      });
      return this.getCuratorProposal(proposalId) as CuratorProposal;
    });
  }

  updateCuratorProposalEvidence(id: string, input: {
    branch: string;
    worktreePath: string;
    baseRevision: string;
    resultRevision: string;
    diffPath: string;
  }): CuratorProposal {
    const proposal = this.getCuratorProposal(id);
    if (!proposal || proposal.status !== "draft") throw new Error(`Proposal ${id} is not a draft`);
    this.store.tx(() => {
      this.store.run(
        `UPDATE curator_proposals SET status = 'proposed', branch = ?, worktree_path = ?, base_revision = ?,
           result_revision = ?, diff_path = ?, updated_at = ? WHERE id = ?`,
        input.branch, input.worktreePath, input.baseRevision, input.resultRevision, input.diffPath, nowIso(), id,
      );
      this.store.run("UPDATE config_versions SET revision = ? WHERE id = ?", input.resultRevision, proposal.proposedConfigVersion);
      this.recordEvent({
        kind: "curator.proposal_materialized",
        projectId: proposal.projectId,
        data: { proposalId: id, revision: input.resultRevision, branch: input.branch, diffPath: input.diffPath },
      });
    });
    return this.getCuratorProposal(id) as CuratorProposal;
  }

  getCuratorProposal(id: string): CuratorProposal | null {
    const row = this.store.get("SELECT * FROM curator_proposals WHERE id = ?", id);
    return row ? toProposal(row) : null;
  }

  listCuratorProposals(projectId?: string): CuratorProposal[] {
    const rows = projectId
      ? this.store.all("SELECT * FROM curator_proposals WHERE project_id = ? ORDER BY created_at DESC", projectId)
      : this.store.all("SELECT * FROM curator_proposals ORDER BY created_at DESC LIMIT 200");
    return rows.map(toProposal);
  }

  failCuratorProposal(id: string, reason: string): CuratorProposal {
    const proposal = this.getCuratorProposal(id);
    if (!proposal || proposal.status !== "draft") throw new Error(`Proposal ${id} is not a draft`);
    this.store.tx(() => {
      this.store.run(
        "UPDATE curator_proposals SET status = 'failed', rejection_reason = ?, updated_at = ? WHERE id = ?",
        reason, nowIso(), id,
      );
      this.recordEvent({ kind: "curator.proposal_failed", projectId: proposal.projectId, data: { proposalId: id, reason } });
    });
    return this.getCuratorProposal(id) as CuratorProposal;
  }

  rejectCuratorProposal(id: string, reason: string, rejectedBy: string): CuratorProposal {
    if (!reason.trim()) throw new Error("Rejection reason is required");
    return this.store.tx(() => {
      const proposal = this.getCuratorProposal(id);
      if (!proposal || !["proposed", "evaluated"].includes(proposal.status)) throw new Error(`Proposal ${id} cannot be rejected from its current state`);
      this.store.run(
        "UPDATE curator_proposals SET status = 'rejected', rejection_reason = ?, updated_at = ? WHERE id = ?",
        reason, nowIso(), id,
      );
      const approvals = this.store.all(
        `SELECT * FROM approvals WHERE project_id = ? AND task_id IS NULL AND action = 'activate_config_change'
         AND target = ? AND state IN ('pending','approved')`,
        proposal.projectId, proposal.id,
      ).map(toApproval);
      for (const approval of approvals) {
        this.store.run("UPDATE approvals SET state = 'invalidated', decided_at = ? WHERE id = ?", nowIso(), approval.id);
        this.recordEvent({
          kind: "approval.invalidated",
          projectId: proposal.projectId,
          data: { approvalId: approval.id, reason: `Curator proposal ${id} was rejected.` },
        });
      }
      this.recordEvent({ kind: "curator.proposal_rejected", projectId: proposal.projectId, data: { proposalId: id, reason, rejectedBy } });
      return this.getCuratorProposal(id) as CuratorProposal;
    });
  }

  recordCuratorEvaluation(input: {
    proposalId: string;
    suiteVersion: string;
    status: CuratorEvaluation["status"];
    baselineMetrics: EvaluationMetrics;
    candidateMetrics: EvaluationMetrics;
    cases: EvaluationCase[];
    errors: string[];
    evidencePath: string | null;
    startedAt: string;
  }): CuratorEvaluation {
    const proposal = this.getCuratorProposal(input.proposalId);
    if (!proposal || !["proposed", "evaluated"].includes(proposal.status)) throw new Error(`Proposal ${input.proposalId} is not ready for evaluation`);
    const id = ids.evaluation();
    const endedAt = nowIso();
    return this.store.tx(() => {
      this.store.run(
        `INSERT INTO curator_evaluations(id, proposal_id, suite_version, status, baseline_metrics,
           candidate_metrics, case_results, errors, evidence_path, started_at, ended_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.proposalId, input.suiteVersion, input.status, toJson(input.baselineMetrics),
        toJson(input.candidateMetrics), toJson(input.cases), toJson(input.errors), input.evidencePath, input.startedAt, endedAt,
      );
      this.store.run(
        "UPDATE curator_proposals SET status = 'evaluated', updated_at = ? WHERE id = ?",
        endedAt, input.proposalId,
      );
      this.recordEvent({
        kind: "curator.evaluated",
        projectId: proposal.projectId,
        data: { proposalId: input.proposalId, evaluationId: id, status: input.status, suiteVersion: input.suiteVersion },
      });
      return this.getCuratorEvaluation(id) as CuratorEvaluation;
    });
  }

  getCuratorEvaluation(id: string): CuratorEvaluation | null {
    const row = this.store.get("SELECT * FROM curator_evaluations WHERE id = ?", id);
    return row ? toEvaluation(row) : null;
  }

  evaluationsForProposal(proposalId: string): CuratorEvaluation[] {
    return this.store.all(
      "SELECT * FROM curator_evaluations WHERE proposal_id = ? ORDER BY ended_at",
      proposalId,
    ).map(toEvaluation);
  }

  findProjectApprovalFor(projectId: string, binding: ApprovalBinding): Approval | null {
    const row = this.store.get(
      `SELECT * FROM approvals WHERE project_id = ? AND task_id IS NULL AND action = ? AND target = ?
       AND revision = ? AND config_version = ? AND state = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      projectId, binding.action, binding.target, binding.revision, binding.configVersion,
    );
    return row ? toApproval(row) : null;
  }

  activateCuratorProposal(id: string, approvalId: string, activatedBy: string, reason: string): ConfigActivation {
    if (!reason.trim()) throw new Error("Activation reason is required");
    const proposal = this.getCuratorProposal(id);
    if (!proposal || proposal.status !== "evaluated" || !proposal.resultRevision) throw new Error(`Proposal ${id} is not evaluated and revision-bound`);
    const evaluation = this.evaluationsForProposal(id).at(-1);
    if (!evaluation || evaluation.status !== "passed") throw new Error(`Proposal ${id} has no passing evaluation`);
    const project = this.getProject(proposal.projectId);
    if (!project) throw new Error(`Unknown project ${proposal.projectId}`);
    if (project.configVersion !== proposal.baseConfigVersion) throw new Error(`Proposal ${id} is stale because project configuration changed`);
    const activeTasks = this.listTasks({ projectId: project.id }).filter((task) => ["RUNNING", "CHECKING", "REVIEWING"].includes(task.state));
    if (activeTasks.length > 0) throw new Error(`Configuration activation requires a safe checkpoint; ${activeTasks.length} task(s) are active`);
    const binding: ApprovalBinding = {
      action: "activate_config_change",
      target: id,
      revision: proposal.resultRevision,
      configVersion: project.configVersion,
    };
    const approval = this.getApproval(approvalId);
    if (!approval || approval.id !== this.findProjectApprovalFor(project.id, binding)?.id) {
      throw new Error("Activation requires an exact approved proposal revision and configuration binding");
    }
    const version = this.getConfigVersion(proposal.proposedConfigVersion);
    if (!version) throw new Error(`Missing proposed configuration ${proposal.proposedConfigVersion}`);
    const errors = validateProjectConfig(version.payload);
    if (errors.length > 0) throw new Error(`Proposed configuration is invalid: ${errors.join("; ")}`);
    return this.applyConfiguration({
      project,
      configVersion: proposal.proposedConfigVersion,
      config: version.payload,
      proposalId: proposal.id,
      action: "activate",
      sourceConfigVersion: proposal.proposedConfigVersion,
      approval,
      activatedBy,
      reason,
    });
  }

  revertProjectConfig(input: {
    projectId: string;
    targetConfigVersion: string;
    approvalId: string;
    activatedBy: string;
    reason: string;
  }): ConfigActivation {
    if (!input.reason.trim()) throw new Error("Revert reason is required");
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Unknown project ${input.projectId}`);
    const activeTasks = this.listTasks({ projectId: project.id }).filter((task) => ["RUNNING", "CHECKING", "REVIEWING"].includes(task.state));
    if (activeTasks.length > 0) throw new Error(`Configuration revert requires a safe checkpoint; ${activeTasks.length} task(s) are active`);
    const target = this.getConfigVersion(input.targetConfigVersion);
    if (!target || target.project_id !== project.id) throw new Error(`Unknown project configuration ${input.targetConfigVersion}`);
    const binding: ApprovalBinding = {
      action: "activate_config_change",
      target: `revert:${input.targetConfigVersion}`,
      revision: input.targetConfigVersion,
      configVersion: project.configVersion,
    };
    const approval = this.getApproval(input.approvalId);
    if (!approval || approval.id !== this.findProjectApprovalFor(project.id, binding)?.id) {
      throw new Error("Revert requires an exact approved target and current configuration binding");
    }
    const errors = validateProjectConfig(target.payload);
    if (errors.length > 0) throw new Error(`Target configuration is invalid: ${errors.join("; ")}`);
    const revertVersion = ids.config();
    this.store.run(
      `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, revision, active, created_at)
       VALUES(?,?,?,'curator-revert','snapshot',?,NULL,0,?)`,
      revertVersion, project.id, project.configVersion, toJson(target.payload), nowIso(),
    );
    return this.applyConfiguration({
      project,
      configVersion: revertVersion,
      config: target.payload,
      proposalId: null,
      action: "revert",
      sourceConfigVersion: input.targetConfigVersion,
      approval,
      activatedBy: input.activatedBy,
      reason: input.reason,
    });
  }

  private applyConfiguration(input: {
    project: Project;
    configVersion: string;
    config: ProjectConfigSnapshot;
    proposalId: string | null;
    action: ConfigActivation["action"];
    sourceConfigVersion: string;
    approval: Approval;
    activatedBy: string;
    reason: string;
  }): ConfigActivation {
    const activationId = ids.activation();
    return this.store.tx(() => {
      this.markApprovalConsumed(input.approval.id);
      this.store.run("UPDATE config_versions SET active = 0 WHERE project_id = ?", input.project.id);
      this.store.run("UPDATE config_versions SET active = 1 WHERE id = ?", input.configVersion);
      this.store.run(
        `UPDATE projects SET routing_profile = ?, routing_overrides = ?, approval_policy = ?, review_policy = ?,
           check_commands = ?, prompt_profile = ?, controller_settings = ?, config_version = ?, updated_at = ? WHERE id = ?`,
        input.config.routingProfile, toJson(input.config.routingOverrides), toJson(input.config.approvalPolicy),
        toJson(input.config.reviewPolicy), toJson(input.config.checkCommands), toJson(input.config.promptProfile),
        toJson(input.config.controllerSettings), input.configVersion, nowIso(), input.project.id,
      );
      if (input.proposalId) {
        this.store.run("UPDATE curator_proposals SET status = 'activated', updated_at = ? WHERE id = ?", nowIso(), input.proposalId);
        this.store.run(
          `UPDATE curator_proposals SET status = 'superseded', updated_at = ? WHERE project_id = ? AND id <> ?
           AND status IN ('proposed','evaluated')`,
          nowIso(), input.project.id, input.proposalId,
        );
      }
      this.invalidateProjectApprovals(input.project.id, `Configuration ${input.action} completed.`);
      this.store.run(
        `INSERT INTO config_activations(id, project_id, proposal_id, action, from_config_version,
           to_config_version, source_config_version, approval_id, activated_by, reason, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        activationId, input.project.id, input.proposalId, input.action, input.project.configVersion,
        input.configVersion, input.sourceConfigVersion, input.approval.id, input.activatedBy, input.reason, nowIso(),
      );
      this.recordEvent({
        kind: input.action === "activate" ? "config.activated" : "config.reverted",
        projectId: input.project.id,
        data: {
          activationId,
          proposalId: input.proposalId,
          fromConfigVersion: input.project.configVersion,
          toConfigVersion: input.configVersion,
          approvalId: input.approval.id,
          activatedBy: input.activatedBy,
        },
      });
      return this.getConfigActivation(activationId) as ConfigActivation;
    });
  }

  getConfigActivation(id: string): ConfigActivation | null {
    const row = this.store.get("SELECT * FROM config_activations WHERE id = ?", id);
    return row ? toActivation(row) : null;
  }

  listConfigActivations(projectId: string): ConfigActivation[] {
    return this.store.all(
      "SELECT * FROM config_activations WHERE project_id = ? ORDER BY created_at DESC",
      projectId,
    ).map(toActivation);
  }

  // --- plans, review, and feedback ----------------------------------------

  recordExecutionPlan(input: {
    projectId: string;
    objective: string;
    mode: string;
    reason: string;
    assumptions?: string[];
    milestones?: string[];
    tasks: { taskId: string; key: string }[];
  }): ExecutionPlanRecord {
    const id = ids.plan();
    const at = nowIso();
    return this.store.tx(() => {
      this.store.run(
        `INSERT INTO execution_plans(id, project_id, objective, mode, reason, assumptions, milestones, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        id, input.projectId, input.objective, input.mode, input.reason,
        toJson(input.assumptions ?? []), toJson(input.milestones ?? []), at, at,
      );
      for (const item of input.tasks) {
        this.store.run("INSERT INTO execution_plan_tasks(plan_id, task_id, task_key) VALUES(?,?,?)", id, item.taskId, item.key);
      }
      this.recordEvent({ kind: "plan.recorded", projectId: input.projectId, data: { planId: id, taskIds: input.tasks.map((item) => item.taskId) } });
      return this.getExecutionPlan(id)?.plan as ExecutionPlanRecord;
    });
  }

  listExecutionPlans(projectId?: string): ExecutionPlanRecord[] {
    const rows = projectId
      ? this.store.all("SELECT * FROM execution_plans WHERE project_id = ? ORDER BY created_at DESC", projectId)
      : this.store.all("SELECT * FROM execution_plans ORDER BY created_at DESC LIMIT 200");
    return rows.map(toPlan);
  }

  getExecutionPlan(id: string): { plan: ExecutionPlanRecord; items: { key: string; task: Task; dependencies: string[]; routing: Row[] }[] } | null {
    const row = this.store.get("SELECT * FROM execution_plans WHERE id = ?", id);
    if (!row) return null;
    const items = this.store.all(
      "SELECT task_id, task_key FROM execution_plan_tasks WHERE plan_id = ? ORDER BY rowid",
      id,
    ).flatMap((item) => {
      const task = this.getTask(item.task_id as string);
      return task ? [{
        key: item.task_key as string,
        task,
        dependencies: this.dependenciesOf(task.id),
        routing: this.routingForTask(task.id),
      }] : [];
    });
    return { plan: toPlan(row), items };
  }

  recordReview(input: {
    taskId: string;
    attemptId: string;
    revision: string;
    verdict: ReviewResult["verdict"];
    summary: string;
    findings: string[];
    blockingFindings?: string[];
    advisoryFindings?: string[];
    requirementsChecked: string[];
    evidencePath?: string | null;
  }): ReviewResult {
    const id = ids.review();
    const classified = classifyFindings(input.findings);
    const blocking = input.blockingFindings ?? classified.blocking;
    const advisory = input.advisoryFindings ?? classified.advisory;
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO review_results(id, task_id, attempt_id, revision, verdict, summary, findings,
           blocking_findings, advisory_findings, requirements_checked, evidence_path, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.taskId, input.attemptId, input.revision, input.verdict, input.summary,
        toJson(classified.all), toJson(blocking), toJson(advisory),
        toJson(input.requirementsChecked), input.evidencePath ?? null, nowIso(),
      );
      const task = this.getTask(input.taskId);
      this.recordEvent({
        kind: "review.result",
        projectId: task?.projectId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        data: {
          reviewId: id, revision: input.revision, verdict: input.verdict,
          findings: classified.all.length, blocking: blocking.length, advisory: advisory.length,
          severities: classified.counts,
        },
      });
    });
    return toReview(this.store.get("SELECT * FROM review_results WHERE id = ?", id) as Row);
  }

  reviewsForTask(taskId: string): ReviewResult[] {
    return this.store.all("SELECT * FROM review_results WHERE task_id = ? ORDER BY created_at", taskId).map(toReview);
  }

  submitFeedback(input: {
    projectId: string;
    taskId?: string | null;
    planId?: string | null;
    kind: Feedback["kind"];
    body: string;
    expectedVersion: number;
    createdBy: string;
  }): Feedback {
    if (!input.body.trim()) throw new Error("Feedback body is required");
    if (!(["comment", "question", "request_change", "priority"] as string[]).includes(input.kind)) throw new Error(`Unknown feedback kind: ${input.kind}`);
    if (Boolean(input.taskId) === Boolean(input.planId)) throw new Error("Feedback must target exactly one task or plan");
    return this.store.tx(() => {
      const task = input.taskId ? this.getTask(input.taskId) : null;
      const planDetail = input.planId ? this.getExecutionPlan(input.planId) : null;
      const actualVersion = task?.recordVersion ?? planDetail?.plan.version;
      if (actualVersion === undefined) throw new Error("Feedback target does not exist");
      if ((task?.projectId ?? planDetail?.plan.projectId) !== input.projectId) throw new Error("Feedback target belongs to another project");
      if (actualVersion !== input.expectedVersion) {
        throw new Error(`Feedback target changed since version ${input.expectedVersion}; current version is ${actualVersion}`);
      }
      let state: Feedback["state"] = input.kind === "question" ? "pending" : "applied";
      let linkedTaskId: string | null = null;
      let response: string | null = null;
      if (input.kind === "question") {
        const targetContext = task
          ? `Task ${task.id} (${task.title}): ${task.objective}`
          : `Plan ${planDetail?.plan.id}: ${planDetail?.plan.objective}`;
        const responseTask = this.createTask({
          projectId: input.projectId,
          title: `Answer feedback question`,
          objective: `Answer this project-scoped question using repository evidence and authoritative requirements.\n\nTarget: ${targetContext}\n\nQuestion: ${input.body}`,
          acceptanceCriteria: ["Provide a concise supported answer and identify any uncertainty in the result summary."],
          role: "researcher",
          taskClass: "research",
          complexity: "low",
          ambiguity: "medium",
          changeRisk: "low",
          allowedScope: [".mabs/result.json"],
          executionMode: "single",
          executionReason: "One on-demand response task; no permanent orchestrator loop.",
        });
        linkedTaskId = responseTask.id;
        response = `Response task ${responseTask.id} queued.`;
      } else if (input.kind === "request_change") {
        if (!task) throw new Error("Change requests must target a task");
        const followUp = this.createTask({
          projectId: task.projectId,
          title: `Requested change: ${task.title}`,
          objective: input.body,
          acceptanceCriteria: [`The requested change is implemented: ${input.body}`],
          role: "implementer",
          taskClass: task.taskClass,
          complexity: task.complexity,
          ambiguity: task.ambiguity,
          changeRisk: task.changeRisk,
          language: task.language,
          domain: task.domain,
          contextSize: task.contextSize,
          requiredTools: task.requiredTools,
          allowedScope: task.allowedScope,
          dependsOn: [task.id],
          executionMode: "sequential",
          executionReason: `User-requested follow-up to ${task.id}.`,
        });
        linkedTaskId = followUp.id;
        response = `Created follow-up task ${followUp.id}; it will run after ${task.id} completes.`;
      } else if (input.kind === "priority") {
        if (!task) throw new Error("Priority feedback must target a task");
        const priority = Number(input.body);
        if (!Number.isSafeInteger(priority) || priority < 0) throw new Error("Priority must be a non-negative integer");
        this.updateTaskFields(task.id, { priority });
        response = `Priority updated to ${priority}.`;
      } else if (input.kind === "comment") {
        response = "Comment recorded.";
      }
      const id = ids.feedback();
      this.store.run(
        `INSERT INTO feedback(id, project_id, task_id, plan_id, kind, body, state, response, linked_task_id,
           submitted_for_version, created_by, created_at, resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.projectId, input.taskId ?? null, input.planId ?? null, input.kind, input.body, state,
        response, linkedTaskId, input.expectedVersion, input.createdBy, nowIso(), state === "pending" ? null : nowIso(),
      );
      this.recordEvent({
        kind: `feedback.${input.kind}`,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        data: { feedbackId: id, planId: input.planId ?? null, state, linkedTaskId },
      });
      return this.getFeedback(id) as Feedback;
    });
  }

  getFeedback(id: string): Feedback | null {
    const row = this.store.get("SELECT * FROM feedback WHERE id = ?", id);
    return row ? toFeedback(row) : null;
  }

  listFeedback(filter: { projectId?: string; taskId?: string; planId?: string; state?: Feedback["state"] } = {}): Feedback[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [["project_id", filter.projectId], ["task_id", filter.taskId], ["plan_id", filter.planId], ["state", filter.state]] as const) {
      if (value) { clauses.push(`${column} = ?`); params.push(value); }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.store.all(`SELECT * FROM feedback ${where} ORDER BY created_at DESC LIMIT 200`, ...params).map(toFeedback);
  }

  completeFeedbackForTask(taskId: string, response: string): number {
    const pending = this.store.all(
      "SELECT * FROM feedback WHERE linked_task_id = ? AND kind = 'question' AND state = 'pending'",
      taskId,
    ).map(toFeedback);
    return this.store.tx(() => {
      for (const feedback of pending) {
        this.store.run(
          "UPDATE feedback SET state = 'answered', response = ?, resolved_at = ? WHERE id = ?",
          response, nowIso(), feedback.id,
        );
        this.recordEvent({
          kind: "feedback.answered",
          projectId: feedback.projectId,
          taskId: feedback.taskId,
          data: { feedbackId: feedback.id, answeredBy: "linked-response-task", linkedTaskId: taskId },
        });
      }
      return pending.length;
    });
  }

  answerFeedback(id: string, response: string, answeredBy: string): Feedback {
    if (!response.trim()) throw new Error("A response is required");
    return this.store.tx(() => {
      const feedback = this.getFeedback(id);
      if (!feedback) throw new Error(`Unknown feedback ${id}`);
      if (feedback.kind !== "question" || feedback.state !== "pending") throw new Error(`Feedback ${id} is not a pending question`);
      const linked = feedback.linkedTaskId ? this.getTask(feedback.linkedTaskId) : null;
      if (linked && (linked.state === "QUEUED" || linked.state === "READY")) {
        this.transition(linked.id, "CANCELLED", { blocked_reason: "Question was answered before the response task started." });
      }
      this.store.run(
        "UPDATE feedback SET state = 'answered', response = ?, resolved_at = ? WHERE id = ?",
        response, nowIso(), id,
      );
      this.recordEvent({
        kind: "feedback.answered",
        projectId: feedback.projectId,
        taskId: feedback.taskId,
        data: { feedbackId: id, answeredBy },
      });
      return this.getFeedback(id) as Feedback;
    });
  }

  // --- provider capacity, fairness, routing, and context ------------------

  configureProvider(provider: string, maxConcurrency: number): ProviderCapacity {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`Provider ${provider} concurrency must be a positive integer`);
    }
    this.store.run(
      `INSERT INTO provider_capacity(provider, state, max_concurrency, updated_at)
       VALUES(?,'available',?,?)
       ON CONFLICT(provider) DO UPDATE SET max_concurrency = excluded.max_concurrency, updated_at = excluded.updated_at`,
      provider,
      maxConcurrency,
      nowIso(),
    );
    return this.getProviderCapacity(provider) as ProviderCapacity;
  }

  getProviderCapacity(provider: string, now = new Date()): ProviderCapacity | null {
    let row = this.store.get("SELECT * FROM provider_capacity WHERE provider = ?", provider);
    if (!row) return null;
    const capacity = toProviderCapacity(row);
    if (capacity.state === "cooldown" && capacity.blockedUntil && Date.parse(capacity.blockedUntil) <= now.getTime()) {
      this.store.run(
        "UPDATE provider_capacity SET state = 'available', blocked_until = NULL, reason = NULL, updated_at = ? WHERE provider = ?",
        now.toISOString(),
        provider,
      );
      this.recordEvent({ kind: "provider.available", data: { provider, reason: "cooldown expired" } });
      row = this.store.get("SELECT * FROM provider_capacity WHERE provider = ?", provider) as Row;
      return toProviderCapacity(row);
    }
    return capacity;
  }

  listProviderCapacity(now = new Date()): ProviderCapacity[] {
    const providers = this.store.all("SELECT provider FROM provider_capacity ORDER BY provider").map((row) => row.provider as string);
    return providers.map((provider) => this.getProviderCapacity(provider, now)).filter((item): item is ProviderCapacity => item !== null);
  }

  noteProviderFailure(provider: string, failure: FailureClass, reason: string, cooldownMs = 15 * 60_000): ProviderCapacity {
    const existing = this.getProviderCapacity(provider) ?? this.configureProvider(provider, 1);
    const state: ProviderCapacity["state"] = failure === "AUTH" ? "unavailable" : failure === "QUOTA" ? "cooldown" : existing.state;
    const blockedUntil = failure === "QUOTA" ? new Date(Date.now() + cooldownMs).toISOString() : null;
    this.store.tx(() => {
      this.store.run(
        `UPDATE provider_capacity SET state = ?, blocked_until = ?, reason = ?, error_count = error_count + 1,
           updated_at = ? WHERE provider = ?`,
        state,
        blockedUntil,
        reason,
        nowIso(),
        provider,
      );
      this.recordEvent({ kind: "provider.failure", data: { provider, failure, state, blockedUntil, reason } });
    });
    return this.getProviderCapacity(provider) as ProviderCapacity;
  }

  resetProvider(provider: string, reason = "operator reset"): ProviderCapacity {
    const existing = this.getProviderCapacity(provider);
    if (!existing) throw new Error(`Unknown provider ${provider}`);
    this.store.tx(() => {
      this.store.run(
        "UPDATE provider_capacity SET state = 'available', blocked_until = NULL, reason = NULL, updated_at = ? WHERE provider = ?",
        nowIso(),
        provider,
      );
      this.recordEvent({ kind: "provider.available", data: { provider, reason } });
    });
    return this.getProviderCapacity(provider) as ProviderCapacity;
  }

  markProjectDispatched(projectId: string): void {
    this.store.run(
      `INSERT INTO project_schedule(project_id, dispatch_count, last_dispatched_at) VALUES(?,1,?)
       ON CONFLICT(project_id) DO UPDATE SET dispatch_count = dispatch_count + 1,
         last_dispatched_at = excluded.last_dispatched_at`,
      projectId,
      nowIso(),
    );
  }

  projectSchedule(): Map<string, { dispatchCount: number; lastDispatchedAt: string | null }> {
    return new Map(this.store.all("SELECT * FROM project_schedule").map((row) => [
      row.project_id as string,
      { dispatchCount: Number(row.dispatch_count ?? 0), lastDispatchedAt: (row.last_dispatched_at as string) ?? null },
    ]));
  }

  recordRouting(input: {
    taskId: string;
    attemptId?: string | null;
    rule: string;
    reason: string;
    eligible: string[];
    chosen: string;
    model?: string | null;
    effort?: string | null;
  }): void {
    this.store.run(
      "INSERT INTO routing_decisions(id, task_id, attempt_id, rule, reason, eligible, chosen, model, effort, at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ids.event(),
      input.taskId,
      input.attemptId ?? null,
      input.rule,
      input.reason,
      toJson(input.eligible),
      input.chosen,
      input.model ?? null,
      input.effort ?? null,
      nowIso(),
    );
  }

  routingForTask(taskId: string): Row[] {
    return this.store.all("SELECT * FROM routing_decisions WHERE task_id = ? ORDER BY at ASC", taskId).map((row) => ({
      ...row,
      eligible: fromJson<string[]>(row.eligible, []),
    }));
  }

  recordCheckpoint(input: {
    taskId: string;
    attemptId?: string | null;
    kind: string;
    summary: string;
    baseRevision?: string | null;
    resultRevision?: string | null;
    changedFiles?: string[];
    findings?: string[];
    unresolved?: string[];
    nextAction?: string | null;
    evidence?: string[];
  }): TaskCheckpoint {
    const id = ids.checkpoint();
    const task = this.getTask(input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO task_checkpoints(id, task_id, attempt_id, kind, summary, base_revision, result_revision,
           changed_files, findings, unresolved, next_action, evidence, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.taskId, input.attemptId ?? null, input.kind, input.summary,
        input.baseRevision ?? null, input.resultRevision ?? null, toJson(input.changedFiles ?? []),
        toJson(input.findings ?? []), toJson(input.unresolved ?? []), input.nextAction ?? null,
        toJson(input.evidence ?? []), nowIso(),
      );
      this.recordEvent({
        kind: "task.checkpoint",
        projectId: task.projectId,
        taskId: task.id,
        attemptId: input.attemptId ?? null,
        data: { checkpointId: id, kind: input.kind, resultRevision: input.resultRevision ?? null, nextAction: input.nextAction ?? null },
      });
    });
    return toCheckpoint(this.store.get("SELECT * FROM task_checkpoints WHERE id = ?", id) as Row);
  }

  checkpointsForTask(taskId: string): TaskCheckpoint[] {
    return this.store.all("SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at", taskId).map(toCheckpoint);
  }

  latestCheckpoint(taskId: string): TaskCheckpoint | null {
    const row = this.store.get("SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", taskId);
    return row ? toCheckpoint(row) : null;
  }

  changedFilesForTask(taskId: string): string[] {
    const events = this.store.all(
      "SELECT data FROM events WHERE task_id = ? AND kind = 'task.state' ORDER BY rowid DESC",
      taskId,
    );
    for (const event of events) {
      const data = fromJson<{ changedFiles?: string[] }>(event.data, {});
      if (Array.isArray(data.changedFiles)) return data.changedFiles;
    }
    return [];
  }

  recordPacket(input: {
    id: string;
    taskId: string;
    attemptId?: string | null;
    requirementIds: string[];
    omitted: string[];
    files: string[];
    artifacts: string[];
    baseRevision: string | null;
    sourceWorkspace?: string | null;
    inspectedRevision?: string | null;
    configVersion?: string | null;
    provider?: string | null;
    checkpointId?: string | null;
    tokenEstimate: number | null;
    budgetTokens?: number | null;
    manifestPath: string | null;
    warnings: string[];
    fileDetails?: {
      path: string;
      reason: string;
      included: boolean;
      omissionReason?: string | null;
      sizeBytes?: number | null;
      estimatedTokens?: number | null;
      excerptTruncated?: boolean;
    }[];
  }): void {
    this.store.tx(() => {
      this.store.run(
      `INSERT INTO context_packets(id, task_id, attempt_id, requirement_ids, omitted, files, artifacts,
         base_revision, source_workspace, inspected_revision, config_version, provider, checkpoint_id,
         token_estimate, budget_tokens, manifest_path, warnings, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.taskId,
      input.attemptId ?? null,
      toJson(input.requirementIds),
      toJson(input.omitted),
      toJson(input.files),
      toJson(input.artifacts),
      input.baseRevision,
      input.sourceWorkspace ?? null,
      input.inspectedRevision ?? null,
      input.configVersion ?? null,
      input.provider ?? null,
      input.checkpointId ?? null,
      input.tokenEstimate,
      input.budgetTokens ?? null,
      input.manifestPath,
      toJson(input.warnings),
      nowIso(),
      );
      for (const file of input.fileDetails ?? []) {
        this.store.run(
          `INSERT INTO context_packet_files(packet_id, path, reason, included, omission_reason, size_bytes,
             estimated_tokens, excerpt_truncated) VALUES(?,?,?,?,?,?,?,?)`,
          input.id, file.path, file.reason, file.included ? 1 : 0, file.omissionReason ?? null,
          file.sizeBytes ?? null, file.estimatedTokens ?? null, file.excerptTruncated ? 1 : 0,
        );
      }
    });
  }

  getPacket(id: string): Row | undefined {
    return this.store.get("SELECT * FROM context_packets WHERE id = ?", id);
  }

  packetsForTask(taskId: string): Row[] {
    return this.store.all("SELECT * FROM context_packets WHERE task_id = ? ORDER BY created_at", taskId).map((row) => ({
      ...row,
      requirement_ids: fromJson<string[]>(row.requirement_ids, []),
      omitted: fromJson<string[]>(row.omitted, []),
      files: fromJson<string[]>(row.files, []),
      artifacts: fromJson<string[]>(row.artifacts, []),
      warnings: fromJson<string[]>(row.warnings, []),
      file_details: this.store.all(
        "SELECT * FROM context_packet_files WHERE packet_id = ? ORDER BY included DESC, path",
        row.id,
      ).map((file) => ({ ...file, included: Boolean(file.included), excerpt_truncated: Boolean(file.excerpt_truncated) })),
    }));
  }

  taskLatency(taskId: string): {
    planningMs: number | null;
    queueWaitMs: number | null;
    workerExecutionMs: number;
    checkingMs: number;
    reviewMs: number;
    approvalWaitMs: number;
    longestStage: string | null;
    longestStageReason: string | null;
  } {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const stateEvents = this.store.all(
      "SELECT at, data FROM events WHERE task_id = ? AND kind = 'task.state' ORDER BY rowid ASC",
      taskId,
    ).map((row) => ({ at: row.at as string, data: fromJson<{ to?: string }>(row.data, {}) }));
    const firstReady = stateEvents.find((event) => event.data.to === "READY");
    const queueWaitMs = firstReady ? Date.parse(firstReady.at) - Date.parse(task.createdAt) : null;
    const workerExecutionMs = this.listAttempts(taskId).reduce((total, attempt) => {
      const end = attempt.endedAt ? Date.parse(attempt.endedAt) : Date.now();
      return total + Math.max(0, end - Date.parse(attempt.startedAt));
    }, 0);
    const durationInState = (state: string) => stateEvents.reduce((total, event, index) => {
      if (event.data.to !== state) return total;
      const end = stateEvents[index + 1]?.at ?? task.updatedAt;
      return total + Math.max(0, Date.parse(end) - Date.parse(event.at));
    }, 0);
    const checkingMs = durationInState("CHECKING");
    const reviewMs = durationInState("REVIEWING");
    const approvalWaitMs = this.store.all("SELECT requested_at, decided_at FROM approvals WHERE task_id = ?", taskId)
      .reduce((total, row) => total + Math.max(0, Date.parse((row.decided_at as string | null) ?? new Date().toISOString()) - Date.parse(row.requested_at as string)), 0);
    const stages: [string, number][] = [
      ["queue_wait", queueWaitMs ?? 0],
      ["worker_execution", workerExecutionMs],
      ["checking", checkingMs],
      ["review", reviewMs],
      ["approval_wait", approvalWaitMs],
    ];
    const longest = stages.sort((a, b) => b[1] - a[1])[0];
    const longestStage = longest && longest[1] > 0 ? longest[0] : null;
    const reasons: Record<string, string> = {
      queue_wait: "Waiting for dependencies, project admission, execution locks, or worker/provider capacity.",
      worker_execution: "Subscription worker execution and attempt-boundary collection.",
      checking: "Registered deterministic quality gates.",
      review: "Independent review work.",
      approval_wait: "Human approval wait; not a model bottleneck.",
    };
    return {
      planningMs: null,
      queueWaitMs,
      workerExecutionMs,
      checkingMs,
      reviewMs,
      approvalWaitMs,
      longestStage,
      longestStageReason: longestStage ? reasons[longestStage] ?? null : null,
    };
  }

  // --- controller health --------------------------------------------------

  acquireControllerLease(controllerId: string, pid: number, staleAfterMs: number): boolean {
    return this.store.tx(() => {
      const row = this.store.get("SELECT * FROM controller_lease WHERE singleton = 1");
      const at = nowIso();
      if (!row) {
        this.store.run(
          "INSERT INTO controller_lease(singleton, controller_id, pid, acquired_at, heartbeat_at) VALUES(1,?,?,?,?)",
          controllerId,
          pid,
          at,
          at,
        );
        this.recordEvent({ kind: "controller.lease_acquired", data: { controllerId, pid } });
        return true;
      }
      if (row.controller_id === controllerId) {
        this.store.run("UPDATE controller_lease SET pid = ?, heartbeat_at = ? WHERE singleton = 1", pid, at);
        return true;
      }
      const heartbeat = Date.parse(row.heartbeat_at as string);
      if (Number.isFinite(heartbeat) && Date.now() - heartbeat <= staleAfterMs) return false;
      this.store.run(
        "UPDATE controller_lease SET controller_id = ?, pid = ?, acquired_at = ?, heartbeat_at = ? WHERE singleton = 1",
        controllerId,
        pid,
        at,
        at,
      );
      this.recordEvent({
        kind: "controller.lease_stolen",
        data: { controllerId, pid, previousControllerId: row.controller_id, previousPid: row.pid },
      });
      return true;
    });
  }

  releaseControllerLease(controllerId: string): void {
    this.store.tx(() => {
      const result = this.store.db.prepare("DELETE FROM controller_lease WHERE singleton = 1 AND controller_id = ?").run(controllerId);
      if (Number(result.changes) === 1) {
        this.recordEvent({ kind: "controller.lease_released", data: { controllerId } });
      }
    });
  }

  currentControllerLease(): Row | undefined {
    return this.store.get("SELECT * FROM controller_lease WHERE singleton = 1");
  }

  writeHealth(input: {
    id: string;
    pid: number;
    startedAt: string;
    loopDelayMs: number;
    dbErrors: number;
    queueDepth: number;
    oldestReadyAgeS: number;
    oldestClaimAgeS: number;
    activeWorkers: number;
    workerLimit: number;
    slotUtilization: number;
    uptimeS: number;
    providerStatus: Record<string, unknown>[];
    backpressureReason: string | null;
    staleHeartbeatWorkers?: number;
    state: "running" | "stopped" | "degraded";
  }): void {
    this.store.run(
      `INSERT INTO controller_health(id, pid, started_at, heartbeat_at, loop_delay_ms, db_errors, queue_depth,
         oldest_ready_age_s, oldest_claim_age_s, active_workers, worker_limit, slot_utilization, uptime_s,
         provider_status, backpressure_reason, stale_heartbeat_workers, state)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, loop_delay_ms = excluded.loop_delay_ms,
         db_errors = excluded.db_errors, queue_depth = excluded.queue_depth,
         oldest_ready_age_s = excluded.oldest_ready_age_s, oldest_claim_age_s = excluded.oldest_claim_age_s,
         active_workers = excluded.active_workers, worker_limit = excluded.worker_limit,
         slot_utilization = excluded.slot_utilization, uptime_s = excluded.uptime_s,
         provider_status = excluded.provider_status, backpressure_reason = excluded.backpressure_reason,
         stale_heartbeat_workers = excluded.stale_heartbeat_workers, state = excluded.state`,
      input.id,
      input.pid,
      input.startedAt,
      nowIso(),
      input.loopDelayMs,
      input.dbErrors,
      input.queueDepth,
      input.oldestReadyAgeS,
      input.oldestClaimAgeS,
      input.activeWorkers,
      input.workerLimit,
      input.slotUtilization,
      input.uptimeS,
      toJson(input.providerStatus),
      input.backpressureReason,
      input.staleHeartbeatWorkers ?? 0,
      input.state,
    );
  }

  staleHeartbeatAttempts(thresholdMs: number): { attemptId: string; taskId: string; projectId: string; ageMs: number }[] {
    const now = Date.now();
    return this.listRunningAttempts().flatMap((attempt) => {
      const reference = attempt.heartbeatAt ?? attempt.startedAt;
      const ageMs = reference ? now - Date.parse(reference) : Number.POSITIVE_INFINITY;
      if (ageMs < thresholdMs) return [];
      const task = this.getTask(attempt.taskId);
      return task ? [{ attemptId: attempt.id, taskId: attempt.taskId, projectId: task.projectId, ageMs: Math.round(ageMs) }] : [];
    });
  }

  latestHealth(): Row | undefined {
    return this.store.get("SELECT * FROM controller_health ORDER BY heartbeat_at DESC LIMIT 1");
  }

  operationalMetrics(): {
    controllerRestarts: number;
    providerErrors: number;
    invalidPlans: number;
    routingOverrides: number;
    repeatedReplans: number;
    reviewChangesRequested: number;
    pendingFeedback: number;
    curatorProposals: number;
    curatorRejected: number;
    configActivations: number;
    orchestratorState: "idle" | "active";
    lastDecisionDurationMs: number | null;
  } {
    const generations = this.store.get("SELECT COUNT(*) AS n FROM controller_health");
    const providerErrors = this.store.get("SELECT COALESCE(SUM(error_count), 0) AS n FROM provider_capacity");
    const countEvents = (kind: string) => Number(this.store.get("SELECT COUNT(*) AS n FROM events WHERE kind = ?", kind)?.n ?? 0);
    const decision = this.store.get("SELECT data FROM events WHERE kind = 'orchestrator.decision' ORDER BY rowid DESC LIMIT 1");
    const decisionData = decision ? fromJson<{ durationMs?: number }>(decision.data, {}) : {};
    return {
      controllerRestarts: Math.max(0, Number(generations?.n ?? 0) - 1),
      providerErrors: Number(providerErrors?.n ?? 0),
      invalidPlans: countEvents("plan.invalid"),
      routingOverrides: countEvents("routing.override"),
      repeatedReplans: countEvents("plan.replanned"),
      reviewChangesRequested: Number(this.store.get("SELECT COUNT(*) AS n FROM review_results WHERE verdict = 'request_changes'")?.n ?? 0),
      pendingFeedback: Number(this.store.get("SELECT COUNT(*) AS n FROM feedback WHERE state = 'pending'")?.n ?? 0),
      curatorProposals: Number(this.store.get("SELECT COUNT(*) AS n FROM curator_proposals")?.n ?? 0),
      curatorRejected: Number(this.store.get("SELECT COUNT(*) AS n FROM curator_proposals WHERE status = 'rejected'")?.n ?? 0),
      configActivations: Number(this.store.get("SELECT COUNT(*) AS n FROM config_activations")?.n ?? 0),
      orchestratorState: "idle",
      lastDecisionDurationMs: typeof decisionData.durationMs === "number" ? decisionData.durationMs : null,
    };
  }
}

export function openRecords(path?: string): Records {
  return new Records(new Store(path));
}
