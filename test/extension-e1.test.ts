/**
 * E1 regression suite for the MABS Extension Implementation Brief.
 *
 * Each test targets one invariant that the reviewed baseline violated:
 * packet provenance, review-policy normalization, finding severity, and
 * unconfigured quality coverage.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { buildContextPacket } from "../src/context/packet.ts";
import { retrieveContext } from "../src/context/retrieval.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateProjectConfig } from "../src/domain/config.ts";
import { validateWorkerOutput, type WorkerOutput } from "../src/domain/contract.ts";
import { runGates } from "../src/gates/runner.ts";
import { classifyFindings, normalizeReviewPolicy, reviewRequiredFor } from "../src/review/policy.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";
import { prepareWorkspace } from "../src/workspace/git.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(path: string, message: string): string {
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

function repoAt(path: string): string {
  mkdirSync(join(path, "src", "billing"), { recursive: true });
  writeFileSync(join(path, "src", "billing", "invoice.ts"), "export function invoiceTotal(){ return 0; } // base clone version\n");
  git(path, "init", "-q", "-b", "main");
  return commit(path, "initial");
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-e1-"));
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

function output(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
  return {
    outcome: "completed",
    reason: "work completed",
    summary: "Completed assigned work.",
    evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] },
    follow_up: { unresolved: [], decisions_requested: [], next_step: null },
    usage: { model: null, input_tokens: null, output_tokens: null },
    addressed_requirements: ["REQ-1"],
    ...overrides,
  };
}

test("context packets quote the worktree under execution, not the project's base clone", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({ name: "provenance", repoPath: repo });
  const task = records.createTask({
    projectId: project.id,
    title: "Fix invoice total",
    objective: "Correct invoiceTotal in src/billing/invoice.ts so it sums item prices.",
    acceptanceCriteria: ["invoiceTotal sums item prices"],
    allowedScope: ["src/billing"],
  });
  const workspace = await prepareWorkspace(project, task);

  // The worktree and the base clone now hold different content and different
  // revisions. Retrieval must follow the workspace it was given.
  writeFileSync(join(workspace.path, "src", "billing", "invoice.ts"), "export function invoiceTotal(items){ return items.length; } // worktree version\n");
  const worktreeRevision = commit(workspace.path, "worktree change");
  writeFileSync(join(repo, "src", "billing", "invoice.ts"), "export function invoiceTotal(){ return -1; } // base clone drifted\n");
  commit(repo, "base clone change");

  const fromWorktree = retrieveContext({ project, task, sourceWorkspace: workspace.path, requirementTexts: [] });
  const invoice = fromWorktree.files.find((file) => file.path === "src/billing/invoice.ts");
  assert.ok(invoice, "the invoice file should be retrieved");
  assert.match(invoice.excerpt, /worktree version/);
  assert.doesNotMatch(invoice.excerpt, /base clone/);
  assert.equal(fromWorktree.sourceWorkspace, workspace.path);
  assert.equal(fromWorktree.inspectedRevision, worktreeRevision);
  assert.ok(invoice.absolutePath.startsWith(workspace.path));

  // An implementation packet built against a drifted base revision is labeled
  // with the revision that was actually read, and records the drift.
  records.updateTaskFields(task.id, {
    worktree_path: workspace.path, branch: workspace.branch, base_revision: workspace.baseRevision,
  });
  const packet = buildContextPacket({
    records, project, task: records.getTask(task.id) as never, attemptId: "att_e1",
    workspace: { path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision },
    execution: { harness: "codex", model: null, effort: null, authMode: "test-subscription" },
  });
  assert.equal(packet.input.context.inspected_revision, worktreeRevision);
  assert.equal(packet.input.context.source_workspace, workspace.path);
  assert.equal(packet.input.workspace.head_revision, worktreeRevision);
  const manifest = JSON.parse(readFileSync(packet.manifestPath, "utf8")) as { warnings: string[] };
  assert.ok(manifest.warnings.some((warning) => warning.includes("differs from the attempt base revision")));
  assert.ok(records.listEvents(task.id).some((event) => event.kind === "context.revision_drift"));

  // A review packet may never be labeled as a revision it did not inspect.
  assert.throws(
    () => buildContextPacket({
      records, project, task: records.getTask(task.id) as never, attemptId: "att_e1_review",
      workspace: { path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision },
      execution: { harness: "claude", model: null, effort: null, authMode: "test-subscription" },
      purpose: "review",
    }),
    /would misreport its revision/,
  );
});

test("required review never inherits skip classes at any entry point", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);

  // Project registration: the CLI path passes default skips alongside the mode.
  const project = records.createProject({
    name: "required-review",
    repoPath: repo,
    reviewPolicy: { mode: "required", skipTaskClasses: ["mechanical", "planning", "research"] },
  });
  assert.equal(project.reviewPolicy.mode, "required");
  assert.deepEqual(project.reviewPolicy.skipTaskClasses, []);
  assert.ok(records.recentEvents(20).some((event) => event.kind === "project.review_policy_normalized"));

  // Policy update.
  records.setProjectReviewPolicy(project.id, { mode: "required", skipTaskClasses: ["research"] });
  assert.equal(records.getProject(project.id)?.reviewPolicy.mode, "required");
  assert.deepEqual(records.getProject(project.id)?.reviewPolicy.skipTaskClasses, []);

  // A required-mode project reviews every class, including the ones a
  // substantive project would skip.
  const policy = records.getProject(project.id)?.reviewPolicy as never;
  assert.equal(reviewRequiredFor(policy, { taskClass: "research", role: "implementer" }), true);
  assert.equal(reviewRequiredFor(policy, { taskClass: "mechanical", role: "implementer" }), true);
  assert.equal(reviewRequiredFor(policy, { taskClass: "research", role: "reviewer" }), false);

  // Substantive projects keep their configured skips.
  const substantive = normalizeReviewPolicy({ mode: "substantive", skipTaskClasses: ["research", "nonsense"] });
  assert.equal(substantive.mode, "substantive");
  assert.deepEqual(substantive.skipTaskClasses, ["research"]);

  // Explicitly authored configuration is rejected rather than silently repaired.
  const errors = validateProjectConfig({
    routingProfile: "default", routingOverrides: {}, approvalPolicy: { overrides: {}, standing: [] },
    reviewPolicy: { mode: "required", skipTaskClasses: ["research"] } as never,
    checkCommands: [], promptProfile: { implementationAddendum: null, reviewAddendum: null, researchAddendum: null },
    controllerSettings: { defaultRepairLimit: 2, contextBudgetTokens: 12_000 },
  });
  assert.ok(errors.some((error) => error.includes("required review mode cannot skip task classes")));
});

test("minor findings stay advisory while blocking findings still force repair", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({ name: "severity", repoPath: repo });
  const task = records.createTask({ projectId: project.id, title: "task", objective: "do work" });
  const attempt = records.startAttempt({
    id: "att_sev", taskId: task.id, launchId: "lch_sev", kind: "review", adapter: "claude",
    model: null, effort: null, authMode: "test-subscription", worktreePath: repo, baseRevision: "rev1",
  });

  const classified = classifyFindings([
    "[minor] Consider renaming the helper.",
    "[critical] Credentials are written to the log.",
    "Unlabelled finding about a real defect.",
  ]);
  assert.deepEqual(classified.counts, { critical: 1, major: 1, minor: 1 });
  assert.equal(classified.blocking.length, 2);
  assert.deepEqual(classified.advisory, ["[minor] Consider renaming the helper."]);
  assert.ok(classified.all.includes("[major] Unlabelled finding about a real defect."));

  const advisoryOnly = classifyFindings(["[minor] Consider renaming the helper.", "[minor] Add a comment."]);
  const review = records.recordReview({
    taskId: task.id, attemptId: attempt.id, revision: "rev1",
    verdict: advisoryOnly.blocking.length > 0 ? "request_changes" : "approved",
    summary: "Two small suggestions; nothing blocking.",
    findings: advisoryOnly.all, blockingFindings: advisoryOnly.blocking, advisoryFindings: advisoryOnly.advisory,
    requirementsChecked: [],
  });
  assert.equal(review.verdict, "approved");
  assert.equal(review.findings.length, 2, "advisory evidence is preserved, not discarded");
  assert.deepEqual(review.blockingFindings, []);
  assert.equal(review.advisoryFindings.length, 2);
});

test("an unconfigured quality gate list is reported as missing coverage, not as a pass", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  const revision = repoAt(repo);
  const project = records.createProject({ name: "coverage", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] } });
  const task = records.createTask({ projectId: project.id, title: "task", objective: "do work" });

  const summary = await runGates({
    records, task, attemptId: null, worktreePath: repo, revision, specs: project.checkCommands,
  });
  assert.equal(summary.status, "not_configured");
  assert.equal(summary.coverage, "not_configured");
  assert.equal(summary.requiredConfigured, 0);
  const coverageGate = summary.results.find((gate) => gate.name === "quality-coverage");
  assert.equal(coverageGate?.status, "SKIPPED");
  assert.equal(coverageGate?.revision, revision);
  assert.match(readFileSync(coverageGate?.evidencePath as string, "utf8"), /not a passing quality result/);

  // Readiness must not be inferred from an empty gate list.
  records.updateTaskFields(task.id, { result_revision: revision });
  assert.throws(
    () => records.prepareApproval({ taskId: task.id, action: "deploy", target: "local", reason: "ship it" }),
    /no configured required quality checks/,
  );

  // An explicit, recorded waiver is the only way past it.
  const waiver = records.prepareApproval({
    taskId: task.id, action: "waive_required_gate", target: `quality-coverage:${revision}`,
    reason: "Experiment: accepted without configured checks.",
  });
  records.decideApproval(waiver.approval?.id as string, "approved", "test-user");
  const prepared = records.prepareApproval({ taskId: task.id, action: "deploy", target: "local", reason: "ship it" });
  assert.equal(prepared.required, true);
  assert.equal((prepared.approval?.evidence.qualityCoverage as { coverage: string }).coverage, "not_configured");

  // A configured, passing check reports passed coverage instead.
  const configured = records.createProject({
    name: "configured-coverage", repoPath: repo, reviewPolicy: { mode: "none", skipTaskClasses: [] },
    checkCommands: [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true }],
  });
  const configuredTask = records.createTask({ projectId: configured.id, title: "task", objective: "do work" });
  const configuredSummary = await runGates({
    records, task: configuredTask, attemptId: null, worktreePath: repo, revision, specs: configured.checkCommands,
  });
  assert.equal(configuredSummary.status, "passed");
  assert.equal(configuredSummary.coverage, "configured");
  assert.ok(!configuredSummary.results.some((gate) => gate.name === "quality-coverage"));
});

class AdvisoryReviewAdapter implements WorkerAdapter {
  readonly name = "codex";
  readonly authMode = "test-subscription";
  private readonly results = new Map<string, WorkerOutput>();
  reviews = 0;

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    const reviewing = input.prompt.includes('"role": "reviewer"');
    let result: WorkerOutput;
    if (reviewing) {
      this.reviews += 1;
      result = output({
        summary: "Only cosmetic suggestions.",
        follow_up: { unresolved: ["[minor] Rename the local variable."], decisions_requested: [], next_step: null },
      });
    } else {
      writeFileSync(join(input.cwd, "src", "billing", "invoice.ts"), "export function invoiceTotal(items){ return items.reduce((s,i)=>s+i.price,0); }\n");
      result = output({ evidence: { changed_files: ["src/billing/invoice.ts"], result_revision: null, tests: [], artifacts: [] } });
    }
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
    if (!reviewing) writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: "advisory", completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(handle: AdapterHandle): Promise<CollectedResult> {
    return {
      launch: {
        exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null,
        usage: null, apiEquivalentEstimateUsd: null, sessionId: handle.sessionId, raw: "", stderr: "",
      },
      validation: validateWorkerOutput(this.results.get(handle.attemptId)),
      failureClass: null,
      error: null,
    };
  }
}

test("a review that finds only minor issues approves the revision without another repair cycle", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({
    name: "advisory-review", repoPath: repo,
    reviewPolicy: { mode: "substantive", skipTaskClasses: [] },
    checkCommands: [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true }],
  });
  records.addRequirement(project.id, "REQ-1", "invoiceTotal sums item prices");
  const task = records.createTask({
    projectId: project.id,
    title: "Fix invoice total",
    objective: "Correct invoiceTotal in src/billing/invoice.ts so it sums item prices.",
    acceptanceCriteria: ["invoiceTotal sums item prices"],
    allowedScope: ["src/billing"],
  });
  const adapter = new AdvisoryReviewAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick();
  await controller.tick();
  await controller.tick();
  await controller.stop();

  const final = records.getTask(task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "task did not complete");
  assert.equal(final?.repairsUsed, 0, "a minor finding must not consume repair budget");
  assert.equal(adapter.reviews, 1);
  const review = records.reviewsForTask(task.id).at(-1);
  assert.equal(review?.verdict, "approved");
  assert.deepEqual(review?.advisoryFindings, ["[minor] Rename the local variable."]);
  assert.deepEqual(review?.blockingFindings, []);
});
