import assert from "node:assert/strict";
import test from "node:test";

import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";
import { PROJECT_POLICY_VERSION } from "../src/domain/project-policy.ts";

function records(): Records {
  return new Records(new Store(":memory:"));
}

test("project, task, transition, and event state are stored together", (t) => {
  const db = records();
  t.after(() => db.store.close());

  const project = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "demo", repoPath: "/tmp/demo" });
  db.addRequirement(project.id, "REQ-1", "The result must be durable.");
  const task = db.createTask({
    projectId: project.id,
    title: "Implement durability",
    objective: "Persist state",
    acceptanceCriteria: ["restart-safe"],
  });

  assert.equal(task.state, "QUEUED");
  assert.deepEqual(db.listRequirements(project.id), [
    { id: "REQ-1", text: "The result must be durable.", mandatory: true },
  ]);

  const ready = db.transition(task.id, "READY");
  assert.equal(ready.state, "READY");
  const claimed = db.claimTask(task.id, "launch-1");
  assert.equal(claimed?.claimedBy, "launch-1");
  assert.equal(db.claimTask(task.id, "launch-2"), null);

  const running = db.transition(task.id, "RUNNING", { branch: "mabs/task", base_revision: "abc" });
  assert.equal(running.branch, "mabs/task");
  assert.throws(() => db.transition(task.id, "DONE"), /Invalid task transition/);
  assert.throws(() => db.updateTaskFields(task.id, { state: "DONE" }), /Invalid task field/);

  const stateEvents = db.listEvents(task.id).filter((event) => event.kind === "task.state");
  assert.equal(stateEvents.length, 2);
});

test("dependencies must exist in the same project", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const one = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "one", repoPath: "/tmp/one" });
  const two = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "two", repoPath: "/tmp/two" });
  const upstream = db.createTask({ projectId: one.id, title: "upstream", objective: "first" });

  assert.throws(
    () => db.createTask({ projectId: two.id, title: "downstream", objective: "second", dependsOn: [upstream.id] }),
    /belongs to another project/,
  );
  assert.throws(
    () => db.createTask({ projectId: one.id, title: "bad", objective: "bad", dependsOn: ["missing"] }),
    /Unknown dependency/,
  );
});

test("explicit retries require the current task version", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "retry-demo", repoPath: "/tmp/retry" });
  const task = db.createTask({ projectId: project.id, title: "retry", objective: "recover" });
  const blocked = db.transition(task.id, "BLOCKED", { blocked_reason: "provider unavailable" });
  assert.throws(() => db.retryTask(task.id, task.recordVersion), /changed since/);
  const ready = db.retryTask(task.id, blocked.recordVersion);
  assert.equal(ready.state, "READY");
  assert.equal(ready.blockedReason, null);
  assert.equal(db.listEvents(task.id)[0]?.kind, "task.retry_requested");
});

test("provider capacity persists cooldowns, expiry, and operator resets", (t) => {
  const db = records();
  t.after(() => db.store.close());
  db.configureProvider("codex", 2);
  const cooldown = db.noteProviderFailure("codex", "QUOTA", "usage limit", 60_000);
  assert.equal(cooldown.state, "cooldown");
  assert.equal(cooldown.maxConcurrency, 2);
  db.store.run("UPDATE provider_capacity SET blocked_until = ? WHERE provider = 'codex'", new Date(Date.now() - 1_000).toISOString());
  assert.equal(db.getProviderCapacity("codex")?.state, "available");
  assert.equal(db.noteProviderFailure("codex", "AUTH", "login required").state, "unavailable");
  assert.equal(db.resetProvider("codex").state, "available");
});

test("controller lease excludes peers until released or stale", (t) => {
  const db = records();
  t.after(() => db.store.close());
  assert.equal(db.acquireControllerLease("one", 100, 15_000), true);
  assert.equal(db.acquireControllerLease("two", 200, 15_000), false);
  db.store.run("UPDATE controller_lease SET heartbeat_at = ? WHERE singleton = 1", new Date(Date.now() - 60_000).toISOString());
  assert.equal(db.acquireControllerLease("two", 200, 15_000), true);
  assert.equal(db.currentControllerLease()?.controller_id, "two");
  db.releaseControllerLease("two");
  assert.equal(db.currentControllerLease(), undefined);
});

