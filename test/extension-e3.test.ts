/**
 * E3 suite: an ordinary conversation produces an accepted, validated plan.
 *
 * The CLI path exercised here is exactly the one the Pi tools call, so these
 * tests cover the tool surface as well as the service.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type { ExecutionPlan } from "../src/domain/plan.ts";
import {
  acceptPlan,
  answerClarification,
  askClarifications,
  briefDetail,
  productSummary,
  proposePlan,
  submitAcceptedPlan,
} from "../src/intake/service.ts";
import {
  activeAcceptance,
  createBrief,
  latestProposal,
  listClarifications,
  updateBrief,
} from "../src/intake/store.ts";
import { Records } from "../src/store/records.ts";
import { SCHEMA_VERSION, Store } from "../src/store/db.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoAt(path: string): void {
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "main.py"), "def main():\n    return 0\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(path, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-e3-"));
  const oldState = process.env.MABS_STATE_DIR;
  const oldWorktrees = process.env.MABS_WORKTREE_ROOT;
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (oldState === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = oldState;
    if (oldWorktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = oldWorktrees;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, records };
}

function samplePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    objective: "Deliver a local command-line study assistant.",
    mode: "sequential",
    reason: "Later tasks depend on the storage layer created first.",
    assumptions: ["Runs locally with no network scheduling."],
    milestones: ["Storage layer", "Daily packet command"],
    tasks: [
      {
        key: "storage",
        title: "Create the local SQLite store",
        objective: "Create the SQLite schema and access layer for learner state.",
        acceptanceCriteria: ["Schema is created on first run", "Records round-trip through the access layer"],
        executionMode: "sequential",
        executionReason: "Everything else reads this schema.",
        allowedScope: ["src/store"],
      },
      {
        key: "packet",
        title: "Generate a daily packet",
        objective: "Generate one day's study packet from stored state.",
        acceptanceCriteria: ["A packet is written for a requested day"],
        dependsOn: ["storage"],
        executionMode: "sequential",
        executionReason: "Reads the storage layer.",
        allowedScope: ["src/packet"],
      },
    ],
    ...overrides,
  };
}

function proposalPayload(plan: ExecutionPlan = samplePlan()) {
  return {
    summary: "Build a local Python CLI that stores learner state and generates one daily study packet.",
    rationale: "A small deterministic core first; retrieval and scheduling come later.",
    scope: "Local storage plus a single daily packet command.",
    outOfScope: ["Scheduled delivery", "Email notifications"],
    requirements: [
      { id: "REQ-1", text: "Learner state persists locally in SQLite." },
      { id: "REQ-2", text: "A daily packet can be generated on demand." },
    ],
    milestones: ["Storage layer", "Daily packet command"],
    plan,
  };
}

test("an idea becomes an accepted, validated plan through ordinary conversation", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "product-repo");
  repoAt(repo);

  // 1. A new idea, recorded before any repository exists.
  const brief = createBrief(records, {
    title: "study-assistant",
    purpose: "Help me prepare for applied AI engineering roles.",
    objective: "Produce a daily study packet I can actually follow.",
    constraints: ["Runs locally", "No paid services"],
    unknowns: ["Current Python and ML proficiency"],
    createdBy: "prathyush",
  });
  assert.equal(brief.state, "DRAFT");
  assert.equal(brief.projectId, null, "a brief must not require a project");

  // 2. Only material questions are asked, each with a reason.
  askClarifications(records, {
    brief: brief.id,
    questions: [
      { question: "How much Python have you written recently?", whyItMatters: "It changes the exercise difficulty in week one.", field: "unknowns" },
      { question: "How many hours a day can you spend?", whyItMatters: "It sets the daily time budget." },
    ],
  });
  assert.equal(records.getProject(brief.projectId ?? "") ?? null, null);
  assert.equal(listClarifications(records, brief.id, "open").length, 2);
  assert.throws(
    () => askClarifications(records, { brief: brief.id, questions: [{ question: "Colour?", whyItMatters: "" }] }),
    /why the answer matters/,
  );

  // 3. Incomplete answers: one answered, one explicitly assumed.
  const open = listClarifications(records, brief.id, "open");
  answerClarification(records, { id: open[0]?.id as string, answer: "A few scripts a month.", actor: "prathyush" });
  const proposedWithOpenQuestion = proposePlan(records, { brief: brief.id, ...proposalPayload() });
  assert.equal(proposedWithOpenQuestion.valid, true);
  assert.ok(proposedWithOpenQuestion.warnings.some((warning) => warning.includes("still unanswered")),
    "an unanswered material question must be surfaced, not hidden");
  answerClarification(records, { id: open[1]?.id as string, assumption: "Assuming 4-5 hours a day until the user says otherwise." });

  // 4. A validated proposal is persisted and presented.
  const proposed = proposePlan(records, { brief: brief.id, ...proposalPayload() });
  assert.equal(proposed.valid, true);
  assert.deepEqual(proposed.errors, []);
  assert.equal(proposed.warnings.filter((warning) => warning.includes("still unanswered")).length, 0);
  const proposal = proposed.proposal;
  assert.ok(proposal);
  assert.equal(proposal.state, "presented");
  assert.equal(records.getProject(proposal.id) ?? null, null);
  assert.equal(proposed.brief.state, "PROPOSED");

  // 5. The model cannot invent consent.
  assert.throws(
    () => acceptPlan(records, { brief: brief.id, proposalId: proposal.id, fingerprint: proposal.fingerprint, acceptedBy: "agent" }),
    /an agent cannot accept on the user's behalf/,
  );
  assert.throws(
    () => acceptPlan(records, { brief: brief.id, proposalId: proposal.id, fingerprint: "not-the-plan-they-saw", acceptedBy: "prathyush" }),
    /has changed since it was presented/,
  );

  const accepted = acceptPlan(records, {
    brief: brief.id, proposalId: proposal.id, fingerprint: proposal.fingerprint,
    acceptedBy: "prathyush", note: "Yes, start with the storage layer.",
  });
  assert.equal(accepted.brief.state, "ACCEPTED");
  assert.equal(accepted.acceptance.proposalFingerprint, proposal.fingerprint);

  // 6. The accepted plan is applied with no hand-written JSON.
  const project = records.createProject({ name: "study-assistant", repoPath: repo });
  const submitted = submitAcceptedPlan(records, { brief: brief.id, projectId: project.id });
  assert.equal(submitted.tasks.length, 2);
  assert.equal(submitted.brief.state, "REGISTERED");
  const repeated = submitAcceptedPlan(records, { brief: brief.id, projectId: project.id });
  assert.deepEqual(repeated.tasks.map((task) => task.id), submitted.tasks.map((task) => task.id),
    "a retry after an uncertain response must reuse the recorded submission");
  assert.equal(records.listTasks({ projectId: project.id }).length, 2);
  assert.deepEqual(records.listRequirements(project.id).map((requirement) => requirement.id), ["REQ-1", "REQ-2"]);
  const storage = submitted.tasks.find((task) => task.title.includes("SQLite store"));
  const packet = submitted.tasks.find((task) => task.title.includes("daily packet"));
  assert.deepEqual(records.dependenciesOf(packet?.id as string), [storage?.id]);

  const summary = productSummary(records, brief.id);
  assert.equal(summary.work.total, 2);
  assert.equal(summary.acceptance?.acceptedBy, "prathyush");
  assert.ok(summary.assumptions.some((assumption) => assumption.includes("4-5 hours")));
  assert.ok(summary.nextActions.length > 0);

  const detail = briefDetail(records, brief.id);
  assert.ok(detail.conversation.some((event) => event.kind === "brief.created"));
  assert.ok(detail.conversation.some((event) => event.kind === "proposal.accepted"));
});

test("an invalid dependency graph is rejected before the user ever sees it", (t) => {
  const { records } = setup(t);
  const brief = createBrief(records, { title: "cycles", objective: "x", createdBy: "prathyush" });

  const cyclic = proposePlan(records, {
    brief: brief.id,
    ...proposalPayload(samplePlan({
      tasks: [
        {
          key: "a", title: "A", objective: "A", acceptanceCriteria: ["a"], dependsOn: ["b"],
          executionMode: "sequential", executionReason: "ordered",
        },
        {
          key: "b", title: "B", objective: "B", acceptanceCriteria: ["b"], dependsOn: ["a"],
          executionMode: "sequential", executionReason: "ordered",
        },
      ],
    })),
  });
  assert.equal(cyclic.valid, false);
  assert.ok(cyclic.errors.some((error) => error.includes("Dependency cycle")));
  assert.equal(cyclic.proposal, null);
  assert.equal(latestProposal(records, brief.id), null, "an invalid plan is never stored as presentable");
  assert.equal(records.getProject(brief.id) ?? null, null);

  const overlapping = proposePlan(records, {
    brief: brief.id,
    ...proposalPayload(samplePlan({
      mode: "parallel",
      tasks: [
        {
          key: "a", title: "A", objective: "A", acceptanceCriteria: ["a"],
          executionMode: "parallel", executionReason: "independent", allowedScope: ["src/store"],
        },
        {
          key: "b", title: "B", objective: "B", acceptanceCriteria: ["b"],
          executionMode: "parallel", executionReason: "independent", allowedScope: ["src/store/db"],
        },
      ],
    })),
  });
  assert.equal(overlapping.valid, false);
  assert.ok(overlapping.errors.some((error) => error.includes("parallel edit scopes overlap")));

  const missingRequirement = proposePlan(records, { brief: brief.id, ...proposalPayload(), requirements: [] });
  assert.equal(missingRequirement.valid, false);
  assert.ok(missingRequirement.errors.some((error) => error.includes("at least one requirement")));
});

test("a scope change after acceptance invalidates only the affected acceptance and planned work", (t) => {
  const { root, records } = setup(t);
  const repo = join(root, "repo");
  repoAt(repo);
  const brief = createBrief(records, { title: "revisable", objective: "Ship a daily packet.", createdBy: "prathyush" });
  const proposal = proposePlan(records, { brief: brief.id, ...proposalPayload() }).proposal;
  acceptPlan(records, {
    brief: brief.id, proposalId: (proposal as { id: string }).id,
    fingerprint: (proposal as { fingerprint: string }).fingerprint, acceptedBy: "prathyush",
  });
  const project = records.createProject({ name: "revisable", repoPath: repo });
  const submitted = submitAcceptedPlan(records, { brief: brief.id, projectId: project.id });

  // One task has already completed; its history must survive the revision.
  const done = submitted.tasks[0];
  records.transition(done?.id as string, "READY");
  records.transition(done?.id as string, "RUNNING");
  records.transition(done?.id as string, "CHECKING", { result_revision: "rev-done", result_summary: "Storage layer complete." });
  records.transition(done?.id as string, "DONE");

  const current = records.getProject(project.id);
  assert.ok(current);
  const revised = updateBrief(records, {
    briefId: brief.id,
    expectedVersion: 1,
    summary: "The user wants more retrieval-evaluation practice.",
    patch: { acceptanceCriteria: ["Daily packet includes a retrieval-evaluation exercise"] },
    actor: "prathyush",
  });
  assert.equal(revised.brief.state, "CLARIFYING", "a revision after acceptance reopens the conversation");
  assert.equal(revised.invalidated.length, 1);
  assert.equal(activeAcceptance(records, brief.id), null);

  // Completed work and its evidence are untouched; planned work is listed as affected.
  assert.equal(records.getTask(done?.id as string)?.state, "DONE");
  assert.equal(records.getTask(done?.id as string)?.resultSummary, "Storage layer complete.");
  const summary = productSummary(records, brief.id);
  assert.equal(summary.work.completed.length, 1);
  assert.equal(summary.work.notStarted.length, 0);
  assert.equal(summary.work.byState.CANCELLED, 1, "not-started work from the stale plan must not remain dispatchable");
  assert.ok(summary.nextActions.some((action) => action.includes("Propose a plan") || action.includes("accept")));

  // The stale proposal cannot be re-accepted after the revision.
  assert.throws(
    () => acceptPlan(records, {
      brief: brief.id, proposalId: (proposal as { id: string }).id,
      fingerprint: (proposal as { fingerprint: string }).fingerprint, acceptedBy: "prathyush",
    }),
    /invalidated|brief is now at version/,
  );

  // Submitting again is refused until the user accepts a fresh plan.
  assert.throws(() => submitAcceptedPlan(records, { brief: brief.id }), /no active acceptance/);
});

test("a restart during clarification resumes from durable state", (t) => {
  const { root } = setup(t);
  const dbPath = join(root, "restart.sqlite");
  const first = new Records(new Store(dbPath));
  const brief = createBrief(first, { title: "resumable", objective: "Draft my weekly report.", createdBy: "prathyush" });
  askClarifications(first, {
    brief: brief.id,
    questions: [{ question: "Which systems hold the source data?", whyItMatters: "It decides which adapters are needed." }],
  });
  first.store.close();

  const second = new Records(new Store(dbPath));
  const resumed = briefDetail(second, "resumable");
  assert.equal(resumed.brief.state, "CLARIFYING");
  assert.equal(resumed.clarifications.length, 1);
  assert.equal(resumed.clarifications[0]?.state, "open");
  const summary = productSummary(second, resumed.brief.id);
  assert.ok(summary.nextActions[0]?.includes("Answer 1 open question"));
  second.store.close();
});

test("concurrent brief edits fail closed on the expected version", (t) => {
  const { records } = setup(t);
  const brief = createBrief(records, { title: "versioned", objective: "x", createdBy: "prathyush" });
  updateBrief(records, { briefId: brief.id, expectedVersion: 1, summary: "Recorded the audience.", patch: { audience: "Me" } });
  assert.throws(
    () => updateBrief(records, { briefId: brief.id, expectedVersion: 1, summary: "Stale write.", patch: { audience: "Someone else" } }),
    /changed since version 1/,
  );
  assert.equal(records.store.get("SELECT audience FROM product_briefs WHERE id = ?", brief.id)?.audience, "Me");
  assert.throws(
    () => updateBrief(records, { briefId: brief.id, expectedVersion: 2, summary: "", patch: { audience: "Me" } }),
    /needs a one-line summary/,
  );
});

test("schema 11 upgrades add intake records without changing existing projects", (t) => {
  const { root } = setup(t);
  const repo = join(root, "migration-repo");
  repoAt(repo);
  const dbPath = join(root, "migration.sqlite");
  const oldRecords = new Records(new Store(dbPath));
  const existing = oldRecords.createProject({ name: "existing-before-intake", repoPath: repo });
  oldRecords.store.close();

  const legacy = new DatabaseSync(dbPath);
  for (const table of [
    "bootstrap_runs", "acceptance_bindings", "proposal_versions", "clarification_items",
    "conversation_events", "brief_revisions", "product_briefs",
  ]) legacy.exec(`DROP TABLE IF EXISTS ${table}`);
  legacy.prepare("UPDATE schema_meta SET value = '11' WHERE key = 'schema_version'").run();
  legacy.close();

  const migrated = new Records(new Store(dbPath));
  assert.equal(migrated.getProject(existing.id)?.name, "existing-before-intake");
  assert.equal(migrated.store.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")?.value, SCHEMA_VERSION);
  const brief = createBrief(migrated, { title: "after-migration", createdBy: "test" });
  assert.equal(brief.version, 1);
  migrated.store.close();
});

test("the CLI tool surface drives the whole flow without hand-written plan JSON", (t) => {
  const { root } = setup(t);
  const repo = join(root, "cli-repo");
  repoAt(repo);
  const env = {
    ...process.env,
    MABS_DB_PATH: join(root, "cli.sqlite"),
    MABS_STATE_DIR: join(root, "cli-state"),
  };
  const cli = (...args: string[]): string =>
    execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...args], { env, encoding: "utf8" });

  const brief = JSON.parse(cli("brief", "create", `--payload=${JSON.stringify({
    title: "cli-product", objective: "Draft my weekly report from local notes.",
  })}`, "--by=prathyush")) as { id: string; version: number; state: string };
  assert.equal(brief.state, "DRAFT");

  cli("brief", "ask", brief.id, `--payload=${JSON.stringify({
    questions: [{ question: "Where do the notes live?", whyItMatters: "It decides which reader the tool needs." }],
  })}`);
  const asked = JSON.parse(cli("brief", "show", brief.id)) as { clarifications: { id: string }[] };
  cli("brief", "answer", asked.clarifications[0]?.id as string, "--answer=A local Markdown folder.", "--by=prathyush");

  const proposed = JSON.parse(cli("brief", "propose", brief.id, `--payload=${JSON.stringify(proposalPayload())}`)) as {
    valid: boolean; proposal: { id: string; fingerprint: string };
  };
  assert.equal(proposed.valid, true);

  cli("brief", "accept", brief.id, proposed.proposal.id,
    `--fingerprint=${proposed.proposal.fingerprint}`, "--by=prathyush", "--note=Looks right.");

  const project = JSON.parse(cli("project", "add", "cli-product", repo, "--no-checks")) as { id: string };
  const submitted = JSON.parse(cli("brief", "submit", brief.id, `--project=${project.id}`)) as { tasks: { id: string }[] };
  assert.equal(submitted.tasks.length, 2);

  const product = JSON.parse(cli("product", "show", brief.id)) as {
    brief: { state: string }; work: { total: number }; project: { name: string };
  };
  assert.equal(product.brief.state, "REGISTERED");
  assert.equal(product.work.total, 2);
  assert.equal(product.project.name, "cli-product");
});
