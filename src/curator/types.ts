import type { ProjectConfigSnapshot } from "../domain/config.ts";

export type ProposalStatus = "draft" | "proposed" | "evaluated" | "rejected" | "activated" | "superseded" | "failed";

export interface CuratorProposal {
  id: string;
  projectId: string;
  title: string;
  rationale: string;
  fingerprint: string;
  evidenceFingerprint: string;
  status: ProposalStatus;
  baseConfigVersion: string;
  proposedConfigVersion: string;
  branch: string | null;
  worktreePath: string | null;
  baseRevision: string | null;
  resultRevision: string | null;
  diffPath: string | null;
  proposedBy: string;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationMetrics {
  cases: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  repairCycles: number;
  reviewChangesRequested: number;
  requiredGates: number;
  routingChanges: number;
  promptCharacters: number;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
}

export interface EvaluationCase {
  id: string;
  kind: "routing" | "review" | "approval" | "quality" | "prompt";
  baselineOutcome: string;
  candidateOutcome: string;
  expected: string;
  passed: boolean;
}

export interface CuratorEvaluation {
  id: string;
  proposalId: string;
  suiteVersion: string;
  status: "passed" | "failed";
  baselineMetrics: EvaluationMetrics;
  candidateMetrics: EvaluationMetrics;
  cases: EvaluationCase[];
  errors: string[];
  evidencePath: string | null;
  startedAt: string;
  endedAt: string;
}

export interface ConfigActivation {
  id: string;
  projectId: string;
  proposalId: string | null;
  action: "activate" | "revert";
  fromConfigVersion: string;
  toConfigVersion: string;
  sourceConfigVersion: string | null;
  approvalId: string;
  activatedBy: string;
  reason: string;
  createdAt: string;
}

export interface CuratorSignals {
  projectId: string;
  configVersion: string;
  observedAt: string;
  taskCount: number;
  failuresByClass: Record<string, number>;
  repairCycles: number;
  reviewChangesRequested: number;
  routingOverrides: number;
  providerFailures: number;
  repeatedQuestions: number;
  rejectedFingerprints: string[];
}

export interface ProposalInput {
  projectId: string;
  title: string;
  rationale: string;
  config: ProjectConfigSnapshot;
  proposedBy: string;
  signals: CuratorSignals;
}
