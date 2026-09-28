import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import {
  authorizeRun,
  compareExperiment,
  createExperiment,
  experimentBudgetState,
  prepareRun,
  recordTrialFromTask,
  startTrial,
  type ExperimentProtocol,
} from "../src/optimization/experiments.ts";
import { Store } from "../src/store/db.ts";
import { Records, type GateSpec } from "../src/store/records.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

/** Completes every attempt at once and remembers the route each one was launched with. */
class RecordingAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name = "codex";
  readonly starts: AdapterLaunch[] = [];
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input);
    writeFileSync(join(input.cwd, "value.txt"), `changed ${this.starts.length}\n`);
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
        apiEquivalentEstimateUsd: null, sessionId: null, raw: "", stderr: "" },
      validation: validateWorkerOutput({
        outcome: "completed", reason: "done", summary: "done",
        evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null }, addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd, encoding: "utf8" }).trim();
}

function setup(t: TestContext, options: { checks?: GateSpec[]; budget?: Partial<ExperimentProtocol["budget"]> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mabs-trials-"));
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  let controller: Controller | null = null;
  t.after(async () => {
    await controller?.stop();
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "case start\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "case start");
  const startingRevision = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "value.txt"), "later work\n");
  git(repo, "commit", "-q", "-am", "later");
  const project = records.createProject({
    name: "trials", repoPath: repo, projectType: "personal", reviewChoice: "off",
    reviewPolicy: { mode: "none", skipTaskClasses: [] }, checkCommands: options.checks ?? [],
  });
  const experiment = createExperiment(records, {
    projectId: project.id, name: "effort", hypothesis: "medium effort needs no more repairs", dimension: "effort",
    suiteVersion: "live-v1", baselineConfig: { effort: "high" }, candidateConfig: { effort: "medium" },
    protocol: {
      primaryMetric: "repairs", tolerances: {}, cases: ["case-a"], repeats: 1, missingData: "known_subtotal",
      budget: { maxTrials: 2, maxElapsedMs: 3_600_000, usageWarningInputTokens: null, maxAttemptsPerTrial: 3, ...options.budget },
      trialCases: { "case-a": { startingRevision, title: "change value", objective: "change value.txt", taskClass: "small_implementation" } },
    },
  });
  const { fingerprint } = prepareRun(records, experiment.id);
  authorizeRun(records, experiment.id, { fingerprint, authorizedBy: "owner" });
  const adapter = new RecordingAdapter();
  controller = new Controller(records, {
    capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1,
  });
  return { records, project, experiment, startingRevision, adapter, controller };
}

async function runToRest(controller: Controller, records: Records, taskId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!["DONE", "FAILED", "CANCELLED", "BLOCKED"].includes(records.getTask(taskId)?.state ?? "") && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("a live trial runs its variant's route from the case revision through the controller and is recorded to its slot only", async (t) => {
  const { records, project, experiment, startingRevision, adapter, controller } = setup(t);
  // case-a#0 is counterbalanced baseline-first.
  assert.throws(() => startTrial(records, { experimentId: experiment.id, variant: "candidate", caseKey: "case-a", repeatIndex: 0 }), /manifest order/);
  assert.throws(() => startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-z", repeatIndex: 0 }), /not a slot/);

  const baseline = startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0 });
  assert.throws(() => startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0 }), /already has a trial task/);
  await runToRest(controller, records, baseline.task.id);
  assert.equal(records.getTask(baseline.task.id)?.state, "DONE", records.getTask(baseline.task.id)?.blockedReason ?? "");
  assert.equal(records.getTask(baseline.task.id)?.baseRevision, startingRevision, "the trial started from the case revision, not HEAD");
  assert.equal(adapter.starts.at(-1)?.effort, "high", "the baseline variant's effort was applied");

  assert.throws(() => recordTrialFromTask(records, { experimentId: experiment.id, variant: "candidate", caseKey: "case-a", repeatIndex: 0, taskId: baseline.task.id }),
    /is bound to baseline case-a#0/);
  const unrelated = records.createTask({ projectId: project.id, title: "other", objective: "o" });
  records.transition(unrelated.id, "READY");
  records.transition(unrelated.id, "RUNNING");
  records.transition(unrelated.id, "FAILED", { failure_class: "CODE", blocked_reason: "x" });
  assert.throws(() => recordTrialFromTask(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0, taskId: unrelated.id }),
    /was not started as a trial/);
  const recorded = recordTrialFromTask(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0, taskId: baseline.task.id });
  assert.equal(recorded.source, "live_trial");
  assert.equal(recorded.trialState, "completed");

  const candidate = startTrial(records, { experimentId: experiment.id, variant: "candidate", caseKey: "case-a", repeatIndex: 0 });
  await runToRest(controller, records, candidate.task.id);
  assert.equal(adapter.starts.at(-1)?.effort, "medium", "the candidate variant's effort was applied");
  recordTrialFromTask(records, { experimentId: experiment.id, variant: "candidate", caseKey: "case-a", repeatIndex: 0, taskId: candidate.task.id });
  const comparison = compareExperiment(records, experiment.id);
  assert.equal(comparison.evidence, "complete");
  assert.deepEqual(comparison.budgetBreaches, []);
});

