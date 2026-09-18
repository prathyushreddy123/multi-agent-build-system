import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

  pi.on("session_start", async (_event, ctx) => {
    try {
      const status = JSON.parse(await run(["status"])) as { taskCounts?: Record<string, number>; pendingApprovals?: number };
      const active = (status.taskCounts?.RUNNING ?? 0) + (status.taskCounts?.CHECKING ?? 0);
      const attention = (status.taskCounts?.BLOCKED ?? 0) + (status.taskCounts?.FAILED ?? 0) + (status.pendingApprovals ?? 0);
      ctx.ui.setStatus("mabs", ctx.ui.theme.fg(attention > 0 ? "warning" : "dim", `MABS ${active} active · ${attention} attention`));
    } catch {
      ctx.ui.setStatus("mabs", ctx.ui.theme.fg("warning", "MABS unavailable"));
    }
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

  pi.registerCommand("mabs-provider", {
    description: "Inspect or reset provider capacity, e.g. /mabs-provider list",
    handler: async (args, ctx) => ctx.ui.notify(await run(["provider", ...words(args)]), "info"),
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

  pi.registerTool({
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

  pi.registerTool({
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