test("attempts, gates, and revision-bound approvals retain evidence", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "demo", repoPath: "/tmp/demo" });
  const task = db.createTask({ projectId: project.id, title: "change", objective: "change code" });
  db.transition(task.id, "READY");
  db.claimTask(task.id, "launch-1");
  db.transition(task.id, "RUNNING");

  const attempt = db.startAttempt({
    taskId: task.id,
    launchId: "launch-1",
    kind: "initial",
    adapter: "codex",
    model: "gpt-test",
  });
  db.finishAttempt({ attemptId: attempt.id, state: "succeeded", outcome: "completed", exitStatus: 0 });
  assert.equal(db.getAttempt(attempt.id)?.state, "succeeded");

  const gate = db.recordGate({
    taskId: task.id,
    attemptId: attempt.id,
    name: "test",
    status: "PASS",
    required: true,
    command: "npm test",
    toolVersion: "node test",
    revision: "rev-1",
    evidencePath: "/tmp/test.log",
    durationMs: 10,
    waiverId: null,
  });
  assert.equal(gate.required, true);
  assert.equal(gate.status, "PASS");
  assert.equal(db.gatesForRevision(task.id, "rev-1").length, 1);

  const binding = { action: "merge" as const, target: "main", revision: "rev-1", configVersion: project.configVersion };
  const approval = db.requestApproval({ projectId: project.id, taskId: task.id, binding, reason: "ready" });
  assert.throws(() => db.markApprovalConsumed(approval.id), /only an approved decision/);
  db.decideApproval(approval.id, "approved", "owner");
  assert.equal(db.findApprovalFor(task.id, binding)?.id, approval.id);
  db.markApprovalConsumed(approval.id);
  assert.equal(db.getApproval(approval.id)?.state, "consumed");
});

test("governance decisions need the current version and never infer a project type", (t) => {
  const db = records();
  t.after(() => db.store.close());
  // The name looks like client work; classification must still be asked for.
  const project = db.createProject({ name: "Acme client portal", repoPath: "/tmp/acme" });

  assert.equal(project.governance.projectType, null);
  assert.equal(project.governance.decisionState, "unresolved");
  const initial = db.readProjectReadiness(project.id);
  assert.equal(initial.ready, false);
  assert.equal(initial.questions[0]?.key, "project_type");

  assert.throws(() => db.recordProjectDecision({
    projectId: project.id, projectType: "client", reviewChoice: "off", actor: "owner", source: "cli",
  }, 0), /Client projects require/);
  assert.equal(db.getProject(project.id)?.governance.version, 0);

  const decision = db.recordProjectDecision({
    projectId: project.id, projectType: "client", reviewChoice: "required", actor: "owner", source: "cli",
  }, 0);
  assert.equal(decision.projectType, "client");
  assert.equal(decision.expectedVersion, 0);
  assert.equal(db.getProject(project.id)?.governance.version, 1);
  assert.equal(db.getProject(project.id)?.governance.decisionId, decision.id);
  assert.equal(db.readProjectReadiness(project.id).ready, true);
  // Governance is configuration, so the change must produce a new config version
  // whose snapshot carries the decision and its policy version.
  const activeVersion = db.getProject(project.id)!.configVersion;
  assert.notEqual(activeVersion, project.configVersion);
  const snapshot = db.getConfigVersion(activeVersion);
  assert.equal(snapshot?.payload.governance?.projectType, "client");
  assert.equal(snapshot?.payload.governance?.decisionId, decision.id);
  assert.equal(snapshot?.payload.policyVersions?.governance, PROJECT_POLICY_VERSION);

  // A stale expected version is a refusal, not a silent merge.
  assert.throws(() => db.recordProjectDecision({
    projectId: project.id, projectType: "personal", reviewChoice: "off", actor: "owner", source: "cli",
  }, 0), /Governance changed since version 0/);
  assert.equal(db.getProject(project.id)?.governance.reviewChoice, "required");
  assert.equal(db.getProjectDecision(decision.id)?.reviewChoice, "required");

  assert.throws(() => db.recordProjectDecision({
    projectId: project.id, briefId: "brf_other", projectType: "personal", reviewChoice: "off",
    actor: "owner", source: "cli",
  }, 1), /exactly one project or brief subject/);
  assert.throws(() => db.recordProjectDecision({
    projectType: "personal", reviewChoice: "off", actor: "owner", source: "cli",
  }, 1), /exactly one project or brief subject/);
});

