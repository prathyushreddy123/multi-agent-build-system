/**
 * Durable access to product-intake records.
 *
 * Deliberately deterministic: the conversational model supplies reasoning, but
 * every persisted change goes through these functions, which validate shape,
 * enforce expected versions, and write an auditable conversation event in the
 * same transaction. The model never writes SQL.
 */
import { createHash } from "node:crypto";

import { ids } from "../core/ids.ts";
import type { ExecutionPlan } from "../domain/plan.ts";
import { REVIEW_PRESETS, type ReviewPreset } from "../review/policy.ts";
import { fromJson, nowIso, toJson, type Row } from "../store/db.ts";
import type { Records } from "../store/records.ts";
import {
  BRIEF_STATES,
  BRIEF_TRANSITIONS,
  type AcceptanceBinding,
  type BootstrapRun,
  type BootstrapStep,
  type BriefFieldPatch,
  type BriefState,
  type ClarificationItem,
  type ConversationEvent,
  type OperationalPreferences,
  type ProductBrief,
  type ProposalVersion,
  type ProposedStack,
  type QualitySettings,
} from "./types.ts";

export const DEFAULT_STACK: ProposedStack = {
  language: null, runtime: null, packageManager: null, components: [], rationale: null,
};

export const DEFAULT_QUALITY: QualitySettings = { reviewPreset: null, checks: [], notes: null };

