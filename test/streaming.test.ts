import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HarnessAdapter } from "../src/adapters/harness.ts";
import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";
import { BoundedTelemetryQueue, type TelemetryEvent } from "../src/telemetry/sink.ts";
import { LineAssembler, LiveLog, ProviderStreamParser, readProgress, telemetryGap } from "../src/telemetry/stream.ts";
import { launchCodex } from "../src/verify/launch.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";
import { CODEX_MODEL } from "../src/routing/capabilities.ts";

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function tempRoot(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A fake `codex` that streams two events a while apart, splitting a multibyte
 * character across writes, then writes a valid worker result and exits.
 */
function slowCodex(t: TestContext, pauseMs: number): void {
  const bin = join(tempRoot(t, "mabs-slow-codex-"), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.argv[process.argv.indexOf("-C") + 1];
const out = (text) => fs.writeSync(1, text);
out(JSON.stringify({ type: "thread.started", thread_id: "slow" }) + "\\n");
const snowman = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "caf\\u00e9 \\u2603" } }) + "\\n");
fs.writeSync(1, snowman.subarray(0, snowman.length - 4));
setTimeout(() => {
  fs.writeSync(1, snowman.subarray(snowman.length - 4));
  out("not json progress text\\n");
  out("{broken json\\n");
  fs.mkdirSync(path.join(cwd, ".mabs"), { recursive: true });
  const result = { outcome: "completed", reason: "done", summary: "streamed", evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] },
    follow_up: { unresolved: [], decisions_requested: [], next_step: null }, usage: { model: null, input_tokens: null, output_tokens: null }, addressed_requirements: [] };
  fs.writeFileSync(path.join(cwd, ".mabs", "result.json"), JSON.stringify(result));
  out(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }) + "\\n");
  out(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }) + "\\n");
}, ${pauseMs});
`);
  chmodSync(join(bin, "codex"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => { process.env.PATH = previous; });
}

test("stream parsing survives chunk splits, malformed lines, and plain text without inventing values", () => {
  const assembler = new LineAssembler();
  assert.deepEqual(assembler.push('{"type":"a"'), []);
  assert.deepEqual(assembler.push('}\n{"ty'), ['{"type":"a"}']);
  assert.deepEqual(assembler.push('pe":"b"}\npartial'), ['{"type":"b"}']);
  assert.deepEqual(assembler.flush(), ["partial"]);

  const parser = new ProviderStreamParser("codex");
  parser.push('{"type":"thread.started","thread_id":"t1"}\n{oops\nplain text\n{"type":"turn.st');
  parser.push('arted"}\n');
  parser.end();
  const progress = parser.snapshot({ bytesWritten: 0, bytesDropped: 0, truncated: false, writeErrors: 0 }, true);
  assert.equal(progress.events, 2);
  assert.equal(progress.malformedLines, 1);
  assert.equal(progress.textLines, 1);
  assert.equal(progress.lastEventType, "turn.started");
  assert.equal(progress.observedUsage, null, "no usage is synthesized when the provider sent none");
  assert.equal(parser.sessionId, "t1");
  assert.deepEqual(telemetryGap(progress), ["1 malformed provider event line(s)"]);
});

test("a bounded live log marks its own truncation and counts what it dropped", (t) => {
  const path = join(tempRoot(t, "mabs-live-log-"), "worker.log");
  const log = new LiveLog(path, 32);
  log.write("0123456789".repeat(2));
  log.write("é".repeat(20));
  log.write("more after the limit");
  const stats = log.snapshot();
  assert.equal(stats.truncated, true);
  assert.ok(stats.bytesWritten <= 32);
  assert.equal(stats.bytesWritten + stats.bytesDropped, 20 + 40 + 20);
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /�/, "the cut never splits a UTF-8 character");
  assert.match(text, /\[mabs: live log truncated at 32 bytes/);
  assert.match(telemetryGap({ ...new ProviderStreamParser("codex").snapshot(stats, true) }).join(), /truncated; \d+ bytes not stored/);
});

test("OBS-01: provider output is on disk and in the progress record before the process exits", async (t) => {
  slowCodex(t, 1_500);
  const cwd = tempRoot(t, "mabs-stream-cwd-");
  const evidencePath = join(cwd, "worker.log");
  const progressPath = join(cwd, "progress.json");
  const running = launchCodex({ cwd, prompt: "p", model: CODEX_MODEL, effort: "low", timeoutMs: 20_000, evidencePath, progressPath });
  let midway = readProgress(progressPath);
  const deadline = Date.now() + 1_200;
  while (!midway && Date.now() < deadline) {
    await sleep(50);
    midway = readProgress(progressPath);
  }
  assert.ok(midway, "progress exists while the provider is still running");
  assert.equal(midway.final, false);
  assert.equal(midway.lastEventType, "thread.started");
  assert.match(readFileSync(evidencePath, "utf8"), /thread\.started/, "log content is visible before exit");

  const result = await running;
  const log = readFileSync(evidencePath, "utf8");
  assert.match(log, /café ☃/, "a character split across writes arrives intact");
  assert.match(log, /--- stderr ---/);
  assert.equal(result.sessionId, "slow");
  assert.deepEqual(result.usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 });
  assert.equal(result.telemetry?.malformedLines, 1);
  assert.equal(result.telemetry?.textLines, 1);
  const final = readProgress(progressPath);
  assert.equal(final?.final, true);
  assert.equal(final?.events, 4);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd });
}

function controllerFixture(t: TestContext) {
  const root = tempRoot(t, "mabs-stream-controller-");
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "initial\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const project = records.createProject({
    name: "stream", repoPath: repo, projectType: "personal", reviewChoice: "off", reviewPolicy: { mode: "none", skipTaskClasses: [] },
  });
  const task = records.createTask({ projectId: project.id, title: "stream", objective: "o", acceptanceCriteria: ["c"], taskClass: "small_implementation" });
  return { records, task };
}

test("OBS-01: the controller records live progress separately from liveness, and usage only once", async (t) => {
  slowCodex(t, 2_000);
  const { records, task } = controllerFixture(t);
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", new HarnessAdapter("codex", VERIFIED_REGISTRY)]]), defaultAdapter: "codex", workerLimit: 1,
  });
  await controller.tick();
  const attempt = records.listAttempts(task.id)[0];
  assert.ok(attempt);
  const deadline = Date.now() + 1_800;
  while (!records.listEventsOfKind(task.id, "attempt.first_output").length && Date.now() < deadline) {
    await sleep(100);
    await controller.tick();
  }
  const whileRunning = records.getAttempt(attempt.id);
  assert.equal(whileRunning?.state, "running");
  assert.equal(records.listEventsOfKind(task.id, "attempt.first_output").length, 1, "readiness is recorded once, while running");
  assert.ok(Date.parse(whileRunning?.lastProgressAt ?? "") > Date.parse(attempt.startedAt), "progress advanced from a real provider event");
  assert.equal(whileRunning?.usage, null, "live usage is observed, not recorded, until the final envelope");

  const until = Date.now() + 15_000;
  while (records.getAttempt(attempt.id)?.state === "running" && Date.now() < until) {
    await sleep(100);
    await controller.tick();
  }
  await controller.stop();
  const finished = records.getAttempt(attempt.id);
  assert.equal(finished?.state, "succeeded", finished?.reason ?? "");
  assert.equal((finished?.usage as { input_tokens?: number } | null)?.input_tokens, 100, "final usage recorded exactly once");
  assert.equal(records.listEventsOfKind(task.id, "attempt.first_output").length, 1);
  const gap = records.listEventsOfKind(task.id, "telemetry.gap");
  assert.equal(gap.length, 1, "the malformed provider line is reported as a telemetry gap");
  assert.match(String(gap[0]?.data), /1 malformed provider event line/);
  assert.equal(readProgress(join(process.env.MABS_STATE_DIR as string, "artifacts", task.id, attempt.id, "progress.json"))?.final, true);
});

class ImmediateAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name = "codex";
  starts = 0;
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts += 1;
    writeFileSync(join(input.cwd, "value.txt"), "changed\n");
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
        apiEquivalentEstimateUsd: null, sessionId: null, raw: "", stderr: "" },
      validation: validateWorkerOutput({
        outcome: "completed", reason: "done", summary: "done",
        evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null }, addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

test("OBS-02: an exporter outage never stops execution, and loss is counted", async (t) => {
  const { records, task } = controllerFixture(t);
  let calls = 0;
  const queue = new BoundedTelemetryQueue({
    capacity: 3,
    exporter: { name: "down", export: async () => { calls += 1; throw new Error("collector unreachable"); } },
  });
  for (let index = 0; index < 5; index += 1) {
    queue.emit({ kind: "x", at: new Date().toISOString(), data: { index } } satisfies TelemetryEvent);
  }
  await queue.flush();
  const stats = queue.stats();
  assert.equal(stats.dropped, 2, "the bounded queue dropped the oldest events and counted them");
  assert.equal(stats.exportFailures, 1);
  assert.equal(stats.lastExportError, "collector unreachable");
  assert.equal(stats.queued, 3, "the failed batch is retained up to the bound");

  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", new ImmediateAdapter()]]), defaultAdapter: "codex", workerLimit: 1, telemetry: queue,
  });
  for (let tick = 0; tick < 3; tick += 1) await controller.tick();
  await controller.stop();
  assert.equal(records.getTask(task.id)?.state, "DONE", "local execution completed despite the exporter outage");
  assert.ok(calls >= 1);
});

test("disabled telemetry retains and sends nothing", () => {
  const queue = new BoundedTelemetryQueue();
  queue.emit({ kind: "x", at: new Date().toISOString(), data: {} });
  assert.deepEqual(queue.stats(), { queued: 0, emitted: 0, exported: 0, dropped: 0, exportFailures: 0, lastExportError: null, exporter: null });
});
