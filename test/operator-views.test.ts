import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { governancePrompts, queueExplanations, taskScorecard, taskTimeline } from "../src/diagnostics/views.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";
import { FileExporter, HttpJsonExporter, exporterFromSpec, redactEvent } from "../src/telemetry/exporter.ts";
import { BoundedTelemetryQueue } from "../src/telemetry/sink.ts";
import { createWorkbench } from "../src/workbench/server.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-views-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = join(root, "state");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, records };
}

function accept(records: Records, taskId: string, review: { status: "approved" | "not_required"; reviewId?: string | null }) {
  records.transition(taskId, "READY");
  records.transition(taskId, "RUNNING");
  records.transition(taskId, "CHECKING");
  records.transition(taskId, "DONE");
  records.recordEvent({ kind: "task.accepted", taskId, data: { reason: "test", review: { status: review.status, reviewId: review.reviewId ?? null } } });
}

test("OBS-03: unknown type, personal off, and client required are distinct and never defaulted", (t) => {
  const { root, records } = setup(t);
  const unknown = records.createProject({ name: "unclassified", repoPath: root });
  const prompts = governancePrompts(records);
  const prompt = prompts.find((item) => item.projectId === unknown.id);
  assert.ok(prompt, "the unclassified project needs input");
  assert.ok(prompt.missing.includes("project_type"));
  assert.equal(prompt.questions.every((question) => question.default === null), true, "no answer is preselected");
  assert.match(prompt.answerWith, /--type=<personal\|client\|other>/);

  const personal = records.createProject({ name: "personal-off", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const off = records.createTask({ projectId: personal.id, title: "off", objective: "o" });
  accept(records, off.id, { status: "not_required" });
  const offCard = taskScorecard(records, off.id);
  assert.equal(offCard.review.status, "not_required");
  assert.match(offCard.review.label, /not an approval/);

  const client = records.createProject({ name: "client", repoPath: root, projectType: "client", reviewChoice: "required" });
  const reviewed = records.createTask({ projectId: client.id, title: "reviewed", objective: "o" });
  accept(records, reviewed.id, { status: "approved", reviewId: "rev_test" });
  assert.equal(taskScorecard(records, reviewed.id).review.status, "approved");
  assert.equal(prompts.some((item) => item.projectId === personal.id || item.projectId === client.id), false);
});

test("OBS-04/OBS-05: failed attempts with missing usage are counted, and requested, configured, and reported settings stay distinct", (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "p", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const task = records.createTask({ projectId: project.id, title: "t", objective: "o" });
  const failed = records.startAttempt({
    taskId: task.id, launchId: "lnc_a", kind: "initial", adapter: "codex", model: null, effort: "high",
    engineVersion: "mabs.controller.stage.v1", promptVersion: "worker-packet-v3+worker-roles-v2",
  });
  records.finishAttempt({ attemptId: failed.id, state: "failed", failureClass: "QUOTA", reason: "usage limit" });
  const succeeded = records.startAttempt({
    taskId: task.id, launchId: "lnc_b", kind: "reroute", adapter: "claude", model: "claude-opus-5", effort: null,
    engineVersion: "mabs.controller.stage.v1", promptVersion: "worker-packet-v3+worker-roles-v2",
  });
  records.finishAttempt({
    attemptId: succeeded.id, state: "succeeded", reportedModel: "claude-opus-5",
    usage: { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 50 },
  });
  const card = taskScorecard(records, task.id);
  assert.equal(card.attempts.length, 2, "the failed attempt is part of the scorecard");
  assert.deepEqual(card.usageCoverage, { attempts: 2, complete: 1, partial: 0, missing: 1, malformed: 0 });
  const [first, second] = card.attempts;
  assert.deepEqual(first?.effort, { requested: "high", configured: "high", reported: "unknown (not reported by the provider)" });
  assert.deepEqual(first?.model, { requested: null, configured: "provider default", reported: "unknown (not reported by the provider)" });
  assert.equal(second?.model.reported, "claude-opus-5");
  assert.deepEqual(card.provenance.engineVersions, ["mabs.controller.stage.v1"]);
  assert.deepEqual(card.provenance.promptVersions, ["worker-packet-v3+worker-roles-v2"]);
});

test("queue explanations name the actual reason each task waits", (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "q", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const running = records.createTask({ projectId: project.id, title: "running", objective: "o" });
  records.transition(running.id, "READY");
  records.transition(running.id, "RUNNING");
  const ready = records.createTask({ projectId: project.id, title: "ready", objective: "o" });
  records.transition(ready.id, "READY");
  records.createTask({ projectId: project.id, title: "later", objective: "o", dependsOn: [ready.id] });
  const explained = queueExplanations(records);
  const byTitle = new Map(explained.items.map((item) => [item.title, item]));
  assert.equal(byTitle.get("ready")?.category, "capacity");
  assert.match(byTitle.get("ready")?.reasons.join() ?? "", /repository is held by/);
  assert.equal(byTitle.get("later")?.category, "dependency");
  assert.equal(queueExplanations(records, { limit: 1 }).items.length, 1, "bounded pages");
});

test("the timeline is paged and bounded", (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "tl", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const task = records.createTask({ projectId: project.id, title: "t", objective: "o" });
  for (let index = 0; index < 60; index += 1) records.recordEvent({ kind: "test.tick", taskId: task.id, data: { index, evidencePath: "/tmp/e.log" } });
  const first = taskTimeline(records, task.id, { limit: 25 });
  assert.equal(first.items.length, 25);
  assert.ok(first.total >= 61);
  assert.deepEqual(first.items[0]?.evidence, ["/tmp/e.log"]);
  assert.equal(taskTimeline(records, task.id, { limit: 10_000 }).limit, 500, "page size is capped");
});

test("export is disabled by default and redacts prompts and secrets when enabled", async (t) => {
  const { root } = setup(t);
  assert.equal(exporterFromSpec(undefined), null, "no target, no exporter");
  assert.throws(() => exporterFromSpec("ftp://nowhere"), /must be file/);
  assert.throws(() => exporterFromSpec("file:relative.jsonl"), /absolute path/);

  const event = {
    kind: "attempt.progress", at: new Date().toISOString(), taskId: "tsk", attemptId: "att",
    data: { provider: "codex", events: 3, prompt: "SECRET PROMPT", excerpt: "file body", apiKey: "sk-123", lastEventType: "turn.started" },
  };
  assert.deepEqual(redactEvent(event).data, { provider: "codex", events: 3, lastEventType: "turn.started" });

  const path = join(root, "export", "events.jsonl");
  const queue = new BoundedTelemetryQueue({ exporter: new FileExporter(path) });
  queue.emit(event);
  await queue.flush();
  const written = readFileSync(path, "utf8");
  assert.doesNotMatch(written, /SECRET PROMPT|file body|sk-123/);
  assert.match(written, /mabs\.telemetry-export\.v1/);

  const bodies: string[] = [];
  const http = new HttpJsonExporter("http://127.0.0.1:9/collect", {
    fetchImpl: (async (_url: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  await http.export([event]);
  assert.doesNotMatch(bodies[0] ?? "", /SECRET PROMPT|sk-123/);

  const disabled = new BoundedTelemetryQueue();
  disabled.emit(event);
  await disabled.flush();
  assert.equal(disabled.stats().exporter, null);
  assert.equal(existsSync(join(root, "state", "telemetry-status.json")), false, "a disabled exporter records nothing");
});

test("the native workbench serves scorecards, queue explanations, and readiness with no external service", async (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "wb", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const task = records.createTask({ projectId: project.id, title: "t", objective: "o" });
  const workbench = createWorkbench(records, { port: 0 });
  const address = await workbench.listen();
  t.after(() => new Promise<void>((resolvePromise) => workbench.server.close(() => resolvePromise())));
  const origin = `http://${address.host}:${address.port}`;
  const scorecard = await (await fetch(`${origin}/api/tasks/${task.id}/scorecard`)).json() as { review: { status: string } };
  assert.equal(scorecard.review.status, "not_yet_decided");
  const queue = await (await fetch(`${origin}/api/queue?limit=5`)).json() as { limit: number };
  assert.equal(queue.limit, 5);
  assert.ok(Array.isArray(await (await fetch(`${origin}/api/readiness`)).json()));
  const improvements = await (await fetch(`${origin}/api/projects/${project.id}/improvements`)).json() as { incidents: unknown[] };
  assert.deepEqual(improvements.incidents, []);
  const detail = await (await fetch(`${origin}/api/tasks/${task.id}`)).json() as { scorecard: { task: { id: string } } };
  assert.equal(detail.scorecard.task.id, task.id);
});
