/**
 * Conversation views of intake results.
 *
 * The full records stay the CLI's default output and the source of truth. A
 * conversation view keeps what the model needs to decide its next step (ids,
 * versions, fingerprints, states, decisions, warnings, next actions) and pages
 * any list that grows with the product, saying how many items were omitted and
 * how to read them. Nothing is cut in the middle of a record.
 */
import type { Records, Task } from "../store/records.ts";
import type {
  AskClarificationsResult,
  ClarificationRecord,
  ProductSummary,
  ProposalResult,
  ResolveIntakeResult,
} from "./service.ts";
import type { StartAcceptedWorkResult } from "./start.ts";
import { latestProposal, listClarifications, resolveBrief } from "./store.ts";
import type { AcceptanceBinding, ProductBrief, ProposalVersion } from "./types.ts";

/** Items per page. Sized from measured responses (see docs/plans/mabs-efficiency-implementation.md, OUT-01). */
export const VIEW_PAGE_SIZE = { questions: 10, tasks: 20, list: 10 } as const;

export interface Page<T> {
  shown: T[];
  total: number;
  omitted: number;
  /** The command that returns the next page, when anything was omitted. */
  more: string | null;
}

export function page<T>(items: T[], size: number, more: (page: number) => string, index = 1): Page<T> {
  const start = (index - 1) * size;
  const shown = items.slice(start, start + size);
  const omitted = Math.max(0, items.length - start - shown.length);
  return { shown, total: items.length, omitted, more: omitted > 0 ? more(index + 1) : null };
}

export type BriefSection = "open-questions" | "proposal-tasks" | "tasks" | "outputs" | "assumptions";
export const BRIEF_SECTIONS: BriefSection[] = ["open-questions", "proposal-tasks", "tasks", "outputs", "assumptions"];

const moreOf = (briefId: string, section: BriefSection) => (index: number) => `brief show ${briefId} --section=${section} --page=${index}`;

const question = (item: Pick<ClarificationRecord, "id" | "field" | "question">) => ({ id: item.id, field: item.field, question: item.question });
const taskLine = (task: Pick<Task, "id" | "title" | "state">) => ({ id: task.id, title: task.title, state: task.state });

export function askView(result: AskClarificationsResult) {
  const requestedIds = new Set(result.requested.map((item) => item.id));
  return {
    briefId: result.briefId,
    briefVersion: result.briefVersion,
    state: result.brief.state,
    // Every record from this call, so each id can be answered immediately.
    requested: result.requested.map((item) => ({ ...question(item), reused: item.reused ?? false })),
    open: result.open,
    otherOpenQuestions: page(
      result.openQuestions.filter((item) => !requestedIds.has(item.id)).map(question),
      VIEW_PAGE_SIZE.questions, moreOf(result.briefId, "open-questions"),
    ),
  };
}

export function resolveView(result: ResolveIntakeResult) {
  return {
    requestId: result.requestId,
    replayed: result.replayed,
    briefId: result.briefId,
    briefVersion: result.briefVersion,
    state: result.state,
    resolved: result.resolved.map((item) => ({ id: item.id, state: item.state, unchanged: item.unchanged })),
    changed: result.changed,
    invalidatedAcceptances: result.invalidatedAcceptances,
    openQuestions: page(result.openQuestions.map(question), VIEW_PAGE_SIZE.questions, moreOf(result.briefId, "open-questions")),
  };
}

export function proposeView(result: ProposalResult) {
  const proposal = result.proposal;
  return {
    briefId: result.brief.id,
    briefVersion: result.brief.version,
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    proposal: proposal
      ? {
          id: proposal.id, version: proposal.version, state: proposal.state, fingerprint: proposal.fingerprint,
          summary: proposal.summary, requirements: proposal.requirements.length,
          // The model wrote the plan; it needs the stored keys back, not the whole plan.
          tasks: page(
            proposal.plan.tasks.map((task) => ({ key: task.key, title: task.title, dependsOn: task.dependsOn ?? [] })),
            VIEW_PAGE_SIZE.tasks, moreOf(result.brief.id, "proposal-tasks"),
          ),
        }
      : null,
  };
}

