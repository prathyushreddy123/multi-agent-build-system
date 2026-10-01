/**
 * Start accepted work in one resumable operation.
 *
 * This composes what already exists rather than adding a workflow: exact
 * acceptance is checked here, a new directory goes through the restartable
 * bootstrap (which links the accepted plan as its last step), and an existing
 * registered project goes through the idempotent plan submission. Filesystem
 * and Git effects cannot be rolled back by a database transaction, so the
 * request records durable checkpoints and a retry continues from them.
 */
import { resolve } from "node:path";

import { bootstrapProject, type BootstrapStepName } from "../bootstrap/service.ts";
import type { PackageManager, ProfileKind } from "../profiles/index.ts";
import type { Records, Task } from "../store/records.ts";
import { IntakeError } from "./errors.ts";
import { getIntakeRequest, insertIntakeRequest, matchIntakeRequest, requestHash, updateIntakeRequest } from "./requests.ts";
import { submitAcceptedPlan } from "./service.ts";
import { activeAcceptance, getBrief, listBootstrapRuns, resolveBrief } from "./store.ts";
import type { ProductBrief } from "./types.ts";

export type StartDestination =
  | { kind: "new_directory"; targetPath: string }
  | { kind: "registered_project"; project: string };

export interface StartAcceptedWorkInput {
  brief: string;
  /** The proposal the user accepted, exactly as presented. */
  proposalId: string;
  fingerprint: string;
  destination: StartDestination;
  requestId: string;
  profile?: ProfileKind | "auto";
  packageManager?: PackageManager;
  language?: string | null;
  runtime?: string | null;
  projectName?: string;
  actor?: string;
  /** Deterministic interruption injection for recovery tests; not exposed by the CLI or Pi. */
  interruptAt?: "validated" | "bootstrapped" | { bootstrapStep: BootstrapStepName };
}

interface StartProgress {
  phase: "validated" | "bootstrapped" | "submitted";
  proposalId: string;
  fingerprint: string;
  governanceDecisionId: string | null;
  governanceVersion: number;
  bootstrapId?: string | null;
  projectId?: string | null;
  planId?: string | null;
  taskIds?: string[];
}

export interface StartAcceptedWorkResult {
  requestId: string;
  status: "completed" | "interrupted";
  /** True when retrying the same request continues from recorded progress. */
  resumable: boolean;
  briefId: string;
  briefState: ProductBrief["state"];
  projectId: string | null;
  bootstrapId: string | null;
  planId: string | null;
  tasks: { id: string; title: string; state: string }[];
  error: string | null;
  nextActions: string[];
  replayed: boolean;
}

function requireAcceptedBrief(records: Records, value: string): ProductBrief {
  const brief = resolveBrief(records, value);
  if (!brief) throw new Error(`Unknown product brief: ${value}`);
  return brief;
}

/** Refuse unless the active acceptance is exactly the proposal and fingerprint the caller names. */
function requireExactAcceptance(records: Records, brief: ProductBrief, proposalId: string, fingerprint: string): void {
  const acceptance = activeAcceptance(records, brief.id);
  if (!acceptance) {
    throw new IntakeError(
      "stale_start",
      `Brief ${brief.id} has no active acceptance. Present the current proposal and record the user's acceptance first; ` +
      "starting work never accepts a plan.",
      { briefId: brief.id, reason: "not_accepted" },
    );
  }
  if (acceptance.proposalId !== proposalId || acceptance.proposalFingerprint !== fingerprint) {
    throw new IntakeError(
      "stale_start",
      `The accepted plan for brief ${brief.id} is proposal ${acceptance.proposalId}, not the one named. ` +
      "Present the accepted proposal again rather than starting a plan the user did not accept.",
      { briefId: brief.id, reason: "proposal_changed", acceptedProposalId: acceptance.proposalId },
    );
  }
}

function summarizeTasks(tasks: Task[]) {
  return tasks.map((task) => ({ id: task.id, title: task.title, state: task.state }));
}

function interrupted(at: string): never {
  throw new Error(`Injected interruption after ${at}.`);
}

