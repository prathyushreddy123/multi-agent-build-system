#!/usr/bin/env node
import { resolve } from "node:path";

import { Controller } from "./controller/controller.ts";
import { exec } from "./core/exec.ts";
import { discoverChecks } from "./gates/discover.ts";
import { createBackup, pruneArtifacts, RETENTION_POLICY } from "./maintenance/retention.ts";
import { openRecords } from "./store/records.ts";
import { runBaseline } from "./verify/baseline.ts";
import { runPhase0 } from "./verify/phase0.ts";
import { createWorkbench } from "./workbench/server.ts";

interface ParsedArgs { positionals: string[]; options: Map<string, string | boolean> }

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const equals = arg.indexOf("=");
    if (equals !== -1) { options.set(arg.slice(2, equals), arg.slice(equals + 1)); continue; }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) { options.set(arg.slice(2), next); i += 1; }
    else options.set(arg.slice(2), true);
  }
  return { positionals, options };
}

function textOption(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : fallback;
}

function numberOption(args: ParsedArgs, name: string, fallback: number): number {
  const raw = textOption(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
}

async function baseBranch(repoPath: string): Promise<string> {
  const current = await exec("git", ["branch", "--show-current"], { cwd: repoPath, timeoutMs: 30_000 });
  if (current.code === 0 && current.stdout.trim()) return current.stdout.trim();
  const main = await exec("git", ["rev-parse", "--verify", "main"], { cwd: repoPath, timeoutMs: 30_000 });
  return main.code === 0 ? "main" : "master";
}

function printHelp(): void {
  console.log(`mabs — local multi-agent build controller

Commands:
  verify [--quick]                          Run Phase 0 subscription/access proof
  baseline [--only=a,b] [--harness=codex]  Run task-class baseline
  project add <name> <repo> [--goal=...]    Register a project and discover existing checks
  project list                              List registered projects
  project status <id|name> <active|paused|archived>
  requirement add <project> <id> <text>
  task add <project> <title> --objective=... [--accept='a;b'] [--depends=id,id]
  task list [--project=id] [--state=READY]
  task show <id>
  task retry <id> --version=<recordVersion>
  task cancel <id> --version=<recordVersion>
  controller once [--adapter=codex]          Reconcile and dispatch one cycle
  controller run [--adapter=codex] [--ui]   Run controller loop
  status                                    Show queue and controller health
  approval approve|reject <id> [--by=name]
  maintenance policy                         Show retention and backup defaults
  maintenance backup                        Create a consistent SQLite backup
  maintenance prune [--apply]                Preview or apply evidence retention
  ui [--port=4317]                          Run the localhost workbench
`);
}

function resolveProject(records: ReturnType<typeof openRecords>, value: string) {
  return records.getProject(value) ?? records.findProjectByName(value);
}

async function waitForSignal(stop: () => Promise<void> | void): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let ending = false;
    const end = () => {
      if (ending) return;
      ending = true;
      Promise.resolve(stop()).finally(resolvePromise);
    };
    process.once("SIGINT", end);
    process.once("SIGTERM", end);
  });
}

