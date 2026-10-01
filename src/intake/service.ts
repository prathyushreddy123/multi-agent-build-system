/**
 * Product intake service.
 *
 * Pi supplies the conversational reasoning. This module supplies the parts that
 * must not be improvised: record validation, plan validation, expected-version
 * checks, and consent that is bound to one exact proposal version. A model can
 * propose; it cannot decide that the user agreed.
 */
import { applyExecutionPlan, requirementOwnershipErrors, validateExecutionPlan, type ExecutionPlan } from "../domain/plan.ts";
import { requireProjectReadiness } from "../domain/project-policy.ts";
import { normalizeReviewPolicy } from "../review/policy.ts";
import type { Records, Task } from "../store/records.ts";
import {
  activeAcceptance,
  addClarification,
  briefGovernance,
  conversationFor,
  getBrief,
  getClarification,
  getProposal,
  insertProposal,
  latestProposal,
  linkBriefProject,
  listAcceptances,
  listBootstrapRuns,
  listClarifications,
  listProposals,
  planSubmissions,
  proposalFingerprint,
  recordAcceptance,
  recordConversation,
  resolveBrief,
  resolveClarification,
  setBriefState,
  syncGovernanceClarifications,
  updateBrief,
} from "./store.ts";
import { insertIntakeRequest, matchIntakeRequest, requestHash } from "./requests.ts";
import { IntakeError } from "./errors.ts";
import type { AcceptanceBinding, BriefFieldPatch, ClarificationItem, ProductBrief, ProposalVersion } from "./types.ts";

export interface ProposalInput {
  summary: string;
  rationale: string;
  scope: string;
  outOfScope?: string[];
  requirements: { id: string; text: string; mandatory?: boolean }[];
  milestones?: string[];
  plan: ExecutionPlan;
}

export interface ProposalResult {
  proposal: ProposalVersion | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
  brief: ProductBrief;
}

function requireBrief(records: Records, value: string): ProductBrief {
  const brief = resolveBrief(records, value);
  if (!brief) throw new Error(`Unknown product brief: ${value}`);
  return brief;
}

function reuseLinkedProjectGovernance(records: Records, brief: ProductBrief): ProductBrief {
  if (brief.governanceDecisionId || !brief.projectId) return brief;
  const project = records.getProject(brief.projectId);
  if (!project || !records.readProjectReadiness(project.id).ready) return brief;
  const compatibleType = brief.projectType === null || brief.projectType === project.governance.projectType;
  const compatibleReview = brief.reviewChoice === null || brief.reviewChoice === project.governance.reviewChoice;
  if (!compatibleType || !compatibleReview || !project.governance.projectType || !project.governance.reviewChoice) return brief;
  records.recordProjectDecision({
    briefId: brief.id,
    projectType: project.governance.projectType,
    reviewChoice: project.governance.reviewChoice,
    actor: "system",
    source: "linked-project-decision",
    sourceRef: project.governance.decisionId,
  }, brief.governanceVersion);
  return getBrief(records, brief.id) as ProductBrief;
}

function fingerprintForBrief(brief: ProductBrief, proposal: Pick<ProposalVersion, "summary" | "requirements" | "plan">): string {
  return proposalFingerprint({
    briefId: brief.id,
    briefVersion: brief.version,
    governanceDecisionId: brief.governanceDecisionId,
    governanceVersion: brief.governanceVersion,
    projectType: brief.projectType,
    reviewChoice: brief.reviewChoice,
    summary: proposal.summary,
    requirements: proposal.requirements,
    plan: proposal.plan,
  });
}

/** What the conversation needs to answer a question: no timestamps or resolution fields. */
export interface ClarificationRecord {
  id: string;
  field: string | null;
  question: string;
  whyItMatters: string;
  state: ClarificationItem["state"];
  /** True when this call matched an open question already recorded for the same field. */
  reused?: boolean;
}