test("episodes, stages, task state, and events advance in one transaction", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "durable", repoPath: "/tmp/durable" });
  const task = db.createTask({ projectId: project.id, title: "durable", objective: "persist" });
  const ready = db.transition(task.id, "READY");

  const episode = db.createExecutionEpisode({ taskId: task.id, expectedTaskVersion: ready.recordVersion });
  assert.equal(episode.episodeNumber, 1);
  assert.equal(episode.status, "active");
  assert.throws(
    () => db.createExecutionEpisode({ taskId: task.id, expectedTaskVersion: ready.recordVersion }),
    /changed since version/,
  );
  assert.throws(
    () => db.createExecutionEpisode({ taskId: task.id, expectedTaskVersion: db.getTask(task.id)!.recordVersion }),
    /already has an active execution episode/,
  );

  const implement = db.reserveStage({
    taskId: task.id, episodeId: episode.id, stage: "implement", ordinal: 1,
    launchKey: `${task.id}:implement:1`, inputFingerprint: "fp-implement",
    engineRevision: "engine-1", expectedTaskVersion: db.getTask(task.id)!.recordVersion,
  });
  assert.equal(implement.state, "reserved");
  assert.equal(db.getTask(task.id)?.state, "RUNNING");

  const lease = db.reserveAdmission({ stageRunId: implement.id, controllerId: "controller-1", provider: "codex" });
  assert.equal(lease.status, "reserved");
  assert.equal(lease.projectId, project.id);
  db.activateAdmission(lease.id, lease.fencingToken);
  assert.equal(db.getContinuation(task.id).currentStage?.state, "launching");

  const attempt = db.startAttempt({
    taskId: task.id, launchId: "launch-1", kind: "initial", adapter: "codex",
    stageRunId: implement.id, requestedModel: "gpt-test", configuredModel: "gpt-test",
  });
  assert.equal(attempt.stageRunId, implement.id);
  const running = db.recordLaunchStarted(implement.id, implement.fencingToken, { attemptId: attempt.id });
  assert.equal(running.state, "running");
  assert.equal(running.attemptId, attempt.id);

  db.finishAttempt({ attemptId: attempt.id, state: "succeeded", outcome: "completed", exitStatus: 0 });
  db.releaseAdmission(lease.id, lease.fencingToken, "stage complete");
  db.finishStage(implement.id, implement.fencingToken, { state: "succeeded", taskState: "CHECKING" });
  assert.equal(db.getTask(task.id)?.state, "CHECKING");

  // An open blocking obligation is durable continuation state, not a log line.
  const obligation = db.recordObligation({
    taskId: task.id, kind: "gate_failure", severity: "blocking", blocking: true,
    sourceKey: "gate:typecheck:rev-1", summary: "typecheck failed",
  });
  let continuation = db.getContinuation(task.id);
  assert.equal(continuation.taskState, "CHECKING");
  assert.equal(continuation.episode?.id, episode.id);
  assert.equal(continuation.openObligations.length, 1);
  assert.equal(continuation.openObligations[0]?.id, obligation.id);

  db.resolveObligation({ obligationId: obligation.id, state: "resolved", resolvedRevision: "rev-2" }, ["gate:typecheck:PASS"]);
  const accept = db.reserveStage({
    taskId: task.id, episodeId: episode.id, stage: "accept", ordinal: 2,
    launchKey: `${task.id}:accept:2`, inputFingerprint: "fp-accept",
    engineRevision: "engine-1", expectedTaskVersion: db.getTask(task.id)!.recordVersion,
  });
  db.finishStage(accept.id, accept.fencingToken, { state: "succeeded" });

  assert.equal(db.getTask(task.id)?.state, "DONE");
  continuation = db.getContinuation(task.id);
  assert.equal(continuation.episode?.status, "completed");
  assert.equal(continuation.openObligations.length, 0);

  const kinds = db.listEvents(task.id).map((event) => event.kind);
  for (const kind of [
    "execution.episode_started", "stage.reserved", "admission.reserved", "admission.activated",
    "stage.launch_started", "admission.released", "stage.finished", "obligation.recorded", "obligation.updated",
  ]) {
    assert.ok(kinds.includes(kind), `missing event ${kind}`);
  }

  // Completed work cannot be reopened through the execution APIs.
  assert.throws(
    () => db.createExecutionEpisode({ taskId: task.id, expectedTaskVersion: db.getTask(task.id)!.recordVersion }),
    /completed work cannot be reopened/,
  );
});

