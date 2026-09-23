/**
 * Release acceptance for the operator workspace.
 *
 * One lifecycle — implementation, failing check, repair, passing check, review,
 * delivery approval — recorded exactly as the controller records it, then read
 * back through all four surfaces. The point is that the surfaces agree with the
 * store and with each other, not that any of them is individually plausible.
 *
 * Rows of the release matrix that need a real provider run or a human attached
 * to Herdr are listed in docs/operator/progress.md as manual checks.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exec } from "../../src/core/exec.ts";
import { artifactDir } from "../../src/core/paths.ts";
import { openFile, taskChanges } from "../../src/operator/code.ts";
import { INITIAL_VIEW, reconcileView, renderDashboard } from "../../src/operator/dashboard.ts";
import { listEvidence, readChunk } from "../../src/operator/logs.ts";
import { buildProgressSnapshot } from "../../src/operator/progress.ts";
import { summarizeExecution } from "../../src/operator/summaries.ts";
import { openRecords, type Records } from "../../src/store/records.ts";

interface World {
  root: string;
  repo: string;
  records: Records;
  projectId: string;
  taskId: string;
  attempts: { initial: string; repair: string; review: string };
  worktree: string;
  baseRevision: string;
  close: () => void;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Record a complete lifecycle the way the controller does. */