export function acceptView(result: { brief: ProductBrief; proposal: ProposalVersion; acceptance: AcceptanceBinding }) {
  return {
    briefId: result.brief.id,
    briefVersion: result.brief.version,
    state: result.brief.state,
    proposal: { id: result.proposal.id, version: result.proposal.version, fingerprint: result.proposal.fingerprint },
    acceptance: { id: result.acceptance.id, acceptedBy: result.acceptance.acceptedBy, state: result.acceptance.state },
  };
}

export function startView(result: StartAcceptedWorkResult) {
  return {
    ...result,
    tasks: page(result.tasks, VIEW_PAGE_SIZE.tasks, moreOf(result.briefId, "tasks")),
  };
}

export function productView(summary: ProductSummary) {
  const briefId = summary.brief.id;
  const list = (items: string[], section: BriefSection) => page(items, VIEW_PAGE_SIZE.list, moreOf(briefId, section));
  return {
    brief: { id: briefId, title: summary.brief.title, state: summary.brief.state, version: summary.brief.version },
    governance: {
      ready: summary.governance.ready,
      missing: summary.governance.missing,
      conflicts: summary.governance.conflicts,
      questions: summary.governance.questions.map((item) => item.prompt),
    },
    resolvedReviewPolicy: summary.resolvedReviewPolicy,
    openQuestions: page(summary.openQuestions.map((item) => ({ id: item.id, question: item.question })), VIEW_PAGE_SIZE.questions, moreOf(briefId, "open-questions")),
    assumptions: list(summary.assumptions, "assumptions"),
    proposal: summary.proposal,
    acceptance: summary.acceptance,
    project: summary.project,
    work: {
      total: summary.work.total,
      byState: summary.work.byState,
      inProgress: page(summary.work.inProgress, VIEW_PAGE_SIZE.tasks, moreOf(briefId, "tasks")),
    },
    outputs: page(
      summary.outputs.map((output) => ({ taskId: output.taskId, title: output.title, revision: output.revision })),
      VIEW_PAGE_SIZE.list, moreOf(briefId, "outputs"),
    ),
    bootstrap: summary.bootstrap,
    nextActions: page(summary.nextActions, VIEW_PAGE_SIZE.list, () => `product show ${briefId}`),
  };
}

/** One page of a long brief list, for detail the conversation view omitted. */
export function briefSection(records: Records, value: string, section: BriefSection, index: number, size?: number) {
  const brief = resolveBrief(records, value);
  if (!brief) throw new Error(`Unknown product brief: ${value}`);
  if (!BRIEF_SECTIONS.includes(section)) throw new Error(`Unknown section ${section}; use one of ${BRIEF_SECTIONS.join(", ")}.`);
  if (!Number.isSafeInteger(index) || index < 1) throw new Error("--page must be a positive integer.");
  const more = moreOf(brief.id, section);
  const tasks = brief.projectId ? records.listTasks({ projectId: brief.projectId }) : [];
  const items: unknown[] = section === "open-questions"
    ? listClarifications(records, brief.id, "open").map((item) => ({ id: item.id, field: item.field, question: item.question, whyItMatters: item.whyItMatters }))
    : section === "proposal-tasks"
      ? (latestProposal(records, brief.id)?.plan.tasks ?? []).map((task) => ({
          key: task.key, title: task.title, objective: task.objective, dependsOn: task.dependsOn ?? [],
        }))
    : section === "tasks"
      ? tasks.map(taskLine)
      : section === "outputs"
        ? tasks.filter((task) => task.state === "DONE").map((task) => ({ taskId: task.id, title: task.title, revision: task.resultRevision, summary: task.resultSummary }))
        : [
            ...brief.assumptions,
            ...listClarifications(records, brief.id, "assumed").map((item) => `${item.question} -> assumed: ${item.assumption ?? ""}`),
          ];
  return { briefId: brief.id, section, page: index, ...page(items, size ?? VIEW_PAGE_SIZE.list, more, index) };
}
