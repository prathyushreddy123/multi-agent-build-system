#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { artifactDir, dbPath, stateDir } from "./core/paths.ts";
import { launchClaude, launchCodex, sameModel } from "./verify/launch.ts";
import { bootstrapProject, resumeBootstrap } from "./bootstrap/service.ts";
import { ADMISSION_PENDING_PREFIX, Controller, ControllerLeaseHeldError, REVIEW_PENDING_PREFIX } from "./controller/controller.ts";
import { defaultAdapters } from "./adapters/harness.ts";
import { findCapability, loadCapabilityRegistry, recordEntitlementVerification } from "./routing/capabilities.ts";
import { selectRoute } from "./routing/router.ts";
import { SCHEDULING_POLICY_VERSION, canonicalRepoKey, collectActiveWork, evaluateAdmission } from "./scheduling/admission.ts";
import {
  analyzeProject,
  createProposal,
  createSuggestedProposal,
  evaluateProposal,
  parseConfigFile,
  proposalDetail,
  requestActivationApproval,
  requestRevertApproval,
  curatorRecommendations,
} from "./curator/service.ts";
import { importIncidentHistory } from "./incidents/projection.ts";
import { governancePrompts, improvementBoard, queueExplanations, taskScorecard, taskTimeline } from "./diagnostics/views.ts";
import { exporterFromSpec } from "./telemetry/exporter.ts";
import { BoundedTelemetryQueue } from "./telemetry/sink.ts";
import { INCIDENT_CONFIDENCE } from "./incidents/types.ts";
import { projectConfigSnapshot } from "./domain/config.ts";
import {
  GovernanceNeedsInputError,
  governanceNeedsInput,
  PROJECT_TYPES,
  REVIEW_CHOICES,
  type ProjectType,
  type ReviewChoice,
} from "./domain/project-policy.ts";
import { exec } from "./core/exec.ts";
import { taskDiagnostics } from "./diagnostics/task.ts";
import { ACTIONS } from "./domain/policy.ts";
import type { Action } from "./domain/policy.ts";
import { applyExecutionPlan, validateExecutionPlan } from "./domain/plan.ts";
import type { ExecutionPlan } from "./domain/plan.ts";
import { discoverChecks } from "./gates/discover.ts";
import {
  acceptPlan,
  answerClarification,
  askClarifications,
  briefDetail,
  productSummary,
  proposePlan,
  submitAcceptedPlan,
} from "./intake/service.ts";
import { briefGovernance, createBrief, listBriefs, resolveBrief, updateBrief } from "./intake/store.ts";
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
import { migrateDatabase } from "./maintenance/migrate.ts";
import { createBackup, pruneArtifacts, pruneWorktrees, RETENTION_POLICY } from "./maintenance/retention.ts";
import { getOperationsConfig, operationsStatus, prepareOperation, prepareOperationsConfig, requestExternalCostApproval, setOperationsConfig } from "./operations/service.ts";
import type { Capability, OperationsConfig } from "./operations/types.ts";
import { resolveApplicationProfiles } from "./profiles/index.ts";
import {
  authorizeRun,
  completeExperiment,
  createExperiment,
  experimentBudgetState,
  experimentDetail,
  listExperiments,
  prepareRun,
  recordMeasurement,
  recordTrialFromTask,
  startTrial,
  type ExperimentProtocol,
  type ExperimentVariant,
} from "./optimization/experiments.ts";
import { routingOutcomes } from "./optimization/routing.ts";
import { probeOperatorCapabilities, renderCapabilityReport } from "./operator/capabilities.ts";
import { diffFile, openFile, taskChanges, taskFiles } from "./operator/code.ts";
import { renderDashboard, reconcileView, INITIAL_VIEW, watchTasks } from "./operator/dashboard.ts";
import { buildProgressSnapshot, controllerFreshness } from "./operator/progress.ts";
import { controllerLiveness } from "./operator/liveness.ts";
import { followLog, listEvidence, readChunk, readTail } from "./operator/logs.ts";
import { closeWorkspace, openWorkspace, workspaceStatus } from "./operator/herdr.ts";
import { buildLauncherScreen, dispatchLauncherAction, runLauncher, type LauncherAction } from "./operator/launcher.ts";
import { parseOpenTarget } from "./operator/links.ts";
import { readPreferences } from "./operator/preferences.ts";
import { readViewerState, serveViewer, type SurfaceKey } from "./operator/viewer.ts";
import { serveToolView, type ToolViewSurface } from "./operator/workspace/tool-view.ts";
import { openRecords, Records } from "./store/records.ts";
import { Store } from "./store/db.ts";
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