test("stage uniqueness and fencing reject duplicate side effects", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "fencing", repoPath: "/tmp/fencing" });
  const task = db.createTask({ projectId: project.id, title: "fence", objective: "no duplicates" });
  const ready = db.transition(task.id, "READY");
  const episode = db.createExecutionEpisode({
    taskId: task.id, expectedTaskVersion: ready.recordVersion, repairLimit: 1,
  });

  const reserve = (stage: "implement" | "repair", ordinal: number, launchKey: string) => db.reserveStage({
    taskId: task.id, episodeId: episode.id, stage, ordinal, launchKey,
    inputFingerprint: `fp-${ordinal}`, engineRevision: "engine-1",
    expectedTaskVersion: db.getTask(task.id)!.recordVersion,
  });

  const stage = reserve("implement", 1, "launch-key-1");

  // A duplicate launch key is the idempotency guard for a retried dispatch: it
  // must leave no second stage, no task bump, and no event behind.
  const versionBefore = db.getTask(task.id)!.recordVersion;
  const eventsBefore = db.listEvents(task.id).length;
  assert.throws(() => reserve("implement", 2, "launch-key-1"), /UNIQUE|constraint/i);
  assert.equal(db.getTask(task.id)?.recordVersion, versionBefore);
  assert.equal(db.listEvents(task.id).length, eventsBefore);
  assert.equal(Number(db.store.get("SELECT COUNT(*) AS n FROM stage_runs WHERE task_id = ?", task.id)?.n), 1);

  // A stale owner can neither launch nor finish a stage it no longer holds.
  assert.throws(() => db.recordLaunchStarted(stage.id, "not-the-token"), /Stale fencing token/);
  assert.throws(() => db.finishStage(stage.id, "not-the-token", { state: "succeeded" }), /Stale fencing token/);

  db.recordLaunchStarted(stage.id, stage.fencingToken);
  assert.throws(() => db.recordLaunchStarted(stage.id, stage.fencingToken), /already been claimed or finished/);
  db.finishStage(stage.id, stage.fencingToken, { state: "succeeded", taskState: "CHECKING" });
  assert.throws(() => db.finishStage(stage.id, stage.fencingToken, { state: "failed" }), /already terminal/);

  // The repair budget is spent inside the reservation transaction, so a rejected
  // reservation cannot consume one.
  reserve("repair", 3, "launch-key-repair-1");
  assert.equal(db.getContinuation(task.id).episode?.repairsConsumed, 1);
  assert.throws(() => reserve("repair", 4, "launch-key-repair-2"), /Repair limit reached/);
  assert.equal(db.getContinuation(task.id).episode?.repairsConsumed, 1);

  // One stage holds at most one admission lease.
  const idle = db.reserveStage({
    taskId: task.id, episodeId: episode.id, stage: "check", ordinal: 5,
    launchKey: "launch-key-check", inputFingerprint: "fp-check", engineRevision: "engine-1",
    expectedTaskVersion: db.getTask(task.id)!.recordVersion,
  });
  const lease = db.reserveAdmission({ stageRunId: idle.id, controllerId: "controller-1" });
  assert.throws(
    () => db.reserveAdmission({ stageRunId: idle.id, controllerId: "controller-2" }),
    /UNIQUE|constraint/i,
  );
  assert.throws(() => db.activateAdmission(lease.id, "not-the-token"), /Stale fencing token/);
  db.activateAdmission(lease.id, lease.fencingToken);
  assert.throws(() => db.activateAdmission(lease.id, lease.fencingToken), /no longer reservable/);
  assert.throws(() => db.releaseAdmission(lease.id, "not-the-token", "x"), /Stale fencing token/);
  db.releaseAdmission(lease.id, lease.fencingToken, "cancelled");
  assert.throws(() => db.releaseAdmission(lease.id, lease.fencingToken, "again"), /already terminal/);
});

