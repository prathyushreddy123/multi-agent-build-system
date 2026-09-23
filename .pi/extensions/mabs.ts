import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

  pi.registerCommand("mabs-assess", {
    description: "Weigh an idea before recording it: /mabs-assess a tool that drafts my weekly report",
    handler: async (args, ctx) => {
      const idea = args.trim();
      if (!idea) throw new Error("Usage: /mabs-assess <the idea, in your own words>");
      ctx.ui.notify(
        `Assessing before recording: ${idea}\n\n` +
        "You will get assumptions, prior art, cost of being wrong, and the cheapest test that could kill " +
        "the idea. You will not get a verdict, and no brief is created until you ask for one.",
        "info",
      );
      pi.sendUserMessage([
        "Run the product-discovery assessment stage on this idea, and do not create a brief yet:",
        idea,
        "",
        "Produce exactly the four sections the skill defines: what would have to be true, prior art,",
        "cost of being wrong, and the cheapest disconfirming test. Mark each assumption as checkable now,",
        "checkable after building, or unfalsifiable. Label prior art as recall from training data unless you",
        "actually retrieved current sources in this session, and say so if you did.",
        "",
        "Do not give a go or no-go verdict. Do not state market size, pricing, funding, or adoption figures",
        "unless they came from a source you retrieved here; say they are unavailable instead of estimating.",
        "Ask me whether to record the result as a brief once you are done.",
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

  // --- Code surface -------------------------------------------------------
  // Every route below goes through the same task/attempt/worktree/revision
  // resolver as the CLI, so a picker selection and a typed command can never
  // choose different worktrees for the same task.

  interface Candidate { taskId: string; title: string; state: string; projectName: string }

  /**
   * Run a Code command, turning an ambiguous selection into a picker rather
   * than a guess. Returns null when the user cancelled.
   */
  async function code(
    args: string[],
    ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, kind: "info" | "warning" | "error"): void } },
    retryWithTask: (taskId: string) => string[],
  ): Promise<Record<string, unknown> | null> {
    const first = JSON.parse(await run(args)) as Record<string, unknown> & { kind?: string; candidates?: Candidate[]; reason?: string };
    if (first.kind !== "selection-needed") return first;

    const candidates = first.candidates ?? [];
    const labels = candidates.map((candidate) => `${candidate.taskId}  ${candidate.title}  [${candidate.state}]`);
    const chosen = await ctx.ui.select(first.reason ?? "Select a task", labels);
    if (!chosen) {
      ctx.ui.notify("No task selected; nothing was opened.", "info");
      return null;
    }
    const index = labels.indexOf(chosen);
    const taskId = candidates[index]?.taskId;
    if (!taskId) throw new Error("The selected task could not be identified.");
    return JSON.parse(await run(retryWithTask(taskId))) as Record<string, unknown>;
  }

  function reportUnavailable(result: Record<string, unknown>, ctx: { ui: { notify(message: string, kind: "info" | "warning" | "error"): void } }): boolean {
    if (result.kind !== "not-found") return false;
    ctx.ui.notify(String(result.reason ?? "The requested content is unavailable."), "warning");
    return true;
  }

  pi.registerCommand("mabs-changes", {
    description: "List a task's changed files with their worktree and revision context: /mabs-changes [task]",
    handler: async (args, ctx) => {
      const extra = words(args);
      const result = await code(["changes", ...extra], ctx, (taskId) => ["changes", taskId, ...extra.slice(1)]);
      if (!result || reportUnavailable(result, ctx)) return;
      const files = (result.files ?? []) as { path: string; status: string; categories: string[] }[];
      const lines = files.map((file) => `  ${file.status.padEnd(12)} ${file.categories.join(",").padEnd(26)} ${file.path}`);
      ctx.ui.notify(
        [String(result.context), `${files.length} changed file(s)`, ...lines].join("\n") ||
        "No changed files.",
        "info",
      );
    },
  });

  pi.registerCommand("mabs-files", {
    description: "Browse every file in a task worktree: /mabs-files [task] [--filter=src]",
    handler: async (args, ctx) => {
      const extra = words(args);
      const result = await code(["files", ...extra], ctx, (taskId) => ["files", taskId, ...extra.slice(1)]);
      if (!result || reportUnavailable(result, ctx)) return;
      const files = (result.files ?? []) as string[];
      ctx.ui.notify([String(result.context), `${files.length} file(s)`, ...files.map((file) => `  ${file}`)].join("\n"), "info");
    },
  });

  pi.registerCommand("mabs-open", {
    description: "Open a file from a task worktree in the Code surface: /mabs-open <task> <path> [--line=N]",
    handler: async (args, ctx) => {
      const extra = words(args);
      if (extra.length === 0) throw new Error("Usage: /mabs-open <task> <path> [--line=N]");
      const result = await code(["open", ...extra, "--view"], ctx, (taskId) => ["open", taskId, ...extra.slice(1), "--view"]);
      if (!result || reportUnavailable(result, ctx)) return;
      const viewer = result.viewer as { delivered?: boolean; reason?: string } | null;
      const content = result.content as { text: string | null; unavailableReason: string | null; source: string };
      ctx.ui.notify([
        String(result.context),
        `${String(result.relativePath)}${result.line ? `:${String(result.line)}` : ""} (${content.source})`,
        result.viewReason ? String(result.viewReason) : "",
        content.unavailableReason ? content.unavailableReason : "",
        viewer?.delivered ? "Opened in the Code viewer." : String(viewer?.reason ?? ""),
        `Command: ${String(result.command)}`,
      ].filter(Boolean).join("\n"), content.unavailableReason ? "warning" : "info");
    },
  });

  pi.registerCommand("mabs-diff", {
    description: "Diff a file against the task's recorded base revision: /mabs-diff <task> <path>",
    handler: async (args, ctx) => {
      const extra = words(args);
      if (extra.length === 0) throw new Error("Usage: /mabs-diff <task> <path>");
      const result = await code(["diff", ...extra, "--view"], ctx, (taskId) => ["diff", taskId, ...extra.slice(1), "--view"]);
      if (!result || reportUnavailable(result, ctx)) return;
      const diff = result.diff as { text: string | null; from: string; to: string; unavailableReason: string | null };
      ctx.ui.notify([
        String(result.context),
        `${String(result.relativePath)}: ${diff.from} → ${diff.to}`,
        diff.unavailableReason ?? (diff.text === "" ? "No changes against the recorded base." : "Opened in the Code viewer."),
        `Command: ${String(result.command)}`,
      ].filter(Boolean).join("\n"), diff.unavailableReason ? "warning" : "info");
    },
  });

  pi.registerCommand("mabs-progress", {
    description: "Read-only task, attempt, and recorded-step view: /mabs-progress [--project=<id>]",
    handler: async (args, ctx) => {
      // The dashboard never schedules work; this is a snapshot of what is recorded.
      ctx.ui.notify(await run(["task", "watch", ...words(args), "--once"]), "info");
    },
  });

  pi.registerCommand("mabs-steps", {
    description: "Recorded implementation steps for one task: /mabs-steps <task>",
    handler: async (args, ctx) => {
      const extra = words(args);
      if (extra.length === 0) throw new Error("Usage: /mabs-steps <task>");
      const detail = JSON.parse(await run(["task", "steps", ...extra])) as {
        task: { state: string; steps: { kind: string; status: string; summary: string; attemptNumber: number | null }[]; stepGaps: string[]; delivery: string };
        controller: { state: string; stale: boolean; reason: string };
      };
      const steps = detail.task.steps.map(
        (step) => `  ${step.status.padEnd(10)} #${String(step.attemptNumber ?? "-")} ${step.kind.padEnd(24)} ${step.summary}`,
      );
      ctx.ui.notify([
        `state ${detail.task.state} · delivery ${detail.task.delivery}`,
        ...(steps.length > 0 ? steps : ["  No steps have been recorded for this task yet."]),
        ...detail.task.stepGaps.map((gap) => `  unavailable: ${gap}`),
        detail.controller.stale ? `  ⚠ ${detail.controller.reason}` : "",
      ].filter(Boolean).join("\n"), detail.controller.stale ? "warning" : "info");
    },
  });

  pi.registerCommand("mabs-workspace", {
    description: "Create or recover the Agent, Code, Tasks, and Logs surfaces: /mabs-workspace [open|status|close|viewer]",
    handler: async (args, ctx) => {
      const extra = words(args);
      const action = extra[0] ?? "open";
      if (!["open", "status", "close", "viewer"].includes(action)) {
        throw new Error("Usage: /mabs-workspace [open|status|close|viewer]");
      }
      // Viewer ownership is a property of the workspace surfaces, so it belongs
      // here rather than in a command of its own.
      if (action === "viewer") {
        ctx.ui.notify(await run(["viewer", extra[1] ?? "status", ...extra.slice(2)]), "info");
        return;
      }
      const output = await run(["workspace", action, ...extra.slice(1)]);
      if (action === "status") { ctx.ui.notify(output, "info"); return; }
      if (action === "close") {
        const closed = JSON.parse(output) as { closed: string[]; kept: { surface: string; reason: string }[]; notes: string[] };
        ctx.ui.notify([
          closed.closed.length > 0 ? `Closed: ${closed.closed.join(", ")}` : "Nothing owned by MABS was open.",
          ...closed.kept.map((entry) => `  kept ${entry.surface}: ${entry.reason}`),
          ...closed.notes,
        ].join("\n"), "info");
        return;
      }
      const result = JSON.parse(output) as {
        degraded: boolean; layout: string;
        surfaces: { surface: string; action: string; paneId: string | null; reason: string }[];
        notes: string[];
      };
      ctx.ui.notify([
        result.degraded
          ? "Herdr is not driving this session; every surface is available as a CLI command:"
          : `Operator workspace (${result.layout} layout):`,
        ...result.surfaces.map((surface) => `  ${surface.action.padEnd(9)} ${surface.surface.padEnd(6)} ${surface.paneId ?? ""}  ${surface.reason}`),
        ...result.notes.map((note) => `  · ${note}`),
      ].join("\n"), result.degraded ? "warning" : "info");
    },
  });

  pi.registerCommand("mabs-logs", {
    description: "Open original task evidence: /mabs-logs <task> [--attempt=<id>] [--evidence=<id>] [--tail=200]",
    handler: async (args, ctx) => {
      const extra = words(args);
      if (extra.length === 0) throw new Error("Usage: /mabs-logs <task> [--attempt=<id>] [--evidence=<id>]");
      if (extra.some((word) => word.startsWith("--evidence"))) {
        // Opening one record streams its bounded tail rather than the whole file.
        ctx.ui.notify(await run(["logs", ...extra]), "info");
        return;
      }
      const listing = JSON.parse(await run(["logs", ...extra])) as {
        entries: { id: string; label: string; exists: boolean; kind: string; attemptNumber: number | null; sizeBytes: number | null }[];
        notes: string[];
      };
      const rows = listing.entries.map((item) =>
        `  ${item.exists ? " " : "✕"} ${String(item.attemptNumber ?? "-").padStart(2)} ${item.kind.padEnd(18)} ${item.label.padEnd(36)} ${item.id}`,
      );
      ctx.ui.notify([
        `${listing.entries.length} evidence record(s). Open one with --evidence=<id>.`,
        ...rows,
        ...listing.notes.map((note) => `  ⚠ ${note}`),
      ].join("\n"), "info");
    },
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

      // Starting a second controller used to be silent and permanent: the loser
      // of the lease race failed every tick forever with its output discarded.
      // Check first, and never spawn a twin.
      const status = JSON.parse(await run(["status"])) as {
        controller?: { liveness?: { state?: string; reason?: string; startWouldContend?: boolean } };
      };
      const liveness = status.controller?.liveness;
      if (liveness?.startWouldContend) {
        ctx.ui.notify(`${liveness.reason ?? "A controller is already running."}\nNot starting another.`, "warning");
        return;
      }
      if (liveness?.state === "wedged") {
        ctx.ui.notify(`${liveness.reason ?? ""}\nNot starting another; investigate that process first.`, "warning");
        return;
      }

      const adapterArgs = adapter === "policy" ? [] : [`--adapter=${adapter}`];
      // Keep the output. Discarding it is what hid the lease contention.
      const logPath = join(ROOT, "controller.log");
      const log = openSync(logPath, "a");
      const child = spawn(process.execPath, [CLI, "controller", "run", ...adapterArgs, "--ui"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.unref();
      closeSync(log);
      ctx.ui.notify(
        `MABS controller started with ${adapter} routing (pid ${child.pid ?? "unknown"})\nLog: ${logPath}`,
        "info",
      );
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
