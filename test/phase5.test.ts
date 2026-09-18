import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { retrieveContext } from "../src/context/retrieval.ts";
import { taskDiagnostics } from "../src/diagnostics/task.ts";
import { validateProjectConfig, type ProjectConfigSnapshot } from "../src/domain/config.ts";
import { validateWorkerOutput, type WorkerOutput } from "../src/domain/contract.ts";
import { compareExperiment, completeExperiment, createExperiment, recordMeasurement } from "../src/optimization/experiments.ts";
import { routingOutcomes } from "../src/optimization/routing.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoAt(path: string): void {
  mkdirSync(join(path, "src", "billing"), { recursive: true });
  mkdirSync(join(path, "src", "unrelated"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "fixture" }, null, 2));
  writeFileSync(join(path, "README.md"), "# Fixture\n");
  writeFileSync(join(path, "src", "billing", "invoice.ts"), "export function invoiceTotal(items){ return items.length; }\n");
  writeFileSync(join(path, "src", "unrelated", "weather.ts"), "export function forecast(){ return 'sunny'; }\n".repeat(200));
  writeFileSync(join(path, ".env"), "SECRET=do-not-read\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-phase5-"));
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

test("deterministic retrieval selects scoped and explicitly referenced files, excludes secrets, and records omissions under a tight budget", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({ name: "retrieval", repoPath: repo });
  const task = records.createTask({
    projectId: project.id,
    title: "Fix invoice total",
    objective: "Correct invoiceTotal in src/billing/invoice.ts so it sums item prices.",
    acceptanceCriteria: ["invoiceTotal sums item prices"],
    allowedScope: ["src/billing"],
  });

  const generous = retrieveContext({ project, task, requirementTexts: [], budgetTokens: 8_000 });
  assert.ok(generous.files.some((file) => file.path === "src/billing/invoice.ts"));
  assert.ok(generous.files.every((file) => file.path !== ".env"));
  assert.ok(generous.files.find((file) => file.path === "src/billing/invoice.ts")?.reason.includes("explicitly referenced") ||
    generous.files.find((file) => file.path === "src/billing/invoice.ts")?.reason.includes("declared task scope"));
  assert.ok(!generous.files.some((file) => file.path === "src/unrelated/weather.ts"));

  const tight = retrieveContext({ project, task, requirementTexts: [], budgetTokens: 5 });
  assert.equal(tight.files.length <= 1, true);
  assert.ok(tight.estimatedTokens <= 5 + 4);
  if (tight.files.length === 0) {
    assert.ok(tight.omitted.some((item) => item.path === "src/billing/invoice.ts"));
  }
});

function output(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
  return {
    outcome: "completed",
    reason: "work completed",
    summary: "Completed assigned work.",
    evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] },
    follow_up: { unresolved: [], decisions_requested: [], next_step: null },
    usage: { model: "test-model", input_tokens: 100, output_tokens: 50 },
    addressed_requirements: ["REQ-1"],
    ...overrides,
  };
}

class SingleShotAdapter implements WorkerAdapter {
  readonly name = "codex";
  readonly authMode = "test-subscription";
  readonly prompts: string[] = [];
  private readonly results = new Map<string, WorkerOutput>();

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.prompts.push(input.prompt);
    writeFileSync(join(input.cwd, "src", "billing", "invoice.ts"), "export function invoiceTotal(items){ return items.reduce((s,i)=>s+i.price,0); }\n");
    const result = output({ evidence: { changed_files: ["src/billing/invoice.ts"], result_revision: null, tests: [], artifacts: [] } });
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
    writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: "single", completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(handle: AdapterHandle): Promise<CollectedResult> {
    return {
      launch: {
        exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: "test-model",
        usage: { model: "test-model", input_tokens: 100, output_tokens: 50 },
        apiEquivalentEstimateUsd: null, sessionId: handle.sessionId, raw: "", stderr: "",
      },
      validation: validateWorkerOutput(this.results.get(handle.attemptId)),
      failureClass: null,
      error: null,
    };
  }
}

test("a real task run produces a non-empty relevant-file manifest, checkpoints, and continuity diagnostics", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({
    name: "checkpointed", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] },
  });
  const task = records.createTask({
    projectId: project.id,
    title: "Fix invoice total",
    objective: "Correct invoiceTotal in src/billing/invoice.ts so it sums item prices.",
    acceptanceCriteria: ["invoiceTotal sums item prices"],
    allowedScope: ["src/billing"],
  });
  const adapter = new SingleShotAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick();
  await controller.tick();
  const final = records.getTask(task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "task did not complete");
  await controller.stop();

  const packets = records.packetsForTask(task.id);
  assert.ok(packets.length >= 1);
  const packet = packets[0] as { manifest_path: string; files: string[]; token_estimate: number; provider: string };
  assert.ok((packet.files as string[]).length > 0, "context packet must have a non-empty relevant-file manifest");
  assert.ok((packet.files as string[]).some((path) => path.endsWith("src/billing/invoice.ts")));
  assert.equal(packet.provider, "codex");
  assert.ok(typeof packet.token_estimate === "number" && packet.token_estimate > 0);
  const manifest = JSON.parse(readFileSync(packet.manifest_path, "utf8")) as { estimate_kind: string; retrieval: { files: unknown[] } };
  assert.equal(manifest.estimate_kind, "derived_utf8_bytes_divided_by_four");
  assert.ok(manifest.retrieval.files.length > 0);

  const checkpoints = records.checkpointsForTask(task.id);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.kind === "implementation_complete"));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.kind === "checks_passed" || checkpoint.kind.startsWith("review_")));
  assert.ok(checkpoints.every((checkpoint) => checkpoint.taskId === task.id));

  const diagnostics = taskDiagnostics(records, task.id);
  assert.ok(diagnostics.checkpoints.length > 0);
  const relevantFiles = diagnostics.context[0]?.relevantFiles as unknown[] | undefined;
  assert.ok(relevantFiles && relevantFiles.length > 0);
  assert.equal(diagnostics.continuity.repeatedFindings.length, 0);
});

