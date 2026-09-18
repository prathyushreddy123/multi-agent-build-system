import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

class FakeAdapter implements WorkerAdapter {
  readonly name = "codex";
  readonly authMode = "test-subscription";
  starts = 0;

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts += 1;
    writeFileSync(join(input.cwd, "value.txt"), "implemented\n");
    writeFileSync(input.completionPath, JSON.stringify({ done: true }));
    return { attemptId: input.attemptId, pid: null, sessionId: "fake-session", completionPath: input.completionPath };
  }

  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    const validation = validateWorkerOutput({
      outcome: "completed",
      reason: "implemented",
      summary: "Changed value.txt.",
      evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] },
      follow_up: { unresolved: [], decisions_requested: [], next_step: null },
      usage: { model: null, input_tokens: null, output_tokens: null },
      addressed_requirements: ["REQ-1"],
    });
    return {
      launch: {
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        finalMessage: "",
        reportedModel: null,
        usage: null,
        apiEquivalentEstimateUsd: null,
        sessionId: "fake-session",
        raw: "",
        stderr: "",
      },
      validation,
      failureClass: null,
      error: null,
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("controller restart collects one isolated launch without duplication and checks its final revision", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-controller-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "initial\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");

  const oldState = process.env.MABS_STATE_DIR;
  const oldWorktrees = process.env.MABS_WORKTREE_ROOT;
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const dbPath = join(root, "state", "mabs.sqlite");
  let records = new Records(new Store(dbPath));
  t.after(() => {
    try { records.store.close(); } catch { /* already closed by the restart simulation */ }
    if (oldState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = oldState;
    if (oldWorktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = oldWorktrees;
    rmSync(root, { recursive: true, force: true });
  });

  const project = records.createProject({
    name: "fixture",
    repoPath: repo,
    reviewPolicy: { mode: "none", skipTaskClasses: [] },
    checkCommands: [{
      name: "value-check",
      command: [process.execPath, "-e", "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='implemented'?0:1)"],
      required: true,
    }],
  });
  records.addRequirement(project.id, "REQ-1", "value.txt must contain implemented");
  const task = records.createTask({
    projectId: project.id,
    title: "implement value",
    objective: "Change value.txt to implemented.",
    acceptanceCriteria: ["the registered value check passes"],
  });
  const fake = new FakeAdapter();
  const controller = new Controller(records, { adapters: new Map([["codex", fake]]), defaultAdapter: "codex", workerLimit: 1 });

  await controller.tick();
  assert.equal(records.getTask(task.id)?.state, "RUNNING");
  assert.equal(records.listRunningAttempts().length, 1);
  assert.equal(fake.starts, 1);

  // Simulate a controller crash/restart by closing and reopening authoritative
  // SQLite state before collecting the already-completed worker.
  records.store.close();
  records = new Records(new Store(dbPath));
  records.store.run("UPDATE controller_lease SET heartbeat_at = ? WHERE singleton = 1", new Date(Date.now() - 60_000).toISOString());
  const restarted = new Controller(records, {
    adapters: new Map([["codex", fake]]),
    defaultAdapter: "codex",
    workerLimit: 1,
    leaseTimeoutMs: 10,
  });
  await restarted.tick();
  const done = records.getTask(task.id);
  assert.equal(done?.state, "DONE");
  assert.ok(done?.resultRevision);
  assert.equal(records.listAttempts(task.id)[0]?.state, "succeeded");
  assert.equal(fake.starts, 1, "restart must collect the existing launch rather than dispatch a duplicate");
  assert.equal(records.gatesForRevision(task.id, done?.resultRevision as string)[0]?.status, "PASS");
  assert.equal(readFileSync(join(done?.worktreePath as string, "value.txt"), "utf8"), "implemented\n");
  assert.equal(git(done?.worktreePath as string, "status", "--porcelain"), "");
});