export function startAcceptedWork(records: Records, input: StartAcceptedWorkInput): StartAcceptedWorkResult {
  const requestId = input.requestId?.trim();
  if (!requestId) throw new IntakeError("invalid_resolution", "A request id is required so a retry resumes instead of starting twice.");
  const brief = requireAcceptedBrief(records, input.brief);
  const actor = input.actor ?? "agent";
  const payloadHash = requestHash("start", {
    briefId: brief.id, proposalId: input.proposalId, fingerprint: input.fingerprint, destination: input.destination,
    profile: input.profile ?? "auto", packageManager: input.packageManager ?? null, language: input.language ?? null,
    runtime: input.runtime ?? null, projectName: input.projectName ?? null,
  });

  // Claim the request id, or find the progress an earlier attempt recorded.
  const claimed = records.store.tx(() => {
    const recorded = matchIntakeRequest<StartProgress, StartAcceptedWorkResult>(records, {
      requestId, briefId: brief.id, operation: "start", payloadHash,
    });
    if (recorded) return recorded;
    requireExactAcceptance(records, brief, input.proposalId, input.fingerprint);
    const progress: StartProgress = {
      phase: "validated", proposalId: input.proposalId, fingerprint: input.fingerprint,
      governanceDecisionId: brief.governanceDecisionId, governanceVersion: brief.governanceVersion,
    };
    insertIntakeRequest(records, { requestId, briefId: brief.id, operation: "start", payloadHash, state: "in_progress", progress });
    return getIntakeRequest<StartProgress, StartAcceptedWorkResult>(records, requestId)!;
  });
  if (claimed.state === "completed" && claimed.result) return { ...claimed.result, replayed: true };

  // A retry must still be the work the user accepted, under the same governance.
  const progress: StartProgress = { ...claimed.progress };
  const current = getBrief(records, brief.id) as ProductBrief;
  if (progress.phase !== "submitted") {
    requireExactAcceptance(records, current, progress.proposalId, progress.fingerprint);
    if (current.governanceDecisionId !== progress.governanceDecisionId || current.governanceVersion !== progress.governanceVersion) {
      throw new IntakeError(
        "stale_start",
        `Project governance for brief ${brief.id} changed after this start was requested; confirm the plan again before starting.`,
        { briefId: brief.id, reason: "governance_changed" },
      );
    }
  }

  const checkpoint = (patch: Partial<StartProgress>) => {
    Object.assign(progress, patch);
    updateIntakeRequest(records, requestId, { progress, state: "in_progress", error: null });
  };

  try {
    if (input.interruptAt === "validated") interrupted("validation");
    let tasks: Task[] = progress.taskIds?.map((id) => records.getTask(id)).filter((task): task is Task => task !== null) ?? [];
    if (progress.phase !== "submitted") {
      if (input.destination.kind === "new_directory") {
        // Bootstrap resumes its own recorded steps and links the plan as its final step.
        const outcome = bootstrapProject(records, {
          briefId: brief.id, targetPath: input.destination.targetPath, profile: input.profile ?? "auto",
          packageManager: input.packageManager, language: input.language, runtime: input.runtime,
          projectName: input.projectName, actor,
          interruptAfterStep: typeof input.interruptAt === "object" ? input.interruptAt.bootstrapStep : undefined,
        });
        checkpoint({ phase: "bootstrapped", bootstrapId: outcome.run.id, projectId: outcome.project?.id ?? null, planId: outcome.run.planId });
        if (input.interruptAt === "bootstrapped") interrupted("bootstrap");
        tasks = outcome.tasks;
      } else {
        const project = records.getProject(input.destination.project) ?? records.findProjectByName(input.destination.project);
        if (!project) throw new Error(`Unknown project ${input.destination.project}`);
        const submitted = submitAcceptedPlan(records, { brief: brief.id, projectId: project.id, actor });
        checkpoint({ projectId: project.id, planId: submitted.planId });
        tasks = submitted.tasks;
      }
      checkpoint({ phase: "submitted", taskIds: tasks.map((task) => task.id) });
    }

    const finalBrief = getBrief(records, brief.id) as ProductBrief;
    const result: StartAcceptedWorkResult = {
      requestId, status: "completed", resumable: false,
      briefId: finalBrief.id, briefState: finalBrief.state,
      projectId: progress.projectId ?? null, bootstrapId: progress.bootstrapId ?? null, planId: progress.planId ?? null,
      tasks: summarizeTasks(tasks), error: null,
      nextActions: ["Start or confirm the controller so the queued tasks run; merging and deployment stay with the user."],
      replayed: false,
    };
    updateIntakeRequest(records, requestId, { state: "completed", result, error: null });
    return result;
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!progress.bootstrapId && input.destination.kind === "new_directory") {
      // Bootstrap records its own run before it can fail; name it so the state is inspectable.
      const target = resolve(input.destination.targetPath);
      progress.bootstrapId = listBootstrapRuns(records, brief.id).findLast((run) => run.targetPath === target)?.id ?? null;
    }
    updateIntakeRequest(records, requestId, { state: "failed", progress, error: message });
    const finalBrief = getBrief(records, brief.id) as ProductBrief;
    return {
      requestId, status: "interrupted", resumable: true,
      briefId: finalBrief.id, briefState: finalBrief.state,
      projectId: progress.projectId ?? null, bootstrapId: progress.bootstrapId ?? null, planId: progress.planId ?? null,
      tasks: [], error: message,
      nextActions: [
        `Fix the reported problem, then retry with the same request id (${requestId}); recorded steps are not repeated.`,
      ],
      replayed: false,
    };
  }
}