export function clarificationRecord(item: ClarificationItem, reused?: boolean): ClarificationRecord {
  return {
    id: item.id, field: item.field, question: item.question, whyItMatters: item.whyItMatters, state: item.state,
    ...(reused === undefined ? {} : { reused }),
  };
}

export interface AskClarificationsResult {
  brief: ProductBrief;
  briefId: string;
  briefVersion: number;
  /** Count of open questions on the brief, kept for older callers. */
  open: number;
  /** The records for exactly the questions in this call, in order, without duplicates. */
  requested: ClarificationRecord[];
  /** Every open question on the brief, including ones asked earlier. */
  openQuestions: ClarificationRecord[];
}

/** Ask only material questions, and record why each one matters. */
export function askClarifications(records: Records, input: {
  brief: string;
  questions: { question: string; whyItMatters: string; field?: string | null }[];
  actor?: string;
}): AskClarificationsResult {
  const brief = requireBrief(records, input.brief);
  if (input.questions.length === 0) throw new Error("Provide at least one question.");
  return records.store.tx(() => {
    const openBefore = new Set(listClarifications(records, brief.id, "open").map((item) => item.id));
    const requested = new Map<string, ClarificationRecord>();
    for (const question of input.questions) {
      const item = addClarification(records, { briefId: brief.id, ...question, actor: input.actor });
      if (!requested.has(item.id)) requested.set(item.id, clarificationRecord(item, openBefore.has(item.id)));
    }
    const updated = setBriefState(records, brief.id, "CLARIFYING", "Material unknowns were raised with the user.", input.actor ?? "agent");
    const openQuestions = listClarifications(records, brief.id, "open").map((item) => clarificationRecord(item));
    return {
      brief: updated, briefId: updated.id, briefVersion: updated.version,
      open: openQuestions.length, requested: [...requested.values()], openQuestions,
    };
  });
}

/**
 * Find a clarification for an answer, refusing an unknown ID or one that
 * belongs to a different brief with the IDs that would have been valid.
 */
export function requireClarification(records: Records, id: string, briefValue?: string | null): ClarificationItem {
  const brief = briefValue ? requireBrief(records, briefValue) : null;
  const openIds = (briefId: string) => listClarifications(records, briefId, "open").map((item) => item.id);
  const item = getClarification(records, id);
  if (!item) {
    throw new IntakeError(
      "unknown_clarification",
      brief
        ? `Unknown clarification ${id} for brief ${brief.id}; answer one of its open questions instead.`
        : `Unknown clarification ${id}; use the id returned by mabs_ask_clarifications, or list them with brief show <brief>.`,
      { clarificationId: id, ...(brief ? { briefId: brief.id, openClarificationIds: openIds(brief.id) } : {}) },
    );
  }
  if (brief && item.briefId !== brief.id) {
    throw new IntakeError(
      "clarification_brief_mismatch",
      `Clarification ${id} belongs to brief ${item.briefId}, not ${brief.id}.`,
      { clarificationId: id, briefId: brief.id, clarificationBriefId: item.briefId, openClarificationIds: openIds(brief.id) },
    );
  }
  return item;
}

export function answerClarification(records: Records, input: {
  id: string;
  brief?: string | null;
  answer?: string;
  assumption?: string;
  actor?: string;
}) {
  requireClarification(records, input.id, input.brief);
  return resolveClarification(records, input);
}

/**
 * Project governance was requested for something that is not a registered
 * project. A product brief records its own governance through a brief update;
 * this names that operation and the version it needs instead of a bare usage
 * error. Nothing is inferred from the value's name.
 */