test("a trial task from another project, or one that bypassed the controller, is refused", async (t) => {
  const { records, experiment } = setup(t);
  const { task } = startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0 });
  // Driven to rest by hand: no stage, admission, or attempt ever existed.
  records.transition(task.id, "READY");
  records.transition(task.id, "RUNNING");
  records.transition(task.id, "FAILED", { failure_class: "CODE", blocked_reason: "x" });
  assert.throws(() => recordTrialFromTask(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0, taskId: task.id }),
    /did not run through normal execution/);

  const other = records.createProject({ name: "elsewhere", repoPath: "/tmp/elsewhere", projectType: "personal", reviewChoice: "off" });
  records.store.run("UPDATE tasks SET project_id = ? WHERE id = ?", other.id, task.id);
  assert.throws(() => recordTrialFromTask(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0, taskId: task.id }),
    /not the experiment's project/);
});

test("a trial stops at its attempt budget and is recorded as interrupted", async (t) => {
  const failing: GateSpec = { name: "unit", required: true, command: [process.execPath, "-e", "console.error('AssertionError [ERR_ASSERTION]: value mismatch');process.exit(1)"] };
  const { records, experiment, adapter, controller } = setup(t, { checks: [failing], budget: { maxAttemptsPerTrial: 1 } });
  const { task } = startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0 });
  await runToRest(controller, records, task.id);
  const current = records.getTask(task.id);
  assert.equal(current?.state, "BLOCKED");
  assert.match(current?.blockedReason ?? "", /attempt budget of 1 is spent/);
  assert.equal(adapter.starts.length, 1, "the repair that would exceed the budget never launched");
  const trial = recordTrialFromTask(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0, taskId: task.id });
  assert.equal(trial.trialState, "interrupted");
  assert.equal(trial.accepted, false);
});

test("an exhausted elapsed budget stops new trials and withholds proposal support", async (t) => {
  const { records, experiment, controller } = setup(t, { budget: { maxElapsedMs: 60_000 } });
  const baseline = startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0 });
  await runToRest(controller, records, baseline.task.id);
  // The authorization was granted two minutes ago: the run is past its budget.
  const earlier = new Date(Date.now() - 120_000).toISOString();
  records.store.run("UPDATE optimization_experiments SET run_authorization = json_set(run_authorization, '$.at', ?) WHERE id = ?", earlier, experiment.id);
  assert.throws(() => startTrial(records, { experimentId: experiment.id, variant: "candidate", caseKey: "case-a", repeatIndex: 0 }), /elapsed budget is spent/);
  const late = recordTrialFromTask(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0, taskId: baseline.task.id });
  assert.equal(late.warnings, 1, "a trial recorded past the budget carries a warning");
  assert.equal(records.listEventsOfKind(baseline.task.id, "optimization.budget_warning").length, 1);
  const state = experimentBudgetState(records, experiment.id);
  assert.equal(state.elapsedExceeded, true);
  assert.equal(state.lateTrials, 1);
  const comparison = compareExperiment(records, experiment.id);
  assert.equal(comparison.supportsProposal, false);
  assert.match(comparison.reasons.join(" "), /Budget exceeded/);
});

test("changing a fingerprinted input after authorization stops further trials", (t) => {
  const { records, project, experiment } = setup(t);
  records.store.run("UPDATE projects SET check_commands = ? WHERE id = ?", JSON.stringify([{ name: "new", required: true, command: ["true"] }]), project.id);
  assert.throws(() => startTrial(records, { experimentId: experiment.id, variant: "baseline", caseKey: "case-a", repeatIndex: 0 }),
    /manifest changed after authorization/);
});
