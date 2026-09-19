import type { ExecutionPlan } from "../domain/plan.ts";
import type { ReviewPreset } from "../review/policy.ts";

/**
 * Product intake lifecycle. Deliberately separate from task execution states:
 * a brief is a conversation about what to build, not a unit of work.
 *
 *   DRAFT -> CLARIFYING -> PROPOSED -> ACCEPTED -> BOOTSTRAPPING -> REGISTERED
 *
 * A failed bootstrap stays resumable with its evidence, and a revision after
 * acceptance returns the brief to CLARIFYING without discarding history.
 */
export const BRIEF_STATES = [
  "DRAFT",
  "CLARIFYING",
  "PROPOSED",
  "ACCEPTED",
  "BOOTSTRAPPING",
  "REGISTERED",
] as const;
export type BriefState = (typeof BRIEF_STATES)[number];

export const BRIEF_TRANSITIONS: Record<BriefState, readonly BriefState[]> = {
  DRAFT: ["CLARIFYING", "PROPOSED"],
  CLARIFYING: ["CLARIFYING", "PROPOSED", "DRAFT"],
  PROPOSED: ["CLARIFYING", "PROPOSED", "ACCEPTED"],
  ACCEPTED: ["CLARIFYING", "PROPOSED", "BOOTSTRAPPING", "REGISTERED"],
  BOOTSTRAPPING: ["REGISTERED", "ACCEPTED", "CLARIFYING", "BOOTSTRAPPING"],
  REGISTERED: ["CLARIFYING", "PROPOSED", "BOOTSTRAPPING"],
};

export interface ProposedStack {
  language: string | null;
  runtime: string | null;
  packageManager: string | null;
  components: string[];
  rationale: string | null;
}

export interface QualitySettings {
  reviewPreset: ReviewPreset | null;
  checks: string[];
  notes: string | null;
}

export interface OperationalPreferences {
  ci: "off" | "configured";
  deployment: "off" | "local" | "configured";
  monitoring: "off" | "run_health" | "application";
  scheduling: "manual" | "configured";
  delivery: "local_files" | "configured";
  notes: string | null;
}

export interface ProductBrief {
  id: string;
  title: string;
  state: BriefState;
  purpose: string | null;
  audience: string | null;
  objective: string | null;
  constraints: string[];
  unknowns: string[];
  assumptions: string[];
  proposedStack: ProposedStack;
  acceptanceCriteria: string[];
  qualitySettings: QualitySettings;
  operationalPreferences: OperationalPreferences;
  targetPath: string | null;
  projectId: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type BriefFieldPatch = Partial<Pick<ProductBrief,
  | "title" | "purpose" | "audience" | "objective" | "constraints" | "unknowns" | "assumptions"
  | "proposedStack" | "acceptanceCriteria" | "qualitySettings" | "operationalPreferences" | "targetPath"
>>;

export interface ClarificationItem {
  id: string;
  briefId: string;
  field: string | null;
  question: string;
  whyItMatters: string;
  state: "open" | "answered" | "assumed" | "withdrawn";
  answer: string | null;
  assumption: string | null;
  askedAt: string;
  resolvedAt: string | null;
}

export interface ProposalVersion {
  id: string;
  briefId: string;
  version: number;
  state: "draft" | "presented" | "accepted" | "superseded" | "invalidated";
  summary: string;
  rationale: string;
  scope: string;
  outOfScope: string[];
  requirements: { id: string; text: string; mandatory: boolean }[];
  milestones: string[];
  plan: ExecutionPlan;
  validation: { valid: boolean; errors: string[]; warnings: string[]; topologicalOrder: string[] };
  fingerprint: string;
  briefVersion: number;
  createdAt: string;
  presentedAt: string | null;
}

export interface AcceptanceBinding {
  id: string;
  briefId: string;
  proposalId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  briefVersion: number;
  decision: "accepted";
  note: string | null;
  acceptedBy: string;
  state: "active" | "invalidated";
  invalidatedReason: string | null;
  createdAt: string;
}

export interface BootstrapStep {
  name: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  detail: string | null;
  at: string | null;
}

export interface BootstrapRun {
  id: string;
  briefId: string;
  targetPath: string;
  state: "pending" | "running" | "failed" | "completed";
  profile: string | null;
  steps: BootstrapStep[];
  projectId: string | null;
  planId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationEvent {
  id: string;
  briefId: string;
  at: string;
  kind: string;
  actor: string;
  body: string;
  data: Record<string, unknown>;
}
