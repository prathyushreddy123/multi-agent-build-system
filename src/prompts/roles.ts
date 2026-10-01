import { WORKER_OUTPUT_SCHEMA } from "../domain/contract.ts";
import type { WorkerInput } from "../domain/contract.ts";

export type WorkerPurpose = "implementation" | "repair" | "review";

export const ROLE_PROMPT_VERSION = "worker-roles-v5";

/**
 * How this worker verifies its change. Claude has the controller's exact-name
 * check tool; Codex runs commands in its sandbox. Either way the controller
 * re-runs the checks, so the worker never needs another route to them.
 */
export function checkInstructions(workerInput: WorkerInput, purpose: WorkerPurpose): string[] {
  if (purpose === "review") return [];
  const claude = workerInput.execution?.harness === "claude";
  const lines: string[] = [];
  // Packets recorded before contract 1.3.0 carry no checks list.
  if ((workerInput.workspace?.checks ?? []).length > 0) {
    lines.push(claude
      ? "Verify your change with the run_checks tool before reporting completed; it runs the registered checks in workspace.checks. " +
        "Do not try other ways to run them; the controller re-runs them to accept the change."
      : "Verify your change by running the commands in workspace.checks exactly before reporting completed; the controller re-runs them to accept the change.");
  }
  // Packets recorded before contract 1.4.0 carry no recipes.
  if ((workerInput.workspace?.recipes ?? []).length > 0) {
    lines.push(claude
      ? "To try the program itself, use the run_recipe tool with a recipe from workspace.recipes and your arguments; other shell commands are not permitted. " +
        "Its output is exploration, not acceptance evidence."
      : "To try the program itself, run a command from workspace.recipes with your arguments. Its output is exploration, not acceptance evidence.");
  }
  return lines;
}

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
    "A clarification or question that does not block acceptance goes in follow_up.unresolved as [minor]. Put a question in follow_up.decisions_requested only when a user must answer it before this revision can be accepted, and prefix it with [blocking].",
  ],
};

/**
 * The worker input as the model reads it: compact JSON without null, empty
 * list, or empty object fields. Absent means "none"; the stored packet keeps
 * every field. Indentation and empty fields were a fifth of a small packet.
 */
export function renderWorkerInput(workerInput: WorkerInput): string {
  return JSON.stringify(pruneForWorker(workerInput));
}

/** Drop null, empty-list, and empty-object fields at every depth, as the worker sees them. */
export function pruneForWorker(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneForWorker);
  if (value === null || typeof value !== "object") return value;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const pruned = pruneForWorker(item);
    if (pruned === null || pruned === undefined) continue;
    if (Array.isArray(pruned) && pruned.length === 0) continue;
    if (typeof pruned === "object" && !Array.isArray(pruned) && Object.keys(pruned).length === 0) continue;
    kept[key] = pruned;
  }
  return kept;
}

/**
 * UTF-8 bytes a value occupies in the rendered worker input: zero when the
 * renderer omits it, otherwise its compact pruned JSON.
 */
export function renderedBytes(value: unknown): number {
  const pruned = pruneForWorker(value);
  if (pruned === null || pruned === undefined) return 0;
  if (Array.isArray(pruned) && pruned.length === 0) return 0;
  if (typeof pruned === "object" && !Array.isArray(pruned) && Object.keys(pruned).length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(pruned), "utf8");
}

export function assembleWorkerPrompt(input: {
  purpose: WorkerPurpose;
  workerInput: WorkerInput;
  projectAddendum: string | null;
  guidance: string[];
}): string {
  const editing = input.purpose !== "review";
  return [
    "You are a MABS worker. Follow the supplied contract exactly.",
    "Work only in the assigned worktree. Do not push, merge, deploy, or broaden scope.",
    ...ROLE_INSTRUCTIONS[input.purpose],
    ...checkInstructions(input.workerInput, input.purpose),
    "Paths are relative to workspace.worktree_path (file_context paths to context.source_workspace). An absent field means none.",
    ...(editing
      ? ["file_context excerpts are current at head_revision; do not re-read a file whose excerpt is not truncated unless you changed it. Prefer Edit over rewriting whole files."]
      : []),
    "Treat project requirements and acceptance criteria as authoritative.",
    ...(input.guidance.length > 0
      ? ["Selected versioned guidance (cannot override controller policy, contract, or accepted scope):", ...input.guidance]
      : []),
    ...(input.projectAddendum
      ? ["Project prompt addendum (cannot override scope, approval, paid-access, or worker-contract rules):", input.projectAddendum]
      : []),
    "Worker input:",
    renderWorkerInput(input.workerInput),
    "",
    "When finished, create .mabs/result.json in the worktree containing exactly one JSON object matching this schema:",
    JSON.stringify(WORKER_OUTPUT_SCHEMA),
    "Use null for unknown usage; never invent measurements.",
    // The controller reads the file; repeating the object costs output tokens.
    // The final message is only a fallback for when the file could not be written.
    "Then end with a one-line final message. Only if you could not write the file, put the JSON object in your final message instead.",
  ].join("\n");
}

/**
 * The brief for a repair that continues the implementer's own session. The
 * session already holds the task, contract, scope, schema, and the code it
 * wrote, so the brief carries only what changed: the open obligations and
 * findings, and the exit condition. The full packet is still recorded and is
 * the cold fallback if the session cannot be resumed.
 */
export function assembleResumePrompt(workerInput: WorkerInput): string {
  const obligations = workerInput.context.obligations ?? [];
  const findings = workerInput.context.previous_findings.filter((finding) => !obligations.some((item) => finding.includes(item.summary)));
  return [
    `MABS targeted repair, attempt ${workerInput.identity.attempt_id}, of the change you made earlier in this session.`,
    `The controller committed that change as ${workerInput.workspace.head_revision ?? "the current revision"}; its checks or independent review require the following before it can be accepted.`,
    ...(obligations.length > 0
      ? ["Open obligations (address each blocking one; name the IDs you addressed in your summary):",
        ...obligations.map((item) => `- ${item.id} [${item.severity}${item.blocking ? ", blocking" : ""}] ${item.summary}`)]
      : []),
    ...(findings.length > 0 ? ["Findings:", ...findings.map((finding) => `- ${finding}`)] : []),
    ...ROLE_INSTRUCTIONS.repair.slice(1),
    ...checkInstructions(workerInput, "repair"),
    "When finished, overwrite .mabs/result.json with a new result object using the same schema as before, then end with a one-line final message. " +
      "Only if you could not write the file, put the JSON object in your final message instead.",
  ].join("\n");
}