export function wrongGovernanceSubject(records: Records, value: string): IntakeError {
  const brief = resolveBrief(records, value);
  if (brief) {
    return new IntakeError(
      "wrong_subject",
      `${value} is product brief ${brief.id}, not a registered project. Record its project type and review choice on the brief ` +
      "with mabs_update_brief (patch.projectType / patch.reviewChoice); project governance applies only after bootstrap or registration.",
      {
        subject: "brief", briefId: brief.id, briefVersion: brief.version, linkedProjectId: brief.projectId,
        operation: "mabs_update_brief",
        command: `brief update ${brief.id} --version=${brief.version} --summary=... --payload='{"projectType":...,"reviewChoice":...}'`,
      },
    );
  }
  return new IntakeError(
    "wrong_subject",
    `No registered project matches ${value}. For a product that is still a brief, use mabs_update_brief with ` +
    "patch.projectType and patch.reviewChoice; for an existing repository, register it as a project first.",
    { subject: "unknown", value, operation: "mabs_update_brief" },
  );
}

export interface IntakeResolution {
  clarificationId: string;
  /** The user's own words. Exactly one of answer or assumption. */
  answer?: string | null;
  /** An assumption disclosed to the user because they could not answer. */
  assumption?: string | null;
}

export interface ResolveIntakeInput {
  brief: string;
  expectedVersion: number;
  /** Caller-chosen id: an identical retry returns the recorded result. */
  requestId: string;
  resolutions?: IntakeResolution[];
  /** Explicit, already-interpreted brief fields. The service infers nothing. */
  patch?: BriefFieldPatch | null;
  /** Required with a patch: what changed and why. */
  summary?: string | null;
  /** Allow replacing an already-recorded answer or assumption with a different one. */
  revise?: boolean;
  actor?: string;
}

export interface ResolveIntakeResult {
  requestId: string;
  briefId: string;
  briefVersion: number;
  state: ProductBrief["state"];
  resolved: (ClarificationRecord & { answer: string | null; assumption: string | null; unchanged: boolean })[];
  changed: string[];
  invalidatedAcceptances: number;
  openQuestions: ClarificationRecord[];
  /** True when this is the recorded result of an earlier identical request. */
  replayed: boolean;
}

/**
 * Record several answers, and optionally an explicit brief change, as one
 * all-or-nothing request. Every part is checked before anything is written;
 * the answers, the brief revision, and the request record commit together.
 */
