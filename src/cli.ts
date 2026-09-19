#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Controller } from "./controller/controller.ts";
import {
  analyzeProject,
  createProposal,
  createSuggestedProposal,
  evaluateProposal,
  parseConfigFile,
  proposalDetail,
  requestActivationApproval,
  requestRevertApproval,
} from "./curator/service.ts";
import { projectConfigSnapshot } from "./domain/config.ts";
import { exec } from "./core/exec.ts";
import { taskDiagnostics } from "./diagnostics/task.ts";
import { ACTIONS } from "./domain/policy.ts";
import type { Action } from "./domain/policy.ts";
import { applyExecutionPlan, validateExecutionPlan } from "./domain/plan.ts";
import type { ExecutionPlan } from "./domain/plan.ts";
import { discoverChecks } from "./gates/discover.ts";
import {
  DEFAULT_SKIP_TASK_CLASSES,
  REVIEW_MODES,
  REVIEW_PRESETS,
  describeReviewPolicy,
  evaluateReviewPolicy,
  normalizeReviewPolicy,
  reviewPreset,
  type ReviewMode,
  type ReviewPreset,
} from "./review/policy.ts";
import { createBackup, pruneArtifacts, RETENTION_POLICY } from "./maintenance/retention.ts";
import {
  completeExperiment,
  createExperiment,
  experimentDetail,
  listExperiments,
  recordMeasurement,
  type ExperimentVariant,
} from "./optimization/experiments.ts";
import { routingOutcomes } from "./optimization/routing.ts";
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
  project add <name> <repo> [--goal=...] [--review=substantive]
                                               Register a project and discover existing checks
  project list                              List registered projects
  project status <id|name> <active|paused|archived>
  project review <id|name> [required|substantive|none]   Show or set the resolved review policy
  project preset <id|name> <experiment|personal|client> [--reason=...] [--acknowledge-weakening]
  review decide <task>                         Explain the review decision for a task
  review request <task>                        Record an explicit manual review request
  project base <id|name> <branch>              Change target and invalidate open approvals
  requirement add <project> <id> <text>
  task add <project> <title> --objective=... [--class=small_implementation]
  task list [--project=id] [--state=READY]
  task show <id>
  task retry <id> --version=<recordVersion>
  task cancel <id> --version=<recordVersion>
  plan validate <file>
  plan apply <project> <file>
  plan list [--project=id] | plan show <id>
  feedback add task|plan <id> <kind> --body=... --version=N
  feedback list [--project=id] | feedback answer <id> --response=...
  provider list | provider reset <name>
  curator analyze|snapshot|suggest <project>
  curator propose <project> <config.json> --title=... --rationale=...
  curator list [project] | curator show <proposal>
  curator evaluate|reject|request-activation <proposal>
  curator activate <proposal> <approval> --reason=...
  curator request-revert <project> <configVersion> --reason=...
  curator revert <project> <configVersion> <approval> --reason=...
  curator history <project>
  optimization create <project|global> <definition.json>
  optimization list [project] | optimization show|complete <experiment>
  optimization record <experiment> <baseline|candidate> <case> <measurement.json>
  optimization routing [project]
  controller once [--adapter=codex]          Reconcile and dispatch one cycle
  controller run [--adapter=codex] [--ui]   Run controller loop
  status                                    Show queue and controller health
  approval request <task> <action> <target> --reason=...
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
        reviewPolicy: normalizeReviewPolicy({
          mode: textOption(args, "review", "substantive") as ReviewMode,
          skipTaskClasses: [...DEFAULT_SKIP_TASK_CLASSES],
        }),
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
    if (area === "project" && action === "base") {
      const [projectValue, branch] = rest;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project || !branch) throw new Error("Usage: mabs project base <id|name> <branch>");
      console.log(JSON.stringify({ projectId: project.id, baseBranch: branch, configVersion: records.setProjectBaseBranch(project.id, branch) }, null, 2));
      return;
    }
    if (area === "project" && action === "review") {
      const args = parseArgs(rest);
      const [projectValue, mode] = args.positionals;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project) throw new Error("Usage: mabs project review <id|name> [required|substantive|none]");
      if (!mode) {
        console.log(JSON.stringify({
          projectId: project.id,
          resolved: describeReviewPolicy(project.reviewPolicy),
          policy: project.reviewPolicy,
        }, null, 2));
        return;
      }
      if (!REVIEW_MODES.includes(mode as ReviewMode)) {
        throw new Error("Usage: mabs project review <id|name> [required|substantive|none]");
      }
      const policy = normalizeReviewPolicy({ mode: mode as ReviewMode, skipTaskClasses: [...DEFAULT_SKIP_TASK_CLASSES] });
      const configVersion = records.setProjectReviewPolicy(project.id, policy, {
        reason: textOption(args, "reason"),
        acknowledgeWeakening: args.options.has("acknowledge-weakening"),
        changedBy: textOption(args, "by", "local-cli"),
      });
      console.log(JSON.stringify({ projectId: project.id, resolved: describeReviewPolicy(policy), policy, configVersion }, null, 2));
      return;
    }
    if (area === "project" && action === "preset") {
      const args = parseArgs(rest);
      const [projectValue, preset] = args.positionals;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project || !preset || !REVIEW_PRESETS.includes(preset as ReviewPreset) || preset === "custom") {
        throw new Error("Usage: mabs project preset <id|name> <experiment|personal|client> [--reason=...] [--acknowledge-weakening]");
      }
      const policy = reviewPreset(preset as Exclude<ReviewPreset, "custom">);
      const configVersion = records.setProjectReviewPreset(project.id, preset as Exclude<ReviewPreset, "custom">, {
        reason: textOption(args, "reason"),
        acknowledgeWeakening: args.options.has("acknowledge-weakening"),
        changedBy: textOption(args, "by", "local-cli"),
      });
      console.log(JSON.stringify({ projectId: project.id, resolved: describeReviewPolicy(policy), policy, configVersion }, null, 2));
      return;
    }
    if (area === "review" && (action === "decide" || action === "request")) {
      const args = parseArgs(rest);
      const taskId = args.positionals[0];
      const task = taskId ? records.getTask(taskId) : null;
      const project = task ? records.getProject(task.projectId) : null;
      if (!task || !project) throw new Error(`Usage: mabs review ${action} <task>`);
      const decision = evaluateReviewPolicy(project.reviewPolicy, {
        subject: task,
        changedFiles: records.changedFilesForTask(task.id),
        manualRequest: action === "request",
      });
      if (action === "request") {
        records.recordEvent({
          kind: "review.requested",
          projectId: project.id,
          taskId: task.id,
          data: { requestedBy: textOption(args, "by", "local-cli"), revision: task.resultRevision, policy: describeReviewPolicy(project.reviewPolicy) },
        });
      }
      console.log(JSON.stringify({ taskId: task.id, resolved: describeReviewPolicy(project.reviewPolicy), decision }, null, 2));
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
        taskClass: textOption(args, "class") as never,
        complexity: textOption(args, "complexity") as never,
        ambiguity: textOption(args, "ambiguity") as never,
        changeRisk: textOption(args, "risk") as never,
        language: textOption(args, "language") ?? null,
        domain: textOption(args, "domain") ?? null,
        contextSize: textOption(args, "context-size") as never,
        requiredTools: textOption(args, "tools")?.split(",").filter(Boolean) ?? [],
        allowedScope: textOption(args, "scope")?.split(",").filter(Boolean) ?? [],
        executionMode: textOption(args, "mode", "single"),
        executionReason: textOption(args, "mode-reason", "User submitted a single task.") ?? null,
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
        routing: records.routingForTask(id),
        gates: records.gatesForTask(id),
        reviews: records.reviewsForTask(id),
        feedback: records.listFeedback({ taskId: id }),
        events: records.listEvents(id),
        latency: records.taskLatency(id),
        diagnostics: records.getTask(id) ? taskDiagnostics(records, id) : null,
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
    if (area === "plan" && action === "list") {
      const args = parseArgs(rest);
      console.log(JSON.stringify(records.listExecutionPlans(textOption(args, "project")), null, 2));
      return;
    }
    if (area === "plan" && action === "show") {
      const id = rest[0];
      if (!id) throw new Error("Usage: mabs plan show <id>");
      const plan = records.getExecutionPlan(id);
      if (!plan) throw new Error(`Unknown plan ${id}`);
      console.log(JSON.stringify({ ...plan, feedback: records.listFeedback({ planId: id }) }, null, 2));
      return;
    }
    if (area === "plan" && (action === "validate" || action === "apply")) {
      const [first, second] = rest;
      const projectValue = action === "apply" ? first : undefined;
      const file = action === "apply" ? second : first;
      if (!file) throw new Error(action === "apply" ? "Usage: mabs plan apply <project> <file>" : "Usage: mabs plan validate <file>");
      const plan = JSON.parse(readFileSync(resolve(file), "utf8")) as ExecutionPlan;
      const validation = validateExecutionPlan(plan);
      if (action === "validate") {
        if (!validation.valid) records.recordEvent({ kind: "plan.invalid", data: { file: resolve(file), errors: validation.errors } });
        console.log(JSON.stringify(validation, null, 2));
        if (!validation.valid) process.exitCode = 1;
        return;
      }
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project) throw new Error(`Unknown project: ${projectValue ?? ""}`);
      if (!validation.valid) {
        records.recordEvent({ kind: "plan.invalid", projectId: project.id, data: { file: resolve(file), errors: validation.errors } });
        throw new Error(`Invalid execution plan:\n${validation.errors.join("\n")}`);
      }
      const tasks = applyExecutionPlan(records, project.id, plan);
      records.recordEvent({
        kind: "plan.applied",
        projectId: project.id,
        data: { file: resolve(file), mode: plan.mode, reason: plan.reason, taskIds: tasks.map((task) => task.id) },
      });
      console.log(JSON.stringify({ validation, tasks }, null, 2));
      return;
    }
    if (area === "feedback" && action === "list") {
      const args = parseArgs(rest);
      console.log(JSON.stringify(records.listFeedback({ projectId: textOption(args, "project") }), null, 2));
      return;
    }
    if (area === "feedback" && action === "add") {
      const args = parseArgs(rest);
      const [targetType, targetId, kind] = args.positionals;
      const body = textOption(args, "body");
      const expectedVersion = Number(textOption(args, "version"));
      if (!targetId || !body || !["task", "plan"].includes(targetType ?? "") ||
          !["comment", "question", "request_change", "priority"].includes(kind ?? "") ||
          !Number.isSafeInteger(expectedVersion)) {
        throw new Error("Usage: mabs feedback add task|plan <id> <comment|question|request_change|priority> --body=... --version=N");
      }
      const task = targetType === "task" ? records.getTask(targetId) : null;
      const plan = targetType === "plan" ? records.getExecutionPlan(targetId)?.plan : null;
      const projectId = task?.projectId ?? plan?.projectId;
      if (!projectId) throw new Error(`Unknown ${targetType} ${targetId}`);
      console.log(JSON.stringify(records.submitFeedback({
        projectId,
        taskId: task?.id,
        planId: plan?.id,
        kind: kind as "comment" | "question" | "request_change" | "priority",
        body,
        expectedVersion,
        createdBy: textOption(args, "by", "local-cli") as string,
      }), null, 2));
      return;
    }
    if (area === "feedback" && action === "answer") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const response = textOption(args, "response");
      if (!id || !response) throw new Error("Usage: mabs feedback answer <id> --response=...");
      console.log(JSON.stringify(records.answerFeedback(id, response, textOption(args, "by", "local-cli") as string), null, 2));
      return;
    }
    if (area === "curator" && action === "analyze") {
      const projectValue = rest[0];
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project) throw new Error("Usage: mabs curator analyze <project>");
      console.log(JSON.stringify(analyzeProject(records, project.id), null, 2));
      return;
    }
    if (area === "curator" && action === "suggest") {
      const args = parseArgs(rest);
      const projectValue = args.positionals[0];
      const project = projectValue ? resolveProject(records, projectValue) : null;
      const title = textOption(args, "title", "Rules-first curator suggestion") as string;
      const rationale = textOption(args, "rationale", "Recurring durable evidence supports this bounded configuration proposal.") as string;
      if (!project) throw new Error("Usage: mabs curator suggest <project> [--title=...] [--rationale=...]");
      const proposal = await createSuggestedProposal(records, {
        projectId: project.id,
        title,
        rationale,
        proposedBy: textOption(args, "by", "local-cli") as string,
      });
      console.log(JSON.stringify(proposalDetail(records, proposal.id), null, 2));
      return;
    }
    if (area === "curator" && action === "snapshot") {
      const projectValue = rest[0];
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project) throw new Error("Usage: mabs curator snapshot <project>");
      console.log(JSON.stringify(projectConfigSnapshot(project), null, 2));
      return;
    }
    if (area === "curator" && action === "propose") {
      const args = parseArgs(rest);
      const [projectValue, file] = args.positionals;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      const title = textOption(args, "title");
      const rationale = textOption(args, "rationale");
      if (!project || !file || !title || !rationale) {
        throw new Error("Usage: mabs curator propose <project> <config.json> --title=... --rationale=...");
      }
      const signals = analyzeProject(records, project.id);
      const proposal = await createProposal(records, {
        projectId: project.id,
        title,
        rationale,
        config: parseConfigFile(readFileSync(resolve(file), "utf8")),
        proposedBy: textOption(args, "by", "local-cli") as string,
        signals,
      });
      console.log(JSON.stringify(proposalDetail(records, proposal.id), null, 2));
      return;
    }
    if (area === "curator" && action === "list") {
      const projectValue = rest[0];
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (projectValue && !project) throw new Error(`Unknown project ${projectValue}`);
      console.log(JSON.stringify(records.listCuratorProposals(project?.id), null, 2));
      return;
    }
    if (area === "curator" && action === "show") {
      const id = rest[0];
      if (!id) throw new Error("Usage: mabs curator show <proposal>");
      console.log(JSON.stringify(proposalDetail(records, id), null, 2));
      return;
    }
    if (area === "curator" && action === "evaluate") {
      const id = rest[0];
      if (!id) throw new Error("Usage: mabs curator evaluate <proposal>");
      console.log(JSON.stringify(evaluateProposal(records, id), null, 2));
      return;
    }
    if (area === "curator" && action === "reject") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const reason = textOption(args, "reason");
      if (!id || !reason) throw new Error("Usage: mabs curator reject <proposal> --reason=...");
      console.log(JSON.stringify(records.rejectCuratorProposal(id, reason, textOption(args, "by", "local-cli") as string), null, 2));
      return;
    }
    if (area === "curator" && action === "request-activation") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const reason = textOption(args, "reason");
      if (!id || !reason) throw new Error("Usage: mabs curator request-activation <proposal> --reason=...");
      console.log(JSON.stringify(requestActivationApproval(records, id, reason), null, 2));
      return;
    }
    if (area === "curator" && action === "activate") {
      const args = parseArgs(rest);
      const [id, approvalId] = args.positionals;
      const reason = textOption(args, "reason");
      if (!id || !approvalId || !reason) throw new Error("Usage: mabs curator activate <proposal> <approval> --reason=...");
      console.log(JSON.stringify(records.activateCuratorProposal(
        id, approvalId, textOption(args, "by", "local-cli") as string, reason,
      ), null, 2));
      return;
    }
    if (area === "curator" && action === "request-revert") {
      const args = parseArgs(rest);
      const [projectValue, configVersion] = args.positionals;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      const reason = textOption(args, "reason");
      if (!project || !configVersion || !reason) throw new Error("Usage: mabs curator request-revert <project> <configVersion> --reason=...");
      console.log(JSON.stringify(requestRevertApproval(records, project.id, configVersion, reason), null, 2));
      return;
    }
    if (area === "curator" && action === "revert") {
      const args = parseArgs(rest);
      const [projectValue, configVersion, approvalId] = args.positionals;
      const project = projectValue ? resolveProject(records, projectValue) : null;
      const reason = textOption(args, "reason");
      if (!project || !configVersion || !approvalId || !reason) {
        throw new Error("Usage: mabs curator revert <project> <configVersion> <approval> --reason=...");
      }
      console.log(JSON.stringify(records.revertProjectConfig({
        projectId: project.id,
        targetConfigVersion: configVersion,
        approvalId,
        activatedBy: textOption(args, "by", "local-cli") as string,
        reason,
      }), null, 2));
      return;
    }
    if (area === "curator" && action === "history") {
      const projectValue = rest[0];
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (!project) throw new Error("Usage: mabs curator history <project>");
      console.log(JSON.stringify({
        activeConfigVersion: records.getProject(project.id)?.configVersion,
        versions: records.listConfigVersions(project.id),
        activations: records.listConfigActivations(project.id),
      }, null, 2));
      return;
    }
    if (area === "provider" && action === "list") {
      console.log(JSON.stringify(records.listProviderCapacity(), null, 2));
      return;
    }
    if (area === "provider" && action === "reset") {
      const provider = rest[0];
      if (!provider) throw new Error("Usage: mabs provider reset <name>");
      console.log(JSON.stringify(records.resetProvider(provider), null, 2));
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
        staleHeartbeatWorkers: records.staleHeartbeatAttempts(10 * 60_000).length,
        providers: records.listProviderCapacity(),
        operations: records.operationalMetrics(),
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
    if (area === "approval" && action === "request") {
      const args = parseArgs(rest);
      const [taskId, actionName, target] = args.positionals;
      const task = taskId ? records.getTask(taskId) : null;
      const project = task ? records.getProject(task.projectId) : null;
      const reason = textOption(args, "reason");
      if (!task || !project || !target || !reason || !ACTIONS.includes(actionName as Action)) {
        throw new Error("Usage: mabs approval request <task> <action> <target> --reason=...");
      }
      console.log(JSON.stringify(records.prepareApproval({
        taskId: task.id,
        action: actionName as Action,
        target,
        reason,
      }), null, 2));
      return;
    }
    if (area === "approval" && (action === "approve" || action === "reject")) {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      if (!id) throw new Error(`Usage: mabs approval ${action} <id> [--by=name]`);
      console.log(JSON.stringify(records.decideApproval(id, action === "approve" ? "approved" : "rejected", textOption(args, "by", "local-cli") as string), null, 2));
      return;
    }

    if (area === "optimization" && action === "create") {
      const projectValue = rest[0];
      const definitionPath = rest[1];
      if (!projectValue || !definitionPath) throw new Error("Usage: mabs optimization create <project|global> <definition.json>");
      const project = projectValue === "global" ? null : resolveProject(records, projectValue);
      if (projectValue !== "global" && !project) throw new Error(`Unknown project ${projectValue}`);
      const definition = JSON.parse(readFileSync(resolve(definitionPath), "utf8")) as {
        name: string; hypothesis: string; dimension: string; suiteVersion: string;
        baselineConfig?: Record<string, unknown>; candidateConfig?: Record<string, unknown>;
      };
      console.log(JSON.stringify(createExperiment(records, {
        projectId: project?.id ?? null,
        name: definition.name, hypothesis: definition.hypothesis, dimension: definition.dimension,
        suiteVersion: definition.suiteVersion, baselineConfig: definition.baselineConfig ?? {},
        candidateConfig: definition.candidateConfig ?? {},
      }), null, 2));
      return;
    }
    if (area === "optimization" && action === "record") {
      const [experimentId, variant, caseKey, measurementPath] = rest;
      if (!experimentId || !variant || !caseKey || !measurementPath || !["baseline", "candidate"].includes(variant)) {
        throw new Error("Usage: mabs optimization record <experiment> <baseline|candidate> <case> <measurement.json>");
      }
      const data = JSON.parse(readFileSync(resolve(measurementPath), "utf8")) as Record<string, unknown>;
      console.log(JSON.stringify(recordMeasurement(records, {
        experimentId, variant: variant as ExperimentVariant, caseKey,
        accepted: Boolean(data.accepted),
        requirementViolations: Number(data.requirementViolations ?? 0), repairs: Number(data.repairs ?? 0),
        interventions: Number(data.interventions ?? 0), durationMs: data.durationMs === null || data.durationMs === undefined ? null : Number(data.durationMs),
        reportedInputTokens: data.reportedInputTokens === null || data.reportedInputTokens === undefined ? null : Number(data.reportedInputTokens),
        reportedOutputTokens: data.reportedOutputTokens === null || data.reportedOutputTokens === undefined ? null : Number(data.reportedOutputTokens),
        relevantFiles: Number(data.relevantFiles ?? 0), warnings: Number(data.warnings ?? 0),
        evidencePath: typeof data.evidencePath === "string" ? data.evidencePath : null,
      }), null, 2));
      return;
    }
    if (area === "optimization" && action === "list") {
      const project = rest[0] ? resolveProject(records, rest[0]) : null;
      if (rest[0] && !project) throw new Error(`Unknown project ${rest[0]}`);
      console.log(JSON.stringify(listExperiments(records, project?.id), null, 2));
      return;
    }
    if (area === "optimization" && action === "show") {
      if (!rest[0]) throw new Error("Usage: mabs optimization show <experiment>");
      console.log(JSON.stringify(experimentDetail(records, rest[0]), null, 2));
      return;
    }
    if (area === "optimization" && action === "complete") {
      if (!rest[0]) throw new Error("Usage: mabs optimization complete <experiment>");
      console.log(JSON.stringify(completeExperiment(records, rest[0]), null, 2));
      return;
    }
    if (area === "optimization" && action === "routing") {
      const project = rest[0] ? resolveProject(records, rest[0]) : null;
      if (rest[0] && !project) throw new Error(`Unknown project ${rest[0]}`);
      console.log(JSON.stringify(routingOutcomes(records, project?.id), null, 2));
      return;
    }
    if (area === "controller" && (action === "once" || action === "run")) {
      const args = parseArgs(rest);
      const adapter = textOption(args, "adapter") ?? process.env.MABS_ADAPTER;
      if (adapter !== undefined && adapter !== "claude" && adapter !== "codex") throw new Error("--adapter must be claude or codex");
      const controller = new Controller(records, {
        defaultAdapter: adapter as "claude" | "codex" | undefined,
        defaultModel: textOption(args, "model") ?? null,
        defaultEffort: textOption(args, "effort") ?? null,
        workerLimit: numberOption(args, "workers", 2),
        activeProjectLimit: numberOption(args, "active-projects", 2),
        perProjectWorkerLimit: numberOption(args, "per-project-workers", numberOption(args, "workers", 2)),
        minFreeMemoryMb: numberOption(args, "min-free-memory-mb", 0),
        maxLoadPerCpu: numberOption(args, "max-load-per-cpu", Number.MAX_SAFE_INTEGER),
        providerLimits: {
          claude: numberOption(args, "claude-limit", Math.max(1, Math.ceil(numberOption(args, "workers", 2) / 2))),
          codex: numberOption(args, "codex-limit", Math.max(1, Math.floor(numberOption(args, "workers", 2) / 2))),
        },
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
      console.log(`controller ${controller.options.controllerId} running with ${adapter ?? controller.routingPolicy.version}; Ctrl-C to stop`);
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