function capacityFallbackOption(value: string | undefined): "allow" | "wait" | undefined {
  if (value === undefined) return undefined;
  if (value !== "allow" && value !== "wait") throw new Error("--capacity-fallback must be allow or wait");
  return value;
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
  // Tiered on purpose. A flat list of every command makes the eight you need
  // daily as hard to find as the ones you may never run.
  console.log(`mabs — local multi-agent build controller

EVERYDAY
  status                                    Queue, controller liveness, and health
  controller run [--adapter=codex] [--ui]   Run the controller loop (refuses a second instance)
      [--model=...] [--effort=low|medium|high] [--capacity-fallback=allow|wait]
      [--workers=1] [--gate-limit=N] [--adaptive]   One model worker unless a pilot is approved
      [--export=file:/abs/path|https://collector]  Optional redacted telemetry export (off by default)
  controller once [--adapter=codex]         Reconcile and dispatch one cycle
  task list [--project=id] [--state=READY]  What is queued, running, or blocked
  task show <id>                            One task with its evidence
  changes [<task>]                          Changed files for a task, with categories
  diff <task> <path> [--view]               Diff a file against the task's base revision
  ui [--port=4317]                          Localhost workbench

PRODUCTS AND PLANS
  brief create --payload='{"title":...}'        Start a product brief before any repository exists
  brief list | brief show <brief>
  brief update <brief> --version=N --summary=... --payload='{...}'
  brief ask <brief> --payload='{"questions":[...]}'
  brief answer <clarification> --answer=... | --assumption=...
  brief propose <brief> --payload='{"summary":...,"plan":{...}}'
  brief accept <brief> <proposal> --fingerprint=... --by=<person> [--note=...]
  brief submit <brief> [--project=id]           Apply the accepted plan; no hand-written JSON
  brief bootstrap <brief> <target> [--profile=auto|python|javascript-typescript]
  product show <brief>                          Brief, pending decisions, work, outputs, next actions
  plan validate <file> | plan apply <project> <file>
  plan list [--project=id] | plan show <id>

PROJECTS AND TASKS
  project add <name> <repo> [--type=personal|client|other] [--review=off|risk|required]
  project governance <project> --type=... [--review=...] --version=N
  project list | project status <id|name> <active|paused|archived>
  project review <id|name> [required|substantive|none]
  project preset <id|name> <experiment|personal|client> [--reason=...] [--acknowledge-weakening]
  project base <id|name> <branch>              Change target and invalidate open approvals
  requirement add <project> <id> <text>
  task add <project> <title> --objective=... [--class=small_implementation]
  task retry <id> --version=<recordVersion>
  task cancel <id> --version=<recordVersion>
  task watch [--project=<id>] [--interval=1000] [--json|--once]
  task steps <task>                            Recorded implementation steps
  task scorecard <task>                        Review, quality, usage coverage, model/effort provenance
  task timeline <task> [--limit=50] [--offset=0]
  queue explain [--limit=50] [--offset=0]      Why each waiting task is waiting
  project readiness                            Governance decisions still needed, with the command to answer
  improvements <project>                       Incidents, remedies, experiments, and proposals
  telemetry status                             Optional export state (disabled unless configured)
  obligation list <task>                       Durable findings, decisions, and their lifecycle
  obligation decide <obligation> --answer=... --by=<person>
                                               Record a human answer to a blocking decision

REVIEW, APPROVAL, FEEDBACK
  review decide <task>                         Explain the review decision for a task
  review request <task>                        Record an explicit manual review request
  approval request <task> <action> <target> --reason=...
  approval approve|reject <id> [--by=name]
  feedback add task|plan <id> <kind> --body=... --version=N
  feedback list [--project=id] | feedback answer <id> --response=...

CODE AND EVIDENCE (read-only; closing a surface never stops a worker)
  files [<task>] [--filter=...] [--attempt=<id>]
  open <task> <path> [--line=N] [--view] [--edit]
  dispatch <mabs://open/...>                   Open a MABS link through the same resolver
  logs <task> [--attempt=<id>]                 Evidence for a task and its attempts
  logs <task> --evidence=<id> [--tail=200] [--follow]
  workspace open [--project=<id>] [--layout=tabs|split] [--focus=code]
  workspace status | workspace close
  workspace view --surface=tasks|logs --workspace=<id>
                                               One rail-free surface in its own tab. The
                                               launcher starts this; scope arrives over the
                                               workspace's control channel, not as a command.
  launcher [--action=code|tasks|logs] [--project=<id>] [--task=<id>]
           [--attempt=<id>] [--path=<relative>] [--line=N] [--column=N]
           [--vscode=<executable>]
           [--dispatch|--json]                  Stock-Herdr popup and scoped CLI fallback
  viewer serve [--surface=code] [--viewer=vim] | viewer status [--surface=code]

MAINTENANCE
  maintenance policy                           Retention and backup defaults
  maintenance backup                           Consistent SQLite backup
  maintenance prune [--only=artifacts|worktrees] [--apply]
                                               Preview or apply retention. Branches are never removed.
  provider list | provider reset <name>
  routing capabilities                         Versioned model/effort/quota-domain registry (local only)
  routing explain <task>                       Recorded route decisions plus a dry, launch-free selection
  scheduler explain <task> [--workers=1] [--gate-limit=2]
                                               Why a task would or would not be admitted now (read-only)

OCCASIONAL — tuning and measurement
  curator analyze|snapshot|suggest <project>
  curator recommend <project>                   Evidence-backed remedies for recurring incidents (proposal only)
  incident import-history [--project=<id>] [--dry-run]
                                                Deterministic, idempotent incident projection
  incident list [--project=<id>] | incident show <incident>
  incident hypothesize <incident> --text=... --confidence=low|medium|high --by=<person>
  incident verify <incident> --cause=... --fix=<ref> --test=<ref> --by=<person>
  incident supersede <incident> --reason=... --by=<person>
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
  optimization prepare-run <experiment> --dry-run   Trial manifest and budget; zero provider calls
  optimization authorize <experiment> --fingerprint=... --by=<person>
  optimization record-trial <experiment> <variant> <case> <task> [--repeat=N]
  optimization routing [project]
  ops status <project>                          Effective disabled/manual operational capabilities
  ops configure <project> --version=N --payload='{...}' --reason=... [--dry-run|--request-approval]
  ops prepare <project> <capability>            Dry-run only; never executes an external action
  ops runs <project>                            Recorded operation attempts and recovery state

DIAGNOSTIC — when something is wrong or unproven
  verify [--quick]                              Subscription and access proof
  baseline [--only=a,b] [--harness=codex]       Task-class baseline; the evidence routing needs
  operator probe [--json] [--repo=<path>]       Prove Pi, Herdr, viewer, and worktree capabilities
  profile inspect <repo>                        Components, checks, setup, and artifacts
  bootstrap resume <id>                         Resume without duplicate projects or cleanup
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
  if (area === "operator" && action === "probe") {
    const args = parseArgs(rest);
    const capabilities = await probeOperatorCapabilities({ repoPath: textOption(args, "repo") });
    console.log(args.options.has("json") ? JSON.stringify(capabilities, null, 2) : renderCapabilityReport(capabilities));
    // Only the two narrow integration proofs gate the exit status. A missing
    // optional capability is reported with its limitation, not treated as a failure.
    const proofs = new Set(["OP0-10", "OP0-11"]);
    if (capabilities.probes.some((probe) => proofs.has(probe.id) && probe.status !== "PASS")) process.exitCode = 1;
    return;
  }

  if (area === "workspace") {
    const args = parseArgs(rest);
    if (action === "view") {
      const surface = textOption(args, "surface") as ToolViewSurface | undefined;
      const workspaceId = textOption(args, "workspace");
      if (!surface || !["tasks", "logs"].includes(surface) || !workspaceId) {
        throw new Error("Usage: mabs workspace view --surface=tasks|logs --workspace=<herdr-workspace-id>");
      }
      const viewRecords = openRecords();
      const stop = new AbortController();
      try {
        await Promise.race([
          serveToolView(viewRecords, { workspaceId, surface, signal: stop.signal, once: args.options.has("once") }),
          waitForSignal(() => stop.abort()),
        ]);
      } finally {
        stop.abort();
        viewRecords.store.close();
      }
      return;
    }
    if (action === "status") {
      console.log(JSON.stringify(await workspaceStatus(), null, 2));
      return;
    }
    if (action === "close") {
      console.log(JSON.stringify(await closeWorkspace(), null, 2));
      return;
    }
    if (action === "open") {
      const layout = textOption(args, "layout", "tabs");
      if (layout !== "tabs" && layout !== "split") throw new Error("--layout must be tabs or split");
      const focus = textOption(args, "focus") ?? null;
      if (focus && !["agent", "code", "tasks", "logs"].includes(focus)) {
        throw new Error("--focus must be agent, code, tasks, or logs");
      }
      const result = await openWorkspace({
        repoPath: resolve(textOption(args, "repo") ?? process.cwd()),
        projectId: textOption(args, "project") ?? null,
        layout,
        focus: focus as never,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error(`Usage: mabs workspace open|status|close|view`);
  }
  if (area === "viewer" && action === "serve") {
    const args = parseArgs(rest);
    const surface = (textOption(args, "surface", "code") ?? "code") as SurfaceKey;
    if (!["code", "diff", "logs"].includes(surface)) throw new Error("--surface must be code, diff, or logs");
    const viewer = textOption(args, "viewer") ?? readPreferences().viewer;
    console.log(`Serving the ${surface} surface. Ctrl-C stops this viewer only; workers are unaffected.`);
    await serveViewer({
      surface,
      viewer: viewer as never,
      onEvent: (event) => console.log(`[${event.kind}] ${event.detail}`),
    });
    return;
  }
  if (area === "viewer" && action === "status") {
    const args = parseArgs(rest);
    const surface = (textOption(args, "surface", "code") ?? "code") as SurfaceKey;
    console.log(JSON.stringify({ surface, viewer: readViewerState(surface) }, null, 2));
    return;
  }

  // Both run before openRecords, which would refuse an older schema. A backup
  // reads the source without migrating it: a pre-upgrade backup must be the
  // pre-upgrade database.
  if (area === "maintenance" && action === "backup") {
    const source = Store.openReadOnly(dbPath());
    try {
      console.log(await createBackup(new Records(source)));
    } finally {
      source.close();
    }
    return;
  }
  if (area === "maintenance" && action === "migrate") {
    console.log(JSON.stringify(await migrateDatabase(), null, 2));
    return;
  }

  const records = openRecords();
  let keepOpen = false;
  try {
    if (area === "launcher") {
      const args = parseArgs([action, ...rest].filter((value): value is string => Boolean(value)));
      const requestedAction = textOption(args, "action") as LauncherAction | undefined;
      if (requestedAction && !["code", "tasks", "logs"].includes(requestedAction)) {
        throw new Error("--action must be code, tasks, or logs");
      }
      const screen = buildLauncherScreen(records, {
        action: requestedAction,
        projectId: textOption(args, "project"),
        taskId: textOption(args, "task"),
        attemptId: textOption(args, "attempt"),
      });
      if (args.options.has("dispatch")) {
        const result = await dispatchLauncherAction(records, screen, {
          vscodeExecutable: textOption(args, "vscode"),
          codePath: textOption(args, "path"),
          line: args.options.has("line") ? numberOption(args, "line", 1) : null,
          column: args.options.has("column") ? numberOption(args, "column", 1) : null,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (args.options.has("json") || !process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(JSON.stringify(screen, null, 2));
        return;
      }
      const result = await runLauncher(records, screen.selection);
      if (result) console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (area === "files" || area === "changes" || area === "open" || area === "diff" || area === "dispatch") {
      const args = parseArgs([action, ...rest].filter((value): value is string => Boolean(value)));
      const selector = {
        attempt: textOption(args, "attempt"),
        project: textOption(args, "project"),
      };
      const useViewer = args.options.has("view") || args.options.has("edit");
      const mode = args.options.has("edit") ? "edit" as const : "read-only" as const;

      if (area === "dispatch") {
        const link = args.positionals[0];
        if (!link) throw new Error("Usage: mabs dispatch <mabs://open/...>");
        const target = parseOpenTarget(link);
        // A link is routed through exactly the same resolver as the picker and
        // the slash command, so it cannot select a different worktree.
        const result = target.action === "diff"
          ? await diffFile(records, target.path, { task: target.taskId, attempt: target.attemptId, project: target.projectId, revision: target.revision, useViewer, mode })
          : await openFile(records, target.path, { task: target.taskId, attempt: target.attemptId, project: target.projectId, revision: target.revision, line: target.line, useViewer, mode });
        console.log(JSON.stringify(result, null, 2));
        if (result.kind === "not-found") process.exitCode = 1;
        return;
      }
      if (area === "files") {
        const result = await taskFiles(records, {
          ...selector, task: args.positionals[0], filter: textOption(args, "filter"),
          limit: args.options.has("limit") ? numberOption(args, "limit", 2000) : undefined,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.kind === "not-found") process.exitCode = 1;
        return;
      }
      if (area === "changes") {
        const result = await taskChanges(records, { ...selector, task: args.positionals[0] });
        console.log(JSON.stringify(result, null, 2));
        if (result.kind === "not-found") process.exitCode = 1;
        return;
      }
      const [taskValue, path] = args.positionals;
      if (!path) throw new Error(`Usage: mabs ${area} <task> <path> [--line=N] [--view]`);
      const options = {
        ...selector, task: taskValue,
        line: args.options.has("line") ? numberOption(args, "line", 1) : null,
        revision: textOption(args, "revision"),
        useViewer, mode,
      };
      const result = area === "diff"
        ? await diffFile(records, path, options)
        : await openFile(records, path, options);
      console.log(JSON.stringify(result, null, 2));
      if (result.kind === "not-found") process.exitCode = 1;
      return;
    }
    if (area === "project" && action === "add") {
      const args = parseArgs(rest);
      const [name, repoArg] = args.positionals;
      if (!name || !repoArg) throw new Error("Usage: mabs project add <name> <repo> [--type=personal|client|other] [--review=off|risk|required]");
      const repoPath = resolve(repoArg);
      const projectType = textOption(args, "type") as ProjectType | undefined;
      const reviewChoice = textOption(args, "review") as ReviewChoice | undefined;
      if (projectType !== undefined && !PROJECT_TYPES.includes(projectType)) throw new Error(`Unknown project type: ${projectType}`);
      if (reviewChoice !== undefined && !REVIEW_CHOICES.includes(reviewChoice)) throw new Error(`Unknown review choice: ${reviewChoice}`);
      const project = records.createProject({
        name,
        repoPath,
        baseBranch: textOption(args, "base") ?? await baseBranch(repoPath),
        goal: textOption(args, "goal"),
        projectType: projectType ?? null,
        reviewChoice: reviewChoice ?? null,
        governanceActor: textOption(args, "by", "local-cli"),
        governanceSource: "cli-project-add",
        checkCommands: args.options.has("no-checks") ? [] : discoverChecks(repoPath),
      });
      console.log(JSON.stringify(
        governanceNeedsInput({ kind: "project", id: project.id }, project.governance, project.reviewPolicy) ?? project,
        null,
        2,
      ));
      return;
    }
    if (area === "project" && action === "governance") {
      const args = parseArgs(rest);
      const project = args.positionals[0] ? resolveProject(records, args.positionals[0] as string) : null;
      const projectType = textOption(args, "type") as ProjectType | undefined;
      const suppliedReview = textOption(args, "review") as ReviewChoice | undefined;
      const reviewChoice = projectType === "client" && suppliedReview === undefined ? "required" : suppliedReview;
      const version = Number(textOption(args, "version"));
      if (!project || !projectType || !reviewChoice || !Number.isSafeInteger(version)) {
        throw new Error("Usage: mabs project governance <project> --type=personal|client|other --review=off|risk|required --version=N");
      }
      if (!PROJECT_TYPES.includes(projectType) || !REVIEW_CHOICES.includes(reviewChoice)) throw new Error("Invalid project governance choice.");
      const decision = records.recordProjectDecision({
        projectId: project.id,
        projectType,
        reviewChoice,
        actor: textOption(args, "by", "local-cli") as string,
        source: "cli-project-governance",
      }, version);
      console.log(JSON.stringify({ decision, project: records.getProject(project.id) }, null, 2));
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
    if (area === "logs") {
      const args = parseArgs([action, ...rest].filter((value): value is string => Boolean(value)));
      const taskValue = args.positionals[0];
      if (!taskValue) throw new Error("Usage: mabs logs <task> [--attempt=<id>] [--evidence=<id>] [--follow]");
      const task = records.getTask(taskValue) ?? records.listTasks().find((item) => item.id.startsWith(taskValue));
      if (!task) throw new Error(`Unknown task ${taskValue}`);
      const listing = listEvidence(records, { taskId: task.id, attemptId: textOption(args, "attempt") });

      const evidenceId = textOption(args, "evidence");
      if (!evidenceId) {
        console.log(JSON.stringify(listing, null, 2));
        return;
      }
      const selected = listing.entries.find((item) => item.id === evidenceId || item.id.endsWith(`:${evidenceId}`));
      if (!selected) throw new Error(`No evidence ${evidenceId} for task ${task.id}. Run mabs logs ${task.id} to list it.`);
      if (!selected.exists) {
        console.log(JSON.stringify({ evidence: selected, unavailableReason: selected.unavailableReason }, null, 2));
        process.exitCode = 1;
        return;
      }

      if (!args.options.has("follow")) {
        const chunk = args.options.has("from")
          ? readChunk(selected.path, { offset: numberOption(args, "from", 0) })
          : readTail(selected.path, numberOption(args, "tail", 200));
        console.log(`# ${selected.label} — ${selected.path}`);
        if (selected.navigationNote) console.log(`# ${selected.navigationNote}`);
        for (const line of chunk.lines) console.log(line);
        console.log(`# offset ${chunk.to}${chunk.atEnd ? " (end of file)" : ""}`);
        return;
      }

      keepOpen = true;
      const stop = new AbortController();
      console.log(`# following ${selected.label} — ${selected.path}`);
      console.log("# Ctrl-C stops following only; the worker keeps running.");
      const following = (async () => {
        for await (const chunk of followLog(selected.path, {
          fromOffset: 0,
          signal: stop.signal,
          // The attempt's own state decides when following can end.
          isFinished: () => records.getAttempt(selected.attemptId ?? "")?.state !== "running",
        })) {
          if (chunk.rotated) console.log("# the evidence file was replaced or truncated; following the new file from its start");
          if (chunk.unavailableReason) console.log(`# ${chunk.unavailableReason}`);
          for (const line of chunk.lines) console.log(line);
        }
      })();
      await Promise.race([following, waitForSignal(() => stop.abort())]);
      await following.catch(() => undefined);
      records.store.close();
      return;
    }
    if (area === "task" && action === "watch") {
      const args = parseArgs(rest);
      const projectValue = textOption(args, "project");
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (projectValue && !project) throw new Error(`Unknown project ${projectValue}`);
      const once = args.options.has("once") || args.options.has("json") || !process.stdout.isTTY;
      if (once) {
        // Non-interactive callers get one honest snapshot rather than a loop
        // that would never repaint.
        const snapshot = buildProgressSnapshot(records, { projectId: project?.id, withSteps: true });
        if (args.options.has("json")) console.log(JSON.stringify(snapshot, null, 2));
        else console.log(renderDashboard(snapshot, reconcileView(snapshot, { ...INITIAL_VIEW, pageSize: 50 })));
        return;
      }
      keepOpen = true;
      const stop = new AbortController();
      const watching = watchTasks(records, {
        projectId: project?.id,
        intervalMs: numberOption(args, "interval", 1000),
        signal: stop.signal,
      });
      // Ctrl-C stops this dashboard only. No worker or task is touched.
      await Promise.race([watching, waitForSignal(() => stop.abort())]);
      await watching.catch(() => undefined);
      records.store.close();
      return;
    }
    if (area === "task" && action === "steps") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: mabs task steps <id>");
      const snapshot = buildProgressSnapshot(records, { taskId: id, withSteps: true });
      if (snapshot.tasks.length === 0) throw new Error(`Unknown task ${id}`);
      console.log(JSON.stringify({
        task: snapshot.tasks[0],
        controller: snapshot.controller,
        notes: snapshot.notes,
      }, null, 2));
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
    if (area === "bootstrap" && action === "resume") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: mabs bootstrap resume <id>");
      console.log(JSON.stringify(resumeBootstrap(records, id, textOption(args, "by", "local-cli")), null, 2));
      return;
    }
    if (area === "profile" && action === "inspect") {
      const args = parseArgs(rest);
      const repo = args.positionals[0];
      if (!repo) throw new Error("Usage: mabs profile inspect <repo>");
      console.log(JSON.stringify(resolveApplicationProfiles(resolve(repo)), null, 2));
      return;
    }
    if (area === "ops") {
      const args = parseArgs(rest);
      const value = args.positionals[0];
      const project = value ? resolveProject(records, value) : null;
      if (!project) throw new Error(`Usage: mabs ops ${String(action)} <project> ...`);
      if (action === "status") {
        console.log(JSON.stringify(operationsStatus(records, project.id), null, 2));
        return;
      }
      if (action === "runs") {
        console.log(JSON.stringify(operationsStatus(records, project.id).runs, null, 2));
        return;
      }
      if (action === "prepare") {
        const capability = args.positionals[1] as Capability | undefined;
        if (!capability || !["ci", "deployment", "monitoring", "scheduling", "delivery", "costs"].includes(capability)) {
          throw new Error("Usage: mabs ops prepare <project> <ci|deployment|monitoring|scheduling|delivery|costs>");
        }
        console.log(JSON.stringify(prepareOperation(records, project.id, capability), null, 2));
        return;
      }
      if (action === "configure") {
        const expectedVersion = Number(textOption(args, "version"));
        const raw = textOption(args, "payload");
        const reason = textOption(args, "reason");
        if (!Number.isSafeInteger(expectedVersion) || !raw || !reason) {
          throw new Error("Usage: mabs ops configure <project> --version=N --payload='{...}' --reason=...");
        }
        const config = JSON.parse(raw) as OperationsConfig;
        if (args.options.get("dry-run") === true) {
          console.log(JSON.stringify(prepareOperationsConfig(records, project.id, config), null, 2));
          return;
        }
        if (args.options.get("request-approval") === true) {
          console.log(JSON.stringify(requestExternalCostApproval(records, { projectId: project.id, config, reason }), null, 2));
          return;
        }
        console.log(JSON.stringify(setOperationsConfig(records, {
          projectId: project.id, expectedVersion, config,
          actor: textOption(args, "by", "local-cli") as string, reason,
          approvalId: textOption(args, "approval"),
        }), null, 2));
        return;
      }
      throw new Error(`Unknown ops command: ${String(action)}. Current version: ${getOperationsConfig(records, project.id).version}.`);
    }
    if (area === "brief" || (area === "product" && action === "show")) {
      const args = parseArgs(rest);
      const payload = (() => {
        const raw = textOption(args, "payload");
        if (!raw) return {} as Record<string, unknown>;
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--payload must be a JSON object");
        return parsed as Record<string, unknown>;
      })();
      const actor = textOption(args, "by", "local-cli") as string;

      if (area === "product") {
        const value = args.positionals[0];
        if (!value) throw new Error("Usage: mabs product show <brief>");
        console.log(JSON.stringify(productSummary(records, value), null, 2));
        return;
      }
      if (action === "create") {
        const brief = createBrief(records, {
          ...(payload as Record<string, never>), createdBy: actor,
        } as Parameters<typeof createBrief>[1]);
        const pending = governanceNeedsInput({ kind: "brief", id: brief.id }, briefGovernance(brief));
        console.log(JSON.stringify(pending ? { ...pending, draft: brief } : brief, null, 2));
        return;
      }
      if (action === "list") {
        console.log(JSON.stringify(listBriefs(records), null, 2));
        return;
      }
      if (action === "show") {
        const value = args.positionals[0];
        if (!value) throw new Error("Usage: mabs brief show <brief>");
        console.log(JSON.stringify(briefDetail(records, value), null, 2));
        return;
      }
      if (action === "update") {
        const value = args.positionals[0];
        const expectedVersion = Number(textOption(args, "version"));
        const summary = textOption(args, "summary");
        const brief = value ? resolveBrief(records, value) : null;
        if (!brief || !summary || !Number.isSafeInteger(expectedVersion)) {
          throw new Error("Usage: mabs brief update <brief> --version=N --summary=... --payload='{...}'");
        }
        const result = updateBrief(records, {
          briefId: brief.id, expectedVersion, summary, actor, patch: payload as never,
        });
        const pending = governanceNeedsInput({ kind: "brief", id: result.brief.id }, briefGovernance(result.brief));
        console.log(JSON.stringify(pending ? { ...pending, update: result } : result, null, 2));
        return;
      }
      if (action === "ask") {
        const value = args.positionals[0];
        if (!value) throw new Error("Usage: mabs brief ask <brief> --payload='{\"questions\":[...]}'");
        console.log(JSON.stringify(askClarifications(records, {
          brief: value, questions: (payload.questions ?? []) as never, actor,
        }), null, 2));
        return;
      }
      if (action === "answer") {
        const id = args.positionals[0];
        if (!id) throw new Error("Usage: mabs brief answer <clarification> --answer=... | --assumption=...");
        console.log(JSON.stringify(answerClarification(records, {
          id, answer: textOption(args, "answer"), assumption: textOption(args, "assumption"), actor,
        }), null, 2));
        return;
      }
      if (action === "propose") {
        const value = args.positionals[0];
        if (!value) throw new Error("Usage: mabs brief propose <brief> --payload='{...}'");
        const result = proposePlan(records, {
          brief: value, actor, ...(payload as Record<string, never>),
        } as Parameters<typeof proposePlan>[1]);
        const pending = governanceNeedsInput({ kind: "brief", id: result.brief.id }, briefGovernance(result.brief));
        console.log(JSON.stringify(pending ? { ...pending, proposal: result } : result, null, 2));
        if (!result.valid) process.exitCode = 1;
        return;
      }
      if (action === "accept") {
        const [value, proposalId] = args.positionals;
        const fingerprint = textOption(args, "fingerprint");
        const acceptedBy = textOption(args, "by");
        if (!value || !proposalId || !fingerprint || !acceptedBy) {
          throw new Error("Usage: mabs brief accept <brief> <proposal> --fingerprint=... --by=<person> [--note=...]");
        }
        console.log(JSON.stringify(acceptPlan(records, {
          brief: value, proposalId, fingerprint, acceptedBy, note: textOption(args, "note"),
        }), null, 2));
        return;
      }
      if (action === "submit") {
        const value = args.positionals[0];
        if (!value) throw new Error("Usage: mabs brief submit <brief> [--project=id]");
        const projectValue = textOption(args, "project");
        const project = projectValue ? resolveProject(records, projectValue) : null;
        if (projectValue && !project) throw new Error(`Unknown project ${projectValue}`);
        console.log(JSON.stringify(submitAcceptedPlan(records, {
          brief: value, projectId: project?.id, actor,
        }), null, 2));
        return;
      }
      if (action === "bootstrap") {
        const [value, targetPath] = args.positionals;
        const brief = value ? resolveBrief(records, value) : null;
        if (!brief || !targetPath) {
          throw new Error("Usage: mabs brief bootstrap <brief> <target> [--profile=auto|python|javascript-typescript] [--package-manager=...]");
        }
        console.log(JSON.stringify(bootstrapProject(records, {
          briefId: brief.id,
          targetPath,
          profile: textOption(args, "profile", "auto") as Parameters<typeof bootstrapProject>[1]["profile"],
          packageManager: textOption(args, "package-manager") as Parameters<typeof bootstrapProject>[1]["packageManager"],
          language: textOption(args, "language"),
          runtime: textOption(args, "runtime"),
          projectName: textOption(args, "name"),
          actor,
        }), null, 2));
        return;
      }
      throw new Error(`Unknown brief command: ${String(action)}. Run mabs help.`);
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
    if (area === "curator" && action === "recommend") {
      const project = rest[0] ? resolveProject(records, rest[0]) : null;
      if (!project) throw new Error("Usage: mabs curator recommend <project>");
      console.log(JSON.stringify(curatorRecommendations(records, project.id), null, 2));
      return;
    }
    if (area === "incident" && action === "import-history") {
      const args = parseArgs(rest);
      const projectValue = textOption(args, "project");
      const project = projectValue ? resolveProject(records, projectValue) : null;
      if (projectValue && !project) throw new Error(`Unknown project ${projectValue}`);
      console.log(JSON.stringify(importIncidentHistory(records, { projectId: project?.id, dryRun: args.options.has("dry-run") }), null, 2));
      return;
    }
    if (area === "incident" && action === "list") {
      const args = parseArgs(rest);
      const projectValue = textOption(args, "project");
      const project = projectValue ? resolveProject(records, projectValue) : null;
      console.log(JSON.stringify(records.listIncidents({ projectId: project?.id }).map((incident) => ({
        ...incident, occurrences: records.incidentOccurrences(incident.id).length,
      })), null, 2));
      return;
    }
    if (area === "incident" && action === "show") {
      const incident = rest[0] ? records.getIncident(rest[0]) : null;
      if (!incident) throw new Error("Usage: mabs incident show <incident>");
      console.log(JSON.stringify({ incident, occurrences: records.incidentOccurrences(incident.id) }, null, 2));
      return;
    }
    if (area === "incident" && (action === "hypothesize" || action === "verify" || action === "supersede")) {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const by = textOption(args, "by");
      if (!id || !by?.trim()) throw new Error(`Usage: mabs incident ${action} <incident> ... --by=<person>`);
      if (action === "hypothesize") {
        const confidence = textOption(args, "confidence") ?? "low";
        if (!["low", "medium", "high"].includes(confidence) || !INCIDENT_CONFIDENCE.includes(confidence as never)) {
          throw new Error("--confidence must be low, medium, or high; verified requires `incident verify`.");
        }
        const text = textOption(args, "text");
        if (!text?.trim()) throw new Error("--text is required");
        console.log(JSON.stringify(records.updateIncident(id, { hypothesis: text, confidence: confidence as "low", lifecycle: "investigating" }, by), null, 2));
      } else if (action === "verify") {
        const cause = textOption(args, "cause");
        const fix = textOption(args, "fix");
        const testRef = textOption(args, "test");
        if (!cause?.trim() || !fix?.trim() || !testRef?.trim()) throw new Error("--cause, --fix, and --test are all required to verify a lesson.");
        console.log(JSON.stringify(records.updateIncident(id, {
          confirmedCause: cause, confidence: "verified", lifecycle: "resolved", fixRefs: [fix], testRefs: [testRef],
        }, by), null, 2));
      } else {
        const reason = textOption(args, "reason");
        if (!reason?.trim()) throw new Error("--reason is required");
        const current = records.getIncident(id);
        console.log(JSON.stringify(records.updateIncident(id, {
          lifecycle: "superseded", lessonRefs: [...(current?.lessonRefs ?? []), `superseded: ${reason}`],
        }, by), null, 2));
      }
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
    if (area === "task" && action === "scorecard") {
      if (!rest[0]) throw new Error("Usage: mabs task scorecard <task>");
      console.log(JSON.stringify(taskScorecard(records, rest[0]), null, 2));
      return;
    }
    if (area === "task" && action === "timeline") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: mabs task timeline <task> [--limit=50] [--offset=0]");
      console.log(JSON.stringify(taskTimeline(records, id, { limit: numberOption(args, "limit", 50), offset: numberOption(args, "offset", 0) }), null, 2));
      return;
    }
    if (area === "queue" && action === "explain") {
      const args = parseArgs(rest);
      console.log(JSON.stringify(queueExplanations(records, { limit: numberOption(args, "limit", 50), offset: numberOption(args, "offset", 0) }), null, 2));
      return;
    }
    if (area === "project" && action === "readiness") {
      console.log(JSON.stringify(governancePrompts(records), null, 2));
      return;
    }
    if (area === "improvements") {
      const project = action ? resolveProject(records, action) : null;
      if (!project) throw new Error("Usage: mabs improvements <project>");
      console.log(JSON.stringify(improvementBoard(records, project.id), null, 2));
      return;
    }
    if (area === "telemetry" && action === "status") {
      const path = join(stateDir(), "telemetry-status.json");
      console.log(JSON.stringify(existsSync(path)
        ? { enabled: true, ...JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> }
        : { enabled: false, note: "No exporter is configured. Local evidence is complete without one; nothing is sent anywhere." }, null, 2));
      return;
    }
    if (area === "obligation" && action === "list") {
      if (!rest[0]) throw new Error("Usage: mabs obligation list <task>");
      console.log(JSON.stringify(records.listObligations(rest[0]), null, 2));
      return;
    }
    if (area === "obligation" && action === "decide") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const answer = textOption(args, "answer");
      const by = textOption(args, "by");
      if (!id || !answer?.trim() || !by?.trim()) throw new Error("Usage: mabs obligation decide <obligation> --answer=... --by=<person>");
      console.log(JSON.stringify(records.decideObligation(id, { answer, decidedBy: by }), null, 2));
      return;
    }
    if (area === "scheduler" && action === "explain") {
      const args = parseArgs(rest);
      const task = args.positionals[0] ? records.getTask(args.positionals[0]) : null;
      if (!task) throw new Error("Usage: mabs scheduler explain <task>");
      const project = records.getProject(task.projectId);
      if (!project) throw new Error(`Unknown project ${task.projectId}`);
      const workers = numberOption(args, "workers", 1);
      const providerLimits: Record<string, number> = {};
      for (const provider of records.listProviderCapacity()) providerLimits[provider.provider] = provider.maxConcurrency;
      const active = collectActiveWork(records, [ADMISSION_PENDING_PREFIX, REVIEW_PENDING_PREFIX]);
      const explanation = evaluateAdmission({
        taskId: task.id, projectId: task.projectId, repoKey: canonicalRepoKey(project.repoPath),
        kind: task.taskClass === "mechanical" ? "gate" : "model", provider: null,
        executionMode: task.executionMode, writeScope: task.allowedScope, resources: task.resources,
      }, active, {
        modelWorkers: workers, providerLimits, perProjectTasks: numberOption(args, "per-project-workers", workers),
        activeProjects: numberOption(args, "active-projects", 2), gateJobs: numberOption(args, "gate-limit", Math.max(2, workers)), childAgents: 0,
      });
      console.log(JSON.stringify({ task: task.id, state: task.state, policy: SCHEDULING_POLICY_VERSION, explanation, active }, null, 2));
      return;
    }
    if (area === "routing" && action === "capabilities") {
      console.log(JSON.stringify(loadCapabilityRegistry(), null, 2));
      return;
    }
    if (area === "routing" && action === "verify-entitlement") {
      // One minimal provider call on an exact registered route. Only a clean
      // answer from that exact model records entitlement; nothing else does.
      const [provider, model] = rest;
      if ((provider !== "claude" && provider !== "codex") || !model) {
        throw new Error("Usage: mabs routing verify-entitlement <claude|codex> <model>");
      }
      const capability = findCapability(loadCapabilityRegistry(), provider, model);
      if (!capability) throw new Error(`${provider}:${model} is not a registered route; the registry is a reviewed code change`);
      const effort = capability.efforts[0] as string;
      const dir = artifactDir("entitlement", `${provider}-${model}-${Date.now()}`);
      const evidencePath = join(dir, "probe.log");
      const launch = provider === "claude" ? launchClaude : launchCodex;
      const result = await launch({ cwd: dir, prompt: "Reply with exactly: ok", model, effort, timeoutMs: 180_000, evidencePath });
      const answered = result.exitCode === 0 && !result.timedOut && result.finalMessage.trim().length > 0;
      const wrongModel = result.reportedModel !== null && !sameModel(result.reportedModel, model);
      if (!answered || wrongModel) {
        throw new Error(`Entitlement not verified for ${provider}:${model} (exit=${result.exitCode}, reported=${result.reportedModel ?? "unreported"}); evidence: ${evidencePath}`);
      }
      recordEntitlementVerification({ provider, model, effort, verifiedAt: new Date().toISOString(), evidencePath });
      console.log(`${provider}:${model} entitlement verified; evidence: ${evidencePath}`);
      return;
    }
    if (area === "routing" && action === "explain") {
      const task = rest[0] ? records.getTask(rest[0]) : null;
      if (!task) throw new Error("Usage: mabs routing explain <task>");
      const running = new Map<string, number>();
      for (const attempt of records.listRunningAttempts()) running.set(attempt.adapter, (running.get(attempt.adapter) ?? 0) + 1);
      const providers = records.listProviderCapacity().map((provider) => ({
        provider: provider.provider,
        available: provider.state === "available",
        active: running.get(provider.provider) ?? 0,
        limit: provider.maxConcurrency,
        reason: provider.reason,
      }));
      // Pure selection: no claim, reservation, provider row, or process.
      const capabilityRegistry = loadCapabilityRegistry();
      const dryRun = selectRoute({ task, adapters: defaultAdapters(capabilityRegistry), providers, capabilityRegistry });
      console.log(JSON.stringify({ task: task.id, recorded: records.routingForTask(task.id), dryRun }, null, 2));
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
        // The health row records what a controller last said. Freshness and
        // liveness say whether that claim is still worth believing, which the
        // raw row cannot: a killed controller leaves "running" behind forever.
        controller: { ...controllerFreshness(records), liveness: controllerLiveness(records) },
        health: records.latestHealth() ?? null,
        // Decisions only a person can make, never defaulted.
        needsInput: governancePrompts(records),
        waiting: queueExplanations(records, { limit: 500 }).items.reduce<Record<string, number>>((counts, item) => {
          counts[item.category] = (counts[item.category] ?? 0) + 1;
          return counts;
        }, {}),
      }, null, 2));
      return;
    }
    if (area === "maintenance" && action === "policy") {
      console.log(JSON.stringify(RETENTION_POLICY, null, 2));
      return;
    }
    if (area === "maintenance" && action === "prune") {
      const args = parseArgs(rest);
      const applied = args.options.has("apply");
      // Worktrees can be reclaimed on their own, because they are the bulk of
      // the disk cost and the only part with refusal conditions worth reading.
      const only = textOption(args, "only");
      if (only !== undefined && only !== "artifacts" && only !== "worktrees") {
        throw new Error("--only must be artifacts or worktrees");
      }
      const artifacts = only === "worktrees" ? [] : pruneArtifacts(records, { apply: applied });
      const worktrees = only === "artifacts" ? [] : await pruneWorktrees(records, { apply: applied });
      const refused = worktrees.filter((candidate) => candidate.refusal !== null);
      console.log(JSON.stringify({
        applied,
        artifacts,
        worktrees: {
          // Branches are never touched, so this can never lose a commit.
          branchesRetained: true,
          removable: worktrees.filter((candidate) => candidate.refusal === null),
          refused,
        },
      }, null, 2));
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
        protocol?: ExperimentProtocol;
      };
      console.log(JSON.stringify(createExperiment(records, {
        projectId: project?.id ?? null,
        name: definition.name, hypothesis: definition.hypothesis, dimension: definition.dimension,
        suiteVersion: definition.suiteVersion, baselineConfig: definition.baselineConfig ?? {},
        candidateConfig: definition.candidateConfig ?? {},
        protocol: definition.protocol,
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
    if (area === "optimization" && action === "prepare-run") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      if (!id || !args.options.has("dry-run")) throw new Error("Usage: mabs optimization prepare-run <experiment> --dry-run");
      console.log(JSON.stringify(prepareRun(records, id), null, 2));
      return;
    }
    if (area === "optimization" && action === "authorize") {
      const args = parseArgs(rest);
      const id = args.positionals[0];
      const fingerprint = textOption(args, "fingerprint");
      const by = textOption(args, "by");
      if (!id || !fingerprint || !by) throw new Error("Usage: mabs optimization authorize <experiment> --fingerprint=<from prepare-run> --by=<person>");
      console.log(JSON.stringify(authorizeRun(records, id, { fingerprint, authorizedBy: by }), null, 2));
      return;
    }
    if (area === "optimization" && action === "start-trial") {
      const args = parseArgs(rest);
      const [id, variant, caseKey] = args.positionals;
      if (!id || !caseKey || (variant !== "baseline" && variant !== "candidate")) {
        throw new Error("Usage: mabs optimization start-trial <experiment> <baseline|candidate> <case> [--repeat=0]");
      }
      const started = startTrial(records, { experimentId: id, variant, caseKey, repeatIndex: numberOption(args, "repeat", 0) });
      console.log(JSON.stringify(started, null, 2));
      return;
    }
    if (area === "optimization" && action === "budget") {
      const id = rest[0];
      if (!id) throw new Error("Usage: mabs optimization budget <experiment>");
      console.log(JSON.stringify(experimentBudgetState(records, id), null, 2));
      return;
    }
    if (area === "optimization" && action === "record-trial") {
      const args = parseArgs(rest);
      const [id, variant, caseKey, taskId] = args.positionals;
      if (!id || !variant || !caseKey || !taskId || !["baseline", "candidate"].includes(variant)) {
        throw new Error("Usage: mabs optimization record-trial <experiment> <baseline|candidate> <case> <task> [--repeat=0]");
      }
      console.log(JSON.stringify(recordTrialFromTask(records, {
        experimentId: id, variant: variant as ExperimentVariant, caseKey, repeatIndex: numberOption(args, "repeat", 0), taskId,
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

      // Refuse to become the second controller. Without this, the loser of the
      // lease race runs forever, failing every tick and dispatching nothing.
      // Exit 0 because "one is already running" is the desired end state.
      const existing = controllerLiveness(records);
      if (existing.startWouldContend && !args.options.has("force")) {
        console.log(existing.reason);
        console.log("Not starting a second controller. Use --force to override, or stop the running one first.");
        return;
      }
      if (existing.state === "wedged" || existing.state === "crashed") console.warn(existing.reason);

      const controller = new Controller(records, {
        capabilityRegistry: loadCapabilityRegistry(),
        defaultAdapter: adapter as "claude" | "codex" | undefined,
        defaultModel: textOption(args, "model") ?? null,
        defaultEffort: textOption(args, "effort") ?? null,
        capacityFallback: capacityFallbackOption(textOption(args, "capacity-fallback")),
        // One model worker is the production setting; more is an explicit, separately approved pilot.
        workerLimit: numberOption(args, "workers", 1),
        activeProjectLimit: numberOption(args, "active-projects", 2),
        perProjectWorkerLimit: numberOption(args, "per-project-workers", numberOption(args, "workers", 1)),
        gateLimit: args.options.has("gate-limit") ? numberOption(args, "gate-limit", 2) : undefined,
        // Export is off unless a target is named; there is no default destination.
        telemetry: new BoundedTelemetryQueue({ exporter: exporterFromSpec(textOption(args, "export")) }),
        adaptiveConcurrency: args.options.has("adaptive") ? {} : undefined,
        minFreeMemoryMb: numberOption(args, "min-free-memory-mb", 0),
        maxLoadPerCpu: numberOption(args, "max-load-per-cpu", Number.MAX_SAFE_INTEGER),
        providerLimits: {
          claude: numberOption(args, "claude-limit", Math.max(1, Math.ceil(numberOption(args, "workers", 1) / 2))),
          codex: numberOption(args, "codex-limit", Math.max(1, Math.floor(numberOption(args, "workers", 1) / 2))),
        },
      });
      if (action === "once") {
        await controller.tick();
        await controller.stop();
        console.log("controller cycle complete");
        return;
      }
      let workbench: ReturnType<typeof createWorkbench> | null = null;
      const stopWorkbench = async () => {
        if (workbench) await new Promise<void>((resolvePromise) => workbench?.server.close(() => resolvePromise()));
      };
      keepOpen = true;
      if (args.options.has("ui")) {
        workbench = createWorkbench(records, { controller, port: numberOption(args, "port", 4317) });
        const address = await workbench.listen();
        console.log(`workbench: http://${address.host}:${address.port}`);
      }
      // Losing the lease race mid-flight is not a retryable fault: stand down
      // and exit rather than fail every tick for the life of the process.
      controller.start({
        onStepDown: (error: ControllerLeaseHeldError) => {
          console.error(error.message);
          void (async () => {
            await controller.stop();
            await stopWorkbench();
            records.store.close();
            process.exit(1);
          })();
        },
      });
      if (!controller.stepDownReason) {
        console.log(`controller ${controller.options.controllerId} running with ${adapter ?? controller.routingPolicy.version}; Ctrl-C to stop`);
      }
      await waitForSignal(async () => {
        await controller.stop();
        await stopWorkbench();
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
      const controller = new Controller(records, { capabilityRegistry: loadCapabilityRegistry() });
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
  if (error instanceof GovernanceNeedsInputError) {
    console.log(JSON.stringify(error.result, null, 2));
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
