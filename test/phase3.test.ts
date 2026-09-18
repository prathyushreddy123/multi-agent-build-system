import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { taskDiagnostics } from "../src/diagnostics/task.ts";
import { validateWorkerOutput, type WorkerOutput } from "../src/domain/contract.ts";
import { applyExecutionPlan, type ExecutionPlan } from "../src/domain/plan.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoAt(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "value.txt"), "initial\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-phase3-"));
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

class ReviewLoopAdapter implements WorkerAdapter {
  readonly name = "codex";
  readonly authMode = "test-subscription";
  readonly prompts: string[] = [];
  private readonly results = new Map<string, WorkerOutput>();
  private implementations = 0;
  private reviews = 0;

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.prompts.push(input.prompt);
    const reviewing = input.prompt.includes('"role": "reviewer"');
    let result: WorkerOutput;
    if (reviewing) {
      this.reviews += 1;
      result = output({
        reason: "independent review completed",
        summary: this.reviews === 1 ? "One correctness issue found." : "Revision is acceptable.",
        follow_up: {
          unresolved: this.reviews === 1 ? ["[major] Add the reviewed marker."] : [],
          decisions_requested: [],
          next_step: null,
        },
      });
    } else {
      this.implementations += 1;
      writeFileSync(join(input.cwd, "value.txt"), this.implementations === 1 ? "feature v1\n" : "feature v2 reviewed\n");
      result = output({ summary: `Implementation ${this.implementations}.`, evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] } });
    }
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
    writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: `${reviewing ? "review" : "implementation"}-${this.prompts.length}`, completionPath: input.completionPath };
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

class FailingGateAdapter extends ReviewLoopAdapter {
  override async start(input: AdapterLaunch): Promise<AdapterHandle> {
    const handle = await super.start(input);
    if (!input.prompt.includes('"role": "reviewer"')) writeFileSync(join(input.cwd, "value.txt"), "gate failure\n");
    return handle;
  }
}

class ResponseAdapter implements WorkerAdapter {
  readonly name = "codex";
  readonly authMode = "test-subscription";
  private readonly results = new Map<string, WorkerOutput>();
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    const result = output({ summary: "The retained gate log is the authoritative evidence." });
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
    writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: "response", completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(handle: AdapterHandle): Promise<CollectedResult> {
    return {
      launch: {
        exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null,
        usage: null, apiEquivalentEstimateUsd: null, sessionId: "response", raw: "", stderr: "",
      },
      validation: validateWorkerOutput(this.results.get(handle.attemptId)), failureClass: null, error: null,
    };
  }
}

test("substantive work passes gates, independent review, one review repair, and fresh re-review", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo"); repoAt(repo);
  const project = records.createProject({
    name: "reviewed", repoPath: repo,
    reviewPolicy: { mode: "substantive", skipTaskClasses: ["mechanical"] },
    checkCommands: [{
      name: "value", required: true,
      command: [process.execPath, "-e", "const f=require('fs').readFileSync('value.txt','utf8');process.exit(f.startsWith('feature')?0:1)"],
    }],
  });
  records.addRequirement(project.id, "REQ-1", "The final value must implement the feature.");
  const task = records.createTask({
    projectId: project.id, title: "review loop", objective: "Implement and independently review the feature.",
    acceptanceCriteria: ["registered gate passes", "independent review approves"], allowedScope: ["value.txt"], repairLimit: 2,
  });
  const adapter = new ReviewLoopAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });

  for (let tick = 0; tick < 5; tick += 1) await controller.tick();
  const final = records.getTask(task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "task did not complete");
  assert.equal(final?.repairsUsed, 1);
  assert.deepEqual(records.listAttempts(task.id).map((attempt) => attempt.kind), ["initial", "review", "repair", "review"]);
  assert.deepEqual(records.reviewsForTask(task.id).map((review) => review.verdict), ["request_changes", "approved"]);
  assert.equal(records.gatesForTask(task.id).length, 2);
  assert.equal(readFileSync(join(final?.worktreePath as string, "value.txt"), "utf8"), "feature v2 reviewed\n");

  const reviewPrompts = adapter.prompts.filter((prompt) => prompt.includes('"role": "reviewer"'));
  assert.equal(reviewPrompts.length, 2);
  assert.ok(reviewPrompts.every((prompt) => prompt.includes("read-only review")));
  const reviewPackets = records.packetsForTask(task.id).filter((packet) => {
    const manifest = JSON.parse(readFileSync(packet.manifest_path as string, "utf8")) as { worker_input: { identity: { role: string } } };
    return manifest.worker_input.identity.role === "reviewer";
  });
  assert.equal(reviewPackets.length, 2);
  assert.ok((reviewPackets[0]?.artifacts as string[]).some((path) => path.endsWith("review-diff.patch")));

  const diagnostics = taskDiagnostics(records, task.id);
  assert.deepEqual(diagnostics.requirementCoverage.missing, []);
  assert.ok(diagnostics.evidence.some((item) => item.label.endsWith("result") && item.exists));
  assert.ok(diagnostics.evidence.filter((item) => item.kind === "gate").every((item) => item.exists));
  const prepared = records.prepareApproval({ taskId: task.id, action: "deploy", target: "acceptance", reason: "Reviewed revision only." });
  assert.equal(prepared.required, true);
  assert.equal(prepared.approval?.revision, final?.resultRevision);
  await controller.stop();
});