test("obligations, usage projections, and incidents are keyed by their source", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ projectType: "personal", reviewChoice: "risk", name: "evidence", repoPath: "/tmp/evidence" });
  const task = db.createTask({ projectId: project.id, title: "fix", objective: "close findings" });

  const obligation = db.recordObligation({
    taskId: task.id, kind: "code_defect", severity: "blocking", blocking: true,
    sourceKey: "review-1:finding-1", summary: "null dereference",
    evidenceRefs: ["review-1"],
  });
  assert.equal(obligation.state, "open");
  assert.deepEqual(obligation.evidenceRefs, ["review-1"]);
  // Re-reading the same review must not duplicate the finding.
  assert.throws(() => db.recordObligation({
    taskId: task.id, kind: "code_defect", severity: "blocking", blocking: true,
    sourceKey: "review-1:finding-1", summary: "null dereference",
  }), /UNIQUE|constraint/i);

  assert.throws(
    () => db.resolveObligation({ obligationId: obligation.id, state: "resolved" }, []),
    /requires validation or decision evidence/,
  );
  const resolved = db.resolveObligation(
    { obligationId: obligation.id, state: "resolved", resolvedRevision: "rev-2" },
    ["gate:test:PASS"],
  );
  assert.equal(resolved.state, "resolved");
  assert.deepEqual(resolved.resolutionEvidence, ["gate:test:PASS"]);
  assert.throws(
    () => db.resolveObligation({ obligationId: obligation.id, state: "withdrawn" }, ["late"]),
    /already resolved/,
  );

  db.transition(task.id, "READY");
  db.claimTask(task.id, "launch-1");
  db.transition(task.id, "RUNNING");
  const attempt = db.startAttempt({ taskId: task.id, launchId: "launch-1", kind: "initial", adapter: "codex" });

  const usageInput = {
    attemptId: attempt.id, normalizerVersion: "mabs.usage.v1",
    normalized: { knownInputEvents: 12, knownOutputTokens: 3 },
    sourceArtifactHash: "sha256:abc", sourceOffset: 0,
    coverage: "complete" as const, sourceSemantics: "codex-input-includes-cache",
  };
  const usage = db.recordUsageProjection(usageInput);
  assert.equal(usage.coverage, "complete");
  assert.equal(db.getUsageProjection(attempt.id, "mabs.usage.v1")?.normalized.knownInputEvents, 12);
  // Re-normalizing the same artifact must not double-count usage.
  assert.throws(() => db.recordUsageProjection(usageInput), /UNIQUE|constraint/i);
  // A different normalizer version is a separate, additive projection.
  db.recordUsageProjection({ ...usageInput, normalizerVersion: "mabs.usage.v2", coverage: "partial" });
  assert.equal(db.getUsageProjection(attempt.id, "mabs.usage.v2")?.coverage, "partial");
  assert.equal(db.getUsageProjection(attempt.id, "mabs.usage.v1")?.coverage, "complete");

  const signature = {
    signature: "gate.typecheck.missing-binary", classifierVersion: "mabs.classifier.v1",
    category: "environment", layer: "gate", symptom: "tsc executable not found",
  };
  const first = db.recordIncidentOccurrence({ ...signature, sourceKey: "gate-1", taskId: task.id });
  const second = db.recordIncidentOccurrence({ ...signature, sourceKey: "gate-2", taskId: task.id });
  // Recurrence groups under one incident instead of creating a new one.
  assert.equal(second.incidentId, first.incidentId);
  assert.equal(db.incidentOccurrences(first.incidentId).length, 2);
  assert.equal(db.getIncident(first.incidentId)?.confidence, "unknown");
  assert.throws(
    () => db.recordIncidentOccurrence({ ...signature, sourceKey: "gate-2", taskId: task.id }),
    /UNIQUE|constraint/i,
  );
  assert.throws(
    () => db.recordIncidentOccurrence({ ...signature, incidentId: "inc_other", sourceKey: "gate-3" }),
    /already belongs to/,
  );

  const check = db.recordEnvironmentCheck({
    taskId: task.id, stageRunId: null, component: ".", profile: "javascript",
    revision: "rev-1", runtimeFingerprint: "node-24", lockfileFingerprint: "sha256:lock",
    outcome: "missing", evidenceRefs: ["preflight.log"], setupActionRequired: "npm ci",
  });
  assert.equal(check.outcome, "missing");
  assert.equal(check.setupActionRequired, "npm ci");
});