export function resolveIntake(records: Records, input: ResolveIntakeInput): ResolveIntakeResult {
  const requestId = input.requestId?.trim();
  if (!requestId) throw new IntakeError("invalid_resolution", "A request id is required so a retry cannot apply the answers twice.");
  const resolutions = input.resolutions ?? [];
  const patch = input.patch ?? null;
  if (resolutions.length === 0 && !patch) {
    throw new IntakeError("invalid_resolution", "Provide at least one answer or assumption, or an explicit brief change.");
  }
  const actor = input.actor ?? "agent";

  return records.store.tx(() => {
    const brief = requireBrief(records, input.brief);
    const payloadHash = requestHash("resolve", {
      briefId: brief.id, expectedVersion: input.expectedVersion, resolutions, patch,
      summary: input.summary ?? null, revise: input.revise === true,
    });
    const recorded = matchIntakeRequest<Record<string, unknown>, ResolveIntakeResult>(records, {
      requestId, briefId: brief.id, operation: "resolve", payloadHash,
    });
    if (recorded?.result) return { ...recorded.result, replayed: true };

    if (brief.version !== input.expectedVersion) {
      throw new IntakeError(
        "stale_version",
        `Brief ${brief.id} changed since version ${input.expectedVersion}; it is now at version ${brief.version}. ` +
        "Read the current brief before resolving again.",
        { briefId: brief.id, expectedVersion: input.expectedVersion, currentVersion: brief.version },
      );
    }
    if (patch && !input.summary?.trim()) {
      throw new IntakeError("invalid_resolution", "A brief change needs a one-line summary of what changed and why.");
    }

    // Validate every resolution before writing any of them.
    const seen = new Set<string>();
    const plan: { item: ClarificationItem; answer: string | null; assumption: string | null; unchanged: boolean }[] = [];
    for (const resolution of resolutions) {
      const id = resolution.clarificationId;
      if (seen.has(id)) throw new IntakeError("invalid_resolution", `Clarification ${id} appears more than once in this request.`, { clarificationId: id });
      seen.add(id);
      const item = requireClarification(records, id, brief.id);
      const answer = resolution.answer?.trim() || null;
      const assumption = resolution.assumption?.trim() || null;
      if ((answer === null) === (assumption === null)) {
        throw new IntakeError(
          "invalid_resolution",
          `Clarification ${id} needs exactly one of answer (the user's words) or assumption (disclosed to the user).`,
          { clarificationId: id },
        );
      }
      if (item.state === "withdrawn") {
        throw new IntakeError("invalid_resolution", `Clarification ${id} was withdrawn and cannot be answered.`, { clarificationId: id });
      }
      const unchanged = item.state !== "open" && item.answer === answer && item.assumption === assumption;
      if (item.state !== "open" && !unchanged && input.revise !== true) {
        throw new IntakeError(
          "already_resolved",
          `Clarification ${id} is already ${item.state}; set revise to replace the recorded ${item.answer !== null ? "answer" : "assumption"}.`,
          { clarificationId: id, state: item.state, answer: item.answer, assumption: item.assumption },
        );
      }
      plan.push({ item, answer, assumption, unchanged });
    }

    for (const entry of plan) {
      if (entry.unchanged) continue;
      resolveClarification(records, {
        id: entry.item.id, answer: entry.answer ?? undefined, assumption: entry.assumption ?? undefined,
        actor: entry.answer !== null ? (input.actor ?? "user") : actor,
      });
    }
    let changed: string[] = [];
    let invalidated: AcceptanceBinding[] = [];
    if (patch) {
      const update = updateBrief(records, {
        briefId: brief.id, expectedVersion: input.expectedVersion, patch, summary: input.summary as string, actor,
      });
      changed = update.changed;
      invalidated = update.invalidated;
    }

    const current = getBrief(records, brief.id) as ProductBrief;
    const result: ResolveIntakeResult = {
      requestId,
      briefId: current.id,
      briefVersion: current.version,
      state: current.state,
      resolved: plan.map((entry) => {
        const item = getClarification(records, entry.item.id) as ClarificationItem;
        return { ...clarificationRecord(item), answer: item.answer, assumption: item.assumption, unchanged: entry.unchanged };
      }),
      changed,
      invalidatedAcceptances: invalidated.length,
      openQuestions: listClarifications(records, brief.id, "open").map((item) => clarificationRecord(item)),
      replayed: false,
    };
    insertIntakeRequest(records, { requestId, briefId: brief.id, operation: "resolve", payloadHash, state: "completed", result });
    return result;
  });
}

/**
 * Persist a structured proposal and validate it before it is presented. An
 * invalid plan is never stored as a presentable proposal.
 */
