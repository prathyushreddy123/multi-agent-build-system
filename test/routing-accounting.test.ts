import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { routingOutcomes, type RoutingOutcome } from "../src/optimization/routing.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";

interface AttemptFixture {
  id: string;
  taskId: string;
  kind: "initial" | "repair" | "review";
  adapter: string;
  model: string;
  state: "succeeded" | "failed" | "running";
  baseRevision?: string | null;
  resultRevision?: string | null;
  usage?: unknown;
  startedAt: string;
  endedAt?: string | null;
}

function at(minute: number, second = 0): string {
  return new Date(Date.UTC(2026, 8, 20, 0, minute, second)).toISOString();
}

/**
 * Historical attempts are inserted directly with their recorded revisions,
 * timestamps, and raw usage. The controller writes these rows during live
 * execution; this suite exercises the read-side accounting over them.
 */
function insertAttempt(records: Records, index: number, fixture: AttemptFixture): void {
  records.store.run(
    `INSERT INTO attempts(id, task_id, launch_id, attempt_number, kind, adapter, model, state,
       base_revision, result_revision, usage_json, started_at, ended_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fixture.id,
    fixture.taskId,
    `launch_${fixture.id}`,
    index + 1,
    fixture.kind,
    fixture.adapter,
    fixture.model,
    fixture.state,
    fixture.baseRevision ?? null,
    fixture.resultRevision ?? null,
    fixture.usage === undefined || fixture.usage === null ? null : JSON.stringify(fixture.usage),
    fixture.startedAt,
    fixture.endedAt ?? null,
  );
}

function setup(t: TestContext) {
  const records = new Records(new Store(":memory:"));
  t.after(() => records.store.close());
  const project = records.createProject({
    name: "routing-accounting",
    repoPath: "/tmp/routing-accounting",
    projectType: "personal",
    reviewChoice: "off",
  });
  const task = (title: string) => records.createTask({ projectId: project.id, title, objective: title }).id;
  const accept = (taskId: string, revision: string) =>
    records.store.run("UPDATE tasks SET state = 'DONE', result_revision = ? WHERE id = ?", revision, taskId);

  const handoff = task("handoff");
  const superseded = task("superseded");
  const reviewed = task("reviewed");
  const running = task("still running");

  const attempts: AttemptFixture[] = [
    // The task was accepted, but this route failed and another provider finished it.
    { id: "att_1", taskId: handoff, kind: "initial", adapter: "codex", model: "gpt-5.6-sol", state: "failed", startedAt: at(0), endedAt: at(0, 5) },
    { id: "att_2", taskId: handoff, kind: "initial", adapter: "claude", model: "claude-opus-5", state: "succeeded",
      resultRevision: "rev-handoff", startedAt: at(1), endedAt: at(1, 7),
      usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 2 } },
    // This route succeeded, but its revision was superseded by a repair.
    { id: "att_3", taskId: superseded, kind: "initial", adapter: "codex", model: "gpt-5.6-sol", state: "succeeded",
      resultRevision: "rev-superseded-a", startedAt: at(2), endedAt: at(2, 4),
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } },
    { id: "att_4", taskId: superseded, kind: "repair", adapter: "claude", model: "claude-opus-5", state: "succeeded",
      resultRevision: "rev-superseded-b", startedAt: at(3), endedAt: at(3, 6) },
    { id: "att_5", taskId: reviewed, kind: "initial", adapter: "codex", model: "gpt-5.6-sol", state: "succeeded",
      resultRevision: "rev-reviewed", startedAt: at(4), endedAt: at(4, 2),
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    // A review of the accepted revision, and a review of a revision that was replaced.
    { id: "att_6", taskId: reviewed, kind: "review", adapter: "claude", model: "claude-opus-5", state: "succeeded",
      baseRevision: "rev-reviewed", startedAt: at(5), endedAt: at(5, 3) },
    { id: "att_7", taskId: handoff, kind: "review", adapter: "claude", model: "claude-opus-5", state: "succeeded",
      baseRevision: "rev-handoff-draft", startedAt: at(6), endedAt: at(6, 1) },
    { id: "att_8", taskId: running, kind: "initial", adapter: "codex", model: "gpt-5.6-sol", state: "running", startedAt: at(7) },
  ];
  for (const [index, fixture] of attempts.entries()) insertAttempt(records, index, fixture);

  records.store.run(
    `INSERT INTO review_results(id, task_id, attempt_id, revision, verdict, summary, created_at)
     VALUES('rev_approved', ?, 'att_6', 'rev-reviewed', 'approved', 'fixture', ?)`,
    reviewed, at(5, 4),
  );
  records.store.run(
    `INSERT INTO review_results(id, task_id, attempt_id, revision, verdict, summary, created_at)
     VALUES('rev_changes', ?, 'att_7', 'rev-handoff-draft', 'request_changes', 'fixture', ?)`,
    handoff, at(6, 2),
  );

  accept(handoff, "rev-handoff");
  accept(superseded, "rev-superseded-b");
  accept(reviewed, "rev-reviewed");

  const outcomes = routingOutcomes(records, project.id);
  const group = (role: string, adapter: string): RoutingOutcome => {
    const found = outcomes.find((item) => item.role === role && item.adapter === adapter);
    assert.ok(found, `expected a ${role} group for ${adapter}`);
    return found;
  };
  return { records, project, outcomes, group };
}

test("a failed or superseded route is credited with contribution, not acceptance", (t) => {
  const { outcomes, group } = setup(t);
  const codex = group("implementation", "codex");
  const claude = group("implementation", "claude");

  // codex failed one accepted task and had its revision replaced on another.
  assert.equal(codex.attempts, 4);
  assert.equal(codex.succeededAttempts, 2);
  assert.equal(codex.failures, 1);
  assert.equal(codex.tasks, 4);
  assert.equal(codex.acceptedTasks, 1);
  assert.equal(codex.contributedTasks, 2);
  assert.equal(codex.unverifiedAcceptedTasks, 0);

  assert.equal(claude.acceptedTasks, 2);
  assert.equal(claude.contributedTasks, 0);
  assert.equal(claude.repairs, 1);
  assert.equal(claude.failures, 0);

  // Three tasks were accepted, so the implementation routes must add up to three
  // acceptances in total rather than each claiming the same delivered work.
  const implementationAccepted = outcomes
    .filter((outcome) => outcome.role === "implementation")
    .reduce((total, outcome) => total + outcome.acceptedTasks, 0);
  assert.equal(implementationAccepted, 3);
});

test("review accounting follows the reviewed revision and keeps change requests", (t) => {
  const { group } = setup(t);
  const review = group("review", "claude");
  assert.equal(review.attempts, 2);
  // The review of the accepted revision counts; the review of the replaced
  // revision contributed but did not review the accepted work.
  assert.equal(review.acceptedTasks, 1);
  assert.equal(review.contributedTasks, 1);
  assert.equal(review.reviewChangeRequests, 1);
  assert.equal(review.usageCoverage, "missing");
  assert.equal(review.reportedInputTokens, null);
  assert.equal(review.reportedOutputTokens, null);
});

test("route duration comes from recorded ended_at and separates running attempts", (t) => {
  const { group } = setup(t);
  const codex = group("implementation", "codex");
  const claude = group("implementation", "claude");
  const review = group("review", "claude");

  // 5s + 4s + 2s of completed attempts; the running attempt is not a duration.
  assert.equal(codex.executionMs, 11_000);
  assert.equal(codex.measuredDurationAttempts, 3);
  assert.equal(codex.runningDurationAttempts, 1);
  assert.equal(codex.missingDurationAttempts, 0);
  assert.equal(codex.invalidDurationAttempts, 0);
  assert.equal(claude.executionMs, 13_000);
  assert.equal(review.executionMs, 4_000);
});

test("route usage keeps provider semantics, coverage, and measured zeros", (t) => {
  const { group } = setup(t);
  const codex = group("implementation", "codex");
  const claude = group("implementation", "claude");

  // codex: 100 input events with a 40-token cached subset that is not added
  // again, plus one measured zero, plus two attempts with no usage at all.
  assert.equal(codex.reportedInputTokens, 100);
  assert.equal(codex.reportedOutputTokens, 20);
  assert.equal(codex.reportedUsageAttempts, 2);
  assert.equal(codex.completeUsageAttempts, 2);
  assert.equal(codex.missingUsageAttempts, 2);
  assert.equal(codex.malformedUsageAttempts, 0);
  assert.equal(codex.usageCoverage, "partial");
  assert.deepEqual(codex.usageConflicts, []);

  // claude: cache-read and cache-creation are separate reported input events.
  assert.equal(claude.reportedInputTokens, 16);
  assert.equal(claude.reportedOutputTokens, 2);
  assert.equal(claude.reportedUsageAttempts, 1);
  assert.equal(claude.missingUsageAttempts, 1);
  assert.equal(claude.usageCoverage, "partial");
});

test("malformed provider usage is reported separately from missing usage", (t) => {
  const { records, project } = setup(t);
  const task = records.createTask({ projectId: project.id, title: "malformed", objective: "malformed" });
  insertAttempt(records, 8, {
    id: "att_9", taskId: task.id, kind: "initial", adapter: "codex", model: "gpt-5.6-sol",
    state: "failed", startedAt: at(8), endedAt: at(8, 1),
  });
  records.store.run("UPDATE attempts SET usage_json = 'not-json' WHERE id = 'att_9'");

  const codex = routingOutcomes(records, project.id)
    .find((outcome) => outcome.role === "implementation" && outcome.adapter === "codex");
  assert.ok(codex);
  assert.equal(codex.malformedUsageAttempts, 1);
  assert.equal(codex.missingUsageAttempts, 2);
  // A malformed envelope neither adds to nor erases the known subtotal.
  assert.equal(codex.reportedInputTokens, 100);
});

test("an unmatched accepted revision is flagged instead of silently credited", (t) => {
  const { records, project } = setup(t);
  const task = records.createTask({ projectId: project.id, title: "legacy", objective: "legacy" });
  insertAttempt(records, 9, {
    id: "att_10", taskId: task.id, kind: "initial", adapter: "legacy-cli", model: "legacy-model",
    state: "succeeded", startedAt: at(9), endedAt: at(9, 2),
  });
  records.store.run("UPDATE tasks SET state = 'DONE' WHERE id = ?", task.id);

  const legacy = routingOutcomes(records, project.id).find((outcome) => outcome.adapter === "legacy-cli");
  assert.ok(legacy);
  assert.equal(legacy.acceptedTasks, 1);
  assert.equal(legacy.unverifiedAcceptedTasks, 1, "no recorded revision ties this attempt to the acceptance");
  assert.equal(legacy.usageCoverage, "missing");
});

test("routing outcomes are scoped to the requested project", (t) => {
  const { records, project, outcomes } = setup(t);
  const other = records.createProject({
    name: "other", repoPath: "/tmp/other", projectType: "personal", reviewChoice: "off",
  });
  const otherTask = records.createTask({ projectId: other.id, title: "other", objective: "other" });
  insertAttempt(records, 10, {
    id: "att_11", taskId: otherTask.id, kind: "initial", adapter: "codex", model: "gpt-5.6-sol",
    state: "succeeded", resultRevision: "rev-other", startedAt: at(10), endedAt: at(10, 3),
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  records.store.run("UPDATE tasks SET state = 'DONE', result_revision = 'rev-other' WHERE id = ?", otherTask.id);

  const scoped = routingOutcomes(records, project.id);
  assert.deepEqual(
    scoped.map((outcome) => [outcome.role, outcome.adapter, outcome.attempts]),
    outcomes.map((outcome) => [outcome.role, outcome.adapter, outcome.attempts]),
  );
  const all = routingOutcomes(records);
  const codexEverywhere = all.filter((outcome) => outcome.adapter === "codex" && outcome.role === "implementation");
  assert.equal(codexEverywhere.reduce((total, outcome) => total + outcome.attempts, 0), 5);
});
