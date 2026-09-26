import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditExecutionHistory,
  normalizeHistoricalUsage,
  type HistoryAuditReport,
} from "../src/diagnostics/history.ts";
import { Store } from "../src/store/db.ts";
import { runHistoryAuditCli } from "../scripts/audit-execution-history.ts";

interface TaskFixture {
  ref: string;
  project_id: string;
  id: string;
  attempts: number;
  reviews: number;
  change_requests: number;
  retries: number;
  gates: number;
  checkpoints: number;
}

interface SummaryFixture {
  expected: Record<string, number | Record<string, number>>;
  cohorts: Array<{
    project_id: string;
    project_name: string;
    known_input_events: number;
    known_output_tokens: number;
    missing_usage_attempts: number;
    elapsed_milliseconds: number;
  }>;
  tasks: TaskFixture[];
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/execution-history/${name}`, import.meta.url), "utf8")) as T;
}

function createHistoricalDatabase(path: string): SummaryFixture {
  const summary = fixture<SummaryFixture>("cohort-summary.json");
  const codex = fixture<{ usage_json: Record<string, number> }>("codex-usage-cached-subset.json");
  const claude = fixture<{ usage_json: Record<string, number> }>("claude-usage-separate-cache.json");
  const store = new Store(path);
  const at = "2026-09-25T09:57:19.347Z";
  for (const cohort of summary.cohorts) {
    store.run(
      `INSERT INTO projects(id, name, repo_path, config_version, created_at, updated_at)
       VALUES(?, ?, ?, 'cfg_fixture', ?, ?)`,
      cohort.project_id, cohort.project_name, `/sanitized/${cohort.project_id}`, at, at,
    );
  }

  let globalAttempt = 0;
  let globalGate = 0;
  for (const task of summary.tasks) {
    store.run(
      `INSERT INTO tasks(id, project_id, title, objective, state, created_at, updated_at)
       VALUES(?, ?, ?, 'sanitized historical fixture', 'DONE', ?, ?)`,
      task.id, task.project_id, task.ref, at, at,
    );
    const attemptIds: string[] = [];
    for (let index = 0; index < task.attempts; index += 1) {
      const id = `att_fixture_${String(globalAttempt).padStart(3, "0")}`;
      attemptIds.push(id);
      const isStudy = task.project_id === "prj_fixture_study";
      const cohortAttempt = summary.tasks
        .filter((candidate) => candidate.project_id === task.project_id && summary.tasks.indexOf(candidate) < summary.tasks.indexOf(task))
        .reduce((total, candidate) => total + candidate.attempts, 0) + index;
      const missing = !isStudy && cohortAttempt >= 16;
      const usage = missing
        ? null
        : JSON.stringify(cohortAttempt === 0 ? (isStudy ? claude.usage_json : codex.usage_json) : {
          input_tokens: 0,
          output_tokens: 0,
          ...(isStudy ? { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : { cached_input_tokens: 0 }),
        });
      const duration = cohortAttempt === 0
        ? summary.cohorts.find((cohort) => cohort.project_id === task.project_id)!.elapsed_milliseconds
        : 0;
      const started = Date.UTC(2026, 8, 20) + globalAttempt * 20_000_000;
      store.run(
        `INSERT INTO attempts(
           id, task_id, launch_id, attempt_number, adapter, state, usage_json, output_path, started_at, ended_at
         ) VALUES(?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
        id, task.id, `launch_fixture_${globalAttempt}`, index + 1, isStudy ? "claude" : "codex", usage,
        globalAttempt === 0 ? "/sanitized/artifact-that-is-not-committed" : null,
        new Date(started).toISOString(), new Date(started + duration).toISOString(),
      );
      globalAttempt += 1;
    }
    for (let index = 0; index < task.reviews; index += 1) {
      store.run(
        `INSERT INTO review_results(
           id, task_id, attempt_id, revision, verdict, summary, created_at
         ) VALUES(?, ?, ?, ?, ?, 'sanitized review', ?)`,
        `review_fixture_${task.ref}_${index}`, task.id, attemptIds[index % attemptIds.length], `revision_${task.ref}_${index}`,
        index < task.change_requests ? "request_changes" : "approved", at,
      );
    }
    for (let index = 0; index < task.retries; index += 1) {
      store.run(
        `INSERT INTO events(id, at, project_id, task_id, kind) VALUES(?, ?, ?, ?, 'task.retry_requested')`,
        `event_fixture_${task.ref}_${index}`, at, task.project_id, task.id,
      );
    }
    for (let index = 0; index < task.gates; index += 1) {
      const status = globalGate < 37 ? "PASS" : globalGate === 37 ? "FAIL" : "ERROR";
      store.run(
        `INSERT INTO gate_results(id, task_id, name, status, command, revision, created_at)
         VALUES(?, ?, 'fixture-gate', ?, 'fixture-only', 'fixture-revision', ?)`,
        `gate_fixture_${globalGate}`, task.id, status, at,
      );
      globalGate += 1;
    }
    for (let index = 0; index < task.checkpoints; index += 1) {
      store.run(
        `INSERT INTO task_checkpoints(id, task_id, kind, summary, created_at)
         VALUES(?, ?, 'fixture', 'sanitized checkpoint', ?)`,
        `checkpoint_fixture_${task.ref}_${index}`, task.id, at,
      );
    }
  }
  const feedbackTask = summary.tasks[0]!;
  store.run(
    `INSERT INTO feedback(
       id, project_id, task_id, kind, body, state, submitted_for_version, created_by, created_at
     ) VALUES('feedback_fixture', ?, ?, 'request_change', 'sanitized', 'applied', 1, 'fixture', ?)`,
    feedbackTask.project_id, feedbackTask.id, at,
  );
  store.close();
  return summary;
}