async function buildWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "mabs-accept-"));
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_DB_PATH = join(root, "state", "mabs.sqlite");

  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "mabs@local"]);
  await git(repo, ["config", "user.name", "MABS Test"]);
  writeFileSync(join(repo, "app.ts"), "export const value = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseRevision = await git(repo, ["rev-parse", "HEAD"]);

  const records = openRecords();
  const project = records.createProject({
    name: "acceptance", repoPath: repo, baseBranch: "main",
    checkCommands: [{ name: "typecheck", command: ["npm", "run", "typecheck"], required: true }],
  });
  const task = records.createTask({ projectId: project.id, title: "Raise the value", objective: "make it 2" });

  const worktree = join(root, "worktrees", task.id);
  await git(repo, ["worktree", "add", "-q", "-b", `mabs/${task.id}`, worktree, baseRevision]);

  records.transition(task.id, "READY");
  records.transition(task.id, "RUNNING");

  // Attempt 1: implementation, then a failing required check.
  const initial = records.startAttempt({
    taskId: task.id, launchId: "launch-1", kind: "initial", adapter: "claude", model: "claude-opus-5",
    worktreePath: worktree, baseRevision,
  });
  writeFileSync(join(worktree, "app.ts"), "export const value: string = 2;\n");
  await git(worktree, ["-c", "user.email=mabs@local", "-c", "user.name=MABS Test", "commit", "-qam", "mabs: raise the value"]);
  const revision1 = await git(worktree, ["rev-parse", "HEAD"]);
  const initialDir = artifactDir(task.id, initial.id);
  writeFileSync(join(initialDir, "worker.log"), "attempt 1: editing app.ts\nattempt 1: done\n");
  writeFileSync(join(initialDir, "worker-result.json"), JSON.stringify({ outcome: "completed" }));
  records.finishAttempt({
    attemptId: initial.id, state: "succeeded", outcome: "completed",
    resultRevision: revision1, outputPath: join(initialDir, "worker-result.json"),
  });
  records.recordCheckpoint({
    taskId: task.id, attemptId: initial.id, kind: "implementation_complete",
    summary: "Set value to 2", baseRevision, resultRevision: revision1, changedFiles: ["app.ts"],
    evidence: [join(initialDir, "worker-result.json")],
  });
  records.transition(task.id, "CHECKING", { result_revision: revision1 });
  writeFileSync(join(initialDir, "gate-0-typecheck.log"), "app.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n");
  records.recordGate({
    taskId: task.id, attemptId: initial.id, name: "typecheck", status: "FAIL", required: true,
    command: "npm run typecheck", toolVersion: "tsc 7.0.2", revision: revision1,
    evidencePath: join(initialDir, "gate-0-typecheck.log"), durationMs: 1800, waiverId: null,
  });
  records.recordCheckpoint({
    taskId: task.id, attemptId: initial.id, kind: "checks_failed",
    summary: "One or more required checks failed.", resultRevision: revision1,
    findings: ["typecheck FAIL"], nextAction: "Repair the type error.",
  });
  records.transition(task.id, "RUNNING");

  // Attempt 2: repair, then a passing check.
  const repair = records.startAttempt({
    taskId: task.id, launchId: "launch-2", kind: "repair", adapter: "claude", model: "claude-opus-5",
    worktreePath: worktree, baseRevision,
  });
  writeFileSync(join(worktree, "app.ts"), "export const value = 2;\n");
  await git(worktree, ["-c", "user.email=mabs@local", "-c", "user.name=MABS Test", "commit", "-qam", "mabs: fix the type"]);
  const revision2 = await git(worktree, ["rev-parse", "HEAD"]);
  const repairDir = artifactDir(task.id, repair.id);
  writeFileSync(join(repairDir, "worker.log"), "attempt 2: removing the annotation\n");
  writeFileSync(join(repairDir, "worker-result.json"), JSON.stringify({ outcome: "completed" }));
  records.finishAttempt({
    attemptId: repair.id, state: "succeeded", outcome: "completed",
    resultRevision: revision2, outputPath: join(repairDir, "worker-result.json"),
  });
  records.recordCheckpoint({
    taskId: task.id, attemptId: repair.id, kind: "repair_complete",
    summary: "Removed the wrong annotation", baseRevision, resultRevision: revision2, changedFiles: ["app.ts"],
  });
  records.transition(task.id, "CHECKING", { result_revision: revision2 });
  writeFileSync(join(repairDir, "gate-0-typecheck.log"), "\n");
  records.recordGate({
    taskId: task.id, attemptId: repair.id, name: "typecheck", status: "PASS", required: true,
    command: "npm run typecheck", toolVersion: "tsc 7.0.2", revision: revision2,
    evidencePath: join(repairDir, "gate-0-typecheck.log"), durationMs: 1700, waiverId: null,
  });
  records.recordCheckpoint({
    taskId: task.id, attemptId: repair.id, kind: "checks_passed", summary: "Required checks passed.", resultRevision: revision2,
  });

  // Attempt 3: review.
  records.transition(task.id, "REVIEWING");
  const review = records.startAttempt({
    taskId: task.id, launchId: "launch-3", kind: "review", adapter: "codex", model: "gpt-5.4",
    worktreePath: worktree, baseRevision,
  });
  const reviewDir = artifactDir(task.id, review.id);
  writeFileSync(join(reviewDir, "review.json"), JSON.stringify({ verdict: "approved" }));
  records.finishAttempt({ attemptId: review.id, state: "succeeded", outcome: "completed", resultRevision: revision2 });
  records.recordReview({
    taskId: task.id, attemptId: review.id, revision: revision2, verdict: "approved",
    summary: "Correct and in scope", findings: ["consider a test"], blockingFindings: [],
    advisoryFindings: ["consider a test"], requirementsChecked: [], evidencePath: join(reviewDir, "review.json"),
  });
  records.recordCheckpoint({
    taskId: task.id, attemptId: review.id, kind: "review_approved", summary: "Review approved", resultRevision: revision2,
  });
  records.transition(task.id, "DONE");
  records.updateTaskFields(task.id, {
    worktree_path: worktree, branch: `mabs/${task.id}`, base_revision: baseRevision, result_revision: revision2,
  });

  return {
    root, repo, records, projectId: project.id, taskId: task.id,
    attempts: { initial: initial.id, repair: repair.id, review: review.id },
    worktree, baseRevision,
    close: () => {
      records.store.close();
      delete process.env.MABS_DB_PATH;
      delete process.env.MABS_STATE_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("acceptance: every surface reports the same lifecycle, and a retry hides nothing", async () => {
  const world = await buildWorld();
  try {
    // --- Tasks: the whole history is present and the retry did not overwrite it.
    const snapshot = buildProgressSnapshot(world.records, { withSteps: true });
    const row = snapshot.tasks[0];
    assert.ok(row);
    assert.equal(row.state, "DONE");
    assert.equal(row.group, "completed");
    assert.equal(snapshot.counts.completed, 1);

    const kinds = row.steps.map((step) => step.kind);
    assert.deepEqual(kinds, [
      "initial_attempt", "implementation_complete", "check:typecheck", "checks_failed",
      "repair_attempt", "repair_complete", "check:typecheck", "checks_passed",
      "review_attempt", "review:approved", "review_approved",
    ]);
    const checks = row.steps.filter((step) => step.kind === "check:typecheck");
    assert.deepEqual(checks.map((step) => step.status), ["failed", "completed"]);
    assert.deepEqual(checks.map((step) => step.attemptNumber), [1, 2]);

    // The review ran on a different provider, and that is reported, not smoothed over.
    assert.equal(row.provider, "codex");
    assert.ok(row.steps.some((step) => step.summary.includes("claude")));

    // Completion is not delivery.
    assert.equal(row.delivery, "not requested");
    assert.equal(row.review?.verdict, "approved");
    assert.equal(row.checks.filter((check) => check.status === "PASS").length, 1);

    const frame = renderDashboard(snapshot, reconcileView(snapshot, { ...INITIAL_VIEW, expanded: true }));
    assert.match(frame, /DONE/);
    assert.match(frame, /delivery: not requested/);
    assert.doesNotMatch(frame, /% complete|remaining/i);

    // --- Code: the task's own content, and its changes against the base.
    const opened = await openFile(world.records, "app.ts", { task: world.taskId });
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    assert.equal(opened.content.text, "export const value = 2;\n");

    const changes = await taskChanges(world.records, { task: world.taskId });
    assert.equal(changes.kind, "changes");
    if (changes.kind !== "changes") return;
    assert.deepEqual(changes.files.map((file) => file.path), ["app.ts"]);
    assert.deepEqual(changes.files[0]?.categories, ["committed"]);

    // Selecting the earlier attempt shows that attempt's revision, not the latest.
    const earlier = await openFile(world.records, "app.ts", { task: world.taskId, attempt: world.attempts.initial });
    assert.equal(earlier.kind, "opened");
    if (earlier.kind !== "opened") return;
    assert.equal(earlier.attemptId, world.attempts.initial);

    // --- Logs: both attempts' evidence is reachable, and steps point at it.
    const evidence = listEvidence(world.records, { taskId: world.taskId });
    const ids = new Set(evidence.entries.map((entry) => entry.id));
    for (const ref of row.steps.flatMap((step) => step.evidenceRefs)) {
      assert.ok(ids.has(ref), `${ref} is not openable from the Logs surface`);
    }
    const failedCheck = evidence.entries.find((entry) => entry.label.startsWith("typecheck FAIL"));
    assert.ok(failedCheck?.exists, "the failing check's output was lost");
    assert.match(readChunk(failedCheck.path, { offset: 0 }).lines.join("\n"), /error TS2322/);

    const firstTranscript = evidence.entries.find((entry) => entry.id === `transcript:${world.attempts.initial}`);
    assert.deepEqual(readChunk(String(firstTranscript?.path), { offset: 0 }).lines, [
      "attempt 1: editing app.ts", "attempt 1: done",
    ]);

    // --- Agent: the failing check summarizes as a failure, from the recorded output.
    const summary = summarizeExecution({
      tool: "bash", command: "npm run typecheck", exitCode: 2, durationMs: 1800,
      output: readChunk(failedCheck.path, { offset: 0 }).lines.join("\n"),
    });
    assert.equal(summary.tone, "failure");
    assert.match(summary.headline, /^Failed: typecheck returned 1 error/);
  } finally {
    world.close();
  }
});

test("acceptance: a cancelled worker reports the real outcome and keeps its evidence", async () => {
  const world = await buildWorld();
  try {
    const { records, taskId } = world;
    const cancelled = records.startAttempt({
      taskId, launchId: "launch-4", kind: "repair", adapter: "claude", model: "claude-opus-5",
    });
    const dir = artifactDir(taskId, cancelled.id);
    writeFileSync(join(dir, "worker.log"), "attempt 4: started\nattempt 4: partway through\n");
    records.finishAttempt({ attemptId: cancelled.id, state: "cancelled", reason: "operator cancelled" });

    const snapshot = buildProgressSnapshot(records, { withSteps: true });
    const step = snapshot.tasks[0]?.steps.find((item) => item.attemptId === cancelled.id);
    // Cancelled is never reported as completed.
    assert.equal(step?.status, "failed");
    assert.match(String(step?.detail), /operator cancelled/);

    // Its partial evidence is retained.
    const evidence = listEvidence(records, { taskId, attemptId: cancelled.id });
    const transcript = evidence.entries.find((entry) => entry.kind === "worker-transcript");
    assert.equal(transcript?.exists, true);
    assert.deepEqual(readChunk(String(transcript?.path), { offset: 0 }).lines, [
      "attempt 4: started", "attempt 4: partway through",
    ]);

    // And the compact view of that execution says so.
    const compact = summarizeExecution({ tool: "bash", command: "npm run repair", cancelled: true, durationMs: 4200, output: "partway through" });
    assert.match(compact.headline, /^Interrupted:/);
    assert.equal(compact.tone, "failure");
  } finally {
    world.close();
  }
});

test("acceptance: removing the worktree keeps inspection honest across every surface", async () => {
  const world = await buildWorld();
  try {
    await git(world.repo, ["worktree", "remove", "--force", world.worktree]);

    // Code falls back to the recorded revision and says so.
    const opened = await openFile(world.records, "app.ts", { task: world.taskId });
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    assert.equal(opened.view, "revision");
    assert.equal(opened.content.source, "revision");
    assert.equal(opened.content.text, "export const value = 2;\n");
    assert.match(String(opened.viewReason), /no longer present/);

    // Tasks and Logs are unaffected: they read records, not the worktree.
    const snapshot = buildProgressSnapshot(world.records, { withSteps: true });
    assert.equal(snapshot.tasks[0]?.state, "DONE");
    assert.equal(snapshot.tasks[0]?.steps.length, 11);
    const evidence = listEvidence(world.records, { taskId: world.taskId });
    assert.ok(evidence.entries.filter((entry) => entry.exists).length >= 4);
  } finally {
    world.close();
  }
});

test("acceptance: repeated reads never mutate task authority", async () => {
  const world = await buildWorld();
  try {
    const before = world.records.getTask(world.taskId);
    const beforeEvents = world.records.listEvents(world.taskId).length;
    const beforeAttempts = world.records.listAttempts(world.taskId).length;

    for (let index = 0; index < 3; index += 1) {
      buildProgressSnapshot(world.records, { withSteps: true });
      listEvidence(world.records, { taskId: world.taskId });
      await taskChanges(world.records, { task: world.taskId });
      await openFile(world.records, "app.ts", { task: world.taskId });
    }

    assert.deepEqual(world.records.getTask(world.taskId), before);
    assert.equal(world.records.listEvents(world.taskId).length, beforeEvents);
    assert.equal(world.records.listAttempts(world.taskId).length, beforeAttempts);
    // No approval was created by looking at delivery state.
    assert.equal(world.records.listApprovals().length, 0);
  } finally {
    world.close();
  }
});
