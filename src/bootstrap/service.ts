/** Safe, restartable local project bootstrap. No package installation occurs here. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  activeAcceptance,
  createBootstrapRun,
  getBrief,
  getBootstrapRun,
  linkBriefProject,
  listBootstrapRuns,
  setBriefState,
  updateBootstrapRun,
} from "../intake/store.ts";
import { submitAcceptedPlan } from "../intake/service.ts";
import type { BootstrapRun, BootstrapStep, ProductBrief } from "../intake/types.ts";
import { resolveApplicationProfiles, scaffoldProfile, type PackageManager, type ProfileKind } from "../profiles/index.ts";
import { reviewPreset } from "../review/policy.ts";
import type { Project, Records, Task } from "../store/records.ts";

export const BOOTSTRAP_STEPS = [
  "directory_creation",
  "git_initialization",
  "skeleton_generation",
  "environment_configuration",
  "profile_resolution",
  "initial_commit",
  "project_registration",
  "check_registration",
  "plan_linkage",
] as const;
export type BootstrapStepName = (typeof BOOTSTRAP_STEPS)[number];

export interface BootstrapInput {
  briefId: string;
  targetPath: string;
  profile?: ProfileKind | "auto";
  packageManager?: PackageManager;
  language?: string | null;
  runtime?: string | null;
  projectName?: string;
  actor?: string;
  /** Deterministic interruption injection used by recovery tests; not exposed by Pi. */
  interruptAfterStep?: BootstrapStepName;
}

export interface BootstrapResult {
  run: BootstrapRun;
  brief: ProductBrief;
  project: Project | null;
  tasks: Task[];
}

function at(): string { return new Date().toISOString(); }

function initialSteps(): BootstrapStep[] {
  return BOOTSTRAP_STEPS.map((name) => ({ name, state: "pending", detail: null, at: null }));
}

function replaceStep(run: BootstrapRun, name: BootstrapStepName, state: BootstrapStep["state"], detail: string | null): BootstrapRun {
  const steps = run.steps.map((step) => step.name === name ? { ...step, state, detail, at: at() } : step);
  return { ...run, steps };
}