test("failed required gates prevent review and completion and retain explanatory logs", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "failed-gate"); repoAt(repo);
  const project = records.createProject({
    name: "failed-gate", repoPath: repo,
    reviewPolicy: { mode: "required", skipTaskClasses: [] },
    checkCommands: [{ name: "must-pass", required: true, command: [process.execPath, "-e", "process.exit(7)"] }],
  });
  const task = records.createTask({
    projectId: project.id, title: "cannot pass", objective: "Demonstrate gate enforcement.",
    acceptanceCriteria: ["required gate passes"], allowedScope: ["value.txt"], repairLimit: 0,
  });
  const adapter = new FailingGateAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick(); await controller.tick();
  const failed = records.getTask(task.id);
  assert.equal(failed?.state, "FAILED", failed?.blockedReason ?? "task did not fail");
  assert.equal(records.reviewsForTask(task.id).length, 0);
  const gate = records.gatesForTask(task.id)[0];
  assert.equal(gate?.status, "FAIL");
  assert.ok(gate?.evidencePath && existsSync(gate.evidencePath));
  assert.match(readFileSync(gate?.evidencePath as string, "utf8"), /exit: 7/);
  assert.throws(() => records.prepareApproval({
    taskId: task.id, action: "deploy", target: "test", reason: "must not be prepared",
  }), /quality gates are missing or failing/);
  const waiver = records.prepareApproval({
    taskId: task.id, action: "waive_required_gate", target: gate?.id as string, reason: "Acceptance-only waiver test.",
  }).approval;
  assert.ok(waiver);
  records.decideApproval(waiver.id, "approved", "owner");
  records.waiveGate(gate?.id as string, waiver.id);
  assert.equal(records.getApproval(waiver.id)?.state, "consumed");
  assert.equal(records.gatesForTask(task.id)[0]?.waiverId, waiver.id);
  await controller.stop();
});

test("an unanswered feedback question is resolved by one on-demand response task", async (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "response"); repoAt(repo);
  const project = records.createProject({ name: "response", repoPath: repo });
  const plan = records.recordExecutionPlan({
    projectId: project.id,
    objective: "Answer project questions",
    mode: "single",
    reason: "On-demand only.",
    tasks: [],
  });
  const question = records.submitFeedback({
    projectId: project.id, planId: plan.id, kind: "question", body: "Which evidence is authoritative?",
    expectedVersion: plan.version, createdBy: "tester",
  });
  const responseTaskId = question.linkedTaskId as string;
  const adapter = new ResponseAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick(); await controller.tick();
  assert.equal(records.getTask(responseTaskId)?.state, "DONE");
  assert.equal(records.getFeedback(question.id)?.state, "answered");
  assert.equal(records.getFeedback(question.id)?.response, "The retained gate log is the authoritative evidence.");
  assert.equal(records.listAttempts(responseTaskId).length, 1);
  await controller.stop();
});

