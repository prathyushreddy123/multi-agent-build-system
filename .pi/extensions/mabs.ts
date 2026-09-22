import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { compactToolRegistrar } from "./mabs-ux.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = resolve(ROOT, "src/cli.ts");
const MAX_OUTPUT = 12_000;

function words(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
    const quoted = (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"));
    return quoted ? part.slice(1, -1) : part;
  }) ?? [];
}

function compact(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n[truncated; use the MABS workbench for full details]`;
}

export default function mabsExtension(pi: ExtensionAPI) {
  async function run(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await pi.exec(process.execPath, [CLI, ...args], { cwd: ROOT, signal, timeout: 60_000 });
    const output = compact(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim());
    if (result.code !== 0) throw new Error(output || `mabs exited ${result.code}`);
    return output;
  }

  // Every MABS tool is drawn by the operator presentation layer, so custom
  // tools and forwarded worker output follow the same rules as Pi's built-ins.
  const registerCompactTool = compactToolRegistrar(pi);

  pi.on("session_start", async (_event, ctx) => {
    try {
      const status = JSON.parse(await run(["status"])) as { taskCounts?: Record<string, number>; pendingApprovals?: number; staleHeartbeatWorkers?: number };
      const active = (status.taskCounts?.RUNNING ?? 0) + (status.taskCounts?.CHECKING ?? 0);
      const attention = (status.taskCounts?.BLOCKED ?? 0) + (status.taskCounts?.FAILED ?? 0) + (status.pendingApprovals ?? 0) + (status.staleHeartbeatWorkers ?? 0);
      ctx.ui.setStatus("mabs", ctx.ui.theme.fg(attention > 0 ? "warning" : "dim", `MABS ${active} active · ${attention} attention`));
    } catch {
      ctx.ui.setStatus("mabs", ctx.ui.theme.fg("warning", "MABS unavailable"));
    }
  });

  pi.registerCommand("mabs-new", {
    description: "Start a new product from a plain description: /mabs-new a tool that drafts my weekly report",
    handler: async (args, ctx) => {
      const idea = args.trim();
      if (!idea) throw new Error("Usage: /mabs-new <what you want to build, in your own words>");
      ctx.ui.notify(
        `Starting a product brief for: ${idea}\n\n` +
        "I will record the idea with mabs_create_brief, ask only the questions that change the plan, " +
        "then present a plan you can accept or change. Nothing is built until you accept.",
        "info",
      );
      pi.sendUserMessage([
        "Start a MABS product-intake conversation. My product description is:",
        idea,
        "",
        "Record this with mabs_create_brief before asking questions. Ask only questions whose answers change",
        "the plan, and persist each question and answer with the clarification tools. Do not invent answers.",
        "When material unknowns are answered or explicitly assumed, call mabs_propose_plan and present a concise",
        "plan. Do not call mabs_accept_plan until I agree in my own words; bind that decision to the exact",
        "proposal fingerprint. Distinguish planning from implementation and from any external release request.",
      ].join("\n"));
    },
  });

  pi.registerCommand("mabs-product", {
    description: "Show a product brief, its pending decisions, work, and next actions: /mabs-product <brief>",
    handler: async (args, ctx) => ctx.ui.notify(await run(["product", "show", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-brief", {
    description: "Run a product-brief command, e.g. /mabs-brief list",
    handler: async (args, ctx) => ctx.ui.notify(await run(["brief", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-bootstrap", {
    description: "Bootstrap an accepted brief safely: /mabs-bootstrap <brief> <target> [--profile=python]",
    handler: async (args, ctx) => ctx.ui.notify(await run(["brief", "bootstrap", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-status", {
    description: "Show MABS projects, queue, approvals, and controller health",
    handler: async (_args, ctx) => ctx.ui.notify(await run(["status"]), "info"),
  });

  pi.registerCommand("mabs-project", {
    description: "Run a project command, e.g. /mabs-project list",
    handler: async (args, ctx) => ctx.ui.notify(await run(["project", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-task", {
    description: "Run a task command, e.g. /mabs-task list --state=BLOCKED",
    handler: async (args, ctx) => ctx.ui.notify(await run(["task", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-plan", {
    description: "Validate or apply an execution plan, e.g. /mabs-plan validate plan.json",
    handler: async (args, ctx) => ctx.ui.notify(await run(["plan", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-feedback", {
    description: "Record or answer durable feedback, e.g. /mabs-feedback add task <id> question --body=... --version=N",
    handler: async (args, ctx) => ctx.ui.notify(await run(["feedback", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-approval", {
    description: "Request or decide a revision-bound approval",
    handler: async (args, ctx) => ctx.ui.notify(await run(["approval", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-curate", {
    description: "Analyze, propose, evaluate, approve, activate, or revert versioned MABS configuration",
    handler: async (args, ctx) => ctx.ui.notify(await run(["curator", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-optimize", {
    description: "Record and compare fixed-suite optimization experiments or inspect routing outcomes",
    handler: async (args, ctx) => ctx.ui.notify(await run(["optimization", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-provider", {
    description: "Inspect or reset provider capacity, e.g. /mabs-provider list",
    handler: async (args, ctx) => ctx.ui.notify(await run(["provider", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-ops", {
    description: "Inspect or dry-run optional operations: /mabs-ops status <project>",
    handler: async (args, ctx) => ctx.ui.notify(await run(["ops", ...words(args)]), "info"),
  });

  pi.registerCommand("mabs-backup", {
    description: "Create a consistent backup of MABS SQLite state",
    handler: async (_args, ctx) => ctx.ui.notify(`Backup: ${await run(["maintenance", "backup"])}`, "info"),
  });

  pi.registerCommand("mabs-ui", {
    description: "Start and open the MABS localhost workbench",
    handler: async (args, ctx) => {
      const port = Number(args.trim() || "4317");
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Usage: /mabs-ui [port]");
      const child = spawn(process.execPath, [CLI, "ui", `--port=${port}`], { cwd: ROOT, detached: true, stdio: "ignore" });
      child.unref();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
      void pi.exec("xdg-open", [`http://127.0.0.1:${port}`], { timeout: 10_000 }).catch(() => undefined);
      ctx.ui.notify(`MABS workbench: http://127.0.0.1:${port}`, "info");
    },
  });

  pi.registerCommand("mabs-start", {
    description: "Start the controller and workbench: /mabs-start [policy|codex|claude]",
    handler: async (args, ctx) => {
      const adapter = args.trim() || "policy";
      if (!["policy", "codex", "claude"].includes(adapter)) throw new Error("Usage: /mabs-start [policy|codex|claude]");
      const adapterArgs = adapter === "policy" ? [] : [`--adapter=${adapter}`];
      const child = spawn(process.execPath, [CLI, "controller", "run", ...adapterArgs, "--ui"], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      ctx.ui.notify(`MABS controller started with ${adapter} routing (pid ${child.pid ?? "unknown"})`, "info");
    },
  });

  registerCompactTool({
    name: "mabs_status",
    label: "MABS Status",
    description: "Read the durable MABS project, task, approval, and controller-health summary. Output is capped at 12KB.",
    promptSnippet: "Read MABS controller and task status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const output = await run(["status"], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  const PLAN_TASK_SCHEMA = Type.Object({
    key: Type.String({ description: "Stable key used for dependencies inside this plan" }),
    title: Type.String(),
    objective: Type.String(),
    acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    taskClass: Type.Optional(Type.String({ description: "mechanical, small_implementation, complex_coding, diagnosis, planning, research" })),
    changeRisk: Type.Optional(Type.String({ description: "low, medium, or high" })),
    language: Type.Optional(Type.String()),
    allowedScope: Type.Optional(Type.Array(Type.String(), { description: "Repository-relative paths this task may edit" })),
    executionMode: Type.String({ description: "single, sequential, parallel, or mixed" }),
    executionReason: Type.String({ description: "Why this task runs that way" }),
  });

  registerCompactTool({
    name: "mabs_create_brief",
    label: "Create MABS Product Brief",
    description: "Record a product idea durably before any repository or project exists. Returns the brief with its ID and version.",
    promptSnippet: "Record a new product idea as a MABS brief",
    promptGuidelines: [
      "Call mabs_create_brief as soon as the user describes something they want built, before asking questions.",
      "Use mabs_create_brief to record what the user actually said; leave unknown fields empty and list them in unknowns instead of guessing.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short product name" }),
      purpose: Type.Optional(Type.String()),
      audience: Type.Optional(Type.String()),
      objective: Type.Optional(Type.String()),
      constraints: Type.Optional(Type.Array(Type.String())),
      unknowns: Type.Optional(Type.Array(Type.String({ description: "Material things you do not know yet" }))),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      targetPath: Type.Optional(Type.String({ description: "Directory the user chose, if they named one" })),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run(["brief", "create", `--payload=${JSON.stringify(params)}`, "--by=pi-conversation"], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_update_brief",
    label: "Update MABS Product Brief",
    description: "Record answers, assumptions, or a scope revision on a brief. Requires the brief version you last read, so concurrent edits cannot be lost.",
    promptSnippet: "Record an answer or scope change on a MABS brief",
    promptGuidelines: [
      "Pass mabs_update_brief the expectedVersion from the brief you last read; if rejected, re-read the brief and merge.",
      "Use mabs_update_brief to record an assumption explicitly rather than filling an unknown with a plausible guess.",
      "Before mabs_update_brief revises an accepted brief, tell the user that stale acceptance will be invalidated.",
    ],
    parameters: Type.Object({
      brief: Type.String({ description: "Brief ID" }),
      expectedVersion: Type.Number(),
      summary: Type.String({ description: "One line: what changed and why" }),
      patch: Type.Object({
        title: Type.Optional(Type.String()),
        purpose: Type.Optional(Type.String()),
        audience: Type.Optional(Type.String()),
        objective: Type.Optional(Type.String()),
        constraints: Type.Optional(Type.Array(Type.String())),
        unknowns: Type.Optional(Type.Array(Type.String())),
        assumptions: Type.Optional(Type.Array(Type.String())),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
        targetPath: Type.Optional(Type.String()),
        proposedStack: Type.Optional(Type.Object({
          language: Type.Optional(Type.String()),
          runtime: Type.Optional(Type.String()),
          packageManager: Type.Optional(Type.String()),
          components: Type.Optional(Type.Array(Type.String())),
          rationale: Type.Optional(Type.String()),
        })),
        qualitySettings: Type.Optional(Type.Object({
          reviewPreset: Type.Optional(Type.String({ description: "experiment, personal, or client" })),
          checks: Type.Optional(Type.Array(Type.String())),
          notes: Type.Optional(Type.String()),
        })),
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "brief", "update", params.brief,
        `--version=${String(params.expectedVersion)}`,
        `--summary=${params.summary}`,
        `--payload=${JSON.stringify(params.patch)}`,
        "--by=pi-conversation",
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_ask_clarifications",
    label: "Record MABS Clarifications",
    description: "Persist only material questions for a product brief, including why each answer would change the plan.",
    promptSnippet: "Record material product-intake questions before asking the user",
    promptGuidelines: [
      "Use mabs_ask_clarifications before asking material product questions, and do not record cosmetic or non-blocking questions.",
      "Explain why every mabs_ask_clarifications question changes scope, architecture, acceptance, or delivery.",
    ],
    parameters: Type.Object({
      brief: Type.String(),
      questions: Type.Array(Type.Object({
        question: Type.String(),
        whyItMatters: Type.String(),
        field: Type.Optional(Type.String()),
      }), { minItems: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "brief", "ask", params.brief,
        `--payload=${JSON.stringify({ questions: params.questions })}`,
        "--by=pi-conversation",
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_answer_clarification",
    label: "Record MABS Clarification Answer",
    description: "Persist the user's answer to one material question, or an explicitly labeled assumption when no answer is available.",
    promptSnippet: "Record an intake answer or explicit assumption",
    promptGuidelines: [
      "Use mabs_answer_clarification with answer only for words supplied by the user.",
      "Use mabs_answer_clarification with assumption when proceeding without an answer, and disclose the assumption to the user.",
    ],
    parameters: Type.Object({
      clarificationId: Type.String(),
      answer: Type.Optional(Type.String()),
      assumption: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "brief", "answer", params.clarificationId,
        ...(params.answer ? [`--answer=${params.answer}`] : []),
        ...(params.assumption ? [`--assumption=${params.assumption}`] : []),
        "--by=pi-conversation",
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_propose_plan",
    label: "Propose MABS Product Plan",
    description: "Persist a structured proposal with requirements, milestones, tasks, dependencies, scope, and rationale. The plan is validated before it can be presented.",
    promptSnippet: "Persist and validate a product plan for the user to accept",
    promptGuidelines: [
      "Use mabs_propose_plan only after material unknowns are answered or explicitly assumed.",
      "Give every mabs_propose_plan task an execution mode and reason, and disjoint allowedScope values for parallel tasks.",
      "If mabs_propose_plan reports validation errors, fix the plan and propose again; never present an invalid plan.",
    ],
    parameters: Type.Object({
      brief: Type.String(),
      summary: Type.String({ description: "The plan in a few sentences, as the user will see it" }),
      rationale: Type.String(),
      scope: Type.String({ description: "What this plan covers" }),
      outOfScope: Type.Optional(Type.Array(Type.String())),
      requirements: Type.Array(Type.Object({
        id: Type.String({ description: "Stable ID such as REQ-1" }),
        text: Type.String(),
        mandatory: Type.Optional(Type.Boolean()),
      }), { minItems: 1 }),
      milestones: Type.Optional(Type.Array(Type.String())),
      plan: Type.Object({
        objective: Type.String(),
        mode: Type.String({ description: "single, sequential, parallel, or mixed" }),
        reason: Type.String(),
        assumptions: Type.Optional(Type.Array(Type.String())),
        milestones: Type.Optional(Type.Array(Type.String())),
        tasks: Type.Array(PLAN_TASK_SCHEMA, { minItems: 1 }),
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const { brief, ...proposal } = params;
      const output = await run(["brief", "propose", brief, `--payload=${JSON.stringify(proposal)}`, "--by=pi-conversation"], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_accept_plan",
    label: "Record MABS Plan Acceptance",
    description: "Bind a decision the user actually made to one exact proposal version. Requires the proposal fingerprint and the name of the person who accepted.",
    promptSnippet: "Record the user's acceptance of a specific proposal version",
    promptGuidelines: [
      "Call mabs_accept_plan only after the user has agreed in their own words to the plan you presented.",
      "Pass mabs_accept_plan the fingerprint from that exact proposal; a changed plan must be presented again.",
      "Set mabs_accept_plan acceptedBy to the person, never the agent.",
    ],
    parameters: Type.Object({
      brief: Type.String(),
      proposalId: Type.String(),
      fingerprint: Type.String({ description: "Fingerprint of the exact proposal the user saw" }),
      acceptedBy: Type.String({ description: "The person who accepted" }),
      note: Type.Optional(Type.String({ description: "What the user said when accepting" })),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "brief", "accept", params.brief, params.proposalId,
        `--fingerprint=${params.fingerprint}`,
        `--by=${params.acceptedBy}`,
        ...(params.note ? [`--note=${params.note}`] : []),
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_get_operations",
    label: "Get MABS Operations",
    description: "Show effective CI, deployment, monitoring, scheduling, delivery, and cost settings. All are disabled/manual by default.",
    parameters: Type.Object({ project: Type.String() }),
    async execute(_toolCallId, params, signal) {
      const output = await run(["ops", "status", params.project], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_prepare_operation",
    label: "Prepare MABS Operation",
    description: "Return a dry-run plan for one optional capability. This never writes provider configuration or performs an external action.",
    promptGuidelines: [
      "Preparation is not execution or authorization.",
      "Do not describe disabled, incomplete, or approval-required output as deployed, scheduled, delivered, or monitored.",
    ],
    parameters: Type.Object({
      project: Type.String(),
      capability: Type.Union([
        Type.Literal("ci"), Type.Literal("deployment"), Type.Literal("monitoring"),
        Type.Literal("scheduling"), Type.Literal("delivery"), Type.Literal("costs"),
      ]),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run(["ops", "prepare", params.project, params.capability], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_bootstrap_project",
    label: "Bootstrap MABS Project",
    description: "Safely scaffold an accepted product in a user-selected local directory. Refuses unrelated non-empty directories, records every step, and resumes by bootstrap ID without duplicate projects.",
    promptSnippet: "Bootstrap an accepted product into a user-selected local directory",
    promptGuidelines: [
      "Use mabs_bootstrap_project only after exact plan acceptance and after the user selects the target directory.",
      "Never use mabs_bootstrap_project to overwrite a non-empty unrelated directory or to infer a release/deployment destination.",
      "If mabs_bootstrap_project reports missing prerequisites, show the recorded setup commands instead of claiming quality checks passed.",
    ],
    parameters: Type.Object({
      brief: Type.String(),
      targetPath: Type.String({ description: "Local product directory explicitly selected by the user" }),
      profile: Type.Optional(Type.String({ description: "auto, python, or javascript-typescript" })),
      packageManager: Type.Optional(Type.String({ description: "python, uv, poetry, pipenv, npm, pnpm, yarn, or bun" })),
      language: Type.Optional(Type.String()),
      runtime: Type.Optional(Type.String()),
      projectName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "brief", "bootstrap", params.brief, params.targetPath,
        ...(params.profile ? [`--profile=${params.profile}`] : []),
        ...(params.packageManager ? [`--package-manager=${params.packageManager}`] : []),
        ...(params.language ? [`--language=${params.language}`] : []),
        ...(params.runtime ? [`--runtime=${params.runtime}`] : []),
        ...(params.projectName ? [`--name=${params.projectName}`] : []),
        "--by=pi-conversation",
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_submit_plan",
    label: "Submit Accepted MABS Plan",
    description: "Apply the accepted, validated plan to the registered project. No hand-written plan JSON is involved.",
    promptSnippet: "Apply an accepted product plan to its registered project",
    promptGuidelines: ["Use mabs_submit_plan only for an accepted plan; if a revision invalidated acceptance, propose and ask again."],
    parameters: Type.Object({
      brief: Type.String(),
      project: Type.Optional(Type.String({ description: "Project ID or name, when the brief is not linked yet" })),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "brief", "submit", params.brief,
        ...(params.project ? [`--project=${params.project}`] : []),
        "--by=pi-conversation",
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_get_product",
    label: "Get MABS Product State",
    description: "Return the current brief, pending decisions, tasks, outputs, and next actions for a product, in a concise form.",
    promptSnippet: "Read the current state of a MABS product",
    parameters: Type.Object({ brief: Type.String({ description: "Brief ID or title" }) }),
    async execute(_toolCallId, params, signal) {
      const output = await run(["product", "show", params.brief], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });

  registerCompactTool({
    name: "mabs_submit_task",
    label: "Submit MABS Task",
    description: "Submit a scoped task to an already registered MABS project. This does not approve push, merge, or deployment.",
    promptSnippet: "Submit an accepted implementation or research task to MABS",
    promptGuidelines: ["Use mabs_submit_task only after the user has supplied or accepted a concrete objective and acceptance criteria."],
    parameters: Type.Object({
      project: Type.String({ description: "Registered project ID or name" }),
      title: Type.String(),
      objective: Type.String(),
      acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await run([
        "task", "add", params.project, params.title,
        `--objective=${params.objective}`,
        `--accept=${params.acceptanceCriteria.join(";")}`,
      ], signal);
      return { content: [{ type: "text", text: output }], details: { output } };
    },
  });
}
