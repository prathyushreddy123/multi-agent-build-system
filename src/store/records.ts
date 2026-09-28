import { createHash } from "node:crypto";

import { Store, nowIso, toJson, fromJson } from "./db.ts";
import type { ConfigActivation, CuratorEvaluation, CuratorProposal, EvaluationCase, EvaluationMetrics, ProposalStatus } from "../curator/types.ts";
import type { Row } from "./db.ts";
import { ids } from "../core/ids.ts";
import { DEFAULT_CONTROLLER_SETTINGS, DEFAULT_PROMPT_PROFILE, normalizeProjectConfig, projectConfigSnapshot, validateProjectConfig } from "../domain/config.ts";
import type { ProjectConfigSnapshot, ProjectControllerSettings, PromptProfile, RoutingOverrides } from "../domain/config.ts";
import { assertTransition } from "../domain/states.ts";
import type { TaskState } from "../domain/states.ts";
import { evaluate } from "../domain/policy.ts";
import type { Action, ApprovalBinding, ProjectApprovalPolicy } from "../domain/policy.ts";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_MODES,
  REVIEW_TRIGGERS,
  classifyFindings,
  describeReviewPolicy,
  evaluateReviewPolicy,
  normalizeReviewPolicy,
  reviewPolicyForGovernance,
  reviewPolicyNormalizationNotes,
  reviewPreset,
  weakensReview,
} from "../review/policy.ts";
import type { ReviewMode, ReviewPolicy, ReviewPreset, ReviewTrigger } from "../review/policy.ts";
import { QUALITY_COVERAGE_GATE } from "../gates/runner.ts";
import type { FailureClass, FailureDiagnosis } from "../core/failure.ts";
import { TASK_CLASSES } from "../routing/router.ts";
import type { Ambiguity, ChangeRisk, Complexity, TaskClass } from "../routing/router.ts";
import {
  assertGovernanceDecision,
  evaluateProjectReadiness,
  PROJECT_POLICY_VERSION,
  requireProjectReadiness,
  unresolvedGovernance,
} from "../domain/project-policy.ts";
import type {
  ProjectGovernance,
  ProjectPolicyDecision,
  ProjectReadiness,
  ProjectType,
  ReviewChoice,
} from "../domain/project-policy.ts";
import { EXECUTION_STAGES, OBLIGATION_KINDS, taskStateForStage } from "../domain/execution.ts";
import type {
  Continuation,
  EnvironmentCheck,
  ExecutionEpisode,
  ExecutionStage,
  ObligationState,
  StageRun,
  StageState,
  TaskObligation,
} from "../domain/execution.ts";
import { USAGE_COVERAGE, type UsageProjection } from "../usage/types.ts";
import type { Incident, IncidentOccurrence } from "../incidents/types.ts";
import type { AdmissionLease } from "../scheduling/types.ts";

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
  governance: ProjectGovernance;
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
  promptVersion: string | null;
  skillVersions: string[];
  startedAt: string;
  heartbeatAt: string | null;
  endedAt: string | null;
  stageRunId: string | null;
  parentAttemptId: string | null;
  parentSessionId: string | null;
  requestedModel: string | null;
  configuredModel: string | null;
  reportedModel: string | null;
  requestedEffort: string | null;
  configuredEffort: string | null;
  reportedEffort: string | null;
  engineVersion: string | null;
  cliVersion: string | null;
  lastProgressAt: string | null;
  usageStatus: string | null;
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
  stageRunId?: string | null;
  jobId?: string | null;
  environmentFingerprint?: string | null;
  commandFingerprint?: string | null;
  inputFingerprint?: string | null;
  rawExitStatus?: number | null;
  rawSignal?: string | null;
  timedOut?: boolean | null;
  failureDiagnosis?: FailureDiagnosis | null;
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
  /** Policy in force when the review ran, and the context it accepted. */
  policyVersion: string | null;
  contextFingerprint: string | null;
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
    // Stored v1 policies are migrated on read, so every consumer sees one shape.
    reviewPolicy: normalizeReviewPolicy(fromJson<unknown>(row.review_policy, DEFAULT_REVIEW_POLICY)),
    routingOverrides: fromJson<RoutingOverrides>(row.routing_overrides, {}),
    promptProfile: fromJson<PromptProfile>(row.prompt_profile, DEFAULT_PROMPT_PROFILE),
    controllerSettings: {
      ...DEFAULT_CONTROLLER_SETTINGS,
      ...fromJson<Partial<ProjectControllerSettings>>(row.controller_settings, {}),
    },
    checkCommands: fromJson<GateSpec[]>(row.check_commands, []),
    configVersion: row.config_version as string,
    goal: (row.goal as string) ?? null,
    governance: {
      ...unresolvedGovernance(),
      projectType: (row.project_type as ProjectType) ?? null,
      reviewChoice: (row.review_choice as ReviewChoice) ?? null,
      decisionState: row.governance_decision_id ? "confirmed" : "unresolved",
      decisionId: (row.governance_decision_id as string) ?? null,
      version: Number(row.governance_version ?? 0),
    },
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
    promptVersion: (row.prompt_version as string) ?? null,
    skillVersions: fromJson<string[]>(row.skill_versions, []),
    startedAt: row.started_at as string,
    heartbeatAt: (row.heartbeat_at as string) ?? null,
    endedAt: (row.ended_at as string) ?? null,
    stageRunId: (row.stage_run_id as string) ?? null,
    parentAttemptId: (row.parent_attempt_id as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    requestedModel: (row.requested_model as string) ?? null,
    configuredModel: (row.configured_model as string) ?? null,
    reportedModel: (row.reported_model as string) ?? null,
    requestedEffort: (row.requested_effort as string) ?? null,
    configuredEffort: (row.configured_effort as string) ?? null,
    reportedEffort: (row.reported_effort as string) ?? null,
    engineVersion: (row.engine_version as string) ?? null,
    cliVersion: (row.cli_version as string) ?? null,
    lastProgressAt: (row.last_progress_at as string) ?? null,
    usageStatus: (row.usage_status as string) ?? null,
  };
}