export function proposePlan(records: Records, input: ProposalInput & { brief: string; actor?: string }): ProposalResult {
  const brief = requireBrief(records, input.brief);
  const actor = input.actor ?? "agent";
  syncGovernanceClarifications(records, brief.id, actor);
  const errors: string[] = [];
  if (!input.summary?.trim()) errors.push("The proposal needs a short summary the user can accept or change.");
  if (!input.rationale?.trim()) errors.push("The proposal needs a rationale.");
  if (!input.scope?.trim()) errors.push("The proposal needs an explicit scope statement.");
  const requirements = (Array.isArray(input.requirements) ? input.requirements : []).map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
    mandatory: requirement.mandatory ?? true,
  }));
  if (requirements.length === 0) errors.push("The proposal needs at least one requirement with a stable ID.");
  for (const requirement of requirements) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(requirement.id ?? "")) errors.push(`Requirement ID is not a stable identifier: ${String(requirement.id)}`);
    if (!requirement.text?.trim()) errors.push(`Requirement ${requirement.id} has no text.`);
  }
  const duplicateIds = requirements.map((requirement) => requirement.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) errors.push(`Duplicate requirement IDs: ${[...new Set(duplicateIds)].join(", ")}`);

  const validation = validateExecutionPlan(input.plan);
  errors.push(...validation.errors);
  if (validation.valid) errors.push(...requirementOwnershipErrors(input.plan, requirements));

  const openQuestions = listClarifications(records, brief.id, "open");
  const warnings = [...validation.warnings];
  if (openQuestions.length > 0) {
    // Name a few; the rest are listed, with ids, by `brief show <brief> --section=open-questions`.
    const named = openQuestions.slice(0, 5).map((item) => `${item.question} (${item.id})`);
    const more = openQuestions.length - named.length;
    warnings.push(
      `${openQuestions.length} material question(s) are still unanswered: ${named.join(" | ")}` +
      `${more > 0 ? ` | and ${more} more (brief show ${brief.id} --section=open-questions)` : ""}. ` +
      "Answer them, or record an explicit assumption, before this plan is executed.",
    );
  }

  if (errors.length > 0) {
    recordConversation(records, {
      briefId: brief.id, kind: "proposal.rejected", actor,
      body: "The proposed plan did not validate.", data: { errors },
    });
    records.recordEvent({ kind: "intake.proposal_invalid", data: { briefId: brief.id, errors } });
    return { proposal: null, valid: false, errors: [...new Set(errors)], warnings, brief };
  }

  const fingerprint = proposalFingerprint({
    briefId: brief.id,
    briefVersion: brief.version,
    governanceDecisionId: brief.governanceDecisionId,
    governanceVersion: brief.governanceVersion,
    projectType: brief.projectType,
    reviewChoice: brief.reviewChoice,
    summary: input.summary,
    requirements,
    plan: input.plan,
  });
  return records.store.tx(() => {
    const proposal = insertProposal(records, {
      briefId: brief.id,
      briefVersion: brief.version,
      summary: input.summary.trim(),
      rationale: input.rationale.trim(),
      scope: input.scope.trim(),
      outOfScope: input.outOfScope ?? [],
      requirements,
      milestones: input.milestones ?? [],
      plan: input.plan,
      validation: { ...validation, warnings },
      fingerprint,
      actor,
    });
    const updated = setBriefState(records, brief.id, "PROPOSED", "A validated plan is waiting for the user's decision.", actor);
    return { proposal, valid: true, errors: [], warnings, brief: updated };
  });
}

/**
 * Bind a recorded user decision to one exact proposal version. The caller must
 * echo back the proposal's fingerprint, so an agent cannot accept a plan the
 * user never saw, and a stale proposal cannot be accepted after a revision.
 */
export function acceptPlan(records: Records, input: {
  brief: string;
  proposalId: string;
  fingerprint: string;
  acceptedBy: string;
  note?: string | null;
}): { brief: ProductBrief; proposal: ProposalVersion; acceptance: ReturnType<typeof recordAcceptance> } {
  const brief = reuseLinkedProjectGovernance(records, requireBrief(records, input.brief));
  syncGovernanceClarifications(records, brief.id, input.acceptedBy || "user");
  requireProjectReadiness({ kind: "brief", id: brief.id }, briefGovernance(brief));
  const proposal = getProposal(records, input.proposalId);
  if (!proposal || proposal.briefId !== brief.id) throw new Error(`Unknown proposal ${input.proposalId} for brief ${brief.id}`);
  if (fingerprintForBrief(brief, proposal) !== proposal.fingerprint) {
    throw new Error("This proposal was invalidated because project governance changed after it was prepared; create and present a fresh proposal before acceptance.");
  }
  const acceptedBy = input.acceptedBy?.trim();
  const nonPeople = new Set(["agent", "assistant", "model", "system", "pi", "pi-conversation"]);
  if (!acceptedBy || nonPeople.has(acceptedBy.toLowerCase())) {
    throw new Error("Acceptance must record the person who decided; an agent cannot accept on the user's behalf.");
  }
  if (proposal.fingerprint !== input.fingerprint) {
    throw new Error(
      `Proposal ${proposal.id} has changed since it was presented. Present the current version and ask again ` +
      "rather than accepting a plan the user did not see.",
    );
  }
  if (proposal.state === "superseded" || proposal.state === "invalidated") {
    throw new Error(`Proposal version ${proposal.version} is ${proposal.state}; present the current proposal before accepting.`);
  }
  if (proposal.briefVersion !== brief.version) {
    throw new Error(
      `This proposal was built from brief version ${proposal.briefVersion}, but the brief is now at version ${brief.version}. ` +
      "Propose again against the current brief.",
    );
  }
  if (!proposal.validation.valid) throw new Error("This proposal did not validate and cannot be accepted.");
  const existing = activeAcceptance(records, brief.id);
  if (existing) {
    if (existing.proposalId === proposal.id && existing.proposalFingerprint === proposal.fingerprint && existing.acceptedBy === acceptedBy) {
      return { brief, proposal, acceptance: existing };
    }
    throw new Error(`Brief ${brief.id} already has an active acceptance; revise the brief before accepting a different plan.`);
  }

  return records.store.tx(() => {
    const acceptance = recordAcceptance(records, { briefId: brief.id, proposal, acceptedBy, note: input.note ?? null });
    const updated = setBriefState(records, brief.id, "ACCEPTED", `Accepted by ${acceptedBy}.`, acceptedBy);
    records.recordEvent({ kind: "intake.plan_accepted", data: { briefId: brief.id, proposalId: proposal.id, acceptedBy } });
    return { brief: updated, proposal: getProposal(records, proposal.id) as ProposalVersion, acceptance };
  });
}

