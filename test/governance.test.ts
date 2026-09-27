import assert from "node:assert/strict";
import test from "node:test";

import { Controller } from "../src/controller/controller.ts";
import { projectConfigSnapshot } from "../src/domain/config.ts";
import { GovernanceNeedsInputError } from "../src/domain/project-policy.ts";
import { acceptPlan, proposePlan } from "../src/intake/service.ts";
import { createBrief, listClarifications, syncGovernanceClarifications } from "../src/intake/store.ts";
import { reviewPreset } from "../src/review/policy.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";

function records(): Records {
  return new Records(new Store(":memory:"));
}

test("MABS is explicitly personal with risk review without making personal a global default", (t) => {
  const db = records();
  t.after(() => db.store.close());

  const unknown = db.createProject({ name: "unclassified", repoPath: "/tmp/unclassified" });
  assert.equal(unknown.governance.projectType, null);
  assert.equal(unknown.reviewPolicy.preset, "custom");
  assert.equal(db.readProjectReadiness(unknown.id).ready, false);

  const mabs = db.createProject({
    name: "MABS",
    repoPath: "/tmp/mabs",
    projectType: "personal",
    reviewChoice: "risk",
    governanceActor: "project-owner",
    governanceSource: "accepted-plan",
  });
  assert.equal(mabs.governance.projectType, "personal");
  assert.equal(mabs.governance.reviewChoice, "risk");
  assert.equal(mabs.reviewPolicy.trigger, "risk");
  assert.equal(mabs.reviewPolicy.qualityExpectation, "configured_checks");
  assert.equal(db.readProjectReadiness(mabs.id).ready, true);
});

test("missing governance is structured needs-input and creates no task", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({ name: "unknown", repoPath: "/tmp/unknown" });

  assert.throws(() => db.createTask({ projectId: project.id, title: "must wait", objective: "do work" }), (error) => {
    assert.ok(error instanceof GovernanceNeedsInputError);
    assert.equal(error.result.outcome, "needs_input");
    assert.equal(error.result.subject.id, project.id);
    assert.equal(error.result.questions[0]?.key, "project_type");
    return true;
  });
  assert.equal(db.listTasks({ projectId: project.id }).length, 0);
  assert.equal(Number(db.store.get("SELECT COUNT(*) AS n FROM attempts")?.n), 0);
});

test("personal unanswered review is asked once per governance version", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const brief = createBrief(db, { title: "personal draft", projectType: "personal", createdBy: "owner" });

  syncGovernanceClarifications(db, brief.id);
  syncGovernanceClarifications(db, brief.id);
  const governanceQuestions = listClarifications(db, brief.id, "open")
    .filter((item) => item.field?.startsWith("governance:"));
  assert.equal(governanceQuestions.length, 1);
  assert.match(governanceQuestions[0]?.question ?? "", /no automatic review|risk-based review|every code change/i);
  assert.throws(() => db.createTask({
    projectId: db.createProject({ name: "personal", repoPath: "/tmp/personal", projectType: "personal" }).id,
    title: "wait", objective: "wait",
  }), GovernanceNeedsInputError);
});

test("client review cannot be disabled by registration or a review-policy setter", (t) => {
  const db = records();
  t.after(() => db.store.close());

  assert.throws(() => db.createProject({
    name: "client-off", repoPath: "/tmp/client-off", projectType: "client", reviewChoice: "off",
  }), /Client projects require/);

  const client = db.createProject({ name: "client", repoPath: "/tmp/client", projectType: "client" });
  assert.equal(client.governance.reviewChoice, "required");
  assert.equal(client.reviewPolicy.reviewerRoute, "independent_provider");
  assert.throws(() => db.setProjectReviewPolicy(client.id, reviewPreset("experiment"), {
    acknowledgeWeakening: true,
    reason: "attempted bypass",
  }), /conflicts with recorded project governance/);
});

test("client review-off cannot enter configuration history through proposal or revert", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const client = db.createProject({ name: "client", repoPath: "/tmp/client", projectType: "client" });
  const candidate = {
    ...projectConfigSnapshot(client),
    reviewPolicy: reviewPreset("experiment"),
  };
  const before = Number(db.store.get("SELECT COUNT(*) AS n FROM curator_proposals")?.n);
  assert.throws(() => db.createCuratorProposal({
    projectId: client.id,
    title: "disable review",
    rationale: "must be rejected",
    fingerprint: "bad-config",
    evidenceFingerprint: "bad-evidence",
    config: candidate,
    proposedBy: "optimizer",
  }), /conflicts with current project governance/);
  assert.equal(Number(db.store.get("SELECT COUNT(*) AS n FROM curator_proposals")?.n), before);

  db.store.run(
    `INSERT INTO config_versions(id, project_id, parent_id, source, kind, payload, active, created_at)
     VALUES('cfg_client_off', ?, ?, 'legacy-test', 'snapshot', ?, 0, ?)`,
    client.id, client.configVersion, JSON.stringify(candidate), new Date().toISOString(),
  );
  assert.throws(() => db.revertProjectConfig({
    projectId: client.id,
    targetConfigVersion: "cfg_client_off",
    approvalId: "missing",
    activatedBy: "owner",
    reason: "attempted revert",
  }), /conflicts with current project governance/);
  assert.equal(db.getProject(client.id)?.reviewPolicy.trigger, "required");
});

test("controller backstop deduplicates needs-input and launches nothing", async (t) => {
  const db = records();
  t.after(() => db.store.close());
  const project = db.createProject({
    name: "legacy", repoPath: "/tmp/legacy", projectType: "personal", reviewChoice: "off",
  });
  const task = db.createTask({ projectId: project.id, title: "legacy queued", objective: "must wait" });
  db.store.run(
    "UPDATE projects SET project_type = NULL, review_choice = NULL, governance_decision_id = NULL, governance_version = 0 WHERE id = ?",
    project.id,
  );

  const controller = new Controller(db, { adapters: new Map(), workerLimit: 1 });
  await controller.tick();
  await controller.tick();
  await controller.stop();

  assert.equal(db.listAttempts(task.id).length, 0);
  assert.equal(db.listEvents(task.id).filter((event) => event.kind === "governance.needs_input").length, 1);
  assert.equal(db.getTask(task.id)?.state, "READY");
});

test("a governance change makes an already-presented proposal stale", (t) => {
  const db = records();
  t.after(() => db.store.close());
  const brief = createBrief(db, {
    title: "governed proposal", projectType: "personal", reviewChoice: "risk", createdBy: "owner",
  });
  const proposed = proposePlan(db, {
    brief: brief.id,
    summary: "Make one governed change.",
    rationale: "The smallest plan proves the binding.",
    scope: "One source file.",
    requirements: [{ id: "REQ-1", text: "The change remains governed." }],
    plan: {
      objective: "Make the governed change.", mode: "single", reason: "Only one task is needed.",
      tasks: [{
        key: "change", title: "Make change", objective: "Implement it.", acceptanceCriteria: ["It works."],
        executionMode: "single", executionReason: "One isolated edit.", allowedScope: ["src/change.ts"],
      }],
    },
  });
  assert.equal(proposed.valid, true);
  assert.ok(proposed.proposal);

  db.recordProjectDecision({
    briefId: brief.id,
    projectType: "personal",
    reviewChoice: "off",
    actor: "owner",
    source: "user-decision",
  }, 1);

  assert.throws(() => acceptPlan(db, {
    brief: brief.id,
    proposalId: proposed.proposal!.id,
    fingerprint: proposed.proposal!.fingerprint,
    acceptedBy: "owner",
  }), /governance changed|fresh proposal/i);
});