function toPolicyDecision(row: Row): ProjectPolicyDecision {
  return {
    id: row.id as string,
    projectId: (row.project_id as string) ?? null,
    briefId: (row.brief_id as string) ?? null,
    expectedVersion: Number(row.expected_version),
    projectType: row.project_type as ProjectType,
    reviewChoice: row.review_choice as ReviewChoice,
    resolvedPolicy: fromJson<Record<string, unknown>>(row.resolved_policy, {}),
    actor: row.actor as string,
    source: row.source as string,
    sourceRef: (row.source_ref as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function toEpisode(row: Row): ExecutionEpisode {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    episodeNumber: Number(row.episode_number),
    authorizingDecision: (row.authorizing_decision as string) ?? null,
    status: row.status as ExecutionEpisode["status"],
    repairLimit: Number(row.repair_limit),
    repairsConsumed: Number(row.repairs_consumed),
    recoveryLimit: Number(row.recovery_limit),
    recoveriesConsumed: Number(row.recoveries_consumed),
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
  };
}

function toStageRun(row: Row): StageRun {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    episodeId: row.episode_id as string,
    stage: row.stage as ExecutionStage,
    ordinal: Number(row.ordinal),
    state: row.state as StageState,
    attemptId: (row.attempt_id as string) ?? null,
    gateId: (row.gate_id as string) ?? null,
    launchKey: row.launch_key as string,
    inputFingerprint: row.input_fingerprint as string,
    revision: (row.revision as string) ?? null,
    environmentFingerprint: (row.environment_fingerprint as string) ?? null,
    engineRevision: row.engine_revision as string,
    fencingToken: row.fencing_token as string,
    reservedAt: row.reserved_at as string,
    startedAt: (row.started_at as string) ?? null,
    lastProgressAt: (row.last_progress_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null,
    failureClass: (row.failure_class as FailureClass) ?? null,
    failureDetail: (row.failure_detail as string) ?? null,
  };
}

function toObligation(row: Row): TaskObligation {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    kind: row.kind as TaskObligation["kind"],
    severity: row.severity as string,
    blocking: Number(row.blocking) === 1,
    sourceReviewId: (row.source_review_id as string) ?? null,
    sourceGateId: (row.source_gate_id as string) ?? null,
    sourceDecisionId: (row.source_decision_id as string) ?? null,
    sourceKey: row.source_key as string,
    state: row.state as ObligationState,
    summary: row.summary as string,
    introducedRevision: (row.introduced_revision as string) ?? null,
    resolvedRevision: (row.resolved_revision as string) ?? null,
    evidenceRefs: fromJson<string[]>(row.evidence_refs, []),
    resolutionEvidence: fromJson<string[]>(row.resolution_evidence, []),
    clarificationId: (row.clarification_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toUsageProjection(row: Row): UsageProjection {
  return {
    attemptId: row.attempt_id as string,
    normalizerVersion: row.normalizer_version as string,
    normalized: fromJson<UsageProjection["normalized"]>(row.normalized, {}),
    sourceArtifactHash: row.source_artifact_hash as string,
    sourceOffset: row.source_offset === null || row.source_offset === undefined ? null : Number(row.source_offset),
    coverage: row.coverage as UsageProjection["coverage"],
    sourceSemantics: row.source_semantics as string,
    updatedAt: row.updated_at as string,
  };
}

function toIncident(row: Row): Incident {
  return {
    id: row.id as string,
    signature: row.signature as string,
    classifierVersion: row.classifier_version as string,
    category: row.category as string,
    layer: row.layer as string,
    symptom: row.symptom as string,
    hypothesis: (row.hypothesis as string) ?? null,
    confirmedCause: (row.confirmed_cause as string) ?? null,
    confidence: row.confidence as Incident["confidence"],
    lifecycle: row.lifecycle as Incident["lifecycle"],
    affectedVersionStart: (row.affected_version_start as string) ?? null,
    affectedVersionEnd: (row.affected_version_end as string) ?? null,
    lessonRefs: fromJson<string[]>(row.lesson_refs, []),
    fixRefs: fromJson<string[]>(row.fix_refs, []),
    testRefs: fromJson<string[]>(row.test_refs, []),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toIncidentOccurrence(row: Row): IncidentOccurrence {
  return {
    id: row.id as string,
    incidentId: row.incident_id as string,
    sourceKey: row.source_key as string,
    taskId: (row.task_id as string) ?? null,
    stageRunId: (row.stage_run_id as string) ?? null,
    attemptId: (row.attempt_id as string) ?? null,
    revision: (row.revision as string) ?? null,
    evidenceRefs: fromJson<string[]>(row.evidence_refs, []),
    observedAt: row.observed_at as string,
  };
}

function toEnvironmentCheck(row: Row): EnvironmentCheck {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    stageRunId: (row.stage_run_id as string) ?? null,
    component: row.component as string,
    profile: row.profile as string,
    revision: (row.revision as string) ?? null,
    runtimeFingerprint: (row.runtime_fingerprint as string) ?? null,
    lockfileFingerprint: (row.lockfile_fingerprint as string) ?? null,
    outcome: row.outcome as EnvironmentCheck["outcome"],
    evidenceRefs: fromJson<string[]>(row.evidence_refs, []),
    setupActionRequired: (row.setup_action_required as string) ?? null,
    checkedAt: row.checked_at as string,
  };
}

function toAdmissionLease(row: Row): AdmissionLease {
  return {
    id: row.id as string,
    stageRunId: row.stage_run_id as string,
    controllerId: row.controller_id as string,
    fencingToken: row.fencing_token as string,
    provider: (row.provider as string) ?? null,
    quotaDomain: (row.quota_domain as string) ?? null,
    projectId: row.project_id as string,
    resources: fromJson<string[]>(row.resources, []),
    status: row.status as AdmissionLease["status"],
    grantedAt: row.granted_at as string,
    releasedAt: (row.released_at as string) ?? null,
    releaseReason: (row.release_reason as string) ?? null,
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
    policyVersion: (row.policy_version as string) ?? null,
    contextFingerprint: (row.context_fingerprint as string) ?? null,
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

export const REQUIREMENT_OWNERSHIP_VERSION = "mabs.requirement-ownership.v1";

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

/** Reject obviously invalid policy input instead of normalizing nonsense into a default. */
function assertReviewPolicyInput(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review policy must be an object");
  const candidate = input as Partial<ReviewPolicy> & { mode?: unknown };
  if (candidate.mode !== undefined && !REVIEW_MODES.includes(candidate.mode as ReviewMode)) {
    throw new Error(`Invalid review mode: ${String(candidate.mode)}`);
  }
  if (candidate.trigger !== undefined && !REVIEW_TRIGGERS.includes(candidate.trigger as ReviewTrigger)) {
    throw new Error(`Invalid review trigger: ${String(candidate.trigger)}`);
  }
  const skips = candidate.skipTaskClasses;
  if (skips !== undefined) {
    if (!Array.isArray(skips)) throw new Error("Review policy skipTaskClasses must be an array");
    const invalid = skips.filter((taskClass) => !TASK_CLASSES.includes(taskClass as TaskClass));
    if (invalid.length > 0) throw new Error(`Unknown review task classes: ${invalid.join(", ")}`);
  }
}

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
    stageRunId: (row.stage_run_id as string) ?? null,
    jobId: (row.job_id as string) ?? null,
    environmentFingerprint: (row.environment_fingerprint as string) ?? null,
    commandFingerprint: (row.command_fingerprint as string) ?? null,
    inputFingerprint: (row.input_fingerprint as string) ?? null,
    rawExitStatus: row.raw_exit_status === null || row.raw_exit_status === undefined ? null : Number(row.raw_exit_status),
    rawSignal: (row.raw_signal as string) ?? null,
    timedOut: row.timed_out === null || row.timed_out === undefined ? null : Number(row.timed_out) === 1,
    failureDiagnosis: fromJson<FailureDiagnosis | null>(row.failure_diagnosis, null),
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

  /**
   * A person asked for a review of this task and no review has run since.
   * This is how manual review stays available under an off or risk trigger.
   */
  hasOpenManualReviewRequest(taskId: string): boolean {
    const events = this.store.all(
      "SELECT kind FROM events WHERE task_id = ? AND kind IN ('review.requested','review.result') ORDER BY rowid DESC LIMIT 1",
      taskId,
    );
    return events[0]?.kind === "review.requested";
  }

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

  /** Every event of one kind for a task, oldest first and unbounded. */
  listEventsOfKind(taskId: string, kind: string): Row[] {
    return this.store.all("SELECT * FROM events WHERE task_id = ? AND kind = ? ORDER BY rowid ASC", taskId, kind);
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
    reviewPolicy?: Partial<ReviewPolicy>;
    routingOverrides?: RoutingOverrides;
    promptProfile?: PromptProfile;
    controllerSettings?: ProjectControllerSettings;
    routingProfile?: string;
    projectType?: ProjectType | null;
    reviewChoice?: ReviewChoice | null;
    governanceActor?: string;
    governanceSource?: string;
  }): Project {
    const resolvedReviewChoice = input.projectType === "client" && input.reviewChoice == null
      ? "required"
      : input.reviewChoice ?? null;
    if (input.projectType != null && resolvedReviewChoice != null) {
      assertGovernanceDecision(input.projectType, resolvedReviewChoice);
    }
    const requestedReviewPolicy = input.reviewPolicy ?? (
      input.projectType != null && resolvedReviewChoice != null
        ? reviewPolicyForGovernance(input.projectType, resolvedReviewChoice)
        : DEFAULT_REVIEW_POLICY
    );
    assertReviewPolicyInput(requestedReviewPolicy);
    const reviewPolicy = normalizeReviewPolicy(requestedReviewPolicy);
    if (input.projectType != null && resolvedReviewChoice != null) {
      const provisional = {
        ...unresolvedGovernance(),
        projectType: input.projectType,
        reviewChoice: resolvedReviewChoice,
        decisionState: "confirmed" as const,
        decisionId: "pending",
        version: 1,
      };
      const conflicts = evaluateProjectReadiness(provisional, reviewPolicy).conflicts;
      if (conflicts.length > 0) throw new Error(`Review policy conflicts with project governance: ${conflicts.join("; ")}`);
    }
    const normalizationNotes = reviewPolicyNormalizationNotes(requestedReviewPolicy, reviewPolicy);
    const id = ids.project();
    const at = nowIso();
    const configVersion = ids.config();
    return this.store.tx(() => {
      this.store.run(
        `INSERT INTO projects(id, name, repo_path, base_branch, status, routing_profile, approval_policy,
           review_policy, routing_overrides, prompt_profile, controller_settings, check_commands,
           config_version, goal, project_type, review_choice, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input.projectType ?? null,
        resolvedReviewChoice,
        at,
        at,
      );
      const project = this.getProject(id) as Project;
      const initialConfig = projectConfigSnapshot(project);
      this.store.run(
        `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, active, created_at)
         VALUES(?,?,NULL,'project-registration','snapshot',?,1,?)`,
        configVersion, id, toJson(initialConfig), at,
      );
      this.recordEvent({ kind: "project.registered", projectId: id, data: { name: input.name, repoPath: input.repoPath, reviewPolicy } });
      if (normalizationNotes.length > 0) {
        this.recordEvent({ kind: "project.review_policy_normalized", projectId: id, data: { requested: requestedReviewPolicy, stored: reviewPolicy, notes: normalizationNotes } });
      }
      if (input.projectType != null && resolvedReviewChoice != null) {
        this.recordProjectDecision({
          projectId: id,
          projectType: input.projectType,
          reviewChoice: resolvedReviewChoice,
          actor: input.governanceActor ?? "project-registration",
          source: input.governanceSource ?? "project-registration",
        }, 0);
        return this.getProject(id) as Project;
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
    const payload = projectConfigSnapshot(project);
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

  /**
   * Review policy is a user decision: it is versioned, logged, and a change
   * that weakens review has to be acknowledged explicitly rather than applied
   * because something else in the configuration moved.
   */
  setProjectReviewPolicy(id: string, requested: Partial<ReviewPolicy>, options: {
    reason?: string;
    acknowledgeWeakening?: boolean;
    changedBy?: string;
  } = {}): string {
    assertReviewPolicyInput(requested);
    const current = this.getProject(id);
    if (!current) throw new Error(`Unknown project ${id}`);
    const policy = normalizeReviewPolicy(requested);
    if (current.governance.decisionState === "confirmed") {
      const conflicts = evaluateProjectReadiness(current.governance, policy).conflicts;
      if (conflicts.length > 0) {
        throw new Error(
          `Review policy conflicts with recorded project governance: ${conflicts.join("; ")}. ` +
          "Record a new governance decision instead of bypassing it through review settings.",
        );
      }
    }
    const notes = reviewPolicyNormalizationNotes(requested, policy);
    const weakened = weakensReview(current.reviewPolicy, policy);
    if (weakened.length > 0 && !options.acknowledgeWeakening) {
      throw new Error(
        `Refusing to weaken review for ${current.name} without an explicit decision: ${weakened.join("; ")}. ` +
        "Re-run with an acknowledged weakening and a reason.",
      );
    }
    const parentId = current.configVersion;
    const configVersion = ids.config();
    this.store.tx(() => {
      this.store.run(
        "UPDATE projects SET review_policy = ?, config_version = ?, updated_at = ? WHERE id = ?",
        toJson(policy), configVersion, nowIso(), id,
      );
      this.invalidateProjectApprovals(id, "Review policy changed.");
      this.recordCurrentProjectConfig(id, configVersion, "review-policy-change", parentId);
      this.recordEvent({
        kind: "project.review_policy_updated",
        projectId: id,
        data: {
          configVersion, policy, notes, weakened,
          from: describeReviewPolicy(current.reviewPolicy),
          to: describeReviewPolicy(policy),
          reason: options.reason ?? null,
          changedBy: options.changedBy ?? "local-cli",
        },
      });
    });
    return configVersion;
  }

  setProjectReviewPreset(id: string, preset: Exclude<ReviewPreset, "custom">, options: {
    reason?: string;
    acknowledgeWeakening?: boolean;
    changedBy?: string;
  } = {}): string {
    return this.setProjectReviewPolicy(id, reviewPreset(preset), options);
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

  // --- governance --------------------------------------------------------

  readProjectReadiness(subject: { projectId: string } | { briefId: string } | string): ProjectReadiness {
    if (typeof subject === "string" || "projectId" in subject) {
      const projectId = typeof subject === "string" ? subject : subject.projectId;
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Unknown project ${projectId}`);
      return evaluateProjectReadiness(project.governance, project.reviewPolicy);
    }
    const row = this.store.get(
      "SELECT project_type, review_choice, governance_decision_id, governance_version FROM product_briefs WHERE id = ?",
      subject.briefId,
    );
    if (!row) throw new Error(`Unknown brief ${subject.briefId}`);
    return evaluateProjectReadiness({
      ...unresolvedGovernance(),
      projectType: (row.project_type as ProjectType) ?? null,
      reviewChoice: (row.review_choice as ReviewChoice) ?? null,
      decisionState: row.governance_decision_id ? "confirmed" : "unresolved",
      decisionId: (row.governance_decision_id as string) ?? null,
      version: Number(row.governance_version ?? 0),
    });
  }

  /** Record at most one controller-visible needs-input event per governance version. */
  recordGovernanceNeedsInput(projectId: string, taskId?: string): ProjectReadiness {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    const readiness = evaluateProjectReadiness(project.governance, project.reviewPolicy);
    if (readiness.ready) return readiness;
    const duplicate = this.store.get(
      `SELECT id FROM events WHERE project_id = ? AND kind = 'governance.needs_input'
       AND json_extract(data, '$.governanceVersion') = ? LIMIT 1`,
      project.id, project.governance.version,
    );
    if (!duplicate) {
      this.recordEvent({
        kind: "governance.needs_input",
        projectId: project.id,
        taskId: taskId ?? null,
        data: {
          outcome: "needs_input",
          subject: { kind: "project", id: project.id },
          policyVersion: PROJECT_POLICY_VERSION,
          governanceVersion: project.governance.version,
          ...readiness,
        },
      });
    }
    return readiness;
  }

  recordProjectDecision(input: {
    projectId?: string;
    briefId?: string;
    projectType: ProjectType;
    reviewChoice: ReviewChoice;
    resolvedPolicy?: Record<string, unknown>;
    actor: string;
    source: string;
    sourceRef?: string | null;
  }, expectedVersion: number): ProjectPolicyDecision {
    if ((input.projectId ? 1 : 0) + (input.briefId ? 1 : 0) !== 1) {
      throw new Error("A governance decision requires exactly one project or brief subject.");
    }
    assertGovernanceDecision(input.projectType, input.reviewChoice);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("Expected governance version must be a non-negative integer.");
    if (!input.actor.trim() || !input.source.trim()) throw new Error("A governance decision requires actor and source provenance.");
    const id = ids.policyDecision();
    const at = nowIso();
    return this.store.tx(() => {
      const table = input.projectId ? "projects" : "product_briefs";
      const subjectId = input.projectId ?? input.briefId as string;
      const current = this.store.get(`SELECT project_type, review_choice, governance_version FROM ${table} WHERE id = ?`, subjectId);
      if (!current) throw new Error(`Unknown ${input.projectId ? "project" : "brief"} ${subjectId}`);
      const currentVersion = Number(current.governance_version ?? 0);
      if (currentVersion !== expectedVersion) {
        throw new Error(`Governance changed since version ${expectedVersion}; current version is ${currentVersion}.`);
      }
      if (input.projectId && current.project_type === "client" && input.projectType !== "client") {
        const nonPeople = new Set(["agent", "assistant", "model", "system", "curator", "optimizer", "controller"]);
        if (nonPeople.has(input.actor.trim().toLowerCase())) {
          throw new Error("Only an explicit human decision may reclassify a client project; automation cannot relabel it to weaken review.");
        }
      }
      const nextVersion = expectedVersion + 1;
      const currentProject = input.projectId ? this.getProject(input.projectId) as Project : null;
      const decidedGovernance: ProjectGovernance | null = currentProject ? {
        ...currentProject.governance,
        projectType: input.projectType,
        reviewChoice: input.reviewChoice,
        decisionState: "confirmed",
        decisionId: id,
        version: nextVersion,
      } : null;
      // Governance fixes the review trigger but does not erase compatible,
      // explicitly configured scope, routing, risk rules, or capacity
      // behavior. A conflicting policy is replaced with the safe canonical
      // policy for the new decision, so review-off can never survive a
      // client/required classification.
      const projectReviewPolicy = currentProject && decidedGovernance &&
          evaluateProjectReadiness(decidedGovernance, currentProject.reviewPolicy).conflicts.length === 0
        ? currentProject.reviewPolicy
        : reviewPolicyForGovernance(input.projectType, input.reviewChoice);
      const resolvedPolicy = input.resolvedPolicy ?? {
        policyVersion: PROJECT_POLICY_VERSION,
        projectType: input.projectType,
        reviewChoice: input.reviewChoice,
        reviewPolicy: projectReviewPolicy,
      };
      this.store.run(
        `INSERT INTO project_policy_decisions(
           id, project_id, brief_id, expected_version, project_type, review_choice,
           resolved_policy, actor, source, source_ref, created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.projectId ?? null, input.briefId ?? null, expectedVersion,
        input.projectType, input.reviewChoice, toJson(resolvedPolicy), input.actor, input.source,
        input.sourceRef ?? null, at,
      );
      const result = this.store.db.prepare(
        `UPDATE ${table} SET project_type = ?, review_choice = ?, governance_decision_id = ?,
           governance_version = ?, updated_at = ? WHERE id = ? AND governance_version = ?`,
      ).run(input.projectType, input.reviewChoice, id, nextVersion, at, subjectId, expectedVersion);
      if (Number(result.changes) !== 1) throw new Error(`Concurrent governance update for ${subjectId}.`);

      let configVersion: string | null = null;
      if (input.projectId) {
        const project = this.getProject(input.projectId) as Project;
        const parentId = project.configVersion;
        configVersion = ids.config();
        this.store.run(
          "UPDATE projects SET review_policy = ?, config_version = ? WHERE id = ?",
          toJson(projectReviewPolicy), configVersion, input.projectId,
        );
        this.invalidateProjectApprovals(input.projectId, "Project governance changed.");
        this.recordCurrentProjectConfig(input.projectId, configVersion, "governance-decision", parentId);
      } else if (input.briefId) {
        const reason = `Brief governance changed to version ${nextVersion}; a fresh acceptance is required.`;
        const active = this.store.all(
          "SELECT id, proposal_id FROM acceptance_bindings WHERE brief_id = ? AND state = 'active'",
          input.briefId,
        );
        for (const binding of active) {
          this.store.run(
            "UPDATE acceptance_bindings SET state = 'invalidated', invalidated_reason = ? WHERE id = ?",
            reason, binding.id,
          );
          this.store.run("UPDATE proposal_versions SET state = 'invalidated' WHERE id = ?", binding.proposal_id);
        }
      }
      this.recordEvent({
        kind: "governance.decision_recorded",
        projectId: input.projectId ?? null,
        data: {
          briefId: input.briefId ?? null, decisionId: id, expectedVersion, version: nextVersion,
          projectType: input.projectType, reviewChoice: input.reviewChoice, policyVersion: PROJECT_POLICY_VERSION,
          configVersion,
        },
      });
      return toPolicyDecision(this.store.get("SELECT * FROM project_policy_decisions WHERE id = ?", id) as Row);
    });
  }

  getProjectDecision(id: string): ProjectPolicyDecision | null {
    const row = this.store.get("SELECT * FROM project_policy_decisions WHERE id = ?", id);
    return row ? toPolicyDecision(row) : null;
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
    /** Requirement IDs this task is accountable for; absent means legacy broad coverage. */
    ownedRequirements?: string[];
  }): Task {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Unknown project ${input.projectId}`);
    requireProjectReadiness({ kind: "project", id: project.id }, project.governance, project.reviewPolicy);
    const id = ids.task();
    const at = nowIso();
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    const defaultRepairLimit = project.controllerSettings.defaultRepairLimit;
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
      if (input.ownedRequirements !== undefined) {
        const known = new Set(this.listRequirements(input.projectId).map((requirement) => requirement.id));
        const unknown = input.ownedRequirements.filter((requirement) => !known.has(requirement));
        if (unknown.length > 0) throw new Error(`Task owns unknown requirement(s): ${unknown.join(", ")}`);
        for (const requirement of new Set(input.ownedRequirements)) {
          this.store.run(
            `INSERT INTO task_requirement_ownership(task_id, requirement_id, mapping_version, source, created_at)
             VALUES(?,?,?,?,?)`,
            id, requirement, REQUIREMENT_OWNERSHIP_VERSION, "task", at,
          );
        }
        // Also marks an explicitly empty set, which differs from "unknown".
        this.recordEvent({
          kind: "task.requirement_ownership", projectId: input.projectId, taskId: id,
          data: { requirementIds: [...new Set(input.ownedRequirements)], mappingVersion: REQUIREMENT_OWNERSHIP_VERSION },
        });
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

  // --- durable execution -------------------------------------------------

  createExecutionEpisode(input: {
    taskId: string;
    expectedTaskVersion: number;
    authorizingDecision?: string | null;
    repairLimit?: number;
    recoveryLimit?: number;
  }): ExecutionEpisode {
    const id = ids.episode();
    return this.store.tx(() => {
      const task = this.getTask(input.taskId);
      if (!task) throw new Error(`Unknown task ${input.taskId}`);
      if (task.recordVersion !== input.expectedTaskVersion) {
        throw new Error(`Task ${task.id} changed since version ${input.expectedTaskVersion}; current version is ${task.recordVersion}`);
      }
      if (["DONE", "CANCELLED"].includes(task.state)) {
        throw new Error(`Task ${task.id} is ${task.state}; completed work cannot be reopened by creating an episode.`);
      }
      if (this.store.get("SELECT id FROM execution_episodes WHERE task_id = ? AND status = 'active'", task.id)) {
        throw new Error(`Task ${task.id} already has an active execution episode.`);
      }
      const next = Number(this.store.get("SELECT COALESCE(MAX(episode_number), 0) + 1 AS n FROM execution_episodes WHERE task_id = ?", task.id)?.n ?? 1);
      const repairLimit = input.repairLimit ?? task.repairLimit;
      const recoveryLimit = input.recoveryLimit ?? 2;
      if (!Number.isSafeInteger(repairLimit) || repairLimit < 0 || !Number.isSafeInteger(recoveryLimit) || recoveryLimit < 0) {
        throw new Error("Episode retry limits must be non-negative integers.");
      }
      const at = nowIso();
      this.store.run(
        `INSERT INTO execution_episodes(
           id, task_id, episode_number, authorizing_decision, status, repair_limit, recovery_limit, started_at
         ) VALUES(?,?,?,?,'active',?,?,?)`,
        id, task.id, next, input.authorizingDecision ?? null, repairLimit, recoveryLimit, at,
      );
      const updated = this.store.db.prepare(
        "UPDATE tasks SET record_version = record_version + 1, updated_at = ? WHERE id = ? AND record_version = ?",
      ).run(at, task.id, input.expectedTaskVersion);
      if (Number(updated.changes) !== 1) throw new Error(`Concurrent task update for ${task.id}.`);
      this.recordEvent({
        kind: "execution.episode_started", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, episodeId: id, episodeNumber: next, repairLimit, recoveryLimit },
      });
      return toEpisode(this.store.get("SELECT * FROM execution_episodes WHERE id = ?", id) as Row);
    });
  }

  getContinuation(taskId: string): Continuation {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const episodeRow = this.store.get(
      "SELECT * FROM execution_episodes WHERE task_id = ? ORDER BY (status = 'active') DESC, episode_number DESC LIMIT 1",
      taskId,
    );
    const stageRow = episodeRow ? this.store.get(
      `SELECT * FROM stage_runs WHERE episode_id = ?
       ORDER BY CASE WHEN state IN ('reserved','launching','running','waiting','unknown') THEN 0 ELSE 1 END, ordinal DESC, rowid DESC LIMIT 1`,
      episodeRow.id,
    ) : undefined;
    return {
      taskId,
      taskState: task.state,
      taskVersion: task.recordVersion,
      episode: episodeRow ? toEpisode(episodeRow) : null,
      currentStage: stageRow ? toStageRun(stageRow) : null,
      openObligations: this.store.all(
        "SELECT * FROM task_obligations WHERE task_id = ? AND state IN ('open','addressed_pending_validation') ORDER BY created_at, rowid",
        taskId,
      ).map(toObligation),
    };
  }

  reserveStage(input: {
    taskId: string;
    episodeId: string;
    stage: ExecutionStage;
    ordinal: number;
    launchKey: string;
    inputFingerprint: string;
    revision?: string | null;
    environmentFingerprint?: string | null;
    engineRevision: string;
    expectedTaskVersion: number;
    fencingToken?: string;
    /** A provider reroute of an already-reserved repair keeps its allocation. */
    consumeRepair?: boolean;
    /** An explicitly retried operational stage consumes the separate recovery budget. */
    consumeRecovery?: boolean;
  }): StageRun {
    if (!EXECUTION_STAGES.includes(input.stage)) throw new Error(`Unknown execution stage: ${input.stage}`);
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) throw new Error("Stage ordinal must be a positive integer.");
    if (!input.launchKey.trim() || !input.inputFingerprint.trim() || !input.engineRevision.trim()) {
      throw new Error("Stage reservation requires launch, input, and engine provenance.");
    }
    const id = ids.stage();
    const fencingToken = input.fencingToken ?? ids.launch();
    return this.store.tx(() => {
      const task = this.getTask(input.taskId);
      if (!task) throw new Error(`Unknown task ${input.taskId}`);
      if (task.recordVersion !== input.expectedTaskVersion) {
        throw new Error(`Task ${task.id} changed since version ${input.expectedTaskVersion}; current version is ${task.recordVersion}`);
      }
      if (["DONE", "CANCELLED"].includes(task.state)) throw new Error(`Task ${task.id} is ${task.state}; no stage can be reserved.`);
      const episode = this.store.get("SELECT * FROM execution_episodes WHERE id = ? AND task_id = ?", input.episodeId, task.id);
      if (!episode || episode.status !== "active") throw new Error(`Execution episode ${input.episodeId} is not active for task ${task.id}.`);
      if (input.stage === "repair" && input.consumeRepair !== false) {
        if (Number(episode.repairs_consumed) >= Number(episode.repair_limit)) throw new Error(`Repair limit reached for episode ${input.episodeId}.`);
        this.store.run("UPDATE execution_episodes SET repairs_consumed = repairs_consumed + 1 WHERE id = ?", input.episodeId);
      }
      if (input.consumeRecovery === true) {
        if (Number(episode.recoveries_consumed) >= Number(episode.recovery_limit)) throw new Error(`Recovery limit reached for episode ${input.episodeId}.`);
        this.store.run("UPDATE execution_episodes SET recoveries_consumed = recoveries_consumed + 1 WHERE id = ?", input.episodeId);
      }
      const taskState = taskStateForStage(input.stage);
      if (task.state !== taskState) assertTransition(task.state, taskState);
      const at = nowIso();
      this.store.run(
        `INSERT INTO stage_runs(
           id, task_id, episode_id, stage, ordinal, state, launch_key, input_fingerprint,
           revision, environment_fingerprint, engine_revision, fencing_token, reserved_at
         ) VALUES(?,?,?,?,?,'reserved',?,?,?,?,?,?,?)`,
        id, task.id, input.episodeId, input.stage, input.ordinal, input.launchKey, input.inputFingerprint,
        input.revision ?? null, input.environmentFingerprint ?? null, input.engineRevision, fencingToken, at,
      );
      const updated = this.store.db.prepare(
        "UPDATE tasks SET state = ?, record_version = record_version + 1, updated_at = ? WHERE id = ? AND record_version = ?",
      ).run(taskState, at, task.id, input.expectedTaskVersion);
      if (Number(updated.changes) !== 1) throw new Error(`Concurrent task update for ${task.id}.`);
      this.recordEvent({
        kind: "stage.reserved", projectId: task.projectId, taskId: task.id,
        data: {
          schemaVersion: 1,
          stageRunId: id,
          episodeId: input.episodeId,
          stage: input.stage,
          ordinal: input.ordinal,
          launchKey: input.launchKey,
          repairConsumed: input.stage === "repair" && input.consumeRepair !== false,
          recoveryConsumed: input.consumeRecovery === true,
        },
      });
      return toStageRun(this.store.get("SELECT * FROM stage_runs WHERE id = ?", id) as Row);
    });
  }

  getStageRun(stageId: string): StageRun | null {
    const row = this.store.get("SELECT * FROM stage_runs WHERE id = ?", stageId);
    return row ? toStageRun(row) : null;
  }

  stageRunsForTask(taskId: string): StageRun[] {
    return this.store.all("SELECT * FROM stage_runs WHERE task_id = ? ORDER BY ordinal, rowid", taskId).map(toStageRun);
  }

  listActiveStageRuns(): StageRun[] {
    return this.store.all(
      "SELECT * FROM stage_runs WHERE state IN ('reserved','launching','running','waiting','unknown') ORDER BY reserved_at, rowid",
    ).map(toStageRun);
  }

  stageByLaunchKey(launchKey: string): StageRun | null {
    const row = this.store.get("SELECT * FROM stage_runs WHERE launch_key = ?", launchKey);
    return row ? toStageRun(row) : null;
  }

  admissionForStage(stageRunId: string): AdmissionLease | null {
    const row = this.store.get("SELECT * FROM admission_leases WHERE stage_run_id = ?", stageRunId);
    return row ? toAdmissionLease(row) : null;
  }

  /** Charge an operational recovery independently from the code-repair budget. */
  consumeRecovery(episodeId: string, stageRunId: string, reason: string): ExecutionEpisode {
    return this.store.tx(() => {
      const episode = this.store.get("SELECT * FROM execution_episodes WHERE id = ?", episodeId);
      if (!episode) throw new Error(`Unknown execution episode ${episodeId}`);
      if (episode.status !== "active") throw new Error(`Execution episode ${episodeId} is ${String(episode.status)}.`);
      if (Number(episode.recoveries_consumed) >= Number(episode.recovery_limit)) {
        throw new Error(`Recovery limit reached for episode ${episodeId}.`);
      }
      this.store.run("UPDATE execution_episodes SET recoveries_consumed = recoveries_consumed + 1 WHERE id = ?", episodeId);
      const stage = this.getStageRun(stageRunId);
      const task = stage ? this.getTask(stage.taskId) : null;
      this.recordEvent({
        kind: "execution.recovery_consumed", projectId: task?.projectId ?? null, taskId: task?.id ?? null,
        data: { schemaVersion: 1, episodeId, stageRunId, reason },
      });
      return toEpisode(this.store.get("SELECT * FROM execution_episodes WHERE id = ?", episodeId) as Row);
    });
  }

  recordLaunchStarted(stageId: string, fencingToken: string, handle: {
    attemptId?: string | null;
    gateId?: string | null;
  } = {}): StageRun {
    return this.store.tx(() => {
      const stage = this.store.get("SELECT * FROM stage_runs WHERE id = ?", stageId);
      if (!stage) throw new Error(`Unknown stage ${stageId}`);
      if (stage.fencing_token !== fencingToken) throw new Error(`Stale fencing token for stage ${stageId}.`);
      if (stage.state !== "reserved" && stage.state !== "launching") {
        throw new Error(`Stage ${stageId} is ${String(stage.state)}; launch has already been claimed or finished.`);
      }
      const at = nowIso();
      const updated = this.store.db.prepare(
        `UPDATE stage_runs SET state = 'running', attempt_id = ?, gate_id = ?,
           started_at = COALESCE(started_at, ?), last_progress_at = ?
         WHERE id = ? AND fencing_token = ? AND state IN ('reserved','launching')`,
      ).run(handle.attemptId ?? null, handle.gateId ?? null, at, at, stageId, fencingToken);
      if (Number(updated.changes) !== 1) throw new Error(`Stage ${stageId} launch was fenced by another owner.`);
      const task = this.getTask(stage.task_id as string) as Task;
      this.store.run("UPDATE tasks SET record_version = record_version + 1, updated_at = ? WHERE id = ?", at, task.id);
      this.recordEvent({
        kind: "stage.launch_started", projectId: task.projectId, taskId: task.id,
        attemptId: handle.attemptId ?? null,
        data: { schemaVersion: 1, stageRunId: stageId, gateId: handle.gateId ?? null },
      });
      return toStageRun(this.store.get("SELECT * FROM stage_runs WHERE id = ?", stageId) as Row);
    });
  }

  finishStage(stageId: string, fencingToken: string, outcome: {
    state: Extract<StageState, "succeeded" | "failed" | "waiting" | "cancelled" | "unknown">;
    failureClass?: FailureClass | null;
    failureDetail?: string | null;
    taskState?: TaskState;
  }): StageRun {
    return this.store.tx(() => {
      const stage = this.store.get("SELECT * FROM stage_runs WHERE id = ?", stageId);
      if (!stage) throw new Error(`Unknown stage ${stageId}`);
      if (stage.fencing_token !== fencingToken) throw new Error(`Stale fencing token for stage ${stageId}.`);
      if (!["reserved", "launching", "running", "waiting", "unknown"].includes(String(stage.state))) {
        throw new Error(`Stage ${stageId} is already terminal (${String(stage.state)}).`);
      }
      const task = this.getTask(stage.task_id as string) as Task;
      let nextTaskState = outcome.taskState ?? task.state;
      if (outcome.taskState === undefined) {
        if (outcome.state === "cancelled") nextTaskState = "CANCELLED";
        else if (["failed", "waiting", "unknown"].includes(outcome.state)) nextTaskState = "BLOCKED";
        else if (stage.stage === "accept") nextTaskState = "DONE";
      }
      if (task.state !== nextTaskState) assertTransition(task.state, nextTaskState);
      const at = nowIso();
      const updated = this.store.db.prepare(
        `UPDATE stage_runs SET state = ?, failure_class = ?, failure_detail = ?,
           last_progress_at = ?, finished_at = ?
         WHERE id = ? AND fencing_token = ? AND state IN ('reserved','launching','running','waiting','unknown')`,
      ).run(outcome.state, outcome.failureClass ?? null, outcome.failureDetail ?? null, at, at, stageId, fencingToken);
      if (Number(updated.changes) !== 1) throw new Error(`Stage ${stageId} completion was fenced by another owner.`);
      this.store.run(
        `UPDATE tasks SET state = ?, record_version = record_version + 1, updated_at = ?,
           blocked_reason = ?, failure_class = ?, claimed_by = ?, claimed_at = ? WHERE id = ?`,
        nextTaskState,
        at,
        nextTaskState === "BLOCKED" ? outcome.failureDetail ?? null : null,
        nextTaskState === "BLOCKED" ? outcome.failureClass ?? task.failureClass : task.failureClass,
        nextTaskState === "BLOCKED" ? null : task.claimedBy,
        nextTaskState === "BLOCKED" ? null : task.claimedAt,
        task.id,
      );
      if (stage.stage === "accept" && outcome.state === "succeeded") {
        this.store.run("UPDATE execution_episodes SET status = 'completed', ended_at = ? WHERE id = ?", at, stage.episode_id);
      } else if (outcome.state === "cancelled") {
        this.store.run("UPDATE execution_episodes SET status = 'cancelled', ended_at = ? WHERE id = ?", at, stage.episode_id);
      }
      this.recordEvent({
        kind: "stage.finished", projectId: task.projectId, taskId: task.id,
        attemptId: (stage.attempt_id as string) ?? null,
        data: { schemaVersion: 1, stageRunId: stageId, stage: stage.stage, state: outcome.state, taskState: nextTaskState, failureClass: outcome.failureClass ?? null },
      });
      return toStageRun(this.store.get("SELECT * FROM stage_runs WHERE id = ?", stageId) as Row);
    });
  }

  recordObligation(input: {
    taskId: string;
    kind: TaskObligation["kind"];
    severity: string;
    blocking: boolean;
    sourceKey: string;
    summary: string;
    sourceReviewId?: string | null;
    sourceGateId?: string | null;
    sourceDecisionId?: string | null;
    introducedRevision?: string | null;
    evidenceRefs?: string[];
    clarificationId?: string | null;
  }): TaskObligation {
    if (!OBLIGATION_KINDS.includes(input.kind)) throw new Error(`Unknown obligation kind: ${input.kind}`);
    if (!input.sourceKey.trim() || !input.summary.trim() || !input.severity.trim()) throw new Error("An obligation requires a stable source key, severity, and summary.");
    const task = this.getTask(input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    const id = ids.obligation();
    const at = nowIso();
    return this.store.tx(() => {
      this.store.run(
        `INSERT INTO task_obligations(
           id, task_id, kind, severity, blocking, source_review_id, source_gate_id, source_decision_id,
           source_key, state, summary, introduced_revision, evidence_refs, clarification_id, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?)`,
        id, input.taskId, input.kind, input.severity, input.blocking ? 1 : 0,
        input.sourceReviewId ?? null, input.sourceGateId ?? null, input.sourceDecisionId ?? null,
        input.sourceKey, input.summary, input.introducedRevision ?? null, toJson(input.evidenceRefs ?? []),
        input.clarificationId ?? null, at, at,
      );
      this.recordEvent({
        kind: "obligation.recorded", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, obligationId: id, kind: input.kind, sourceKey: input.sourceKey, blocking: input.blocking },
      });
      return toObligation(this.store.get("SELECT * FROM task_obligations WHERE id = ?", id) as Row);
    });
  }

  /**
   * The requirement IDs a task is accountable for, or null when no mapping was
   * recorded. Null is "legacy broad coverage", never an empty ownership set.
   */
  requirementOwnership(taskId: string): { requirementIds: string[]; mappingVersion: string } | null {
    const rows = this.store.all(
      "SELECT requirement_id, mapping_version FROM task_requirement_ownership WHERE task_id = ? AND mapping_version = ? ORDER BY requirement_id",
      taskId, REQUIREMENT_OWNERSHIP_VERSION,
    );
    if (rows.length === 0) {
      const marker = this.store.get(
        "SELECT 1 AS present FROM events WHERE task_id = ? AND kind = 'task.requirement_ownership' LIMIT 1", taskId,
      );
      return marker ? { requirementIds: [], mappingVersion: REQUIREMENT_OWNERSHIP_VERSION } : null;
    }
    return { requirementIds: rows.map((row) => row.requirement_id as string), mappingVersion: REQUIREMENT_OWNERSHIP_VERSION };
  }

  /** Every obligation of a task with this exact source key or a recurrence of it, oldest first. */
  obligationsForSourceKey(taskId: string, sourceKey: string): TaskObligation[] {
    return this.store.all(
      "SELECT * FROM task_obligations WHERE task_id = ? AND (source_key = ? OR source_key LIKE ?) ORDER BY created_at, rowid",
      taskId, sourceKey, `${sourceKey}:recurrence:%`,
    ).map(toObligation);
  }

  listObligations(taskId: string): TaskObligation[] {
    return this.store.all("SELECT * FROM task_obligations WHERE task_id = ? ORDER BY created_at, rowid", taskId).map(toObligation);
  }

  /**
   * A finding a repair claimed to address was restated by the next review of
   * the repaired revision: it returns to open with the restating evidence.
   */
  reopenObligation(obligationId: string, evidence: string[]): TaskObligation {
    if (evidence.length === 0) throw new Error("Reopening an obligation requires the evidence that restated it.");
    return this.store.tx(() => {
      const current = this.store.get("SELECT * FROM task_obligations WHERE id = ?", obligationId);
      if (!current) throw new Error(`Unknown obligation ${obligationId}`);
      if (current.state !== "addressed_pending_validation") {
        throw new Error(`Only an addressed obligation can be reopened; ${obligationId} is ${String(current.state)}.`);
      }
      const at = nowIso();
      const refs = [...fromJson<string[]>(current.evidence_refs, []), ...evidence];
      this.store.run(
        "UPDATE task_obligations SET state = 'open', evidence_refs = ?, updated_at = ? WHERE id = ?",
        toJson([...new Set(refs)]), at, obligationId,
      );
      const task = this.getTask(current.task_id as string) as Task;
      this.recordEvent({
        kind: "obligation.updated", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, obligationId, state: "open", reopened: true, evidence },
      });
      return toObligation(this.store.get("SELECT * FROM task_obligations WHERE id = ?", obligationId) as Row);
    });
  }

  /**
   * Record a person's answer to a blocking decision. Only `decision_needed`
   * obligations are decided this way; defects need validation evidence. The
   * task is not resumed automatically: a retry is a separate explicit action.
   */
  decideObligation(obligationId: string, decision: { answer: string; decidedBy: string }): TaskObligation {
    const current = this.store.get("SELECT * FROM task_obligations WHERE id = ?", obligationId);
    if (!current) throw new Error(`Unknown obligation ${obligationId}`);
    if (current.kind !== "decision_needed") throw new Error(`Obligation ${obligationId} is ${String(current.kind)}, not a decision.`);
    const task = this.getTask(current.task_id as string) as Task;
    return this.store.tx(() => {
      const eventId = this.recordEvent({
        kind: "obligation.decided", projectId: task.projectId, taskId: task.id,
        data: { obligationId, answer: decision.answer, decidedBy: decision.decidedBy },
      });
      return this.resolveObligation(
        { obligationId, state: "resolved", resolvedRevision: task.resultRevision },
        [`decision:${eventId}:${decision.decidedBy}`],
      );
    });
  }

  resolveObligation(input: {
    obligationId: string;
    state: Exclude<ObligationState, "open">;
    resolvedRevision?: string | null;
  }, evidence: string[]): TaskObligation {
    if (input.state === "resolved" && evidence.length === 0) throw new Error("Resolving an obligation requires validation or decision evidence.");
    return this.store.tx(() => {
      const current = this.store.get("SELECT * FROM task_obligations WHERE id = ?", input.obligationId);
      if (!current) throw new Error(`Unknown obligation ${input.obligationId}`);
      if (!["open", "addressed_pending_validation"].includes(String(current.state))) {
        throw new Error(`Obligation ${input.obligationId} is already ${String(current.state)}.`);
      }
      const at = nowIso();
      this.store.run(
        `UPDATE task_obligations SET state = ?, resolved_revision = ?, resolution_evidence = ?, updated_at = ? WHERE id = ?`,
        input.state, input.resolvedRevision ?? null, toJson(evidence), at, input.obligationId,
      );
      const task = this.getTask(current.task_id as string) as Task;
      this.recordEvent({
        kind: "obligation.updated", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, obligationId: input.obligationId, state: input.state, evidence },
      });
      return toObligation(this.store.get("SELECT * FROM task_obligations WHERE id = ?", input.obligationId) as Row);
    });
  }

  recordEnvironmentCheck(input: Omit<EnvironmentCheck, "id" | "checkedAt">): EnvironmentCheck {
    const task = this.getTask(input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    const id = ids.environmentCheck();
    const at = nowIso();
    return this.store.tx(() => {
      this.store.run(
        `INSERT INTO environment_checks(
           id, task_id, stage_run_id, component, profile, revision, runtime_fingerprint,
           lockfile_fingerprint, outcome, evidence_refs, setup_action_required, checked_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.taskId, input.stageRunId, input.component, input.profile, input.revision,
        input.runtimeFingerprint, input.lockfileFingerprint, input.outcome, toJson(input.evidenceRefs),
        input.setupActionRequired, at,
      );
      this.recordEvent({
        kind: "environment.checked", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, environmentCheckId: id, stageRunId: input.stageRunId, outcome: input.outcome },
      });
      return toEnvironmentCheck(this.store.get("SELECT * FROM environment_checks WHERE id = ?", id) as Row);
    });
  }

  latestEnvironmentCheck(taskId: string): EnvironmentCheck | null {
    const row = this.store.get(
      "SELECT * FROM environment_checks WHERE task_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1",
      taskId,
    );
    return row ? toEnvironmentCheck(row) : null;
  }

  reserveAdmission(input: {
    stageRunId: string;
    controllerId: string;
    fencingToken?: string;
    provider?: string | null;
    quotaDomain?: string | null;
    resources?: string[];
  }): AdmissionLease {
    const id = ids.admissionLease();
    const fencingToken = input.fencingToken ?? ids.launch();
    return this.store.tx(() => {
      const stage = this.store.get("SELECT * FROM stage_runs WHERE id = ?", input.stageRunId);
      if (!stage) throw new Error(`Unknown stage ${input.stageRunId}`);
      if (stage.state !== "reserved") throw new Error(`Stage ${input.stageRunId} is ${String(stage.state)}; admission is not reservable.`);
      const task = this.getTask(stage.task_id as string) as Task;
      const at = nowIso();
      this.store.run(
        `INSERT INTO admission_leases(
           id, stage_run_id, controller_id, fencing_token, provider, quota_domain,
           project_id, resources, status, granted_at
         ) VALUES(?,?,?,?,?,?,?,?,'reserved',?)`,
        id, input.stageRunId, input.controllerId, fencingToken, input.provider ?? null,
        input.quotaDomain ?? null, task.projectId, toJson([...new Set(input.resources ?? [])]), at,
      );
      this.recordEvent({
        kind: "admission.reserved", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, admissionLeaseId: id, stageRunId: input.stageRunId, provider: input.provider ?? null, quotaDomain: input.quotaDomain ?? null },
      });
      return toAdmissionLease(this.store.get("SELECT * FROM admission_leases WHERE id = ?", id) as Row);
    });
  }

  activateAdmission(id: string, fencingToken: string): AdmissionLease {
    return this.store.tx(() => {
      const lease = this.store.get("SELECT * FROM admission_leases WHERE id = ?", id);
      if (!lease) throw new Error(`Unknown admission lease ${id}`);
      if (lease.fencing_token !== fencingToken) throw new Error(`Stale fencing token for admission lease ${id}.`);
      const result = this.store.db.prepare(
        "UPDATE admission_leases SET status = 'active' WHERE id = ? AND fencing_token = ? AND status = 'reserved'",
      ).run(id, fencingToken);
      if (Number(result.changes) !== 1) throw new Error(`Admission lease ${id} is no longer reservable.`);
      const stageResult = this.store.db.prepare(
        "UPDATE stage_runs SET state = 'launching' WHERE id = ? AND state = 'reserved'",
      ).run(String(lease.stage_run_id));
      if (Number(stageResult.changes) !== 1) throw new Error(`Stage ${String(lease.stage_run_id)} is no longer reserved.`);
      const stage = this.store.get("SELECT * FROM stage_runs WHERE id = ?", lease.stage_run_id) as Row;
      const task = this.getTask(stage.task_id as string) as Task;
      this.store.run("UPDATE tasks SET record_version = record_version + 1, updated_at = ? WHERE id = ?", nowIso(), task.id);
      this.recordEvent({
        kind: "admission.activated", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, admissionLeaseId: id, stageRunId: lease.stage_run_id },
      });
      return toAdmissionLease(this.store.get("SELECT * FROM admission_leases WHERE id = ?", id) as Row);
    });
  }

  releaseAdmission(id: string, fencingToken: string, reason: string): AdmissionLease {
    return this.store.tx(() => {
      const lease = this.store.get("SELECT * FROM admission_leases WHERE id = ?", id);
      if (!lease) throw new Error(`Unknown admission lease ${id}`);
      if (lease.fencing_token !== fencingToken) throw new Error(`Stale fencing token for admission lease ${id}.`);
      const result = this.store.db.prepare(
        `UPDATE admission_leases SET status = 'released', released_at = ?, release_reason = ?
         WHERE id = ? AND fencing_token = ? AND status IN ('reserved','active')`,
      ).run(nowIso(), reason, id, fencingToken);
      if (Number(result.changes) !== 1) throw new Error(`Admission lease ${id} is already terminal.`);
      const stage = this.store.get("SELECT * FROM stage_runs WHERE id = ?", lease.stage_run_id) as Row;
      const task = this.getTask(stage.task_id as string) as Task;
      this.recordEvent({
        kind: "admission.released", projectId: task.projectId, taskId: task.id,
        data: { schemaVersion: 1, admissionLeaseId: id, stageRunId: lease.stage_run_id, reason },
      });
      return toAdmissionLease(this.store.get("SELECT * FROM admission_leases WHERE id = ?", id) as Row);
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
    promptVersion?: string | null;
    skillVersions?: string[];
    stageRunId?: string | null;
    parentAttemptId?: string | null;
    parentSessionId?: string | null;
    requestedModel?: string | null;
    configuredModel?: string | null;
    requestedEffort?: string | null;
    configuredEffort?: string | null;
    engineVersion?: string | null;
    cliVersion?: string | null;
  }): Attempt {
    const id = input.id ?? ids.attempt();
    const at = nowIso();
    return this.store.tx(() => {
      const previous = this.store.get("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?", input.taskId);
      const attemptNumber = Number(previous?.n ?? 0) + 1;
      this.store.run(
        `INSERT INTO attempts(id, task_id, launch_id, attempt_number, kind, adapter, model, effort, auth_mode,
           state, worktree_path, base_revision, packet_id, output_path, prompt_version, skill_versions,
           stage_run_id, parent_attempt_id, parent_session_id, requested_model, configured_model,
           requested_effort, configured_effort, engine_version, cli_version, started_at, heartbeat_at, last_progress_at)
         VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input.promptVersion ?? null,
        toJson(input.skillVersions ?? []),
        input.stageRunId ?? null,
        input.parentAttemptId ?? null,
        input.parentSessionId ?? null,
        input.requestedModel ?? input.model ?? null,
        input.configuredModel ?? input.model ?? null,
        input.requestedEffort ?? input.effort ?? null,
        input.configuredEffort ?? input.effort ?? null,
        input.engineVersion ?? null,
        input.cliVersion ?? null,
        at,
        at,
        at,
      );
      this.recordEvent({
        kind: "attempt.started",
        taskId: input.taskId,
        attemptId: id,
        data: {
          adapter: input.adapter, model: input.model ?? null, kind: input.kind, launchId: input.launchId,
          promptVersion: input.promptVersion ?? null, skillVersions: input.skillVersions ?? [],
          stageRunId: input.stageRunId ?? null, requestedModel: input.requestedModel ?? input.model ?? null,
          configuredModel: input.configuredModel ?? input.model ?? null,
        },
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

  /**
   * Record what the provider itself reported about the run. Absent values stay
   * NULL: a requested setting is never copied in as if it had been observed.
   */
  recordReportedSettings(attemptId: string, reported: { reportedModel: string | null; reportedEffort: string | null }): void {
    this.store.run(
      "UPDATE attempts SET reported_model = COALESCE(?, reported_model), reported_effort = COALESCE(?, reported_effort) WHERE id = ?",
      reported.reportedModel,
      reported.reportedEffort,
      attemptId,
    );
  }

  /**
   * Record observed provider activity. Distinct from the heartbeat: a live
   * process (heartbeat) can be silent, and progress means the provider
   * actually emitted events. Only moves forward.
   */
  recordAttemptProgress(id: string, at: string): boolean {
    const attempt = this.getAttempt(id);
    if (!attempt || attempt.state !== "running") return false;
    if (attempt.lastProgressAt && Date.parse(attempt.lastProgressAt) >= Date.parse(at)) return false;
    this.store.run("UPDATE attempts SET last_progress_at = ? WHERE id = ? AND state = 'running'", at, id);
    return true;
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
    reportedModel?: string | null;
    reportedEffort?: string | null;
    usageStatus?: string | null;
  }): void {
    this.store.tx(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${input.attemptId}`);
      this.store.run(
        `UPDATE attempts SET state = ?, outcome = ?, failure_class = ?, reason = ?, exit_status = ?,
           result_revision = ?, usage_json = ?, output_path = COALESCE(?, output_path),
           reported_model = COALESCE(?, reported_model), reported_effort = COALESCE(?, reported_effort),
           usage_status = ?, last_progress_at = ?, ended_at = ?
         WHERE id = ?`,
        input.state,
        input.outcome ?? null,
        input.failureClass ?? null,
        input.reason ?? null,
        input.exitStatus ?? null,
        input.resultRevision ?? null,
        input.usage ? toJson(input.usage) : null,
        input.outputPath ?? null,
        input.reportedModel ?? null,
        input.reportedEffort ?? null,
        input.usageStatus ?? (input.usage ? "reported" : null),
        nowIso(),
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

  recordUsageProjection(input: Omit<UsageProjection, "updatedAt">): UsageProjection {
    if (!USAGE_COVERAGE.includes(input.coverage)) throw new Error(`Unknown usage coverage: ${input.coverage}`);
    if (!input.normalizerVersion.trim() || !input.sourceArtifactHash.trim() || !input.sourceSemantics.trim()) {
      throw new Error("Usage projection requires normalizer and source provenance.");
    }
    const at = nowIso();
    this.store.tx(() => {
      if (!this.getAttempt(input.attemptId)) throw new Error(`Unknown attempt ${input.attemptId}`);
      this.store.run(
        `INSERT INTO attempt_usage(
           attempt_id, normalizer_version, normalized, source_artifact_hash, source_offset,
           coverage, source_semantics, updated_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
        input.attemptId, input.normalizerVersion, toJson(input.normalized), input.sourceArtifactHash,
        input.sourceOffset, input.coverage, input.sourceSemantics, at,
      );
      const attempt = this.getAttempt(input.attemptId) as Attempt;
      this.recordEvent({
        kind: "usage.projected", taskId: attempt.taskId, attemptId: input.attemptId,
        data: { schemaVersion: 1, normalizerVersion: input.normalizerVersion, coverage: input.coverage, sourceArtifactHash: input.sourceArtifactHash },
      });
    });
    return this.getUsageProjection(input.attemptId, input.normalizerVersion) as UsageProjection;
  }

  getUsageProjection(attemptId: string, normalizerVersion: string): UsageProjection | null {
    const row = this.store.get(
      "SELECT * FROM attempt_usage WHERE attempt_id = ? AND normalizer_version = ?",
      attemptId, normalizerVersion,
    );
    return row ? toUsageProjection(row) : null;
  }

  recordIncidentOccurrence(input: {
    incidentId?: string;
    signature: string;
    classifierVersion: string;
    category: string;
    layer: string;
    symptom: string;
    hypothesis?: string | null;
    confirmedCause?: string | null;
    confidence?: Incident["confidence"];
    lifecycle?: Incident["lifecycle"];
    affectedVersionStart?: string | null;
    affectedVersionEnd?: string | null;
    lessonRefs?: string[];
    fixRefs?: string[];
    testRefs?: string[];
    occurrenceId?: string;
    sourceKey: string;
    taskId?: string | null;
    stageRunId?: string | null;
    attemptId?: string | null;
    revision?: string | null;
    evidenceRefs?: string[];
    observedAt?: string;
  }): IncidentOccurrence {
    if (!input.signature.trim() || !input.classifierVersion.trim() || !input.sourceKey.trim()) {
      throw new Error("Incident occurrence requires signature, classifier version, and stable source key.");
    }
    const occurrenceId = input.occurrenceId ?? ids.occurrence();
    return this.store.tx(() => {
      let incidentRow = this.store.get(
        "SELECT * FROM incidents WHERE signature = ? AND classifier_version = ?",
        input.signature, input.classifierVersion,
      );
      if (!incidentRow) {
        const incidentId = input.incidentId ?? ids.incident();
        const at = nowIso();
        this.store.run(
          `INSERT INTO incidents(
             id, signature, classifier_version, category, layer, symptom, hypothesis, confirmed_cause,
             confidence, lifecycle, affected_version_start, affected_version_end, lesson_refs, fix_refs,
             test_refs, created_at, updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          incidentId, input.signature, input.classifierVersion, input.category, input.layer, input.symptom,
          input.hypothesis ?? null, input.confirmedCause ?? null, input.confidence ?? "unknown",
          input.lifecycle ?? "open", input.affectedVersionStart ?? null, input.affectedVersionEnd ?? null,
          toJson(input.lessonRefs ?? []), toJson(input.fixRefs ?? []), toJson(input.testRefs ?? []), at, at,
        );
        incidentRow = this.store.get("SELECT * FROM incidents WHERE id = ?", incidentId);
      } else if (input.incidentId && input.incidentId !== incidentRow.id) {
        throw new Error(`Incident signature ${input.signature} already belongs to ${String(incidentRow.id)}.`);
      }
      const incident = toIncident(incidentRow as Row);
      this.store.run(
        `INSERT INTO incident_occurrences(
           id, incident_id, source_key, task_id, stage_run_id, attempt_id, revision, evidence_refs, observed_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
        occurrenceId, incident.id, input.sourceKey, input.taskId ?? null, input.stageRunId ?? null,
        input.attemptId ?? null, input.revision ?? null, toJson(input.evidenceRefs ?? []), input.observedAt ?? nowIso(),
      );
      const projectId = input.taskId ? this.getTask(input.taskId)?.projectId ?? null : null;
      this.recordEvent({
        kind: "incident.occurrence_recorded", projectId, taskId: input.taskId ?? null, attemptId: input.attemptId ?? null,
        data: { schemaVersion: 1, incidentId: incident.id, occurrenceId, sourceKey: input.sourceKey, classifierVersion: input.classifierVersion },
      });
      return toIncidentOccurrence(this.store.get("SELECT * FROM incident_occurrences WHERE id = ?", occurrenceId) as Row);
    });
  }

  getIncident(id: string): Incident | null {
    const row = this.store.get("SELECT * FROM incidents WHERE id = ?", id);
    return row ? toIncident(row) : null;
  }

  incidentOccurrences(incidentId: string): IncidentOccurrence[] {
    return this.store.all("SELECT * FROM incident_occurrences WHERE incident_id = ? ORDER BY observed_at, rowid", incidentId)
      .map(toIncidentOccurrence);
  }

  // --- gates --------------------------------------------------------------

  recordGate(input: Omit<GateResult, "id" | "createdAt">): GateResult {
    if (input.stageRunId) {
      const existing = this.store.get("SELECT * FROM gate_results WHERE stage_run_id = ?", input.stageRunId);
      if (existing) {
        const gate = toGate(existing);
        if (gate.taskId !== input.taskId || gate.revision !== input.revision || gate.name !== input.name ||
            (gate.inputFingerprint ?? null) !== (input.inputFingerprint ?? null)) {
          throw new Error(`Gate stage ${input.stageRunId} already collected different evidence.`);
        }
        return gate;
      }
    }
    const id = ids.gate();
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO gate_results(id, task_id, attempt_id, name, status, required, command, tool_version,
           revision, evidence_path, duration_ms, waiver_id, stage_run_id, job_id, environment_fingerprint,
           command_fingerprint, input_fingerprint, raw_exit_status, raw_signal, timed_out, failure_diagnosis, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input.stageRunId ?? null,
        input.jobId ?? null,
        input.environmentFingerprint ?? null,
        input.commandFingerprint ?? null,
        input.inputFingerprint ?? null,
        input.rawExitStatus ?? null,
        input.rawSignal ?? null,
        input.timedOut === null || input.timedOut === undefined ? null : input.timedOut ? 1 : 0,
        input.failureDiagnosis ? toJson(input.failureDiagnosis) : null,
        nowIso(),
      );
      if (input.stageRunId) {
        const bound = this.store.db.prepare(
          "UPDATE stage_runs SET gate_id = ?, last_progress_at = ? WHERE id = ? AND gate_id IS NULL",
        ).run(id, nowIso(), input.stageRunId);
        if (Number(bound.changes) !== 1) throw new Error(`Gate stage ${input.stageRunId} could not bind result ${id}.`);
      }
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
   * Everything an accepted review depended on. Acceptance may be reused only
   * while this value is unchanged: a new requirement, a policy change, a
   * configuration change, or a moved dependency all invalidate it.
   */
  reviewContextFingerprint(taskId: string): string {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const project = this.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project ${task.projectId}`);
    const payload = {
      configVersion: project.configVersion,
      reviewPolicy: normalizeReviewPolicy(project.reviewPolicy),
      checkCommands: project.checkCommands.map((spec) => [spec.name, spec.command.join(" "), spec.required]),
      requirements: this.listRequirements(project.id).map((requirement) => [requirement.id, requirement.text, requirement.mandatory]),
      dependencies: this.dependenciesOf(taskId).map((id) => [id, this.getTask(id)?.resultRevision ?? null]),
      acceptanceCriteria: task.acceptanceCriteria,
    };
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

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
    const allGates = this.gatesForRevision(taskId, revision);
    const latestByIdentity = new Map<string, GateResult>();
    for (const gate of allGates) latestByIdentity.set(gate.inputFingerprint ?? gate.name, gate);
    const gates = [...latestByIdentity.values()];
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
      // Experiments may proceed without configured checks, but only visibly.
      if (project.reviewPolicy.qualityExpectation !== "advisory") {
        throw new Error(
          `Cannot prepare ${input.action}: this project has no configured required quality checks, so ${task.resultRevision} ` +
          `has no quality evidence. Register checks, or record an explicit waiver approval for ${coverageWaiverTarget}.`,
        );
      }
      this.recordEvent({
        kind: "quality.coverage_disclosed",
        projectId: project.id,
        taskId: task.id,
        data: {
          action: input.action,
          revision: task.resultRevision,
          preset: project.reviewPolicy.preset,
          note: "Experiment preset: accepted with no configured quality checks. This is not a production-readiness claim.",
        },
      });
    }
    if (input.action !== "waive_required_gate" && project.reviewPolicy.qualityExpectation === "acceptance_and_gates") {
      const mandatory = this.listRequirements(project.id).filter((requirement) => requirement.mandatory);
      if (mandatory.length === 0) {
        throw new Error(
          `Cannot prepare ${input.action}: the ${project.reviewPolicy.preset} preset expects acceptance evidence, but this project ` +
          "records no mandatory requirements to accept against.",
        );
      }
    }
    const decision = evaluateReviewPolicy(project.reviewPolicy, {
      subject: task,
      changedFiles: this.changedFilesForTask(task.id),
    });
    const reviews = this.reviewsForTask(task.id);
    // A review that actually ran is authoritative even if the policy would not
    // have demanded one: a recorded request_changes cannot be approved past.
    const reviewRequired = input.action !== "waive_required_gate" && (decision.review || reviews.length > 0);
    const approvedReview = reviews.findLast((review) => review.revision === task.resultRevision && review.verdict === "approved") ?? null;
    if (reviewRequired && !approvedReview) {
      throw new Error(`Cannot prepare ${input.action}: independent review has not approved ${task.resultRevision}`);
    }
    const fingerprint = this.reviewContextFingerprint(task.id);
    if (approvedReview?.contextFingerprint && approvedReview.contextFingerprint !== fingerprint) {
      throw new Error(
        `Cannot prepare ${input.action}: the accepted review of ${task.resultRevision} was made against different requirements, ` +
        "policy, configuration, or dependency revisions. A fresh review is required before acceptance can be reused.",
      );
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
        reviewPolicy: { resolved: describeReviewPolicy(project.reviewPolicy), decision },
        reviewContextFingerprint: fingerprint,
        review: reviews.findLast((review) => review.revision === task.resultRevision) ?? null,
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
    requireProjectReadiness({ kind: "project", id: project.id }, project.governance, project.reviewPolicy);
    this.assertConfigurationGovernance(project, input.config, "Curator proposal");
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
    requireProjectReadiness({ kind: "project", id: project.id }, project.governance, project.reviewPolicy);
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
    this.assertConfigurationGovernance(project, version.payload, "Proposed configuration");
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
    requireProjectReadiness({ kind: "project", id: project.id }, project.governance, project.reviewPolicy);
    const activeTasks = this.listTasks({ projectId: project.id }).filter((task) => ["RUNNING", "CHECKING", "REVIEWING"].includes(task.state));
    if (activeTasks.length > 0) throw new Error(`Configuration revert requires a safe checkpoint; ${activeTasks.length} task(s) are active`);
    const target = this.getConfigVersion(input.targetConfigVersion);
    if (!target || target.project_id !== project.id) throw new Error(`Unknown project configuration ${input.targetConfigVersion}`);
    this.assertConfigurationGovernance(project, target.payload, "Target configuration", false);
    const effectiveTarget = { ...normalizeProjectConfig(target.payload), governance: project.governance };
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
    const errors = validateProjectConfig(effectiveTarget);
    if (errors.length > 0) throw new Error(`Target configuration is invalid: ${errors.join("; ")}`);
    const revertVersion = ids.config();
    this.store.run(
      `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, revision, active, created_at)
       VALUES(?,?,?,'curator-revert','snapshot',?,NULL,0,?)`,
      revertVersion, project.id, project.configVersion, toJson(effectiveTarget), nowIso(),
    );
    return this.applyConfiguration({
      project,
      configVersion: revertVersion,
      config: effectiveTarget,
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

  private assertConfigurationGovernance(
    project: Project,
    config: ProjectConfigSnapshot,
    label: string,
    requireExactDecision = true,
  ): void {
    const normalized = normalizeProjectConfig(config);
    const candidate = normalized.governance;
    if (requireExactDecision && (
      candidate?.decisionId !== project.governance.decisionId ||
      candidate?.version !== project.governance.version ||
      candidate?.projectType !== project.governance.projectType ||
      candidate?.reviewChoice !== project.governance.reviewChoice
    )) {
      throw new Error(`${label} is stale because its governance decision does not match the current project decision.`);
    }
    const readiness = evaluateProjectReadiness(project.governance, normalized.reviewPolicy);
    if (!readiness.ready) {
      throw new Error(`${label} conflicts with current project governance: ${[...readiness.conflicts, ...readiness.missing].join("; ")}`);
    }
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
    policyVersion?: string | null;
    contextFingerprint?: string | null;
  }): ReviewResult {
    const prior = this.store.get("SELECT * FROM review_results WHERE attempt_id = ? ORDER BY created_at LIMIT 1", input.attemptId);
    if (prior) {
      const review = toReview(prior);
      if (review.taskId !== input.taskId || review.revision !== input.revision) {
        throw new Error(`Review attempt ${input.attemptId} is already bound to different review evidence.`);
      }
      return review;
    }
    const id = ids.review();
    const classified = classifyFindings(input.findings);
    const blocking = input.blockingFindings ?? classified.blocking;
    const advisory = input.advisoryFindings ?? classified.advisory;
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO review_results(id, task_id, attempt_id, revision, verdict, summary, findings,
           blocking_findings, advisory_findings, requirements_checked, evidence_path,
           policy_version, context_fingerprint, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, input.taskId, input.attemptId, input.revision, input.verdict, input.summary,
        toJson(classified.all), toJson(blocking), toJson(advisory),
        toJson(input.requirementsChecked), input.evidencePath ?? null,
        input.policyVersion ?? null,
        input.contextFingerprint ?? this.reviewContextFingerprint(input.taskId),
        nowIso(),
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
    capabilityRegistryVersion?: string | null;
    configVersion?: string | null;
    requestedSelection?: unknown;
    effectiveSelection?: unknown;
    eligibilityEvidence?: unknown;
    fallbackReason?: string | null;
    escalationReason?: string | null;
    quotaDomain?: string | null;
    decision?: string | null;
  }): void {
    const id = ids.event();
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO routing_decisions(id, task_id, attempt_id, rule, reason, eligible, chosen, model, effort, at,
           capability_registry_version, config_version, requested_selection, effective_selection, eligibility_evidence,
           fallback_reason, escalation_reason, quota_domain_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.taskId,
        input.attemptId ?? null,
        input.rule,
        input.reason,
        toJson(input.eligible),
        input.chosen,
        input.model ?? null,
        input.effort ?? null,
        nowIso(),
        input.capabilityRegistryVersion ?? null,
        input.configVersion ?? null,
        input.requestedSelection === undefined ? null : toJson(input.requestedSelection),
        input.effectiveSelection === undefined ? null : toJson(input.effectiveSelection),
        input.eligibilityEvidence === undefined ? null : toJson(input.eligibilityEvidence),
        input.fallbackReason ?? null,
        input.escalationReason ?? null,
        input.quotaDomain ?? null,
      );
      if (input.decision && input.decision !== "primary" && input.decision !== "deterministic") {
        this.recordEvent({
          kind: "routing.decision",
          taskId: input.taskId,
          attemptId: input.attemptId ?? null,
          data: {
            decision: input.decision,
            fallbackReason: input.fallbackReason ?? null,
            escalationReason: input.escalationReason ?? null,
            quotaDomain: input.quotaDomain ?? null,
          },
        });
      }
    });
  }

  routingForTask(taskId: string): Row[] {
    return this.store.all("SELECT * FROM routing_decisions WHERE task_id = ? ORDER BY at ASC", taskId).map((row) => ({
      ...row,
      eligible: fromJson<string[]>(row.eligible, []),
      requested_selection: fromJson<unknown>(row.requested_selection, null),
      effective_selection: fromJson<unknown>(row.effective_selection, null),
      eligibility_evidence: fromJson<unknown>(row.eligibility_evidence, null),
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
    purpose?: string | null;
    accounting?: {
      promptBytes: number;
      promptTokenEstimate: number;
      estimatorVersion: string;
      sectionBytes: Record<string, number>;
      mandatoryCount: number;
      optionalCount: number;
      contentFingerprint: string;
    } | null;
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
         token_estimate, budget_tokens, manifest_path, warnings, created_at, purpose, prompt_bytes,
         prompt_token_estimate, estimator_version, section_sizes, mandatory_count, optional_count, content_fingerprint)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      input.purpose ?? null,
      input.accounting?.promptBytes ?? null,
      input.accounting?.promptTokenEstimate ?? null,
      input.accounting?.estimatorVersion ?? null,
      input.accounting ? toJson(input.accounting.sectionBytes) : null,
      input.accounting?.mandatoryCount ?? null,
      input.accounting?.optionalCount ?? null,
      input.accounting?.contentFingerprint ?? null,
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