function execute(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || `exit ${String(result.status)}`).trim()}`);
  }
  return result.stdout.trim();
}

function markerPath(targetPath: string): string { return join(targetPath, ".mabs", "bootstrap.json"); }

function readMarker(targetPath: string): { bootstrapId?: string; briefId?: string } | null {
  try { return JSON.parse(readFileSync(markerPath(targetPath), "utf8")) as { bootstrapId?: string; briefId?: string }; }
  catch { return null; }
}

function safeTarget(targetPath: string): string {
  const target = resolve(targetPath);
  if (target === "/" || target === resolve(process.env.HOME ?? "/nonexistent")) {
    throw new Error(`Refusing unsafe bootstrap target ${target}; choose a dedicated product directory.`);
  }
  return target;
}

function ensureRelatedOrEmpty(targetPath: string, run: BootstrapRun): void {
  if (!existsSync(targetPath)) return;
  const entries = readdirSync(targetPath);
  if (entries.length === 0) return;
  const marker = readMarker(targetPath);
  if (marker?.bootstrapId === run.id && marker.briefId === run.briefId) return;
  throw new Error(
    `Refusing to overwrite non-empty unrelated directory ${targetPath}. ` +
    "Choose an empty directory, or resume using the bootstrap ID recorded in that directory.",
  );
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function projectForRun(records: Records, run: BootstrapRun, name: string, targetPath: string): Project | null {
  if (run.projectId) {
    const recorded = records.getProject(run.projectId);
    if (!recorded) throw new Error(`Bootstrap ${run.id} refers to missing project ${run.projectId}; repair the linkage before resuming.`);
    if (resolve(recorded.repoPath) !== targetPath) throw new Error(`Bootstrap ${run.id} project path changed from ${targetPath} to ${recorded.repoPath}.`);
    return recorded;
  }
  const byName = records.findProjectByName(name);
  if (!byName) return null;
  if (resolve(byName.repoPath) !== targetPath) {
    throw new Error(`Project name ${name} is already registered for ${byName.repoPath}; choose another name.`);
  }
  return byName;
}

export function bootstrapProject(records: Records, input: BootstrapInput): BootstrapResult {
  const brief = getBrief(records, input.briefId);
  if (!brief) throw new Error(`Unknown brief ${input.briefId}`);
  const acceptance = activeAcceptance(records, brief.id);
  if (!acceptance) throw new Error(`Brief ${brief.id} must have an active accepted proposal before bootstrap.`);
  const targetPath = safeTarget(input.targetPath);
  const linkedProject = brief.projectId ? records.getProject(brief.projectId) : null;
  if (linkedProject && resolve(linkedProject.repoPath) !== targetPath) {
    throw new Error(
      `Brief ${brief.id} is already linked to ${linkedProject.repoPath}. ` +
      "Revise and re-accept the product boundary before bootstrapping a different directory.",
    );
  }
  const projectName = (input.projectName ?? linkedProject?.name ?? brief.title).trim();
  if (!projectName) throw new Error("Bootstrap requires a project name.");
  const priorRun = listBootstrapRuns(records, brief.id).findLast((candidate) => candidate.targetPath === targetPath) ?? null;
  let run = priorRun ?? createBootstrapRun(records, {
    briefId: brief.id, targetPath, steps: initialSteps(),
  });
  if (run.state === "completed") {
    const project = run.projectId ? records.getProject(run.projectId) : null;
    const tasks = project ? records.listTasks({ projectId: project.id }) : [];
    return { run, brief: getBrief(records, brief.id) as ProductBrief, project, tasks };
  }

  const selection = {
    kind: input.profile ?? "auto",
    packageManager: input.packageManager ?? (brief.proposedStack.packageManager as PackageManager | null) ?? undefined,
    language: input.language ?? brief.proposedStack.language,
    runtime: input.runtime ?? brief.proposedStack.runtime,
  };
  let resolution = run.profileResolution;
  let project = projectForRun(records, run, projectName, targetPath);
  let tasks: Task[] = project ? records.listTasks({ projectId: project.id }) : [];

  const runStep = (name: BootstrapStepName, operation: () => string): void => {
    const existing = run.steps.find((step) => step.name === name);
    if (existing?.state === "done") return;
    run = updateBootstrapRun(records, run.id, { ...replaceStep(run, name, "running", null), state: "running", error: null });
    const detail = operation();
    run = updateBootstrapRun(records, run.id, { ...replaceStep(run, name, "done", detail), state: "running", error: null });
    if (input.interruptAfterStep === name) throw new Error(`Injected interruption after ${name}.`);
  };

  try {
    ensureRelatedOrEmpty(targetPath, run);
    setBriefState(records, brief.id, "BOOTSTRAPPING", `Bootstrap ${run.id} started for ${targetPath}.`, input.actor ?? "bootstrap");

    runStep("directory_creation", () => {
      mkdirSync(targetPath, { recursive: true, mode: 0o700 });
      writeJson(markerPath(targetPath), { bootstrapId: run.id, briefId: brief.id, targetPath, createdAt: run.createdAt });
      return `Prepared ${targetPath} and wrote its bootstrap ownership marker.`;
    });
    runStep("git_initialization", () => {
      if (!existsSync(join(targetPath, ".git"))) execute("git", ["init", "-q", "-b", "main"], targetPath);
      return "Initialized local Git repository on main; no remote was configured.";
    });
    runStep("skeleton_generation", () => {
      const generated = scaffoldProfile(targetPath, projectName, selection);
      run = updateBootstrapRun(records, run.id, {
        profile: generated.kind,
        environmentPlan: [generated.environment],
      });
      return `${generated.kind} scaffold ready (${generated.files.length} newly written file(s)); existing files were not replaced.`;
    });
    runStep("environment_configuration", () => {
      // On resume after skeleton completion, resolve the profile to recover the environment plan.
      const detected = resolveApplicationProfiles(targetPath);
      const plans = detected.components.map((component) => component.environment);
      writeJson(join(targetPath, ".mabs", "environment.json"), {
        version: detected.version,
        setupCommands: plans.flatMap((plan) => plan.setupCommands),
        missingPrerequisites: detected.missingPrerequisites,
        note: "Commands are recorded, not executed by bootstrap.",
      });
      run = updateBootstrapRun(records, run.id, { environmentPlan: plans });
      return plans.length > 0
        ? `Recorded isolated setup instructions for ${plans.map((plan) => plan.runtime).join(", ")}.`
        : "No supported environment was detected; profile resolution will report the setup requirement.";
    });
    runStep("profile_resolution", () => {
      resolution = resolveApplicationProfiles(targetPath);
      if (resolution.components.length === 0) throw new Error("No supported Python or JavaScript/TypeScript component was detected after scaffolding.");
      run = updateBootstrapRun(records, run.id, {
        profile: resolution.components.map((component) => `${component.kind}:${component.root}`).join(","),
        profileResolution: resolution,
        environmentPlan: resolution.components.map((component) => component.environment),
        artifacts: resolution.components.map((component) => component.artifacts),
      });
      return `Resolved ${resolution.components.length} component(s) with ${resolution.checks.length} declared check(s).`;
    });
    runStep("initial_commit", () => {
      execute("git", ["add", "-A"], targetPath);
      const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: targetPath, stdio: "ignore" }).status === 0;
      if (!hasHead) execute("git", ["-c", "user.name=MABS Bootstrap", "-c", "user.email=mabs-bootstrap@local", "commit", "-q", "-m", "chore: bootstrap project"], targetPath);
      return `Initial commit ${execute("git", ["rev-parse", "HEAD"], targetPath)} recorded locally.`;
    });
    runStep("project_registration", () => {
      project = projectForRun(records, run, projectName, targetPath);
      if (!project) {
        const preset = brief.qualitySettings.reviewPreset;
        project = records.createProject({
          name: projectName,
          repoPath: targetPath,
          baseBranch: "main",
          goal: brief.objective ?? brief.purpose ?? undefined,
          checkCommands: [],
          reviewPolicy: preset && preset !== "custom" ? reviewPreset(preset) : reviewPreset("personal"),
        });
      }
      run = updateBootstrapRun(records, run.id, { projectId: project.id });
      linkBriefProject(records, brief.id, project.id);
      return `Registered project ${project.id}; repeated bootstrap resumes this project rather than duplicating it.`;
    });
    runStep("check_registration", () => {
      if (!project) throw new Error("Project registration did not produce a project.");
      resolution = resolveApplicationProfiles(targetPath);
      records.updateProjectChecks(project.id, resolution.checks);
      project = records.getProject(project.id);
      run = updateBootstrapRun(records, run.id, { profileResolution: resolution });
      return resolution.checks.length > 0
        ? `Registered ${resolution.checks.length} post-scaffold quality check(s).`
        : `No checks were declared; quality coverage remains explicitly not configured. Setup requirements: ${resolution.missingPrerequisites.join("; ") || "none detected"}.`;
    });
    runStep("plan_linkage", () => {
      if (!project) throw new Error("Cannot link a plan without a registered project.");
      const submitted = submitAcceptedPlan(records, { brief: brief.id, projectId: project.id, actor: input.actor ?? "bootstrap" });
      tasks = submitted.tasks;
      run = updateBootstrapRun(records, run.id, { planId: submitted.planId });
      return `Linked accepted proposal ${acceptance.proposalId} to plan ${submitted.planId ?? "unknown"} and ${tasks.length} task(s).`;
    });

    run = updateBootstrapRun(records, run.id, { state: "completed", error: null });
    return { run, brief: getBrief(records, brief.id) as ProductBrief, project, tasks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const running = run.steps.find((step) => step.state === "running");
    if (running) run = updateBootstrapRun(records, run.id, {
      ...replaceStep(run, running.name as BootstrapStepName, "failed", message), state: "failed", error: message,
    });
    else run = updateBootstrapRun(records, run.id, { state: "failed", error: message });
    const current = getBrief(records, brief.id);
    if (current?.state === "BOOTSTRAPPING") setBriefState(records, brief.id, "ACCEPTED", `Bootstrap ${run.id} failed and remains resumable: ${message}`, "bootstrap");
    throw new Error(`Bootstrap ${run.id} failed: ${message}`);
  }
}

export function resumeBootstrap(records: Records, bootstrapId: string, actor = "bootstrap"): BootstrapResult {
  const run = getBootstrapRun(records, bootstrapId);
  if (!run) throw new Error(`Unknown bootstrap ${bootstrapId}`);
  return bootstrapProject(records, {
    briefId: run.briefId,
    targetPath: run.targetPath,
    profile: run.profile?.startsWith("python") ? "python" : run.profile?.startsWith("javascript") ? "javascript-typescript" : "auto",
    actor,
  });
}