/**
 * Apply the accepted, validated plan to the registered project. No hand-written
 * plan JSON is involved: the stored proposal is the source.
 */
export function submitAcceptedPlan(records: Records, input: {
  brief: string;
  projectId?: string;
  actor?: string;
}): { brief: ProductBrief; projectId: string; tasks: Task[]; requirements: number; planId: string | null } {
  const brief = reuseLinkedProjectGovernance(records, requireBrief(records, input.brief));
  const acceptance = activeAcceptance(records, brief.id);
  if (!acceptance) throw new Error(`Brief ${brief.id} has no active acceptance; ask the user to accept a proposal first.`);
  const proposal = getProposal(records, acceptance.proposalId);
  if (!proposal) throw new Error(`Accepted proposal ${acceptance.proposalId} is missing.`);
  if (fingerprintForBrief(brief, proposal) !== proposal.fingerprint) {
    throw new Error("Project governance changed after this proposal was prepared; create and accept a fresh proposal before submission.");
  }
  if (proposal.fingerprint !== acceptance.proposalFingerprint) {
    throw new Error("The accepted proposal no longer matches the recorded acceptance; ask the user to accept the current plan.");
  }
  const projectId = input.projectId ?? brief.projectId;
  if (!projectId) throw new Error(`Brief ${brief.id} is not linked to a registered project yet; bootstrap or register one first.`);
  const project = records.getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  requireProjectReadiness({ kind: "brief", id: brief.id }, briefGovernance(brief));
  requireProjectReadiness({ kind: "project", id: project.id }, project.governance, project.reviewPolicy);
  if (brief.projectType !== project.governance.projectType || brief.reviewChoice !== project.governance.reviewChoice) {
    throw new Error(
      `Brief ${brief.id} governance (${brief.projectType}/${brief.reviewChoice}) conflicts with project ${project.id} ` +
      `governance (${project.governance.projectType}/${project.governance.reviewChoice}); record an explicit compatible decision before submission.`,
    );
  }

  const priorSubmission = planSubmissions(records, brief.id).find((submission) =>
    submission.proposalId === proposal.id && submission.projectId === project.id,
  );
  if (priorSubmission) {
    const tasks = priorSubmission.taskIds.map((id) => records.getTask(id)).filter((task): task is Task => task !== null);
    if (tasks.length !== priorSubmission.taskIds.length) {
      throw new Error(`The prior submission for proposal ${proposal.id} is incomplete; repair its recorded task linkage instead of duplicating work.`);
    }
    return {
      brief,
      projectId: project.id,
      tasks,
      requirements: proposal.requirements.length,
      planId: priorSubmission.planId,
    };
  }

  const revalidation = validateExecutionPlan(proposal.plan);
  if (!revalidation.valid) throw new Error(`The accepted plan no longer validates:\n${revalidation.errors.join("\n")}`);

  return records.store.tx(() => {
    if (brief.projectId !== project.id) linkBriefProject(records, brief.id, project.id);
    for (const requirement of proposal.requirements) {
      records.addRequirement(project.id, requirement.id, requirement.text, requirement.mandatory);
    }
    const tasks = applyExecutionPlan(records, project.id, proposal.plan);
    const planId = records.listExecutionPlans(project.id).at(-1)?.id ?? null;
    records.recordEvent({
      kind: "plan.applied",
      projectId: project.id,
      data: {
        source: "intake", briefId: brief.id, proposalId: proposal.id, planId,
        mode: proposal.plan.mode, reason: proposal.plan.reason, taskIds: tasks.map((task) => task.id),
      },
    });
    recordConversation(records, {
      briefId: brief.id, kind: "plan.submitted", actor: input.actor ?? "agent",
      body: `Submitted ${tasks.length} task(s) to ${project.name}.`,
      data: { projectId: project.id, proposalId: proposal.id, planId, taskIds: tasks.map((task) => task.id) },
    });
    const updated = setBriefState(records, brief.id, "REGISTERED", "The accepted plan was applied to the registered project.", input.actor ?? "agent");
    return { brief: updated, projectId: project.id, tasks, requirements: proposal.requirements.length, planId };
  });
}

