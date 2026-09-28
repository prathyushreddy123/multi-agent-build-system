import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { Store } from "../src/store/db.ts";
import { reviewPreset } from "../src/review/policy.ts";
import { Records } from "../src/store/records.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

class CompletingAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name: string;
  starts = 0;
  constructor(name: string) { this.name = name; }
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts += 1;
    writeFileSync(join(input.cwd, "value.txt"), "implemented\n");
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

test("T08: review revision drift at launch fails closed and releases the stage and its admission lease", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-review-drift-"));
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  const adapters = new Map<string, WorkerAdapter>([["codex", new CompletingAdapter("codex")]]);
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters, defaultAdapter: "codex", workerLimit: 1 });
  t.after(async () => {
    await controller.stop();
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "initial\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const project = records.createProject({
    name: "drift", repoPath: repo, projectType: "personal", reviewChoice: "required", reviewPolicy: { ...reviewPreset("client"), capacityAction: "pending", reviewerRoute: "independent_provider" },
  });
  const task = records.createTask({ projectId: project.id, title: "change", objective: "change value", taskClass: "small_implementation" });

  // With only the implementer's provider configured, the independent review cannot route yet.
  for (let tick = 0; tick < 10 && !records.getTask(task.id)?.resultRevision; tick += 1) await controller.tick();
  const reviewed = records.getTask(task.id)?.resultRevision;
  assert.ok(reviewed, `implementation finalized (${records.getTask(task.id)?.state}: ${records.getTask(task.id)?.blockedReason})`);
  await controller.tick();

  // The worktree moves away from the revision under review before the reviewer launches.
  const worktree = records.getTask(task.id)?.worktreePath as string;
  writeFileSync(join(worktree, "value.txt"), "drifted\n");
  git(worktree, "commit", "-q", "-am", "drift");
  const reviewer = new CompletingAdapter("claude");
  adapters.set("claude", reviewer);
  assert.match(records.getTask(task.id)?.blockedReason ?? "", /^Review pending/, "the review waits for an independent provider");
  for (let tick = 0; tick < 5 && !/misreport its revision/.test(records.getTask(task.id)?.blockedReason ?? ""); tick += 1) await controller.tick();

  const blocked = records.getTask(task.id);
  assert.equal(blocked?.state, "BLOCKED");
  assert.match(blocked?.blockedReason ?? "", /Review packet would misreport its revision/);
  assert.equal(reviewer.starts, 0, "no reviewer launched against the wrong revision");
  assert.equal(records.store.all("SELECT * FROM admission_leases WHERE status IN ('reserved','active')").length, 0, "the lease was released");
  const reviewStages = records.stageRunsForTask(task.id).filter((stage) => stage.stage === "review");
  assert.ok(reviewStages.length > 0);
  assert.ok(reviewStages.every((stage) => stage.state === "failed"), reviewStages.map((stage) => stage.state).join(","));
  assert.ok(records.listEvents(task.id).some((event) => event.kind === "context.revision_drift"));
});
