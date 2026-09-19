/**
 * E2 suite: one versioned review-policy evaluator shared by dispatch, verdicts,
 * approval preparation, the CLI, and the workbench.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller, REVIEW_PENDING_PREFIX } from "../src/controller/controller.ts";
import { validateProjectConfig } from "../src/domain/config.ts";
import { validateWorkerOutput, type WorkerOutput } from "../src/domain/contract.ts";
import {
  DEFAULT_RISK_RULES,
  REVIEW_POLICY_VERSION,
  describeReviewPolicy,
  evaluateReviewPolicy,
  migrateLegacyReviewPolicy,
  normalizeReviewPolicy,
  reviewPreset,
  weakensReview,
} from "../src/review/policy.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoAt(path: string): string {
  mkdirSync(join(path, "src", "billing"), { recursive: true });
  writeFileSync(join(path, "src", "billing", "invoice.ts"), "export function invoiceTotal(){ return 0; }\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
  return git(path, "rev-parse", "HEAD");
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-e2-"));
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

const implementer = { taskClass: "small_implementation", role: "implementer" } as const;

test("presets separate trigger, scope, cadence, severity, and quality expectations", () => {
  const experiment = reviewPreset("experiment");
  const personal = reviewPreset("personal");
  const client = reviewPreset("client");

  assert.equal(experiment.trigger, "off");
  assert.equal(experiment.qualityExpectation, "advisory");
  assert.equal(personal.trigger, "risk");
  assert.equal(personal.qualityExpectation, "configured_checks");
  assert.equal(client.trigger, "required");
  assert.deepEqual(client.skipTaskClasses, []);
  assert.equal(client.cadence, "release");
  assert.equal(client.qualityExpectation, "acceptance_and_gates");
  for (const policy of [experiment, personal, client]) assert.equal(policy.version, REVIEW_POLICY_VERSION);

  // Experiment: off by default, but manual review is always available.
  assert.equal(evaluateReviewPolicy(experiment, { subject: implementer }).review, false);
  assert.equal(evaluateReviewPolicy(experiment, { subject: implementer, manualRequest: true }).review, true);

  // Client: everything is reviewed, including classes other presets skip.
  assert.equal(evaluateReviewPolicy(client, { subject: { taskClass: "research", role: "implementer" } }).review, true);

  // A review task is never itself reviewed.
  assert.equal(evaluateReviewPolicy(client, { subject: { taskClass: "review", role: "reviewer" } }).review, false);

  assert.match(describeReviewPolicy(personal), /preset=personal trigger=risk/);
});

test("risk is detected from touched components and change content, not only the task label", () => {
  const personal = reviewPreset("personal");
  const lowRisk = { taskClass: "small_implementation", role: "implementer", changeRisk: "low" } as const;

  const unrelated = evaluateReviewPolicy(personal, {
    subject: lowRisk,
    changedFiles: ["docs/readme.md", "src/billing/invoice.ts"],
    diffText: "+ return items.length;\n",
  });
  assert.equal(unrelated.review, false);
  assert.match(unrelated.reason, /No configured risk rule matched/);

  const authPath = evaluateReviewPolicy(personal, {
    subject: lowRisk,
    changedFiles: ["src/auth/session.ts"],
    diffText: "+ const user = lookup(id);\n",
  });
  assert.equal(authPath.review, true);
  assert.equal(authPath.matchedRules[0]?.id, "authentication-or-credentials");

  // A harmless-looking path that deletes data is still elevated risk.
  const destructive = evaluateReviewPolicy(personal, {
    subject: lowRisk,
    changedFiles: ["src/util/cleanup.ts"],
    diffText: "+ rmSync(target, { recursive: true, force: true });\n",
  });
  assert.equal(destructive.review, true);
  assert.equal(destructive.matchedRules[0]?.id, "destructive-operations");

  const schema = evaluateReviewPolicy(personal, {
    subject: lowRisk,
    changedFiles: ["migrations/003_add_column.sql"],
    diffText: "+ ALTER TABLE users ADD COLUMN email TEXT;\n",
  });
  assert.equal(schema.review, true);

  const declared = evaluateReviewPolicy(personal, {
    subject: { taskClass: "small_implementation", role: "implementer", changeRisk: "high" },
    changedFiles: ["docs/readme.md"],
  });
  assert.equal(declared.matchedRules[0]?.id, "declared-elevated-risk");
  assert.ok(DEFAULT_RISK_RULES.length >= 5);
});

test("v1 policies migrate explicitly and never silently weaken an existing project", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);

  // substantive reviewed every non-skipped class; the migrated policy must review the same set.
  const substantive = migrateLegacyReviewPolicy({ mode: "substantive", skipTaskClasses: ["mechanical"] });
  assert.equal(substantive.trigger, "risk");
  assert.equal(substantive.mode, "substantive");
  assert.deepEqual(substantive.skipTaskClasses, ["mechanical"]);
  assert.equal(substantive.riskRules[0]?.id, "legacy-substantive-change");
  assert.equal(evaluateReviewPolicy(substantive, { subject: implementer, changedFiles: ["docs/readme.md"] }).review, true);
  assert.equal(evaluateReviewPolicy(substantive, { subject: { taskClass: "mechanical", role: "implementer" } }).review, false);

  const required = migrateLegacyReviewPolicy({ mode: "required", skipTaskClasses: ["research"] });
  assert.equal(required.trigger, "required");
  assert.deepEqual(required.skipTaskClasses, []);
  assert.equal(required.qualityExpectation, "acceptance_and_gates");

  // A legacy project is not relaxed to advisory quality just because review was off.
  assert.equal(migrateLegacyReviewPolicy({ mode: "none", skipTaskClasses: [] }).qualityExpectation, "configured_checks");

  const project = records.createProject({ name: "client-work", repoPath: repo, reviewPolicy: { mode: "required", skipTaskClasses: [] } });
  assert.throws(
    () => records.setProjectReviewPreset(project.id, "experiment"),
    /Refusing to weaken review/,
  );
  const configVersion = records.setProjectReviewPreset(project.id, "experiment", {
    acknowledgeWeakening: true,
    reason: "Owner moved this project to an experiment.",
  });
  assert.ok(configVersion);
  const updated = records.getProject(project.id);
  assert.equal(updated?.reviewPolicy.preset, "experiment");
  const event = records.recentEvents(30).find((item) => item.kind === "project.review_policy_updated");
  const data = JSON.parse(event?.data as string) as { weakened: string[]; reason: string };
  assert.ok(data.weakened.length > 0, "the weakening must be recorded, not hidden");
  assert.equal(data.reason, "Owner moved this project to an experiment.");

  assert.deepEqual(weakensReview(reviewPreset("client"), reviewPreset("client")), []);
  assert.ok(weakensReview(reviewPreset("client"), reviewPreset("personal")).length > 0);
});

test("a stored v1 policy is readable, migrated on read, and validated strictly when authored", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({ name: "legacy-row", repoPath: repo });
  // Simulate a row written before this phase existed.
  records.store.run(
    "UPDATE projects SET review_policy = ? WHERE id = ?",
    JSON.stringify({ mode: "substantive", skipTaskClasses: ["mechanical", "planning", "research"] }),
    project.id,
  );
  const reloaded = records.getProject(project.id);
  assert.equal(reloaded?.reviewPolicy.version, REVIEW_POLICY_VERSION);
  assert.equal(reloaded?.reviewPolicy.trigger, "risk");
  assert.equal(reloaded?.reviewPolicy.mode, "substantive");

  const base = {
    routingProfile: "default", routingOverrides: {}, approvalPolicy: { overrides: {}, standing: [] },
    checkCommands: [], promptProfile: { implementationAddendum: null, reviewAddendum: null, researchAddendum: null },
    controllerSettings: { defaultRepairLimit: 2, contextBudgetTokens: 12_000 },
  };
  assert.deepEqual(validateProjectConfig({ ...base, reviewPolicy: reviewPreset("client") }), []);
  assert.ok(validateProjectConfig({ ...base, reviewPolicy: { ...reviewPreset("personal"), riskRules: [] } })
    .some((error) => error.includes("would never review anything")));
  assert.ok(validateProjectConfig({ ...base, reviewPolicy: { ...reviewPreset("personal"), blockingSeverities: ["minor"] } })
    .some((error) => error.includes("must always include critical")));
  assert.ok(validateProjectConfig({ ...base, reviewPolicy: { ...reviewPreset("personal"), riskRules: [{ id: "bad", reason: "x", pathPatterns: ["("] }] } })
    .some((error) => error.includes("invalid pattern")));
  // v1 shapes remain valid input.
  assert.deepEqual(validateProjectConfig({ ...base, reviewPolicy: { mode: "none", skipTaskClasses: [] } as never }), []);
});

test("accepted review is reused only while the reviewed context still matches", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  const revision = repoAt(repo);
  const project = records.createProject({
    name: "reuse", repoPath: repo,
    reviewPolicy: reviewPreset("personal"),
    checkCommands: [{ name: "unit", command: ["true"], required: true }],
  });
  records.addRequirement(project.id, "REQ-1", "invoiceTotal sums item prices");
  const task = records.createTask({ projectId: project.id, title: "t", objective: "o" });
  records.updateTaskFields(task.id, { result_revision: revision });
  records.recordGate({
    taskId: task.id, attemptId: null, name: "unit", status: "PASS", required: true, command: "true",
    toolVersion: null, revision, evidencePath: null, durationMs: 1, waiverId: null,
  });
  const attempt = records.startAttempt({
    id: "att_reuse", taskId: task.id, launchId: "lch_reuse", kind: "review", adapter: "claude",
    model: null, effort: null, authMode: "test", worktreePath: repo, baseRevision: revision,
  });
  records.recordReview({
    taskId: task.id, attemptId: attempt.id, revision, verdict: "approved",
    summary: "Acceptable.", findings: [], requirementsChecked: ["REQ-1"],
  });

  const prepared = records.prepareApproval({ taskId: task.id, action: "merge", target: "main", reason: "ready" });
  assert.equal(prepared.required, true);

  // A new mandatory requirement means the accepted review no longer covers the work.
  records.addRequirement(project.id, "REQ-2", "invoice totals must exclude refunded items");
  assert.throws(
    () => records.prepareApproval({ taskId: task.id, action: "merge", target: "main", reason: "ready" }),
    /A fresh review is required/,
  );
});

class ReviewAdapter implements WorkerAdapter {
  readonly name: string;
  readonly authMode = "test-subscription";
  readonly prompts: string[] = [];
  private readonly results = new Map<string, WorkerOutput>();
  private readonly edit: (cwd: string) => void;
  reviews = 0;

  constructor(name: string, edit: (cwd: string) => void) {
    this.name = name;
    this.edit = edit;
  }

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.prompts.push(input.prompt);
    const reviewing = input.prompt.includes('"role": "reviewer"');
    let result: WorkerOutput;
    if (reviewing) {
      this.reviews += 1;
      result = output({ summary: "Reviewed the change.", follow_up: { unresolved: [], decisions_requested: [], next_step: null } });
    } else {
      this.edit(input.cwd);
      result = output({ evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] } });
      mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
      writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    }
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: this.name, completionPath: input.completionPath };
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

test("a personal project reviews a credential change and skips an unrelated documentation change", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const checks = [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true }];

  const risky = records.createProject({
    name: "risky", repoPath: repo, reviewPolicy: reviewPreset("personal"), checkCommands: checks,
  });
  const riskyTask = records.createTask({
    projectId: risky.id, title: "Store the session token", objective: "Persist the session token for reuse.",
    acceptanceCriteria: ["token persists"],
  });
  const riskyAdapter = new ReviewAdapter("codex", (cwd) => {
    mkdirSync(join(cwd, "src", "auth"), { recursive: true });
    writeFileSync(join(cwd, "src", "auth", "session.ts"), "export const sessionToken = read();\n");
  });
  const riskyController = new Controller(records, {
    adapters: new Map([["codex", riskyAdapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  for (let i = 0; i < 3; i += 1) await riskyController.tick();
  await riskyController.stop();
  assert.equal(records.getTask(riskyTask.id)?.state, "DONE", records.getTask(riskyTask.id)?.blockedReason ?? "");
  assert.equal(riskyAdapter.reviews, 1, "a credential change must be reviewed");
  const riskyDecision = records.listEvents(riskyTask.id).find((event) => event.kind === "review.decision");
  assert.match(JSON.parse(riskyDecision?.data as string).reason as string, /authentication-or-credentials/);

  const calm = records.createProject({
    name: "calm", repoPath: repo, reviewPolicy: reviewPreset("personal"), checkCommands: checks,
  });
  const calmTask = records.createTask({
    projectId: calm.id, title: "Document the invoice helper", objective: "Add usage notes to the documentation.",
    acceptanceCriteria: ["documentation updated"],
  });
  const calmAdapter = new ReviewAdapter("codex", (cwd) => {
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "usage.md"), "# Usage\n\nCall invoiceTotal with the item list.\n");
  });
  const calmController = new Controller(records, {
    adapters: new Map([["codex", calmAdapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  for (let i = 0; i < 3; i += 1) await calmController.tick();
  await calmController.stop();
  assert.equal(records.getTask(calmTask.id)?.state, "DONE");
  assert.equal(calmAdapter.reviews, 0, "an unrelated documentation change needs no independent review");
  const calmDecision = records.listEvents(calmTask.id).find((event) => event.kind === "review.decision");
  assert.match(JSON.parse(calmDecision?.data as string).reason as string, /No configured risk rule matched/);

  // Control: the same documentation task under a migrated v1 "substantive"
  // policy. It is still reviewed, so the measured difference comes from the
  // policy choice and not from a change in what the worker did.
  const legacy = records.createProject({
    name: "legacy-substantive", repoPath: repo,
    reviewPolicy: { mode: "substantive", skipTaskClasses: ["mechanical", "planning", "research"] },
    checkCommands: checks,
  });
  const legacyTask = records.createTask({
    projectId: legacy.id, title: "Document the invoice helper", objective: "Add usage notes to the documentation.",
    acceptanceCriteria: ["documentation updated"],
  });
  const legacyAdapter = new ReviewAdapter("codex", (cwd) => {
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "usage.md"), "# Usage\n\nCall invoiceTotal with the item list.\n");
  });
  const legacyController = new Controller(records, {
    adapters: new Map([["codex", legacyAdapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  for (let i = 0; i < 3; i += 1) await legacyController.tick();
  await legacyController.stop();
  assert.equal(records.getTask(legacyTask.id)?.state, "DONE");
  assert.equal(legacyAdapter.reviews, 1, "the migrated v1 policy still reviews every non-skipped change");
});

test("required review that cannot be routed is recorded as pending and resumed, never skipped", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({
    name: "capacity", repoPath: repo,
    reviewPolicy: { ...reviewPreset("client"), capacityAction: "pending" },
    checkCommands: [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true }],
  });
  records.addRequirement(project.id, "REQ-1", "the change is implemented");
  const task = records.createTask({ projectId: project.id, title: "t", objective: "Change the invoice helper." });
  const adapter = new ReviewAdapter("codex", (cwd) => {
    writeFileSync(join(cwd, "src", "billing", "invoice.ts"), "export function invoiceTotal(items){ return items.length; }\n");
  });

  const controller = new Controller(records, {
    adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await controller.tick();
  // The only subscription provider hits its session limit before the review can run.
  records.noteProviderFailure("codex", "QUOTA", "subscription session limit", 15 * 60_000);
  await controller.tick();
  const deferred = records.getTask(task.id);
  assert.equal(deferred?.state, "BLOCKED");
  assert.ok(deferred?.blockedReason?.startsWith(REVIEW_PENDING_PREFIX), deferred?.blockedReason ?? "");
  assert.equal(adapter.reviews, 0);
  assert.ok(records.listEvents(task.id).some((event) => event.kind === "review.pending"));
  assert.ok(records.checkpointsForTask(task.id).some((checkpoint) => checkpoint.kind === "review_pending"));
  // The outstanding review is never mistaken for acceptance.
  assert.throws(
    () => records.prepareApproval({ taskId: task.id, action: "merge", target: "main", reason: "ready" }),
    /independent review has not approved/,
  );
  await controller.stop();

  // Capacity returns; the controller resumes the outstanding review only.
  records.resetProvider("codex", "test: session limit cleared");
  const resumed = new Controller(records, {
    adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await resumed.tick();
  await resumed.tick();
  await resumed.stop();
  assert.equal(records.getTask(task.id)?.state, "DONE", records.getTask(task.id)?.blockedReason ?? "");
  assert.equal(adapter.reviews, 1);
  assert.equal(records.listAttempts(task.id).filter((attempt) => attempt.kind !== "review").length, 1,
    "resuming a review must not re-run the implementation");
});

class RepairThenPassAdapter implements WorkerAdapter {
  readonly name = "codex";
  readonly authMode = "test-subscription";
  readonly prompts: string[] = [];
  private readonly results = new Map<string, WorkerOutput>();
  private implementations = 0;
  reviews = 0;

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.prompts.push(input.prompt);
    const reviewing = input.prompt.includes('"role": "reviewer"');
    let result: WorkerOutput;
    if (reviewing) {
      this.reviews += 1;
      result = output({
        summary: this.reviews === 1 ? "One blocking issue." : "Repair looks correct.",
        follow_up: {
          unresolved: this.reviews === 1 ? ["[major] The helper ignores refunded items."] : [],
          decisions_requested: [], next_step: null,
        },
      });
    } else {
      this.implementations += 1;
      writeFileSync(join(input.cwd, "src", "billing", "invoice.ts"),
        this.implementations === 1
          ? "export function invoiceTotal(items){ return items.length; }\n"
          : "export function invoiceTotal(items){ return items.filter(i=>!i.refunded).length; }\n");
      result = output({ evidence: { changed_files: ["src/billing/invoice.ts"], result_revision: null, tests: [], artifacts: [] } });
      mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
      writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    }
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: "repair", completionPath: input.completionPath };
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

test("a re-review after a repair receives the prior findings and the repair delta", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const project = records.createProject({
    name: "delta", repoPath: repo,
    reviewPolicy: { ...reviewPreset("client"), scope: "change", reviewerRoute: "same_provider_fresh_context" },
    checkCommands: [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true }],
  });
  records.addRequirement(project.id, "REQ-1", "invoice totals exclude refunded items");
  const task = records.createTask({ projectId: project.id, title: "t", objective: "Fix invoice totals." });
  const adapter = new RepairThenPassAdapter();
  const controller = new Controller(records, {
    adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  for (let i = 0; i < 6; i += 1) await controller.tick();
  await controller.stop();

  assert.equal(records.getTask(task.id)?.state, "DONE", records.getTask(task.id)?.blockedReason ?? "");
  assert.equal(adapter.reviews, 2);
  const reviews = records.reviewsForTask(task.id);
  assert.deepEqual(reviews.map((review) => review.verdict), ["request_changes", "approved"]);
  assert.notEqual(reviews[0]?.revision, reviews[1]?.revision);

  const secondReviewAttempt = records.listAttempts(task.id).filter((attempt) => attempt.kind === "review").at(-1);
  const manifestPath = records.getPacket(secondReviewAttempt?.packetId as string)?.manifest_path as string;
  const artifacts = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    worker_input: { context: { artifacts: string[]; previous_findings: string[] } };
  };
  assert.ok(artifacts.worker_input.context.artifacts.some((path) => path.endsWith("review-delta.patch")),
    "the second review must receive the repair delta");
  assert.ok(artifacts.worker_input.context.artifacts.some((path) => path.endsWith("review-diff.patch")),
    "the full change remains available");
  assert.ok(artifacts.worker_input.context.previous_findings.some((finding) => finding.includes("refunded items")),
    "prior findings are retained across the repair");
  const deltaPath = artifacts.worker_input.context.artifacts.find((path) => path.endsWith("review-delta.patch")) as string;
  assert.ok(existsSync(deltaPath));
  assert.match(readFileSync(deltaPath, "utf8"), /refunded/);
});