test("optimization experiments require a complete fixed suite, reject regressions, and detect the empty-manifest limitation being resolved", (t) => {
  const { records } = setup(t);
  const experiment = createExperiment(records, {
    name: "relevant-file retrieval", hypothesis: "Deterministic retrieval resolves empty relevant-file manifests without regressing accepted work.",
    dimension: "context-retrieval", suiteVersion: "fixed-suite-v1",
    baselineConfig: { retrieval: "none" }, candidateConfig: { retrieval: "deterministic-v1" },
  });
  assert.throws(() => compareExperiment(records, experiment.id), /requires exactly one baseline and one candidate/);

  recordMeasurement(records, {
    experimentId: experiment.id, variant: "baseline", caseKey: "case-1", accepted: true,
    requirementViolations: 0, repairs: 1, interventions: 0, durationMs: 4_000,
    reportedInputTokens: 900, reportedOutputTokens: 300, relevantFiles: 0, warnings: 1, evidencePath: null,
  });
  recordMeasurement(records, {
    experimentId: experiment.id, variant: "candidate", caseKey: "case-1", accepted: true,
    requirementViolations: 0, repairs: 0, interventions: 0, durationMs: 3_200,
    reportedInputTokens: 700, reportedOutputTokens: 260, relevantFiles: 2, warnings: 0, evidencePath: null,
  });
  const { comparison, experiment: completed } = completeExperiment(records, experiment.id);
  assert.equal(comparison.result, "limitation_resolved");
  assert.equal(comparison.safeguardsPassed, true);
  assert.equal(completed.status, "completed");
  assert.ok(completed.evidencePath);
  assert.throws(() => recordMeasurement(records, {
    experimentId: experiment.id, variant: "baseline", caseKey: "case-2", accepted: true,
    requirementViolations: 0, repairs: 0, interventions: 0, durationMs: null,
    reportedInputTokens: null, reportedOutputTokens: null, relevantFiles: 1, warnings: 0, evidencePath: null,
  }), /immutable/);

  const regressing = createExperiment(records, {
    name: "regressive candidate", hypothesis: "Placeholder to exercise safeguard rejection.",
    dimension: "context-retrieval", suiteVersion: "fixed-suite-v1",
    baselineConfig: {}, candidateConfig: {},
  });
  recordMeasurement(records, {
    experimentId: regressing.id, variant: "baseline", caseKey: "case-1", accepted: true,
    requirementViolations: 0, repairs: 0, interventions: 0, durationMs: 1_000,
    reportedInputTokens: 100, reportedOutputTokens: 50, relevantFiles: 1, warnings: 0, evidencePath: null,
  });
  recordMeasurement(records, {
    experimentId: regressing.id, variant: "candidate", caseKey: "case-1", accepted: false,
    requirementViolations: 1, repairs: 2, interventions: 1, durationMs: 2_000,
    reportedInputTokens: 200, reportedOutputTokens: 90, relevantFiles: 1, warnings: 1, evidencePath: null,
  });
  const regressed = compareExperiment(records, regressing.id);
  assert.equal(regressed.safeguardsPassed, false);
  assert.equal(regressed.result, "no_improvement");
  assert.ok(regressed.reasons.some((reason) => reason.includes("regressed")));
});

test("routing outcomes aggregate observed accepted work, repairs, and reported usage without inventing missing measurements", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({
    name: "routing-telemetry", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] },
  });
  const task = records.createTask({
    projectId: project.id, title: "Fix invoice total", objective: "Correct invoiceTotal.",
    acceptanceCriteria: ["invoiceTotal sums item prices"], allowedScope: ["src/billing"],
  });
  const adapter = new SingleShotAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick();
  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "DONE");
  await controller.stop();

  const outcomes = routingOutcomes(records, project.id);
  const implementation = outcomes.find((item) => item.role === "implementation" && item.adapter === "codex");
  assert.ok(implementation);
  assert.equal(implementation?.acceptedTasks, 1);
  assert.equal(implementation?.reportedInputTokens, 100);
  assert.equal(implementation?.reportedOutputTokens, 50);
});

test("project configuration validates and normalizes the context budget", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({ name: "budgeted", repoPath: repo });
  assert.equal(project.controllerSettings.contextBudgetTokens, 12_000);
  const config: ProjectConfigSnapshot = JSON.parse(JSON.stringify({
    routingProfile: project.routingProfile,
    routingOverrides: project.routingOverrides,
    approvalPolicy: project.approvalPolicy,
    reviewPolicy: project.reviewPolicy,
    checkCommands: project.checkCommands,
    promptProfile: project.promptProfile,
    controllerSettings: { defaultRepairLimit: 1, contextBudgetTokens: 500 },
  })) as ProjectConfigSnapshot;
  const errors = validateProjectConfig(config);
  assert.ok(errors.some((error) => error.includes("contextBudgetTokens")));
});