test("historical usage fixtures preserve provider cache semantics", () => {
  const codex = fixture<{ adapter: string; usage_json: unknown; expected: Record<string, number> }>("codex-usage-cached-subset.json");
  const claude = fixture<{ adapter: string; usage_json: unknown; expected: Record<string, number> }>("claude-usage-separate-cache.json");
  const codexUsage = normalizeHistoricalUsage(codex.adapter, codex.usage_json);
  const claudeUsage = normalizeHistoricalUsage(claude.adapter, claude.usage_json);
  assert.equal(codexUsage.knownInputEvents, codex.expected.known_input_events);
  assert.equal(codexUsage.outputTokens, codex.expected.known_output_tokens);
  assert.equal(claudeUsage.knownInputEvents, claude.expected.known_input_events);
  assert.equal(claudeUsage.outputTokens, claude.expected.known_output_tokens);
  assert.equal(normalizeHistoricalUsage("codex", null).coverage, "missing");
  assert.equal(normalizeHistoricalUsage("codex", {}).coverage, "missing");
  assert.equal(normalizeHistoricalUsage("codex", "not-json").coverage, "malformed");
});

test("read-only historical audit reproduces all counts and leaves missing evidence explicit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-history-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "history.sqlite");
  const summary = createHistoricalDatabase(dbPath);
  const before = readFileSync(dbPath);

  const report = auditExecutionHistory({ dbPath, observedAt: "2026-09-25T09:57:19.347631+00:00" });
  assert.equal(report.totals.tasks, summary.expected.tasks);
  assert.equal(report.totals.attempts, summary.expected.attempts);
  assert.equal(report.totals.reviews, summary.expected.reviews);
  assert.equal(report.totals.reviewChangeRequests, summary.expected.review_change_requests);
  assert.equal(report.totals.retries, summary.expected.retries);
  assert.equal(report.totals.gates, summary.expected.gates);
  assert.deepEqual(report.totals.gateStatuses, summary.expected.gate_statuses);
  assert.equal(report.totals.checkpoints, summary.expected.checkpoints);
  assert.equal(report.totals.appliedRequestChanges, summary.expected.applied_request_changes);
  assert.equal(report.totals.curatorProposals, 0);
  assert.equal(report.totals.optimizationExperiments, 0);
  assert.equal(report.usage.knownInputEvents, summary.expected.known_input_events);
  assert.equal(report.usage.knownOutputTokens, summary.expected.known_output_tokens);
  assert.equal(report.usage.missingUsageAttempts.length, summary.expected.missing_usage_attempts);
  assert.equal(report.usage.elapsedMilliseconds, summary.expected.elapsed_milliseconds);
  assert.equal(report.tasks.length, 9);
  for (const expected of summary.tasks) {
    const task = report.tasks.find((candidate) => candidate.taskId === expected.id);
    assert.ok(task);
    assert.deepEqual(
      [task.attempts, task.reviews, task.reviewChangeRequests, task.retries],
      [expected.attempts, expected.reviews, expected.change_requests, expected.retries],
    );
  }
  assert.ok(report.artifactGaps.some((gap) => gap.status === "missing"));
  assert.ok(report.artifactGaps.some((gap) => gap.status === "not-recorded"));
  assert.deepEqual(readFileSync(dbPath), before, "audit must not change even the SQLite source bytes");

  const readOnly = Store.openReadOnly(dbPath);
  assert.equal(readOnly.readOnly, true);
  assert.throws(() => readOnly.run("UPDATE tasks SET title = 'mutated'"), /read-only|readonly/i);
  readOnly.close();
});

test("audit CLI requires an explicit source and writes a new report only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-history-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "history.sqlite");
  const reportPath = join(root, "report.json");
  createHistoricalDatabase(dbPath);
  assert.throws(() => runHistoryAuditCli([]), /Usage:/);
  assert.equal(
    runHistoryAuditCli(["--db", dbPath, "--read-only", "--output", reportPath]),
    reportPath,
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as HistoryAuditReport;
  assert.equal(report.source.access, "read-only");
  assert.equal(report.totals.tasks, 9);
  assert.throws(
    () => runHistoryAuditCli(["--db", dbPath, "--read-only", "--output", reportPath]),
    /already exists/,
  );
});
