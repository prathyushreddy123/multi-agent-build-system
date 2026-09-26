import type { FailureClass } from "../core/failure.ts";
import type { TaskState } from "./states.ts";

export const EXECUTION_STAGES = [
  "prepare_workspace", "preflight", "implement", "finalize", "check", "review", "repair", "accept",
] as const;
export type ExecutionStage = (typeof EXECUTION_STAGES)[number];

export const STAGE_STATES = [
  "ready", "reserved", "launching", "running", "succeeded", "failed", "waiting", "cancelled", "unknown",
] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const OBLIGATION_KINDS = [
  "code_defect", "gate_failure", "requirement_evidence", "decision_needed", "advisory",
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const OBLIGATION_STATES = [
  "open", "addressed_pending_validation", "resolved", "superseded", "withdrawn",
] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

export interface ExecutionEpisode {
  id: string;
  taskId: string;
  episodeNumber: number;
  authorizingDecision: string | null;
  status: "active" | "completed" | "failed" | "cancelled";
  repairLimit: number;
  repairsConsumed: number;
  recoveryLimit: number;
  recoveriesConsumed: number;
  startedAt: string;
  endedAt: string | null;
}

export interface StageRun {
  id: string;
  taskId: string;
  episodeId: string;
  stage: ExecutionStage;
  ordinal: number;
  state: StageState;
  attemptId: string | null;
  gateId: string | null;
  launchKey: string;
  inputFingerprint: string;
  revision: string | null;
  environmentFingerprint: string | null;
  engineRevision: string;
  fencingToken: string;
  reservedAt: string;
  startedAt: string | null;
  lastProgressAt: string | null;
  finishedAt: string | null;
  failureClass: FailureClass | null;
  failureDetail: string | null;
}

export interface TaskObligation {
  id: string;
  taskId: string;
  kind: ObligationKind;
  severity: string;
  blocking: boolean;
  sourceReviewId: string | null;
  sourceGateId: string | null;
  sourceDecisionId: string | null;
  sourceKey: string;
  state: ObligationState;
  summary: string;
  introducedRevision: string | null;
  resolvedRevision: string | null;
  evidenceRefs: string[];
  resolutionEvidence: string[];
  clarificationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Continuation {
  taskId: string;
  taskState: TaskState;
  taskVersion: number;
  episode: ExecutionEpisode | null;
  currentStage: StageRun | null;
  openObligations: TaskObligation[];
}

export interface EnvironmentCheck {
  id: string;
  taskId: string;
  stageRunId: string | null;
  component: string;
  profile: string;
  revision: string | null;
  runtimeFingerprint: string | null;
  lockfileFingerprint: string | null;
  outcome: "ready" | "missing" | "mismatch" | "error";
  evidenceRefs: string[];
  setupActionRequired: string | null;
  checkedAt: string;
}

export function taskStateForStage(stage: ExecutionStage): TaskState {
  if (stage === "check" || stage === "finalize") return "CHECKING";
  if (stage === "review" || stage === "accept") return "REVIEWING";
  return "RUNNING";
}
