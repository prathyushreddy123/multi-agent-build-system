/**
 * Product intake service.
 *
 * Pi supplies the conversational reasoning. This module supplies the parts that
 * must not be improvised: record validation, plan validation, expected-version
 * checks, and consent that is bound to one exact proposal version. A model can
 * propose; it cannot decide that the user agreed.
 */
import { applyExecutionPlan, validateExecutionPlan, type ExecutionPlan } from "../domain/plan.ts";
import { normalizeReviewPolicy, reviewPreset, type ReviewPreset } from "../review/policy.ts";
import type { Records, Task } from "../store/records.ts";
import {
  activeAcceptance,
  addClarification,
  conversationFor,
  getBrief,
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
} from "./store.ts";
import type { ProductBrief, ProposalVersion } from "./types.ts";

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

/** Ask only material questions, and record why each one matters. */
export function askClarifications(records: Records, input: {
  brief: string;
  questions: { question: string; whyItMatters: string; field?: string | null }[];
  actor?: string;
}): { brief: ProductBrief; open: number } {
  const brief = requireBrief(records, input.brief);
  if (input.questions.length === 0) throw new Error("Provide at least one question.");
  return records.store.tx(() => {
    for (const question of input.questions) {
      addClarification(records, { briefId: brief.id, ...question, actor: input.actor });
    }
    const updated = setBriefState(records, brief.id, "CLARIFYING", "Material unknowns were raised with the user.", input.actor ?? "agent");
    return { brief: updated, open: listClarifications(records, brief.id, "open").length };
  });
}

export function answerClarification(records: Records, input: {
  id: string;
  answer?: string;
  assumption?: string;
  actor?: string;
}) {
  return resolveClarification(records, input);
}

/**
 * Persist a structured proposal and validate it before it is presented. An
 * invalid plan is never stored as a presentable proposal.
 */
export function proposePlan(records: Records, input: ProposalInput & { brief: string; actor?: string }): ProposalResult {
  const brief = requireBrief(records, input.brief);
  const actor = input.actor ?? "agent";
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

  const openQuestions = listClarifications(records, brief.id, "open");
  const warnings = [...validation.warnings];
  if (openQuestions.length > 0) {
    warnings.push(
      `${openQuestions.length} material question(s) are still unanswered: ${openQuestions.map((item) => item.question).join(" | ")}. ` +
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
    briefId: brief.id, briefVersion: brief.version, summary: input.summary, requirements, plan: input.plan,
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
  const brief = requireBrief(records, input.brief);
  const proposal = getProposal(records, input.proposalId);
  if (!proposal || proposal.briefId !== brief.id) throw new Error(`Unknown proposal ${input.proposalId} for brief ${brief.id}`);
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
  const brief = requireBrief(records, input.brief);
  const acceptance = activeAcceptance(records, brief.id);
  if (!acceptance) throw new Error(`Brief ${brief.id} has no active acceptance; ask the user to accept a proposal first.`);
  const proposal = getProposal(records, acceptance.proposalId);
  if (!proposal) throw new Error(`Accepted proposal ${acceptance.proposalId} is missing.`);
  if (proposal.fingerprint !== acceptance.proposalFingerprint) {
    throw new Error("The accepted proposal no longer matches the recorded acceptance; ask the user to accept the current plan.");
  }
  const projectId = input.projectId ?? brief.projectId;
  if (!projectId) throw new Error(`Brief ${brief.id} is not linked to a registered project yet; bootstrap or register one first.`);
  const project = records.getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);

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
    const preset = brief.qualitySettings.reviewPreset;
    if (preset && preset !== "custom" && project.reviewPolicy.preset !== preset) {
      records.setProjectReviewPolicy(project.id, reviewPreset(preset as Exclude<ReviewPreset, "custom">), {
        reason: `Review preset agreed during intake for brief ${brief.id}.`,
        acknowledgeWeakening: true,
        changedBy: input.actor ?? "intake",
      });
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
  const tasks = project ? records.listTasks({ projectId: project.id }) : [];
  const byState: Record<string, number> = {};
  for (const task of tasks) byState[task.state] = (byState[task.state] ?? 0) + 1;
  const bootstrap = listBootstrapRuns(records, brief.id).at(-1) ?? null;

  const nextActions: string[] = [];
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
  if (blocked.length > 0) nextActions.push(`${blocked.length} task(s) need attention: ${blocked.map((task) => `${task.id} (${task.blockedReason ?? task.state})`).join("; ")}`);
  const queued = tasks.filter((task) => task.state === "QUEUED" || task.state === "READY");
  if (queued.length > 0) nextActions.push(`${queued.length} accepted task(s) are queued for controller execution.`);
  if (nextActions.length === 0) nextActions.push("No outstanding intake decisions or queued work.");

  return {
    brief,
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
