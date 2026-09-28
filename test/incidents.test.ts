import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { analyzeProject, curatorRecommendations, suggestProjectConfig } from "../src/curator/service.ts";
import { lessonsForTask } from "../src/incidents/lessons.ts";
import { importIncidentHistory, normalizeSymptom, projectIncidents } from "../src/incidents/projection.ts";
import { Store } from "../src/store/db.ts";
import { Records, type Task } from "../src/store/records.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-incidents-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = join(root, "state");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const project = records.createProject({ name: "learn", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const task = (title = "t") => records.createTask({ projectId: project.id, title, objective: "o", acceptanceCriteria: ["c"] });
  const failedAttempt = (owner: Task, reason: string, failureClass: "CODE" | "CONFIG" | "QUOTA" = "CODE", endedAt?: string) => {
    const attempt = records.startAttempt({ taskId: owner.id, launchId: `lnc_${Math.random().toString(16).slice(2)}`, kind: "initial", adapter: "codex" });
    records.finishAttempt({ attemptId: attempt.id, state: "failed", failureClass, reason, exitStatus: failureClass === "CODE" ? 1 : 127 });
    if (endedAt) records.store.run("UPDATE attempts SET ended_at = ? WHERE id = ?", endedAt, attempt.id);
    return attempt;
  };
  return { root, records, project, task, failedAttempt };
}

const snapshot = (records: Records) => JSON.stringify({
  attempts: records.store.all("SELECT * FROM attempts ORDER BY id"),
  gates: records.store.all("SELECT * FROM gate_results ORDER BY id"),
  checkpoints: records.store.all("SELECT * FROM task_checkpoints ORDER BY id"),
});

test("symptoms group across ids, paths, times, and counts", () => {
  assert.equal(
    normalizeSymptom("sh: /home/a/worktrees/prj_01M3A8VTYT9HPM31GQV636BW0N/node_modules/.bin/tsc: not found (att_01M3J3FYPS7PZ1AEXFVFVTJDMV)"),
    normalizeSymptom("sh: /tmp/other/place/node_modules/.bin/tsc: not found (att_01M3J3G6DC1AZ6Y4FQS0NNZYY0)"),
  );
  assert.equal(normalizeSymptom("try again at 4:34 PM"), normalizeSymptom("try again at 11:02 am"));
});

test("LRN-01: historical import is idempotent, copied checkpoint prose is one occurrence, and sources are unchanged", (t) => {
  const { records, task, failedAttempt } = setup(t);
  const first = task("first");
  const second = task("second");
  const a1 = failedAttempt(first, "sh: 1: tsc: not found", "CODE");
  failedAttempt(second, "sh: 1: tsc: not found", "CODE");
  // The same failure text copied into several checkpoints is not more evidence.
  for (let copy = 0; copy < 3; copy += 1) {
    records.recordCheckpoint({ taskId: first.id, attemptId: a1.id, kind: "attempt_failed", summary: "CODE: sh: 1: tsc: not found", findings: ["sh: 1: tsc: not found"] });
  }
  const before = snapshot(records);

  const dryRun = importIncidentHistory(records, { dryRun: true });
  assert.equal(records.listIncidents().length, 0, "a dry run writes nothing");
  assert.equal(dryRun.newOccurrences, 2);

  const firstImport = importIncidentHistory(records, { dryRun: false });
  const again = importIncidentHistory(records, { dryRun: false });
  assert.equal(firstImport.newOccurrences, 2);
  assert.equal(again.newOccurrences, 0);
  assert.equal(again.existingOccurrences, 2);
  const incidents = records.listIncidents();
  assert.equal(incidents.length, 1, "one signature across tasks and copies");
  assert.equal(incidents[0]?.category, "environment");
  assert.equal(records.incidentOccurrences(incidents[0]?.id as string).length, 2);
  assert.equal(snapshot(records), before, "source evidence is never rewritten");
});

test("a task's own product-code defect is an obligation, not an incident", (t) => {
  const { records, task, failedAttempt } = setup(t);
  failedAttempt(task(), "AssertionError [ERR_ASSERTION]: expected 2 to equal 3\n    at test/value.test.ts:4:10", "CODE");
  assert.deepEqual(projectIncidents(records), []);
});

test("a failing environment gate is projected from its evidence", (t) => {
  const { root, records, task } = setup(t);
  const owner = task();
  mkdirSync(join(root, "evidence"), { recursive: true });
  const evidencePath = join(root, "evidence", "gate.log");
  writeFileSync(evidencePath, "$ npm run typecheck\nsh: 1: tsc: not found\n");
  records.recordGate({
    taskId: owner.id, attemptId: null, name: "typecheck", status: "ERROR", required: true, command: "npm run typecheck",
    toolVersion: null, revision: "abc", evidencePath, durationMs: 5, waiverId: null, rawExitStatus: 127,
  });
  const [item] = projectIncidents(records);
  assert.equal(item?.category, "environment");
  assert.equal(item?.layer, "check");
});

