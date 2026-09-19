import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { bootstrapProject, resumeBootstrap } from "../src/bootstrap/service.ts";
import { acceptPlan, proposePlan } from "../src/intake/service.ts";
import { createBrief, listBootstrapRuns } from "../src/intake/store.ts";
import { resolveApplicationProfiles } from "../src/profiles/index.ts";
import { assembleWorkerPrompt } from "../src/prompts/roles.ts";
import { WORKER_PROMPT_VERSION, guidanceForAttempt, guidanceText } from "../src/prompts/versions.ts";
import { SCHEMA_VERSION, Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-e4-"));
  const oldState = process.env.MABS_STATE_DIR;
  const oldWorktrees = process.env.MABS_WORKTREE_ROOT;
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (oldState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = oldState;
    if (oldWorktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = oldWorktrees;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, records };
}

function acceptedBrief(records: Records, input: {
  title: string;
  language: string;
  packageManager?: string;
  reviewPreset?: "experiment" | "personal" | "client";
}) {
  const brief = createBrief(records, {
    title: input.title,
    objective: `Create a local ${input.language} command-line application.`,
    proposedStack: {
      language: input.language, runtime: null, packageManager: input.packageManager ?? null,
      components: ["CLI"], rationale: "Selected for the E4 profile fixture.",
    },
    qualitySettings: { reviewPreset: input.reviewPreset ?? "personal", checks: [], notes: null },
    operationalPreferences: { ci: "off", deployment: "off", monitoring: "off", scheduling: "manual", delivery: "local_files", notes: null },
    createdBy: "E4 Test User",
  });
  const result = proposePlan(records, {
    brief: brief.id,
    summary: `Create the accepted ${input.language} starter behavior.`,
    rationale: "One local implementation task is enough for this bootstrap test.",
    scope: "Local starter behavior and tests.",
    outOfScope: ["Deployment", "Network services"],
    requirements: [{ id: "REQ-1", text: "The local starter is runnable and tested." }],
    milestones: ["Starter"],
    plan: {
      objective: "Implement accepted starter behavior.", mode: "single", reason: "One focused component.",
      tasks: [{
        key: "starter", title: "Implement starter behavior", objective: "Implement the accepted local behavior.",
        acceptanceCriteria: ["Registered checks pass"], language: input.language,
        allowedScope: ["src", "test", "tests"], executionMode: "single", executionReason: "One component.",
      }],
    },
  });
  assert.ok(result.proposal);
  acceptPlan(records, {
    brief: brief.id, proposalId: result.proposal.id, fingerprint: result.proposal.fingerprint,
    acceptedBy: "E4 Test User", note: "I accept this exact local bootstrap plan.",
  });
  return brief;
}

function runChecks(repo: string, checks: { command: string[]; cwd?: string }[]): void {
  for (const check of checks) {
    const [command, ...args] = check.command;
    const result = spawnSync(command as string, args, { cwd: check.cwd ? join(repo, check.cwd) : repo, encoding: "utf8" });
    assert.equal(result.status, 0, `${check.command.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

test("Python bootstrap starts from an empty directory, registers post-scaffold checks, and is idempotent", (t) => {
  const { root, records } = setup(t);
  const brief = acceptedBrief(records, { title: "python-e4-product", language: "Python" });
  const target = join(root, "python-product");

  const result = bootstrapProject(records, {
    briefId: brief.id, targetPath: target, profile: "python", packageManager: "python", actor: "E4 Test User",
  });
  assert.equal(result.run.state, "completed");
  assert.ok(result.run.steps.every((step) => step.state === "done"));
  assert.equal(result.brief.state, "REGISTERED");
  assert.ok(result.project);
  assert.equal(result.tasks.length, 1);
  assert.ok(existsSync(join(target, "pyproject.toml")));
  assert.ok(existsSync(join(target, ".git")));
  assert.ok(execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim());
  assert.deepEqual(result.project.checkCommands.map((check) => check.name).sort(), ["compile", "test"]);
  assert.equal(result.run.profileResolution?.components[0]?.packageManager, "python");
  assert.ok(result.run.environmentPlan[0]?.setupCommands.some((command) => command.join(" ").includes("venv")));
  runChecks(target, result.project.checkCommands);

  const repeated = bootstrapProject(records, { briefId: brief.id, targetPath: target, profile: "python" });
  assert.equal(repeated.run.id, result.run.id);
  assert.equal(records.listProjects().length, 1);
  assert.deepEqual(repeated.tasks.map((task) => task.id), result.tasks.map((task) => task.id));
  assert.throws(
    () => bootstrapProject(records, { briefId: brief.id, targetPath: join(root, "different-product"), profile: "python" }),
    /already linked/,
  );
});

test("JavaScript bootstrap honors package-manager evidence and produces runnable npm checks", (t) => {
  const { root, records } = setup(t);
  const brief = acceptedBrief(records, { title: "javascript-e4-product", language: "JavaScript", packageManager: "npm" });
  const target = join(root, "javascript-product");
  const result = bootstrapProject(records, {
    briefId: brief.id, targetPath: target, profile: "javascript-typescript", packageManager: "npm",
  });
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.profileResolution?.components[0]?.language, "JavaScript");
  assert.equal(result.run.profileResolution?.components[0]?.packageManager, "npm");
  assert.deepEqual(result.project?.checkCommands.map((check) => check.name).sort(), ["test", "typecheck"]);
  runChecks(target, result.project?.checkCommands ?? []);

  const pnpm = join(root, "pnpm-fixture");
  mkdirSync(pnpm);
  writeFileSync(join(pnpm, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0", scripts: { test: "node --test" } }));
  writeFileSync(join(pnpm, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const detected = resolveApplicationProfiles(pnpm);
  assert.equal(detected.components[0]?.packageManager, "pnpm", "a lockfile is stronger evidence than a conflicting declaration");
  assert.deepEqual(detected.checks[0]?.command, ["pnpm", "run", "test"]);
  assert.ok(detected.missingPrerequisites.some((item) => item.includes("pnpm")) === (spawnSync("pnpm", ["--version"]).status !== 0));

  const tsBrief = acceptedBrief(records, { title: "typescript-e4-product", language: "TypeScript", packageManager: "npm" });
  const tsTarget = join(root, "typescript-product");
  const tsResult = bootstrapProject(records, {
    briefId: tsBrief.id, targetPath: tsTarget, profile: "javascript-typescript", packageManager: "npm",
  });
  assert.equal(tsResult.run.profileResolution?.components[0]?.language, "TypeScript");
  assert.deepEqual(tsResult.project?.checkCommands.map((check) => check.name).sort(), ["build", "test", "typecheck"]);
  assert.ok(tsResult.run.profileResolution?.missingPrerequisites.some((item) => item.includes("npm install")),
    "TypeScript dependencies are a visible setup requirement, not implicit passing coverage");
  assert.ok(existsSync(join(tsTarget, "tsconfig.json")));
});

test("bootstrap refuses a non-empty unrelated directory and leaves its files unchanged", (t) => {
  const { root, records } = setup(t);
  const brief = acceptedBrief(records, { title: "refusal-product", language: "Python" });
  const target = join(root, "occupied");
  mkdirSync(target);
  writeFileSync(join(target, "important.txt"), "do not replace\n");

  assert.throws(
    () => bootstrapProject(records, { briefId: brief.id, targetPath: target, profile: "python" }),
    /Refusing to overwrite non-empty unrelated directory/,
  );
  assert.equal(readFileSync(join(target, "important.txt"), "utf8"), "do not replace\n");
  assert.equal(existsSync(join(target, ".git")), false);
  const runs = listBootstrapRuns(records, brief.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.state, "failed");
  assert.match(runs[0]?.error ?? "", /unrelated directory/);
  assert.equal(records.listProjects().length, 0);
});

test("an interrupted bootstrap resumes its recorded steps without duplicate projects or cleanup", (t) => {
  const { root, records } = setup(t);
  const brief = acceptedBrief(records, { title: "resume-e4-product", language: "JavaScript" });
  const target = join(root, "resume-product");

  assert.throws(
    () => bootstrapProject(records, {
      briefId: brief.id, targetPath: target, profile: "javascript-typescript", packageManager: "npm",
      interruptAfterStep: "skeleton_generation",
    }),
    /Injected interruption/,
  );
  const failed = listBootstrapRuns(records, brief.id)[0];
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.steps.find((step) => step.name === "skeleton_generation")?.state, "done");
  writeFileSync(join(target, "resume-proof.txt"), "preserve me\n");

  const resumed = resumeBootstrap(records, failed?.id as string, "E4 Test User");
  assert.equal(resumed.run.id, failed?.id);
  assert.equal(resumed.run.state, "completed");
  assert.equal(readFileSync(join(target, "resume-proof.txt"), "utf8"), "preserve me\n");
  assert.equal(records.listProjects().length, 1);
  assert.equal(records.listTasks({ projectId: resumed.project?.id }).length, 1);
});

test("the CLI path used by the Pi bootstrap tool creates and links an accepted project", (t) => {
  const { root } = setup(t);
  const dbPath = join(root, "cli-bootstrap.sqlite");
  const records = new Records(new Store(dbPath));
  const brief = acceptedBrief(records, { title: "cli-e4-product", language: "Python" });
  records.store.close();
  const target = join(root, "cli-product");
  const output = execFileSync(process.execPath, [
    join(import.meta.dirname, "..", "src", "cli.ts"),
    "brief", "bootstrap", brief.id, target, "--profile=python", "--package-manager=python", "--by=E4 CLI Test",
  ], {
    encoding: "utf8",
    env: { ...process.env, MABS_DB_PATH: dbPath, MABS_STATE_DIR: join(root, "cli-state") },
  });
  const result = JSON.parse(output) as { run: { state: string; projectId: string }; brief: { state: string }; tasks: unknown[] };
  assert.equal(result.run.state, "completed");
  assert.equal(result.brief.state, "REGISTERED");
  assert.equal(result.tasks.length, 1);
  assert.ok(result.run.projectId);
});

test("profile composition detects Python and JS/TS components with scoped checks", (t) => {
  const { root } = setup(t);
  const repo = join(root, "mixed");
  mkdirSync(join(repo, "backend", "tests"), { recursive: true });
  mkdirSync(join(repo, "frontend"), { recursive: true });
  writeFileSync(join(repo, "backend", "pyproject.toml"), "[project]\nname='backend'\nversion='0.1.0'\n");
  writeFileSync(join(repo, "backend", "tests", "test_basic.py"), "import unittest\n");
  writeFileSync(join(repo, "frontend", "package.json"), JSON.stringify({
    packageManager: "npm@10", scripts: { lint: "node --check src.js", test: "node --test" },
  }));

  const resolution = resolveApplicationProfiles(repo);
  assert.deepEqual(resolution.components.map((component) => `${component.kind}:${component.root}`), [
    "python:backend", "javascript-typescript:frontend",
  ]);
  assert.ok(resolution.checks.every((check) => check.cwd === "backend" || check.cwd === "frontend"));
  assert.ok(resolution.checks.some((check) => check.name === "backend:test"));
  assert.ok(resolution.checks.some((check) => check.name === "frontend:lint"));
  assert.ok(!resolution.checks.some((check) => check.command.includes("pytest")),
    "pyproject.toml alone must not imply pytest");
});

test("schema 12 upgrades bootstrap evidence and attempt guidance provenance", (t) => {
  const { root } = setup(t);
  const dbPath = join(root, "schema12.sqlite");
  const initial = new Store(dbPath);
  initial.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'");
  legacy.exec("ALTER TABLE attempts DROP COLUMN prompt_version");
  legacy.exec("ALTER TABLE attempts DROP COLUMN skill_versions");
  legacy.exec("ALTER TABLE bootstrap_runs DROP COLUMN profile_resolution");
  legacy.exec("ALTER TABLE bootstrap_runs DROP COLUMN environment_plan");
  legacy.exec("ALTER TABLE bootstrap_runs DROP COLUMN artifacts");
  legacy.close();

  const migrated = new Records(new Store(dbPath));
  assert.equal(migrated.store.get("SELECT value FROM schema_meta WHERE key='schema_version'")?.value, SCHEMA_VERSION);
  const columns = migrated.store.all("PRAGMA table_info(attempts)").map((row) => row.name);
  assert.ok(columns.includes("prompt_version"));
  assert.ok(columns.includes("skill_versions"));
  migrated.store.close();
});

test("attempt records retain the exact prompt and selected guidance versions", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "attempt-repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial"], { cwd: repo });
  const project = records.createProject({ name: "attempt-e4", repoPath: repo });
  const task = records.createTask({
    projectId: project.id, title: "Python task", objective: "x", acceptanceCriteria: ["x"], language: "Python",
  });
  const skills = guidanceForAttempt(task, "initial");
  const attempt = records.startAttempt({
    taskId: task.id, launchId: "e4-launch", kind: "initial", adapter: "test",
    promptVersion: WORKER_PROMPT_VERSION, skillVersions: skills,
  });
  assert.equal(attempt.promptVersion, WORKER_PROMPT_VERSION);
  assert.deepEqual(attempt.skillVersions, ["mabs-boundaries-v1", "automation-design-v1", "python-delivery-v1"]);
  const prompt = assembleWorkerPrompt({
    purpose: "implementation", workerInput: {} as never, projectAddendum: null, guidance: guidanceText(skills),
  });
  for (const version of skills) assert.match(prompt, new RegExp(version));
  assert.doesNotMatch(prompt, /risk-based-review-v1/, "irrelevant review guidance must not be loaded into an implementation attempt");
});