export interface ProductSummary {
  brief: ProductBrief;
  governance: ReturnType<Records["readProjectReadiness"]>;
  resolvedReviewPolicy: string | null;
  openQuestions: { id: string; question: string; whyItMatters: string }[];
  assumptions: string[];
  proposal: {
    id: string; version: number; state: string; summary: string; fingerprint: string; tasks: number; valid: boolean;
  } | null;
  acceptance: { id: string; proposalVersion: number; acceptedBy: string; state: string; at: string } | null;
  project: { id: string; name: string; repoPath: string; reviewPreset: string } | null;
  work: {
    total: number;
    byState: Record<string, number>;
    notStarted: string[];
    inProgress: string[];
    completed: string[];
  };
  outputs: { taskId: string; title: string; revision: string | null; summary: string | null }[];
  bootstrap: { id: string; state: string; targetPath: string; error: string | null } | null;
  nextActions: string[];
}

/** One concise, honest answer to "where is my product?". */
export function productSummary(records: Records, value: string): ProductSummary {
  const brief = requireBrief(records, value);
  const open = listClarifications(records, brief.id, "open");
  const proposal = latestProposal(records, brief.id);
  const acceptance = activeAcceptance(records, brief.id);
  const project = brief.projectId ? records.getProject(brief.projectId) : null;
  const governance = project ? records.readProjectReadiness(project.id) : records.readProjectReadiness({ briefId: brief.id });
  const tasks = project ? records.listTasks({ projectId: project.id }) : [];
  const byState: Record<string, number> = {};
  for (const task of tasks) byState[task.state] = (byState[task.state] ?? 0) + 1;
  const bootstrap = listBootstrapRuns(records, brief.id).at(-1) ?? null;

  const nextActions: string[] = [];
  if (!governance.ready) {
    nextActions.push(...governance.questions.map((question) => question.prompt));
    nextActions.push(...governance.conflicts);
  }
  if (open.length > 0) nextActions.push(`Answer ${open.length} open question(s), or record an explicit assumption for each.`);
  if (!proposal || proposal.state === "invalidated" || proposal.state === "superseded") {
    nextActions.push("Propose a plan against the current brief for the user to review afresh.");
  } else if (!acceptance && proposal.state === "presented") {
    nextActions.push(`Ask the user to accept or change proposal version ${proposal.version}.`);
  }
  if (acceptance && !project) nextActions.push("Bootstrap the accepted product in a directory the user chooses.");
  if (acceptance && project && tasks.length === 0) nextActions.push("Submit the accepted plan to the registered project.");
  if (bootstrap && bootstrap.state === "failed") nextActions.push(`Resume bootstrap ${bootstrap.id}: ${bootstrap.error ?? "see recorded steps"}.`);
  const blocked = tasks.filter((task) => task.state === "BLOCKED" || task.state === "FAILED");
  if (blocked.length > 0) {
    // A summary line, not the record: the first line of each reason; `task show` has the rest.
    const reason = (task: Task) => {
      const first = (task.blockedReason ?? task.state).split("\n")[0] as string;
      return first.length > 160 ? `${first.slice(0, 157)}...` : first;
    };
    const named = blocked.slice(0, 5).map((task) => `${task.id} (${reason(task)})`);
    const more = blocked.length - named.length;
    nextActions.push(
      `${blocked.length} task(s) need attention: ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}. ` +
      "Use task show <task> for the full reason.",
    );
  }
  const queued = tasks.filter((task) => task.state === "QUEUED" || task.state === "READY");
  if (queued.length > 0) nextActions.push(`${queued.length} accepted task(s) are queued for controller execution.`);
  if (nextActions.length === 0) nextActions.push("No outstanding intake decisions or queued work.");

  return {
    brief,
    governance,
    resolvedReviewPolicy: project ? normalizeReviewPolicy(project.reviewPolicy).preset : brief.qualitySettings.reviewPreset,
    openQuestions: open.map((item) => ({ id: item.id, question: item.question, whyItMatters: item.whyItMatters })),
    assumptions: [
      ...brief.assumptions,
      ...listClarifications(records, brief.id, "assumed").map((item) => `${item.question} -> assumed: ${item.assumption ?? ""}`),
    ],
    proposal: proposal
      ? {
          id: proposal.id, version: proposal.version, state: proposal.state, summary: proposal.summary,
          fingerprint: proposal.fingerprint, tasks: proposal.plan.tasks.length, valid: proposal.validation.valid,
        }
      : null,
    acceptance: acceptance
      ? { id: acceptance.id, proposalVersion: acceptance.proposalVersion, acceptedBy: acceptance.acceptedBy, state: acceptance.state, at: acceptance.createdAt }
      : null,
    project: project
      ? { id: project.id, name: project.name, repoPath: project.repoPath, reviewPreset: project.reviewPolicy.preset }
      : null,
    work: {
      total: tasks.length,
      byState,
      notStarted: tasks.filter((task) => task.state === "QUEUED" || task.state === "READY").map((task) => task.id),
      inProgress: tasks.filter((task) => ["RUNNING", "CHECKING", "REVIEWING", "AWAITING_APPROVAL"].includes(task.state)).map((task) => task.id),
      completed: tasks.filter((task) => task.state === "DONE").map((task) => task.id),
    },
    outputs: tasks
      .filter((task) => task.state === "DONE")
      .map((task) => ({ taskId: task.id, title: task.title, revision: task.resultRevision, summary: task.resultSummary })),
    bootstrap: bootstrap ? { id: bootstrap.id, state: bootstrap.state, targetPath: bootstrap.targetPath, error: bootstrap.error } : null,
    nextActions,
  };
}

export function briefDetail(records: Records, value: string) {
  const brief = requireBrief(records, value);
  return {
    brief,
    clarifications: listClarifications(records, brief.id),
    proposals: listProposals(records, brief.id).map((proposal) => ({
      ...proposal,
      plan: { ...proposal.plan, tasks: proposal.plan.tasks.map((task) => ({ key: task.key, title: task.title, dependsOn: task.dependsOn ?? [] })) },
    })),
    acceptances: listAcceptances(records, brief.id),
    bootstrapRuns: listBootstrapRuns(records, brief.id),
    conversation: conversationFor(records, brief.id),
  };
}

export { getBrief, listClarifications, listProposals };