test("LRN-02: retrieval labels hypotheses and verified lessons; verification needs fix and test evidence", (t) => {
  const { records, task, failedAttempt } = setup(t);
  const owner = task();
  failedAttempt(owner, "sh: 1: tsc: not found", "CONFIG");
  importIncidentHistory(records, { dryRun: false });
  const [incident] = records.listIncidents();
  assert.ok(incident);
  const [hypothesis] = lessonsForTask(records, owner, "implementation");
  assert.equal(hypothesis?.status, "hypothesis");
  assert.match(hypothesis?.text ?? "", /^\[hypothesis, (low|medium) confidence, unverified\]/);
  assert.doesNotMatch(hypothesis?.text ?? "", /\[verified\]/);

  assert.throws(() => records.updateIncident(incident.id, { confidence: "verified", confirmedCause: "no local typescript" }, "owner"),
    /requires a confirmed cause, a fix reference, and a test reference/);
  assert.throws(() => records.updateIncident(incident.id, { lifecycle: "resolved" }, "owner"), /Only a verified lesson/);
  records.updateIncident(incident.id, {
    confirmedCause: "Worktrees had no node_modules; typecheck resolved tsc from PATH.",
    confidence: "verified", lifecycle: "resolved", fixRefs: ["commit:cb484b9"], testRefs: ["test/environment-preflight.test.ts"],
  }, "owner");
  const [verified] = lessonsForTask(records, owner, "implementation");
  assert.equal(verified?.status, "verified");
  assert.match(verified?.text ?? "", /^\[verified\].*cause: Worktrees had no node_modules/);

  records.updateIncident(incident.id, { lifecycle: "superseded" }, "owner");
  assert.deepEqual(lessonsForTask(records, owner, "implementation"), [], "superseded lessons are never retrieved");
  assert.ok(lessonsForTask(records, owner, "implementation", 10).length <= 3);
});

test("LRN-03: the same signature after a verified fix reopens the incident as a recurrence", (t) => {
  const { records, task, failedAttempt } = setup(t);
  const owner = task();
  failedAttempt(owner, "sh: 1: tsc: not found", "CONFIG", "2026-09-01T00:00:00.000Z");
  importIncidentHistory(records, { dryRun: false });
  const [incident] = records.listIncidents();
  records.updateIncident(incident?.id as string, {
    confirmedCause: "missing local compiler", confidence: "verified", lifecycle: "resolved", fixRefs: ["fix"], testRefs: ["test"],
  }, "owner");
  // Re-importing the old occurrence is not a recurrence.
  importIncidentHistory(records, { dryRun: false });
  assert.equal(records.getIncident(incident?.id as string)?.lifecycle, "resolved");

  failedAttempt(task("later"), "sh: 1: tsc: not found", "CONFIG");
  importIncidentHistory(records, { dryRun: false });
  const reopened = records.getIncident(incident?.id as string);
  assert.equal(reopened?.lifecycle, "open");
  assert.equal(reopened?.confidence, "medium", "a recurrence withdraws the verified status");
  assert.equal(records.store.all("SELECT * FROM events WHERE kind = 'incident.recurred'").length, 1);
});

test("LRN-04: missing-compiler incidents get an environment remedy, not a bigger implementation prompt", (t) => {
  const { records, project, task, failedAttempt } = setup(t);
  for (let index = 0; index < 3; index += 1) failedAttempt(task(`t${index}`), `sh: 1: tsc: not found (run ${index})`, "CODE");
  const configBefore = records.getProject(project.id)?.configVersion;
  const signals = analyzeProject(records, project.id);
  assert.equal(signals.failuresByClass.CODE, 3, "the historical label is retained as recorded");
  assert.equal(signals.productCodeFailures, 0, "re-diagnosis finds no product-code failures");
  assert.equal(signals.incidentsByCategory?.environment, 3);
  assert.throws(() => suggestProjectConfig(records, project.id, signals), /No recurring evidence/);

  const recommendations = curatorRecommendations(records, project.id);
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0]?.mechanism, "environment_setup");
  assert.equal(recommendations[0]?.lessonStatus, "not_imported");
  assert.equal(recommendations[0]?.occurrences, 3);
  assert.equal(recommendations[0]?.evidence.length, 3);
  assert.equal(records.getProject(project.id)?.configVersion, configBefore, "recommendations never change configuration");
  assert.equal(records.listCuratorProposals(project.id).length, 0, "and never create or activate a proposal");
});

test("genuine product-code failures still justify implementation guidance", (t) => {
  const { records, project, task, failedAttempt } = setup(t);
  failedAttempt(task(), "AssertionError [ERR_ASSERTION]: expected 2 to equal 3", "CODE");
  const signals = analyzeProject(records, project.id);
  assert.equal(signals.productCodeFailures, 1);
  const suggestion = suggestProjectConfig(records, project.id, signals);
  assert.ok(suggestion.config.promptProfile.implementationAddendum);
  assert.match(suggestion.reasons.join(), /1 product-code or contract failure/);
});
