import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactDir } from "../src/core/paths.ts";
import { createBackup, pruneArtifacts, RETENTION_POLICY } from "../src/maintenance/retention.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

test("backup is consistent and retention is dry-run by default", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-maintenance-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = root;
  const records = new Records(new Store(join(root, "mabs.sqlite")));
  t.after(() => {
    try { records.store.close(); } catch { /* already closed */ }
    if (previous === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const project = records.createProject({ name: "backup", repoPath: "/tmp/backup" });
  const task = records.createTask({ projectId: project.id, title: "done", objective: "finish" });
  records.transition(task.id, "READY");
  records.claimTask(task.id, "launch-maintenance");
  records.transition(task.id, "RUNNING");
  const attempt = records.startAttempt({ taskId: task.id, launchId: "launch-maintenance", kind: "initial", adapter: "test" });
  records.finishAttempt({ attemptId: attempt.id, state: "succeeded", outcome: "completed", outputPath: join(root, "old.log") });
  records.transition(task.id, "CHECKING");
  records.transition(task.id, "DONE", { claimed_by: null, claimed_at: null });

  const old = new Date(Date.now() - (RETENTION_POLICY.completedArtifactDays + 1) * 86_400_000).toISOString();
  records.store.run("UPDATE attempts SET ended_at = ? WHERE id = ?", old, attempt.id);
  const evidenceDir = artifactDir(task.id, attempt.id);
  writeFileSync(join(evidenceDir, "worker.log"), "old evidence");

  const preview = pruneArtifacts(records);
  assert.equal(preview.length, 1);
  assert.equal(existsSync(evidenceDir), true, "dry-run must preserve evidence");
  const applied = pruneArtifacts(records, { apply: true });
  assert.equal(applied.length, 1);
  assert.equal(existsSync(evidenceDir), false);
  assert.equal(records.getAttempt(attempt.id)?.outputPath, null);

  const backupPath = await createBackup(records);
  assert.equal(existsSync(backupPath), true);
  const restored = new Records(new Store(backupPath));
  assert.equal(restored.getProject(project.id)?.name, "backup");
  restored.store.close();
});
