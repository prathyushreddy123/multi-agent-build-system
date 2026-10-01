/**
 * Efficiency v5, Phase 1: intake operations the conversation can use without
 * a second lookup or a guessed identifier (INT-01..04, OUT-01).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { IntakeError } from "../src/intake/errors.ts";
import type { ExecutionPlan } from "../src/domain/plan.ts";
import { acceptPlan, answerClarification, askClarifications, proposePlan, resolveIntake } from "../src/intake/service.ts";
import { activeAcceptance, conversationFor, createBrief, getBrief, getClarification } from "../src/intake/store.ts";
import { Records } from "../src/store/records.ts";
import { SCHEMA_VERSION, Store } from "../src/store/db.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-v5-intake-"));
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, records };
}

function personalBrief(records: Records, title = "notes-tool") {
  return createBrief(records, {
    projectType: "personal", reviewChoice: "off",
    title, objective: "Summarize my weekly notes.", createdBy: "prathyush",
  });
}

function cliFor(root: string) {
  const env = { ...process.env, MABS_DB_PATH: join(root, "cli.sqlite"), MABS_STATE_DIR: join(root, "cli-state") };
  const script = join(import.meta.dirname, "..", "src", "cli.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  const json = <T>(...args: string[]): T => JSON.parse(execFileSync(process.execPath, [script, ...args], { env, encoding: "utf8" })) as T;
  return { run, json };
}

function smallPlan(): ExecutionPlan {
  return {
    objective: "Summarize weekly notes.",
    mode: "sequential",
    reason: "One cohesive change with its tests.",
    tasks: [{
      key: "summary",
      title: "Weekly summary command",
      objective: "Read the notes folder and print a weekly summary.",
      acceptanceCriteria: ["A summary is printed for a folder of notes"],
      executionMode: "sequential",
      executionReason: "Single deliverable.",
      allowedScope: ["src"],
    }],
  };
}

function proposeAndAccept(records: Records, briefId: string) {
  const proposed = proposePlan(records, {
    brief: briefId,
    summary: "A local command that summarizes a week of notes.",
    rationale: "Smallest useful tool.",
    scope: "One command.",
    requirements: [{ id: "REQ-1", text: "A weekly summary is printed." }],
    plan: smallPlan(),
  });
  assert.equal(proposed.valid, true, proposed.errors.join("; "));
  const proposal = proposed.proposal as NonNullable<typeof proposed.proposal>;
  acceptPlan(records, { brief: briefId, proposalId: proposal.id, fingerprint: proposal.fingerprint, acceptedBy: "prathyush" });
  return proposal;
}

const refusal = (code: string) => (error: unknown) => error instanceof IntakeError && error.code === code;

// --- INT-01 ------------------------------------------------------------------

test("INT-01: asking returns usable records whose ids can be answered at once", (t) => {
  const { records } = setup(t);
  const brief = personalBrief(records);

  const asked = askClarifications(records, {
    brief: brief.id,
    questions: [
      { question: "Where do the notes live?", whyItMatters: "It decides the reader.", field: "source" },
      { question: "Which day is the summary due?", whyItMatters: "It sets the schedule." },
    ],
  });
  assert.equal(asked.briefId, brief.id);
  assert.equal(asked.briefVersion, asked.brief.version);
  assert.equal(asked.requested.length, 2);
  assert.equal(asked.open, 2, "the legacy count is still returned");
  assert.deepEqual(Object.keys(asked.requested[0] ?? {}).sort(), ["field", "id", "question", "reused", "state", "whyItMatters"]);
  assert.equal(asked.requested[0]?.field, "source");
  assert.equal(asked.requested[0]?.reused, false);

  const answered = answerClarification(records, { id: asked.requested[0]?.id as string, brief: brief.id, answer: "A Markdown folder." });
  assert.equal(answered.state, "answered");
});

test("INT-01: a repeated same-field question reuses its open record instead of duplicating it", (t) => {
  const { records } = setup(t);
  const brief = personalBrief(records);
  const first = askClarifications(records, {
    brief: brief.id, questions: [{ question: "Where do the notes live?", whyItMatters: "Reader choice.", field: "source" }],
  });
  const second = askClarifications(records, {
    brief: brief.id,
    questions: [
      { question: "Where are the notes stored?", whyItMatters: "Reader choice.", field: "source" },
      { question: "Is the folder synced?", whyItMatters: "Conflict handling.", field: "source" },
      { question: "How long is a summary?", whyItMatters: "Output format." },
    ],
  });
  assert.equal(second.requested.length, 2, "both same-field questions map to one record");
  assert.equal(second.requested[0]?.id, first.requested[0]?.id);
  assert.equal(second.requested[0]?.reused, true);
  assert.equal(second.requested[1]?.reused, false);
  assert.equal(second.openQuestions.length, 2);
  assert.equal(new Set(second.openQuestions.map((item) => item.id)).size, 2, "open questions carry no duplicates");
});

test("INT-01: unknown and cross-brief ids are refused with the ids that would be valid", (t) => {
  const { records } = setup(t);
  const mine = personalBrief(records, "mine");
  const other = personalBrief(records, "other");
  const asked = askClarifications(records, { brief: mine.id, questions: [{ question: "Q?", whyItMatters: "Scope." }] });
  const foreign = askClarifications(records, { brief: other.id, questions: [{ question: "Other?", whyItMatters: "Scope." }] });

  assert.throws(() => answerClarification(records, { id: "clr_missing", answer: "x" }), refusal("unknown_clarification"));
  assert.throws(() => answerClarification(records, { id: "clr_missing", brief: mine.id, answer: "x" }), (error: unknown) => {
    assert.ok(error instanceof IntakeError);
    assert.deepEqual(error.details.openClarificationIds, [asked.requested[0]?.id]);
    return true;
  });
  const foreignId = foreign.requested[0]?.id as string;
  assert.throws(() => answerClarification(records, { id: foreignId, brief: mine.id, answer: "x" }), refusal("clarification_brief_mismatch"));
  assert.equal(getClarification(records, foreignId)?.state, "open", "a refused answer changes nothing");
});

test("INT-01: the CLI returns ids directly and prints refusals as structured JSON", (t) => {
  const { root } = setup(t);
  const { run, json } = cliFor(root);
  const brief = json<{ id: string }>("brief", "create", `--payload=${JSON.stringify({
    title: "cli-notes", objective: "Summarize notes.", projectType: "personal", reviewChoice: "off",
  })}`, "--by=prathyush");
  const asked = json<{ requested: { id: string }[] }>("brief", "ask", brief.id, `--payload=${JSON.stringify({
    questions: [{ question: "Where?", whyItMatters: "Reader." }],
  })}`);
  const id = asked.requested[0]?.id as string;
  const answered = json<{ state: string }>("brief", "answer", id, `--brief=${brief.id}`, "--answer=Local folder.", "--by=prathyush");
  assert.equal(answered.state, "answered");

  const refused = run("brief", "answer", "clr_nope", `--brief=${brief.id}`, "--answer=x");
  assert.equal(refused.status, 1);
  const body = JSON.parse(refused.stderr) as { error: string; briefId: string; openClarificationIds: string[] };
  assert.equal(body.error, "unknown_clarification");
  assert.equal(body.briefId, brief.id);
  assert.deepEqual(body.openClarificationIds, []);
});

// --- INT-02 ------------------------------------------------------------------

function twoQuestions(records: Records) {
  const brief = personalBrief(records);
  const asked = askClarifications(records, {
    brief: brief.id,
    questions: [
      { question: "Where do the notes live?", whyItMatters: "Reader.", field: "source" },
      { question: "Which day?", whyItMatters: "Schedule.", field: "schedule" },
    ],
  });
  const [first, second] = asked.requested.map((item) => item.id) as [string, string];
  return { brief: getBrief(records, brief.id)!, first, second };
}

test("INT-02: answers and an explicit brief change commit together", (t) => {
  const { records } = setup(t);
  const { brief, first, second } = twoQuestions(records);
  const result = resolveIntake(records, {
    brief: brief.id, expectedVersion: brief.version, requestId: "req-1", actor: "prathyush",
    resolutions: [
      { clarificationId: first, answer: "A Markdown folder." },
      { clarificationId: second, assumption: "Assuming Friday until told otherwise." },
    ],
    patch: { constraints: ["Reads local Markdown only"] },
    summary: "Notes are local Markdown.",
  });
  assert.equal(result.replayed, false);
  assert.equal(result.briefVersion, brief.version + 1);
  assert.deepEqual(result.changed, ["constraints"]);
  assert.deepEqual(result.resolved.map((item) => item.state), ["answered", "assumed"]);
  assert.equal(result.resolved[0]?.answer, "A Markdown folder.", "the user's words are preserved");
  assert.equal(result.resolved[1]?.assumption, "Assuming Friday until told otherwise.", "the assumption is kept separately");
  assert.deepEqual(result.openQuestions, []);
});

test("INT-02: one invalid resolution writes nothing at all", (t) => {
  const { records } = setup(t);
  const { brief, first, second } = twoQuestions(records);
  const eventsBefore = conversationFor(records, brief.id).length;
  const cases: [string, Parameters<typeof resolveIntake>[1]["resolutions"], unknown][] = [
    ["both answer and assumption", [{ clarificationId: first, answer: "x" }, { clarificationId: second, answer: "y", assumption: "z" }], "invalid_resolution"],
    ["neither", [{ clarificationId: first, answer: "x" }, { clarificationId: second }], "invalid_resolution"],
    ["unknown id", [{ clarificationId: first, answer: "x" }, { clarificationId: "clr_missing", answer: "y" }], "unknown_clarification"],
    ["duplicate id", [{ clarificationId: first, answer: "x" }, { clarificationId: first, answer: "y" }], "invalid_resolution"],
  ];
  for (const [label, resolutions, code] of cases) {
    assert.throws(
      () => resolveIntake(records, { brief: brief.id, expectedVersion: brief.version, requestId: `bad-${label}`, resolutions }),
      refusal(code as string), label,
    );
  }
  // A valid answer paired with an invalid explicit patch also rolls back.
  assert.throws(() => resolveIntake(records, {
    brief: brief.id, expectedVersion: brief.version, requestId: "bad-patch",
    resolutions: [{ clarificationId: first, answer: "x" }], patch: { projectType: "nonsense" as never }, summary: "bad",
  }), /Unknown project type/);
  assert.equal(getClarification(records, first)?.state, "open");
  assert.equal(getClarification(records, second)?.state, "open");
  assert.equal(getBrief(records, brief.id)?.version, brief.version);
  assert.equal(conversationFor(records, brief.id).length, eventsBefore, "no audit events from a refused request");
});

test("INT-02: an identical retry replays the result; a different request under the same id conflicts", (t) => {
  const { records } = setup(t);
  const { brief, first } = twoQuestions(records);
  const request = {
    brief: brief.id, expectedVersion: brief.version, requestId: "req-retry",
    resolutions: [{ clarificationId: first, answer: "A Markdown folder." }],
    patch: { audience: "Me" }, summary: "Audience is the author.",
  };
  const original = resolveIntake(records, request);
  const events = conversationFor(records, brief.id).length;
  const replay = resolveIntake(records, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.briefVersion, original.briefVersion);
  assert.equal(getBrief(records, brief.id)?.version, original.briefVersion, "the patch was not applied twice");
  assert.equal(conversationFor(records, brief.id).length, events, "no duplicate audit events on retry");

  assert.throws(() => resolveIntake(records, { ...request, patch: { audience: "My team" } }), refusal("request_conflict"));
});

test("INT-02: a stale expected version is refused so concurrent changes are not lost", (t) => {
  const { records } = setup(t);
  const { brief, first, second } = twoQuestions(records);
  resolveIntake(records, {
    brief: brief.id, expectedVersion: brief.version, requestId: "writer-a",
    resolutions: [{ clarificationId: first, answer: "Folder." }], patch: { audience: "Me" }, summary: "A",
  });
  assert.throws(() => resolveIntake(records, {
    brief: brief.id, expectedVersion: brief.version, requestId: "writer-b",
    resolutions: [{ clarificationId: second, answer: "Friday." }], patch: { audience: "Team" }, summary: "B",
  }), (error: unknown) => {
    assert.ok(error instanceof IntakeError && error.code === "stale_version");
    assert.equal(error.details.currentVersion, brief.version + 1);
    return true;
  });
  assert.equal(getClarification(records, second)?.state, "open");
  assert.equal(getBrief(records, brief.id)?.audience, "Me");
});

test("INT-02: an answered question needs an explicit revision to change", (t) => {
  const { records } = setup(t);
  const { brief, first } = twoQuestions(records);
  const at = (requestId: string, answer: string, revise = false) => resolveIntake(records, {
    brief: brief.id, expectedVersion: brief.version, requestId, revise, resolutions: [{ clarificationId: first, answer }],
  });
  at("r1", "Folder.");
  assert.equal(at("r2", "Folder.").resolved[0]?.unchanged, true, "restating the same answer is harmless");
  assert.throws(() => at("r3", "Notion."), refusal("already_resolved"));
  assert.equal(getClarification(records, first)?.answer, "Folder.");
  const revised = at("r4", "Notion.", true);
  assert.equal(revised.resolved[0]?.answer, "Notion.");
});

test("INT-02: a governance change in a batch invalidates stale acceptance exactly as an update does", (t) => {
  const { records } = setup(t);
  const brief = personalBrief(records);
  proposeAndAccept(records, brief.id);
  const accepted = getBrief(records, brief.id)!;
  assert.ok(activeAcceptance(records, brief.id));
  const result = resolveIntake(records, {
    brief: brief.id, expectedVersion: accepted.version, requestId: "gov",
    patch: { reviewChoice: "required" }, summary: "The user wants independent review.",
  });
  assert.equal(result.invalidatedAcceptances, 1);
  assert.equal(activeAcceptance(records, brief.id), null);
  assert.equal(result.state, "CLARIFYING");
});

test("INT-02: the CLI resolve command is all-or-nothing and retry-safe", (t) => {
  const { root } = setup(t);
  const { run, json } = cliFor(root);
  const brief = json<{ id: string; version: number }>("brief", "create", `--payload=${JSON.stringify({
    title: "cli-batch", objective: "Summarize notes.", projectType: "personal", reviewChoice: "off",
  })}`, "--by=prathyush");
  const asked = json<{ briefVersion: number; requested: { id: string }[] }>("brief", "ask", brief.id, `--payload=${JSON.stringify({
    questions: [{ question: "Where?", whyItMatters: "Reader.", field: "a" }, { question: "When?", whyItMatters: "Schedule.", field: "b" }],
  })}`);
  const payload = JSON.stringify({ resolutions: asked.requested.map((item) => ({ clarificationId: item.id, answer: "Yes." })) });
  const args = ["brief", "resolve", brief.id, `--version=${asked.briefVersion}`, "--request=cli-1", `--payload=${payload}`, "--by=prathyush"];
  const first = json<{ resolved: unknown[]; replayed: boolean }>(...args);
  assert.equal(first.resolved.length, 2);
  assert.equal(json<{ replayed: boolean }>(...args).replayed, true);
  const conflict = run("brief", "resolve", brief.id, `--version=${asked.briefVersion}`, "--request=cli-1", "--payload={\"patch\":{\"audience\":\"x\"},\"summary\":\"y\"}");
  assert.equal(conflict.status, 1);
  assert.equal((JSON.parse(conflict.stderr) as { error: string }).error, "request_conflict");
});

test("INT-02: schema 19 adds intake requests to an existing schema 18 database", (t) => {
  const { root } = setup(t);
  assert.equal(SCHEMA_VERSION, "19");
  const path = join(root, "v18.sqlite");
  const fresh = new Store(path);
  fresh.run("DROP TABLE intake_requests");
  fresh.run("UPDATE schema_meta SET value = '18' WHERE key = 'schema_version'");
  fresh.close();

  const upgraded = new Store(path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")?.value, "19");
  assert.ok(upgraded.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'intake_requests'"));
});

// --- INT-03 ------------------------------------------------------------------

test("INT-03: project governance on a brief names the brief operation and version instead of a usage error", (t) => {
  const { root } = setup(t);
  const { run, json } = cliFor(root);
  // Without governance, creation returns the pending question and the draft brief.
  const created = json<{ draft: { id: string; version: number } }>("brief", "create", `--payload=${JSON.stringify({
    title: "governed", objective: "Summarize notes.",
  })}`, "--by=prathyush");
  const brief = { brief: created.draft };

  const onBrief = run("project", "governance", brief.brief.id, "--type=personal", "--review=off", "--version=1", "--by=prathyush");
  assert.equal(onBrief.status, 1);
  const body = JSON.parse(onBrief.stderr) as { error: string; subject: string; briefId: string; briefVersion: number; operation: string };
  assert.equal(body.error, "wrong_subject");
  assert.equal(body.subject, "brief");
  assert.equal(body.briefId, brief.brief.id);
  assert.equal(body.briefVersion, brief.brief.version);
  assert.equal(body.operation, "mabs_update_brief");

  const unknown = run("project", "governance", "no-such-thing", "--type=personal", "--review=off", "--version=1");
  assert.equal(unknown.status, 1);
  const missing = JSON.parse(unknown.stderr) as { error: string; subject: string };
  assert.equal(missing.error, "wrong_subject");
  assert.equal(missing.subject, "unknown");
});