/** Everything optional stays off until the user configures a destination. */
export const DEFAULT_OPERATIONS: OperationalPreferences = {
  ci: "off", deployment: "off", monitoring: "off", scheduling: "manual", delivery: "local_files", notes: null,
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function toBrief(row: Row): ProductBrief {
  return {
    id: row.id as string,
    title: row.title as string,
    state: row.state as BriefState,
    purpose: (row.purpose as string) ?? null,
    audience: (row.audience as string) ?? null,
    objective: (row.objective as string) ?? null,
    constraints: fromJson<string[]>(row.constraints, []),
    unknowns: fromJson<string[]>(row.unknowns, []),
    assumptions: fromJson<string[]>(row.assumptions, []),
    proposedStack: { ...DEFAULT_STACK, ...fromJson<Partial<ProposedStack>>(row.proposed_stack, {}) },
    acceptanceCriteria: fromJson<string[]>(row.acceptance_criteria, []),
    qualitySettings: { ...DEFAULT_QUALITY, ...fromJson<Partial<QualitySettings>>(row.quality_settings, {}) },
    operationalPreferences: { ...DEFAULT_OPERATIONS, ...fromJson<Partial<OperationalPreferences>>(row.operational_preferences, {}) },
    targetPath: (row.target_path as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    version: Number(row.version ?? 1),
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toClarification(row: Row): ClarificationItem {
  return {
    id: row.id as string,
    briefId: row.brief_id as string,
    field: (row.field as string) ?? null,
    question: row.question as string,
    whyItMatters: (row.why_it_matters as string) ?? "",
    state: row.state as ClarificationItem["state"],
    answer: (row.answer as string) ?? null,
    assumption: (row.assumption as string) ?? null,
    askedAt: row.asked_at as string,
    resolvedAt: (row.resolved_at as string) ?? null,
  };
}

function toProposal(row: Row): ProposalVersion {
  return {
    id: row.id as string,
    briefId: row.brief_id as string,
    version: Number(row.version),
    state: row.state as ProposalVersion["state"],
    summary: row.summary as string,
    rationale: row.rationale as string,
    scope: (row.scope as string) ?? "",
    outOfScope: fromJson<string[]>(row.out_of_scope, []),
    requirements: fromJson<ProposalVersion["requirements"]>(row.requirements, []),
    milestones: fromJson<string[]>(row.milestones, []),
    plan: fromJson<ExecutionPlan>(row.plan, { objective: "", mode: "single", reason: "", tasks: [] }),
    validation: fromJson<ProposalVersion["validation"]>(row.validation, { valid: false, errors: [], warnings: [], topologicalOrder: [] }),
    fingerprint: row.fingerprint as string,
    briefVersion: Number(row.brief_version ?? 1),
    createdAt: row.created_at as string,
    presentedAt: (row.presented_at as string) ?? null,
  };
}

function toBinding(row: Row): AcceptanceBinding {
  return {
    id: row.id as string,
    briefId: row.brief_id as string,
    proposalId: row.proposal_id as string,
    proposalVersion: Number(row.proposal_version),
    proposalFingerprint: row.proposal_fingerprint as string,
    briefVersion: Number(row.brief_version),
    decision: row.decision as "accepted",
    note: (row.note as string) ?? null,
    acceptedBy: row.accepted_by as string,
    state: row.state as AcceptanceBinding["state"],
    invalidatedReason: (row.invalidated_reason as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function toBootstrapRun(row: Row): BootstrapRun {
  return {
    id: row.id as string,
    briefId: row.brief_id as string,
    targetPath: row.target_path as string,
    state: row.state as BootstrapRun["state"],
    profile: (row.profile as string) ?? null,
    profileResolution: fromJson<BootstrapRun["profileResolution"]>(row.profile_resolution, null),
    environmentPlan: fromJson<BootstrapRun["environmentPlan"]>(row.environment_plan, []),
    artifacts: fromJson<BootstrapRun["artifacts"]>(row.artifacts, []),
    steps: fromJson<BootstrapStep[]>(row.steps, []),
    projectId: (row.project_id as string) ?? null,
    planId: (row.plan_id as string) ?? null,
    error: (row.error as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function proposalFingerprint(input: {
  briefId: string;
  briefVersion: number;
  summary: string;
  requirements: { id: string; text: string; mandatory: boolean }[];
  plan: ExecutionPlan;
}): string {
  return createHash("sha256").update(JSON.stringify({
    briefId: input.briefId,
    briefVersion: input.briefVersion,
    summary: input.summary,
    requirements: input.requirements.map((requirement) => [requirement.id, requirement.text, requirement.mandatory]),
    plan: input.plan,
  })).digest("hex");
}

export function recordConversation(records: Records, input: {
  briefId: string;
  kind: string;
  actor: string;
  body?: string;
  data?: Record<string, unknown>;
}): string {
  const id = ids.conversation();
  records.store.run(
    "INSERT INTO conversation_events(id, brief_id, at, kind, actor, body, data) VALUES(?,?,?,?,?,?,?)",
    id, input.briefId, nowIso(), input.kind, input.actor, input.body ?? "", toJson(input.data ?? {}),
  );
  return id;
}

export function conversationFor(records: Records, briefId: string, limit = 200): ConversationEvent[] {
  return records.store.all(
    "SELECT * FROM conversation_events WHERE brief_id = ? ORDER BY at, rowid LIMIT ?", briefId, limit,
  ).map((row) => ({
    id: row.id as string,
    briefId: row.brief_id as string,
    at: row.at as string,
    kind: row.kind as string,
    actor: row.actor as string,
    body: row.body as string,
    data: fromJson<Record<string, unknown>>(row.data, {}),
  }));
}

export function planSubmissions(records: Records, briefId: string): {
  proposalId: string;
  projectId: string;
  planId: string | null;
  taskIds: string[];
}[] {
  return records.store.all(
    "SELECT data FROM conversation_events WHERE brief_id = ? AND kind = 'plan.submitted' ORDER BY at DESC, rowid DESC",
    briefId,
  ).map((row) => fromJson<Record<string, unknown>>(row.data, {})).flatMap((data) => {
    if (typeof data.proposalId !== "string" || typeof data.projectId !== "string") return [];
    return [{
      proposalId: data.proposalId,
      projectId: data.projectId,
      planId: typeof data.planId === "string" ? data.planId : null,
      taskIds: Array.isArray(data.taskIds) ? data.taskIds.filter((id): id is string => typeof id === "string") : [],
    }];
  });
}

export function getBrief(records: Records, id: string): ProductBrief | null {
  const row = records.store.get("SELECT * FROM product_briefs WHERE id = ?", id);
  return row ? toBrief(row) : null;
}

export function findBriefByTitle(records: Records, title: string): ProductBrief | null {
  const row = records.store.get("SELECT * FROM product_briefs WHERE title = ? ORDER BY created_at DESC LIMIT 1", title);
  return row ? toBrief(row) : null;
}

export function resolveBrief(records: Records, value: string): ProductBrief | null {
  return getBrief(records, value) ?? findBriefByTitle(records, value);
}

export function listBriefs(records: Records, state?: BriefState): ProductBrief[] {
  const rows = state
    ? records.store.all("SELECT * FROM product_briefs WHERE state = ? ORDER BY updated_at DESC", state)
    : records.store.all("SELECT * FROM product_briefs ORDER BY updated_at DESC");
  return rows.map(toBrief);
}

function writeRevision(records: Records, brief: ProductBrief, source: string, summary: string, changed: string[]): void {
  records.store.run(
    "INSERT INTO brief_revisions(brief_id, version, source, summary, changed, payload, created_at) VALUES(?,?,?,?,?,?,?)",
    brief.id, brief.version, source, summary, toJson(changed), toJson(brief), nowIso(),
  );
}

export function briefRevisions(records: Records, briefId: string): Row[] {
  return records.store.all("SELECT * FROM brief_revisions WHERE brief_id = ? ORDER BY version", briefId)
    .map((row) => ({ ...row, changed: fromJson<string[]>(row.changed, []), payload: fromJson<ProductBrief | null>(row.payload, null) }));
}

export function createBrief(records: Records, input: {
  title: string;
  purpose?: string;
  audience?: string;
  objective?: string;
  constraints?: string[];
  unknowns?: string[];
  assumptions?: string[];
  acceptanceCriteria?: string[];
  proposedStack?: Partial<ProposedStack>;
  qualitySettings?: Partial<QualitySettings>;
  operationalPreferences?: Partial<OperationalPreferences>;
  targetPath?: string | null;
  createdBy?: string;
}): ProductBrief {
  const title = text(input.title);
  if (!title) throw new Error("A product brief needs a short title.");
  const preset = input.qualitySettings?.reviewPreset ?? null;
  if (preset !== null && !REVIEW_PRESETS.includes(preset as ReviewPreset)) {
    throw new Error(`Unknown review preset: ${String(preset)}`);
  }
  const id = ids.brief();
  const at = nowIso();
  return records.store.tx(() => {
    records.store.run(
      `INSERT INTO product_briefs(id, title, state, purpose, audience, objective, constraints, unknowns,
         assumptions, proposed_stack, acceptance_criteria, quality_settings, operational_preferences,
         target_path, project_id, version, created_by, created_at, updated_at)
       VALUES(?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)`,
      id, title, text(input.purpose), text(input.audience), text(input.objective),
      toJson(list(input.constraints)), toJson(list(input.unknowns)), toJson(list(input.assumptions)),
      toJson({ ...DEFAULT_STACK, ...(input.proposedStack ?? {}) }),
      toJson(list(input.acceptanceCriteria)),
      toJson({ ...DEFAULT_QUALITY, ...(input.qualitySettings ?? {}) }),
      toJson({ ...DEFAULT_OPERATIONS, ...(input.operationalPreferences ?? {}) }),
      text(input.targetPath ?? null), input.createdBy ?? "local", at, at,
    );
    const brief = getBrief(records, id) as ProductBrief;
    writeRevision(records, brief, input.createdBy ?? "local", "Brief created.", ["*"]);
    recordConversation(records, {
      briefId: id, kind: "brief.created", actor: input.createdBy ?? "local",
      body: title, data: { objective: brief.objective, unknowns: brief.unknowns.length },
    });
    records.recordEvent({ kind: "intake.brief_created", data: { briefId: id, title } });
    return brief;
  });
}

export function assertBriefTransition(from: BriefState, to: BriefState): void {
  if (!BRIEF_STATES.includes(to)) throw new Error(`Unknown brief state: ${to}`);
  if (from === to && !BRIEF_TRANSITIONS[from].includes(to)) return;
  if (!BRIEF_TRANSITIONS[from].includes(to)) throw new Error(`Invalid brief transition: ${from} -> ${to}`);
}

export function setBriefState(records: Records, briefId: string, to: BriefState, reason: string, actor = "local"): ProductBrief {
  const brief = getBrief(records, briefId);
  if (!brief) throw new Error(`Unknown brief ${briefId}`);
  if (brief.state === to) return brief;
  assertBriefTransition(brief.state, to);
  return records.store.tx(() => {
    records.store.run("UPDATE product_briefs SET state = ?, updated_at = ? WHERE id = ?", to, nowIso(), briefId);
    recordConversation(records, { briefId, kind: "brief.state", actor, body: `${brief.state} -> ${to}`, data: { reason } });
    return getBrief(records, briefId) as ProductBrief;
  });
}

/**
 * Apply a scoped update with an expected-version check, so two conversational
 * turns cannot overwrite each other silently.
 */
export function updateBrief(records: Records, input: {
  briefId: string;
  expectedVersion: number;
  patch: BriefFieldPatch;
  summary: string;
  actor?: string;
}): { brief: ProductBrief; changed: string[]; invalidated: AcceptanceBinding[] } {
  const actor = input.actor ?? "local";
  const current = getBrief(records, input.briefId);
  if (!current) throw new Error(`Unknown brief ${input.briefId}`);
  if (current.version !== input.expectedVersion) {
    throw new Error(`Brief ${input.briefId} changed since version ${input.expectedVersion}; current version is ${current.version}.`);
  }
  if (!text(input.summary)) throw new Error("A brief update needs a one-line summary of what changed and why.");

  const columns: Record<string, { column: string; value: unknown }> = {};
  const patch = input.patch ?? {};
  const scalar: [keyof BriefFieldPatch, string][] = [
    ["title", "title"], ["purpose", "purpose"], ["audience", "audience"], ["objective", "objective"], ["targetPath", "target_path"],
  ];
  for (const [field, column] of scalar) {
    if (patch[field] === undefined) continue;
    const value = text(patch[field] as string);
    if (field === "title" && value === null) throw new Error("A product brief needs a non-empty title.");
    columns[field] = { column, value };
  }
  const arrays: [keyof BriefFieldPatch, string][] = [
    ["constraints", "constraints"], ["unknowns", "unknowns"], ["assumptions", "assumptions"], ["acceptanceCriteria", "acceptance_criteria"],
  ];
  for (const [field, column] of arrays) {
    if (patch[field] !== undefined) columns[field] = { column, value: toJson(list(patch[field] as string[])) };
  }
  if (patch.proposedStack !== undefined) {
    columns.proposedStack = { column: "proposed_stack", value: toJson({ ...current.proposedStack, ...patch.proposedStack }) };
  }
  if (patch.qualitySettings !== undefined) {
    const preset = patch.qualitySettings.reviewPreset;
    if (preset !== undefined && preset !== null && !REVIEW_PRESETS.includes(preset)) {
      throw new Error(`Unknown review preset: ${String(preset)}`);
    }
    columns.qualitySettings = { column: "quality_settings", value: toJson({ ...current.qualitySettings, ...patch.qualitySettings }) };
  }
  if (patch.operationalPreferences !== undefined) {
    columns.operationalPreferences = {
      column: "operational_preferences",
      value: toJson({ ...current.operationalPreferences, ...patch.operationalPreferences }),
    };
  }
  const changed = Object.keys(columns);
  if (changed.length === 0) throw new Error("A brief update must change at least one field.");

  return records.store.tx(() => {
    const assignments = Object.values(columns).map((entry) => `${entry.column} = ?`).join(", ");
    records.store.run(
      `UPDATE product_briefs SET ${assignments}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      ...Object.values(columns).map((entry) => entry.value), nowIso(), input.briefId, input.expectedVersion,
    );
    const updated = getBrief(records, input.briefId) as ProductBrief;
    if (updated.version !== input.expectedVersion + 1) throw new Error(`Concurrent update to brief ${input.briefId}.`);
    writeRevision(records, updated, actor, input.summary, changed);
    recordConversation(records, {
      briefId: input.briefId, kind: "brief.updated", actor, body: input.summary,
      data: { changed, version: updated.version },
    });
    // A revision after acceptance invalidates that acceptance and nothing else:
    // completed work and its evidence are untouched.
    const invalidated = invalidateAcceptance(records, input.briefId, `Brief revised at version ${updated.version}: ${input.summary}`);
    if (invalidated.length > 0) {
      const invalidatedProposalIds = new Set(invalidated.map((binding) => binding.proposalId));
      const submittedTaskIds = planSubmissions(records, input.briefId)
        .filter((submission) => invalidatedProposalIds.has(submission.proposalId))
        .flatMap((submission) => submission.taskIds);
      const cancelledTaskIds: string[] = [];
      for (const taskId of new Set(submittedTaskIds)) {
        const task = records.getTask(taskId);
        if (task && (task.state === "QUEUED" || task.state === "READY")) {
          records.transition(task.id, "CANCELLED", {
            blocked_reason: `Product brief ${input.briefId} changed after this plan was accepted.`,
          }, { reason: "accepted_product_scope_revised", briefId: input.briefId, briefVersion: updated.version });
          cancelledTaskIds.push(task.id);
        }
      }
      recordConversation(records, {
        briefId: input.briefId,
        kind: "plan.invalidated",
        actor: "system",
        body: `Invalidated ${cancelledTaskIds.length} not-started task(s); completed work and evidence were preserved.`,
        data: { cancelledTaskIds, preservedCompletedWork: true },
      });
      if (["ACCEPTED", "REGISTERED", "BOOTSTRAPPING"].includes(updated.state)) {
        setBriefState(records, input.briefId, "CLARIFYING", "Brief revised after acceptance; a fresh proposal is required.", actor);
      }
    }
    return { brief: getBrief(records, input.briefId) as ProductBrief, changed, invalidated };
  });
}

export function linkBriefProject(records: Records, briefId: string, projectId: string): ProductBrief {
  records.store.run("UPDATE product_briefs SET project_id = ?, updated_at = ? WHERE id = ?", projectId, nowIso(), briefId);
  recordConversation(records, { briefId, kind: "brief.project_linked", actor: "bootstrap", body: projectId, data: { projectId } });
  return getBrief(records, briefId) as ProductBrief;
}

// --- clarifications --------------------------------------------------------

export function addClarification(records: Records, input: {
  briefId: string;
  question: string;
  whyItMatters: string;
  field?: string | null;
  actor?: string;
}): ClarificationItem {
  const question = text(input.question);
  if (!question) throw new Error("A clarification needs a question.");
  if (!text(input.whyItMatters)) throw new Error("A clarification must say why the answer matters; otherwise it is not a material question.");
  const id = ids.clarification();
  return records.store.tx(() => {
    records.store.run(
      "INSERT INTO clarification_items(id, brief_id, field, question, why_it_matters, state, asked_at) VALUES(?,?,?,?,?,'open',?)",
      id, input.briefId, text(input.field ?? null), question, input.whyItMatters.trim(), nowIso(),
    );
    recordConversation(records, { briefId: input.briefId, kind: "clarification.asked", actor: input.actor ?? "agent", body: question });
    return getClarification(records, id) as ClarificationItem;
  });
}

export function getClarification(records: Records, id: string): ClarificationItem | null {
  const row = records.store.get("SELECT * FROM clarification_items WHERE id = ?", id);
  return row ? toClarification(row) : null;
}

export function listClarifications(records: Records, briefId: string, state?: ClarificationItem["state"]): ClarificationItem[] {
  const rows = state
    ? records.store.all("SELECT * FROM clarification_items WHERE brief_id = ? AND state = ? ORDER BY asked_at", briefId, state)
    : records.store.all("SELECT * FROM clarification_items WHERE brief_id = ? ORDER BY asked_at", briefId);
  return rows.map(toClarification);
}

/** Answer from the user, or an explicit recorded assumption when they cannot answer. */
export function resolveClarification(records: Records, input: {
  id: string;
  answer?: string;
  assumption?: string;
  actor?: string;
}): ClarificationItem {
  const item = getClarification(records, input.id);
  if (!item) throw new Error(`Unknown clarification ${input.id}`);
  const answer = text(input.answer ?? null);
  const assumption = text(input.assumption ?? null);
  if (!answer && !assumption) throw new Error("Provide the user's answer, or record an explicit assumption instead.");
  const state = answer ? "answered" : "assumed";
  return records.store.tx(() => {
    records.store.run(
      "UPDATE clarification_items SET state = ?, answer = ?, assumption = ?, resolved_at = ? WHERE id = ?",
      state, answer, assumption, nowIso(), input.id,
    );
    recordConversation(records, {
      briefId: item.briefId,
      kind: answer ? "clarification.answered" : "clarification.assumed",
      actor: input.actor ?? (answer ? "user" : "agent"),
      body: (answer ?? assumption) as string,
      data: { clarificationId: input.id, question: item.question },
    });
    return getClarification(records, input.id) as ClarificationItem;
  });
}

// --- proposals -------------------------------------------------------------

export function listProposals(records: Records, briefId: string): ProposalVersion[] {
  return records.store.all("SELECT * FROM proposal_versions WHERE brief_id = ? ORDER BY version", briefId).map(toProposal);
}

export function getProposal(records: Records, id: string): ProposalVersion | null {
  const row = records.store.get("SELECT * FROM proposal_versions WHERE id = ?", id);
  return row ? toProposal(row) : null;
}

export function latestProposal(records: Records, briefId: string): ProposalVersion | null {
  return listProposals(records, briefId).at(-1) ?? null;
}

export function insertProposal(records: Records, input: {
  briefId: string;
  briefVersion: number;
  summary: string;
  rationale: string;
  scope: string;
  outOfScope: string[];
  requirements: { id: string; text: string; mandatory: boolean }[];
  milestones: string[];
  plan: ExecutionPlan;
  validation: ProposalVersion["validation"];
  fingerprint: string;
  actor: string;
}): ProposalVersion {
  const id = ids.proposalVersion();
  const at = nowIso();
  return records.store.tx(() => {
    const previous = listProposals(records, input.briefId);
    const version = (previous.at(-1)?.version ?? 0) + 1;
    for (const proposal of previous) {
      if (proposal.state === "presented" || proposal.state === "draft") {
        records.store.run("UPDATE proposal_versions SET state = 'superseded' WHERE id = ?", proposal.id);
      }
    }
    records.store.run(
      `INSERT INTO proposal_versions(id, brief_id, version, state, summary, rationale, scope, out_of_scope,
         requirements, milestones, plan, validation, fingerprint, brief_version, created_at, presented_at)
       VALUES(?,?,?,'presented',?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.briefId, version, input.summary, input.rationale, input.scope, toJson(input.outOfScope),
      toJson(input.requirements), toJson(input.milestones), toJson(input.plan), toJson(input.validation),
      input.fingerprint, input.briefVersion, at, at,
    );
    recordConversation(records, {
      briefId: input.briefId, kind: "proposal.presented", actor: input.actor, body: input.summary,
      data: { proposalId: id, version, tasks: input.plan.tasks.length, fingerprint: input.fingerprint },
    });
    return getProposal(records, id) as ProposalVersion;
  });
}

// --- acceptance ------------------------------------------------------------

export function activeAcceptance(records: Records, briefId: string): AcceptanceBinding | null {
  const row = records.store.get(
    "SELECT * FROM acceptance_bindings WHERE brief_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1", briefId,
  );
  return row ? toBinding(row) : null;
}

export function listAcceptances(records: Records, briefId: string): AcceptanceBinding[] {
  return records.store.all("SELECT * FROM acceptance_bindings WHERE brief_id = ? ORDER BY created_at", briefId).map(toBinding);
}

export function recordAcceptance(records: Records, input: {
  briefId: string;
  proposal: ProposalVersion;
  acceptedBy: string;
  note?: string | null;
}): AcceptanceBinding {
  const id = ids.acceptance();
  return records.store.tx(() => {
    records.store.run(
      `INSERT INTO acceptance_bindings(id, brief_id, proposal_id, proposal_version, proposal_fingerprint,
         brief_version, decision, note, accepted_by, state, created_at)
       VALUES(?,?,?,?,?,?,'accepted',?,?,'active',?)`,
      id, input.briefId, input.proposal.id, input.proposal.version, input.proposal.fingerprint,
      input.proposal.briefVersion, text(input.note ?? null), input.acceptedBy, nowIso(),
    );
    records.store.run("UPDATE proposal_versions SET state = 'accepted' WHERE id = ?", input.proposal.id);
    recordConversation(records, {
      briefId: input.briefId, kind: "proposal.accepted", actor: input.acceptedBy,
      body: input.note ?? `Accepted proposal version ${input.proposal.version}.`,
      data: { proposalId: input.proposal.id, fingerprint: input.proposal.fingerprint },
    });
    return toBinding(records.store.get("SELECT * FROM acceptance_bindings WHERE id = ?", id) as Row);
  });
}

export function invalidateAcceptance(records: Records, briefId: string, reason: string): AcceptanceBinding[] {
  const active = records.store.all("SELECT * FROM acceptance_bindings WHERE brief_id = ? AND state = 'active'", briefId).map(toBinding);
  for (const binding of active) {
    records.store.run(
      "UPDATE acceptance_bindings SET state = 'invalidated', invalidated_reason = ? WHERE id = ?", reason, binding.id,
    );
    records.store.run("UPDATE proposal_versions SET state = 'invalidated' WHERE id = ?", binding.proposalId);
    recordConversation(records, {
      briefId, kind: "acceptance.invalidated", actor: "system", body: reason,
      data: { acceptanceId: binding.id, proposalId: binding.proposalId },
    });
  }
  return active;
}

// --- bootstrap runs --------------------------------------------------------

export function createBootstrapRun(records: Records, input: {
  briefId: string;
  targetPath: string;
  steps: BootstrapStep[];
}): BootstrapRun {
  const id = ids.bootstrap();
  const at = nowIso();
  records.store.run(
    "INSERT INTO bootstrap_runs(id, brief_id, target_path, state, steps, created_at, updated_at) VALUES(?,?,?,'pending',?,?,?)",
    id, input.briefId, input.targetPath, toJson(input.steps), at, at,
  );
  recordConversation(records, { briefId: input.briefId, kind: "bootstrap.created", actor: "bootstrap", body: input.targetPath, data: { bootstrapId: id } });
  return getBootstrapRun(records, id) as BootstrapRun;
}

export function getBootstrapRun(records: Records, id: string): BootstrapRun | null {
  const row = records.store.get("SELECT * FROM bootstrap_runs WHERE id = ?", id);
  return row ? toBootstrapRun(row) : null;
}

export function listBootstrapRuns(records: Records, briefId: string): BootstrapRun[] {
  return records.store.all("SELECT * FROM bootstrap_runs WHERE brief_id = ? ORDER BY created_at", briefId).map(toBootstrapRun);
}

export function resumableBootstrapRun(records: Records, briefId: string, targetPath: string): BootstrapRun | null {
  return listBootstrapRuns(records, briefId).findLast((run) =>
    run.targetPath === targetPath && run.state !== "completed",
  ) ?? null;
}

export function updateBootstrapRun(records: Records, id: string, patch: Partial<Pick<BootstrapRun,
  "state" | "profile" | "profileResolution" | "environmentPlan" | "artifacts" | "steps" | "projectId" | "planId" | "error">>): BootstrapRun {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const columns: Record<string, string> = {
    state: "state", profile: "profile", profileResolution: "profile_resolution",
    environmentPlan: "environment_plan", artifacts: "artifacts", steps: "steps",
    projectId: "project_id", planId: "plan_id", error: "error",
  };
  for (const [field, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[field];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(["steps", "profileResolution", "environmentPlan", "artifacts"].includes(field) ? toJson(value) : value);
  }
  if (assignments.length === 0) return getBootstrapRun(records, id) as BootstrapRun;
  records.store.run(
    `UPDATE bootstrap_runs SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id,
  );
  return getBootstrapRun(records, id) as BootstrapRun;
}
