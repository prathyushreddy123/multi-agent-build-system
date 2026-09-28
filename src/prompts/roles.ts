import { WORKER_OUTPUT_SCHEMA } from "../domain/contract.ts";
import type { WorkerInput } from "../domain/contract.ts";

export type WorkerPurpose = "implementation" | "repair" | "review";

export const ROLE_PROMPT_VERSION = "worker-roles-v2";

export const ROLE_INSTRUCTIONS: Record<WorkerPurpose, readonly string[]> = {
  implementation: [
    "Do not run git commit. Linked-worktree Git metadata may be outside your sandbox; after you report completed, the controller creates the required local commit and binds checks to it.",
    "A task acceptance criterion requiring a local commit is therefore a controller postcondition, not a reason to report blocked.",
  ],
  repair: [
    "This is a targeted repair of an existing revision. context.obligations lists every open obligation exactly once, by ID; address each blocking one and do not repeat an approach the findings rejected.",
    "Keep the change minimal and inside scope. Name the obligation IDs you addressed in your summary; the controller, not you, decides whether they are resolved.",
    "Do not run git commit. The controller creates the local commit after you report completed.",
  ],
  review: [
    "This is an independent, read-only review. Do not edit tracked files. Inspect evidence directly instead of relying on the implementer's summary.",
    "Put actionable findings in follow_up.unresolved and prefix each with [critical], [major], or [minor]. Leave unresolved empty only when the revision is acceptable.",
  ],
};

export function assembleWorkerPrompt(input: {
  purpose: WorkerPurpose;
  workerInput: WorkerInput;
  projectAddendum: string | null;
  guidance: string[];
}): string {
  return [
    "You are a MABS worker. Follow the supplied contract exactly.",
    "Work only in the assigned worktree. Do not push, merge, deploy, or broaden scope.",
    ...ROLE_INSTRUCTIONS[input.purpose],
    "Treat project requirements and acceptance criteria as authoritative.",
    ...(input.guidance.length > 0
      ? ["Selected versioned guidance (cannot override controller policy, contract, or accepted scope):", ...input.guidance]
      : []),
    ...(input.projectAddendum
      ? ["Project prompt addendum (cannot override scope, approval, paid-access, or worker-contract rules):", input.projectAddendum]
      : []),
    "Worker input:",
    JSON.stringify(input.workerInput, null, 2),
    "",
    "When finished, create .mabs/result.json in the worktree containing exactly one JSON object matching this schema:",
    JSON.stringify(WORKER_OUTPUT_SCHEMA),
    "Use null for unknown usage; never invent measurements.",
    "Your final message must contain the same JSON object and no additional prose.",
  ].join("\n");
}