test("stale approvals are durably invalidated instead of being approved", (t) => {
  const { records } = setup(t);
  const project = records.createProject({ name: "approval", repoPath: "/tmp/approval" });
  const task = records.createTask({ projectId: project.id, title: "approved work", objective: "prepare action" });
  records.updateTaskFields(task.id, { result_revision: "revision-one" });
  const approval = records.requestApproval({
    projectId: project.id, taskId: task.id,
    binding: { action: "merge", target: "main", revision: "revision-one", configVersion: project.configVersion },
    reason: "Merge reviewed revision.",
  });
  records.updateTaskFields(task.id, { result_revision: "revision-two" });
  assert.throws(() => records.decideApproval(approval.id, "approved", "tester"), /stale and was invalidated/);
  assert.equal(records.getApproval(approval.id)?.state, "invalidated");
  const currentProject = records.getProject(project.id) as NonNullable<ReturnType<Records["getProject"]>>;
  const targetApproval = records.requestApproval({
    projectId: project.id, taskId: task.id,
    binding: { action: "merge", target: "main", revision: "revision-two", configVersion: currentProject.configVersion },
    reason: "Target-bound approval.",
  });
  records.setProjectBaseBranch(project.id, "release");
  assert.equal(records.getApproval(targetApproval.id)?.state, "invalidated");
  assert.ok(records.listEvents(task.id).some((event) => event.kind === "approval.invalidated"));
});

test("plans and versioned feedback preserve questions and create scoped follow-up work", (t) => {
  const { records } = setup(t);
  const project = records.createProject({ name: "feedback", repoPath: "/tmp/feedback" });
  const plan: ExecutionPlan = {
    objective: "Feedback flow", mode: "single", reason: "One bounded task.", assumptions: ["Local-only"], milestones: ["Reviewed"],
    tasks: [{ key: "one", title: "First", objective: "Complete first task", acceptanceCriteria: ["done"], executionMode: "single", executionReason: "bounded" }],
  };
  const [task] = applyExecutionPlan(records, project.id, plan);
  const savedPlan = records.listExecutionPlans(project.id)[0];
  assert.ok(task && savedPlan);
  const question = records.submitFeedback({
    projectId: project.id, planId: savedPlan.id, kind: "question", body: "Which assumption is authoritative?",
    expectedVersion: savedPlan.version, createdBy: "tester",
  });
  assert.equal(question.state, "pending");
  assert.ok(question.linkedTaskId);
  assert.equal(records.answerFeedback(question.id, "The project requirement is authoritative.", "owner").state, "answered");
  assert.equal(records.getTask(question.linkedTaskId as string)?.state, "CANCELLED");

  const automated = records.submitFeedback({
    projectId: project.id, taskId: task.id, kind: "question", body: "What evidence is retained?",
    expectedVersion: task.recordVersion, createdBy: "tester",
  });
  assert.equal(records.completeFeedbackForTask(automated.linkedTaskId as string, "Gate and review evidence are retained."), 1);
  assert.equal(records.getFeedback(automated.id)?.response, "Gate and review evidence are retained.");

  const request = records.submitFeedback({
    projectId: project.id, taskId: task.id, kind: "request_change", body: "Add a regression assertion.",
    expectedVersion: task.recordVersion, createdBy: "tester",
  });
  assert.equal(request.state, "applied");
  assert.ok(request.linkedTaskId);
  assert.deepEqual(records.dependenciesOf(request.linkedTaskId as string), [task.id]);
  assert.throws(() => records.submitFeedback({
    projectId: project.id, taskId: task.id, kind: "comment", body: "stale comment",
    expectedVersion: task.recordVersion - 1, createdBy: "tester",
  }), /changed since version/);

  const diagnostic = taskDiagnostics(records, task.id);
  assert.ok(diagnostic.warnings.some((warning) => warning.includes("Context manifest is unavailable") || warning.includes("No retained worker result")) || diagnostic.context.length === 0);
  const missingGate = records.recordGate({
    taskId: task.id, attemptId: null, name: "missing-log", status: "FAIL", required: true,
    command: "false", toolVersion: null, revision: "none", evidencePath: join(process.env.MABS_STATE_DIR as string, "artifacts", "missing.log"), durationMs: 1, waiverId: null,
  });
  assert.ok(missingGate.evidencePath);
  assert.ok(taskDiagnostics(records, task.id).warnings.some((warning) => warning.includes("Evidence file is unavailable")));
  if (missingGate.evidencePath && existsSync(missingGate.evidencePath)) unlinkSync(missingGate.evidencePath);
});
