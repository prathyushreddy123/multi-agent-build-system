import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { taskScorecard } from "../src/diagnostics/views.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";
import { attemptHealth, IDLE_AFTER_MS, STALL_AFTER_MS } from "../src/telemetry/health.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

test("attempt health comes from provider events alone", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.equal(attemptHealth({ state: "succeeded", startedAt: at(1_000), lastEventAt: null }, now), "finished");
  assert.equal(attemptHealth({ state: "running", startedAt: at(5_000), lastEventAt: null }, now), "starting");
  assert.equal(attemptHealth({ state: "running", startedAt: at(60_000), lastEventAt: at(1_000) }, now), "working");
  assert.equal(attemptHealth({ state: "running", startedAt: at(600_000), lastEventAt: at(IDLE_AFTER_MS) }, now), "idle");
  assert.equal(attemptHealth({ state: "running", startedAt: at(STALL_AFTER_MS * 2), lastEventAt: at(STALL_AFTER_MS) }, now), "stalled");
  assert.equal(attemptHealth({ state: "running", startedAt: at(STALL_AFTER_MS), lastEventAt: null }, now), "stalled", "no output at all is stalled too");
});

/** Every attempt fails the same way, reporting fixed usage. */
class SameFailureAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name = "codex";
  starts = 0;
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts += 1;
    writeFileSync(join(input.cwd, "value.txt"), `attempt ${this.starts}\n`);
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null,
        usage: { input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 10 },
        apiEquivalentEstimateUsd: null, sessionId: null, raw: "", stderr: "" },
      validation: validateWorkerOutput({
        outcome: "failed", reason: "TypeError: cannot read properties of undefined (reading 'total') at src/ledger.ts:42",
        summary: "the build fails", evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null }, addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-loop-guard-"));
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  const adapter = new SameFailureAdapter();
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  t.after(async () => {
    await controller.stop();
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "start\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-q", "-m", "start"], { cwd: repo });
  const project = records.createProject({ name: "guard", repoPath: repo, projectType: "personal", reviewChoice: "off", reviewPolicy: { mode: "none", skipTaskClasses: [] } });
  const task = records.createTask({ projectId: project.id, title: "change", objective: "change value", taskClass: "small_implementation", repairLimit: 5 });
  return { records, adapter, controller, task };
}

async function runToRest(controller: Controller, records: Records, taskId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!["DONE", "FAILED", "CANCELLED", "BLOCKED"].includes(records.getTask(taskId)?.state ?? "") && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("the same failure twice on the same route stops a third identical launch, and an explicit retry still gets one", async (t) => {
  const { records, adapter, controller, task } = setup(t);
  await runToRest(controller, records, task.id);
  const blocked = records.getTask(task.id);
  assert.equal(blocked?.state, "BLOCKED", `${blocked?.state}: ${blocked?.blockedReason}`);
  assert.equal(adapter.starts, 2, "a repair budget of five was not spent on identical failures");
  assert.match(blocked?.blockedReason ?? "", /same failure occurred twice/);
  assert.match(blocked?.blockedReason ?? "", /ledger\.ts:<n>/, "the symptom is normalized, not the raw line");
  assert.equal(records.listEventsOfKind(task.id, "attempt.repeat_refused").length, 1);

  // As an operator would, discard the failed attempt's leftovers before retrying.
  execFileSync("git", ["checkout", "--", "."], { cwd: records.getTask(task.id)?.worktreePath as string });
  records.retryTask(task.id, (records.getTask(task.id) as { recordVersion: number }).recordVersion);
  await runToRest(controller, records, task.id);
  assert.equal(adapter.starts, 3, "the operator's retry is honored once, and the same failure then stops it again");
  assert.equal(records.listEventsOfKind(task.id, "attempt.repeat_refused").length, 2);

  const card = taskScorecard(records, task.id);
  assert.equal(card.attempts[0]?.health, "finished");
  assert.equal(card.attempts[0]?.usage.cachedInputTokens, 800);
  assert.equal(card.attempts[0]?.usage.reasoningOutputTokens, 10);
  assert.equal((card.usageByProvider.codex as { knownInputEvents: number | null }).knownInputEvents, 3_000, "per-provider totals sum every attempt");
});
