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
import { answerClarification, askClarifications } from "../src/intake/service.ts";
import { createBrief, getClarification } from "../src/intake/store.ts";
import { Records } from "../src/store/records.ts";
import { Store } from "../src/store/db.ts";

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