async function main(): Promise<void> {
  const [area, action, ...rest] = process.argv.slice(2);
  if (!area || area === "help" || area === "--help") { printHelp(); return; }

  if (area === "verify") {
    const args = parseArgs([action, ...rest].filter((value): value is string => Boolean(value)));
    const probes = await runPhase0({ quick: args.options.has("quick") });
    if (probes.some((probe) => probe.status === "FAIL")) process.exitCode = 1;
    return;
  }
  if (area === "baseline") {
    const args = parseArgs([action, ...rest].filter((value): value is string => Boolean(value)));
    const only = textOption(args, "only")?.split(",").filter(Boolean);
    const harnesses = textOption(args, "harness")?.split(",").filter(Boolean);
    await runBaseline({ only, harnesses });
    return;
  }

  const records = openRecords();
  let keepOpen = false;
  try {
    if (area === "project" && action === "add") {
      const args = parseArgs(rest);
      const [name, repoArg] = args.positionals;
      if (!name || !repoArg) throw new Error("Usage: mabs project add <name> <repo> [--goal=...]");
      const repoPath = resolve(repoArg);
      const project = records.createProject({
        name,
        repoPath,
        baseBranch: textOption(args, "base") ?? await baseBranch(repoPath),
        goal: textOption(args, "goal"),
        checkCommands: args.options.has("no-checks") ? [] : discoverChecks(repoPath),
      });
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    if (area === "project" && action === "list") {
      console.log(JSON.stringify(records.listProjects(), null, 2));
      return;
    }
    if (area === "project" && action === "status") {
      const [projectValue, status] = rest;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project || !status || !["active", "paused", "archived"].includes(status)) {
        throw new Error("Usage: mabs project status <id|name> <active|paused|archived>");
      }
      records.setProjectStatus(project.id, status as "active" | "paused" | "archived");
      console.log(`${project.name}: ${status}`);
      return;
    }
    if (area === "requirement" && action === "add") {
      const [projectValue, id, ...words] = rest;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project || !id || words.length === 0) throw new Error("Usage: mabs requirement add <project> <id> <text>");
      records.addRequirement(project.id, id, words.join(" "));
      console.log(`${project.name}: added ${id}`);
      return;
    }
    if (area === "task" && action === "add") {
      const args = parseArgs(rest);
      const [projectValue, title] = args.positionals;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      const objective = textOption(args, "objective");
      if (!project || !title || !objective) throw new Error("Usage: mabs task add <project> <title> --objective=...");
      const task = records.createTask({
        projectId: project.id,
        title,
        objective,
        acceptanceCriteria: textOption(args, "accept")?.split(";").filter(Boolean) ?? [],
        dependsOn: textOption(args, "depends")?.split(",").filter(Boolean) ?? [],
        role: textOption(args, "role", "implementer"),
        priority: numberOption(args, "priority", 100),
        repairLimit: numberOption(args, "repair-limit", 2),
      });
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    if (area === "task" && action === "list") {
      const args = parseArgs(rest);
      console.log(JSON.stringify(records.listTasks({
        projectId: textOption(args, "project"),
        state: textOption(args, "state") as never,
      }), null, 2));
      return;
    }
    if (area === "task" && action === "show") {
      const id = rest[0];
      if (!id) throw new Error("Usage: mabs task show <id>");
      console.log(JSON.stringify({
        task: records.getTask(id),
        attempts: records.listAttempts(id),
        gates: records.gatesForTask(id),
        events: records.listEvents(id),
      }, null, 2));
      return;
    }
    if (area === "task" && action === "retry") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const version = Number(textOption(args, "version"));
      if (!id || !Number.isSafeInteger(version) || version < 1) {
        throw new Error("Usage: mabs task retry <id> --version=<recordVersion from task show>");
      }
      console.log(JSON.stringify(records.retryTask(id, version), null, 2));
      return;
    }
    if (area === "status") {
      const tasks = records.listTasks();
      const taskCounts: Record<string, number> = {};
      for (const task of tasks) taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1;
      console.log(JSON.stringify({
        projects: records.listProjects().length,
        taskCounts,
        pendingApprovals: records.listApprovals("pending").length,
        health: records.latestHealth() ?? null,
      }, null, 2));
      return;
    }
    if (area === "maintenance" && action === "policy") {
      console.log(JSON.stringify(RETENTION_POLICY, null, 2));
      return;
    }
    if (area === "maintenance" && action === "backup") {
      console.log(await createBackup(records));
      return;
    }
    if (area === "maintenance" && action === "prune") {
      const args = parseArgs(rest);
      const applied = args.options.has("apply");
      const candidates = pruneArtifacts(records, { apply: applied });
      console.log(JSON.stringify({ applied, candidates }, null, 2));
      return;
    }
    if (area === "approval" && (action === "approve" || action === "reject")) {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      if (!id) throw new Error(`Usage: mabs approval ${action} <id> [--by=name]`);
      console.log(JSON.stringify(records.decideApproval(id, action === "approve" ? "approved" : "rejected", textOption(args, "by", "local-cli") as string), null, 2));
      return;
    }

    if (area === "controller" && (action === "once" || action === "run")) {
      const args = parseArgs(rest);
      const adapter = textOption(args, "adapter", process.env.MABS_ADAPTER ?? "codex");
      if (adapter !== "claude" && adapter !== "codex") throw new Error("--adapter must be claude or codex");
      const controller = new Controller(records, {
        defaultAdapter: adapter,
        defaultModel: textOption(args, "model") ?? null,
        workerLimit: numberOption(args, "workers", 2),
        activeProjectLimit: numberOption(args, "active-projects", 2),
      });
      if (action === "once") {
        await controller.tick();
        await controller.stop();
        console.log("controller cycle complete");
        return;
      }
      controller.start();
      keepOpen = true;
      let workbench: ReturnType<typeof createWorkbench> | null = null;
      if (args.options.has("ui")) {
        workbench = createWorkbench(records, { controller, port: numberOption(args, "port", 4317) });
        const address = await workbench.listen();
        console.log(`workbench: http://${address.host}:${address.port}`);
      }
      console.log(`controller ${controller.options.controllerId} running with ${adapter}; Ctrl-C to stop`);
      await waitForSignal(async () => {
        await controller.stop();
        if (workbench) await new Promise<void>((resolvePromise) => workbench?.server.close(() => resolvePromise()));
        records.store.close();
      });
      return;
    }
    if (area === "task" && action === "cancel") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const version = Number(textOption(args, "version"));
      if (!id || !Number.isSafeInteger(version) || version < 1) {
        throw new Error("Usage: mabs task cancel <id> --version=<recordVersion from task show>");
      }
      const controller = new Controller(records);
      await controller.cancelTask(id, version);
      console.log(`${id}: cancelled`);
      return;
    }
    if (area === "ui") {
      const args = parseArgs([action, ...rest].filter((value): value is string => Boolean(value)));
      const workbench = createWorkbench(records, { port: numberOption(args, "port", 4317) });
      const address = await workbench.listen();
      keepOpen = true;
      console.log(`workbench: http://${address.host}:${address.port}`);
      await waitForSignal(() => new Promise<void>((resolvePromise) => workbench.server.close(() => resolvePromise())));
      records.store.close();
      return;
    }

    throw new Error(`Unknown command: ${[area, action].filter(Boolean).join(" ")}. Run mabs help.`);
  } finally {
    if (!keepOpen) records.store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
