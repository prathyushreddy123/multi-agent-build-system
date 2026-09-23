import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactDir } from "../../src/core/paths.ts";
import {
  EvidenceAccessError,
  assertInsideArtifacts,
  followLog,
  listEvidence,
  readChunk,
  readTail,
  sameFile,
} from "../../src/operator/logs.ts";
import { stepsForTask } from "../../src/operator/progress.ts";
import { openRecords, type Attempt, type Records } from "../../src/store/records.ts";

interface Fixture {
  root: string;
  records: Records;
  taskId: string;
  first: Attempt;
  second: Attempt;
  close: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mabs-op4-"));
  process.env.MABS_STATE_DIR = root;
  process.env.MABS_DB_PATH = join(root, "mabs.sqlite");
  const records = openRecords();
  const project = records.createProject({ name: "logs", repoPath: root, baseBranch: "main" });
  const task = records.createTask({ projectId: project.id, title: "Logged task", objective: "x" });
  records.transition(task.id, "READY");
  records.transition(task.id, "RUNNING");

  const first = records.startAttempt({ taskId: task.id, launchId: "l1", kind: "initial", adapter: "claude", model: "claude-opus-5" });
  const firstDir = artifactDir(task.id, first.id);
  writeFileSync(join(firstDir, "worker.log"), "attempt one line 1\nattempt one line 2\n");
  writeFileSync(join(firstDir, "worker-result.json"), JSON.stringify({ outcome: "failed" }));
  records.finishAttempt({
    attemptId: first.id, state: "failed", failureClass: "CODE", reason: "check failed",
    outputPath: join(firstDir, "worker-result.json"),
  });
  records.recordGate({
    taskId: task.id, attemptId: first.id, name: "typecheck", status: "FAIL", required: true,
    command: "npm run typecheck", toolVersion: null, revision: "rev1",
    evidencePath: join(firstDir, "gate-0-typecheck.log"), durationMs: 500, waiverId: null,
  });
  writeFileSync(join(firstDir, "gate-0-typecheck.log"), "a.ts(1,1): error TS1005\n");

  const second = records.startAttempt({ taskId: task.id, launchId: "l2", kind: "repair", adapter: "codex", model: "gpt-5.4" });
  const secondDir = artifactDir(task.id, second.id);
  writeFileSync(join(secondDir, "worker.log"), "attempt two starting\n");

  return {
    root, records, taskId: task.id, first, second,
    close: () => {
      records.store.close();
      delete process.env.MABS_DB_PATH;
      delete process.env.MABS_STATE_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("evidence is listed per task and per attempt, and old attempts stay reachable", () => {
  const fixture = makeFixture();
  try {
    const all = listEvidence(fixture.records, { taskId: fixture.taskId });
    assert.equal(all.attempts.length, 2);

    // The failed first attempt's evidence is not replaced by the repair's.
    const firstTranscript = all.entries.find((entry) => entry.id === `transcript:${fixture.first.id}`);
    const secondTranscript = all.entries.find((entry) => entry.id === `transcript:${fixture.second.id}`);
    assert.ok(firstTranscript?.exists, "attempt 1 transcript is missing");
    assert.ok(secondTranscript?.exists, "attempt 2 transcript is missing");
    assert.equal(firstTranscript?.attemptNumber, 1);
    assert.equal(secondTranscript?.attemptNumber, 2);

    const check = all.entries.find((entry) => entry.kind === "check");
    assert.equal(check?.label, "typecheck FAIL");
    assert.equal(check?.attemptNumber, 1);

    // Narrowing to one attempt says the others are still available.
    const narrowed = listEvidence(fixture.records, { taskId: fixture.taskId, attemptId: fixture.second.id });
    assert.ok(!narrowed.entries.some((entry) => entry.attemptId === fixture.first.id));
    assert.ok(narrowed.notes.some((note) => note.includes("remain available")));
    assert.equal(narrowed.attempts.length, 2, "the attempt selector still lists every attempt");
  } finally {
    fixture.close();
  }
});

test("a raw transcript is kept and its navigation limit is stated rather than faked", () => {
  const fixture = makeFixture();
  try {
    const listing = listEvidence(fixture.records, { taskId: fixture.taskId });
    const transcript = listing.entries.find((entry) => entry.kind === "worker-transcript");
    assert.equal(transcript?.navigation, "whole-transcript");
    assert.match(String(transcript?.navigationNote), /no per-command boundaries/);
    assert.ok(listing.notes.some((note) => note.includes("Per-command navigation")));

    // Structured records do support per-record navigation.
    const result = listing.entries.find((entry) => entry.kind === "worker-result");
    assert.equal(result?.navigation, "per-record");
    assert.equal(result?.format, "json");
    assert.equal(result?.navigationNote, null);
  } finally {
    fixture.close();
  }
});

test("missing evidence is reported with the retention reason, not silently skipped", () => {
  const fixture = makeFixture();
  try {
    const listing = listEvidence(fixture.records, { taskId: fixture.taskId });
    const completion = listing.entries.find((entry) => entry.kind === "completion");
    // The controller never wrote a completion envelope for this attempt.
    assert.equal(completion?.exists, false);
    assert.match(String(completion?.unavailableReason), /retention pruning/);
    assert.ok(listing.notes.some((note) => note.includes("no longer on disk")));

    const chunk = readChunk(String(completion?.path));
    assert.deepEqual(chunk.lines, []);
    assert.match(String(chunk.unavailableReason), /not a readable evidence file/);
  } finally {
    fixture.close();
  }
});

test("reads are bounded and never emit a partially written line twice", () => {
  const fixture = makeFixture();
  try {
    const path = join(artifactDir(fixture.taskId, fixture.second.id), "worker.log");

    const first = readChunk(path, { offset: 0 });
    assert.deepEqual(first.lines, ["attempt two starting"]);
    assert.equal(first.atEnd, true);

    // Reaching the end of the file does not make an unterminated line complete:
    // a file mid-write looks exactly like one with no final newline.
    writeFileSync(path, "attempt two starting\nunterminated");
    const held = readChunk(path, { offset: 0 });
    assert.deepEqual(held.lines, ["attempt two starting"], "an unterminated line was displayed while writing");
    const flushed = readChunk(path, { offset: 0, allowPartialFinalLine: true });
    assert.deepEqual(flushed.lines, ["attempt two starting", "unterminated"]);
    writeFileSync(path, "attempt two starting\n");

    // A line arrives in two writes, as a streaming worker would produce it.
    appendFileSync(path, "half a li");
    const partial = readChunk(path, { offset: first.to, previous: first.identity });
    assert.deepEqual(partial.lines, [], "an incomplete line was displayed");
    assert.equal(partial.to, first.to, "an incomplete line was consumed");

    appendFileSync(path, "ne now complete\n");
    const completed = readChunk(path, { offset: partial.to, previous: partial.identity });
    assert.deepEqual(completed.lines, ["half a line now complete"]);

    // Re-reading from the new offset yields nothing, so nothing is duplicated.
    const again = readChunk(path, { offset: completed.to, previous: completed.identity });
    assert.deepEqual(again.lines, []);

    // A bounded read stops at maxBytes rather than loading the whole file.
    appendFileSync(path, `${"x".repeat(5000)}\n`);
    const bounded = readChunk(path, { offset: 0, maxBytes: 64 });
    assert.ok(bounded.to <= 64);
    assert.equal(bounded.atEnd, false);
  } finally {
    fixture.close();
  }
});

test("rotation and in-place truncation restart cleanly instead of showing garbage", () => {
  const fixture = makeFixture();
  try {
    const path = join(artifactDir(fixture.taskId, fixture.second.id), "worker.log");
    const before = readChunk(path, { offset: 0 });
    assert.ok(before.identity);

    // Rotated: the old file is moved aside and a new one takes its place.
    renameSync(path, `${path}.1`);
    writeFileSync(path, "rotated file first line\n");
    const rotated = readChunk(path, { offset: before.to, previous: before.identity });
    assert.equal(rotated.rotated, true);
    assert.equal(rotated.from, 0, "a stale offset was applied to the new file");
    assert.deepEqual(rotated.lines, ["rotated file first line"]);
    assert.equal(sameFile(before.identity, rotated.identity), false);

    // Truncated in place: same inode, smaller than the saved offset.
    appendFileSync(path, "second line\nthird line\n");
    const grown = readChunk(path, { offset: rotated.to, previous: rotated.identity });
    truncateSync(path, 0);
    writeFileSync(path, "restarted\n");
    const restarted = readChunk(path, { offset: grown.to, previous: grown.identity });
    assert.equal(restarted.rotated, true);
    assert.deepEqual(restarted.lines, ["restarted"]);
  } finally {
    fixture.close();
  }
});

test("following yields only new bytes and ends when the run ends", async () => {
  const fixture = makeFixture();
  try {
    const path = join(artifactDir(fixture.taskId, fixture.second.id), "worker.log");
    let finished = false;
    const seen: string[] = [];

    const follow = (async () => {
      for await (const chunk of followLog(path, { fromOffset: 0, pollMs: 50, isFinished: () => finished })) {
        seen.push(...chunk.lines);
      }
    })();

    await new Promise((done) => setTimeout(done, 120));
    appendFileSync(path, "streamed one\n");
    await new Promise((done) => setTimeout(done, 150));
    appendFileSync(path, "streamed two\n");
    await new Promise((done) => setTimeout(done, 150));
    finished = true;
    await new Promise((done) => setTimeout(done, 250));
    await follow;

    assert.deepEqual(seen, ["attempt two starting", "streamed one", "streamed two"]);
    // No line is displayed twice across appends.
    assert.equal(new Set(seen).size, seen.length);
  } finally {
    fixture.close();
  }
});

test("following stops on request without touching the file or the run", async () => {
  const fixture = makeFixture();
  try {
    const path = join(artifactDir(fixture.taskId, fixture.second.id), "worker.log");
    const stop = new AbortController();
    const seen: string[] = [];
    const follow = (async () => {
      for await (const chunk of followLog(path, { fromOffset: 0, pollMs: 50, signal: stop.signal })) {
        seen.push(...chunk.lines);
      }
    })();

    await new Promise((done) => setTimeout(done, 120));
    stop.abort();
    await follow;

    // The attempt is still running: closing Logs does not end it.
    assert.equal(fixture.records.getAttempt(fixture.second.id)?.state, "running");
    assert.deepEqual(seen, ["attempt two starting"]);
  } finally {
    fixture.close();
  }
});

test("control sequences from a log are escaped when drawn, and the file is left intact", () => {
  const fixture = makeFixture();
  try {
    const path = join(artifactDir(fixture.taskId, fixture.second.id), "worker.log");
    const hostile = "before\u001b[2J\u001b]0;pwned\u0007after\n";
    writeFileSync(path, hostile);

    const chunk = readChunk(path, { offset: 0 });
    const drawn = chunk.lines.join("\n");
    assert.ok(!drawn.includes("\u001b"), "an escape character reached the display");
    assert.ok(!drawn.includes("\u0007"), "a bell character reached the display");
    assert.match(drawn, /before/);
    assert.match(drawn, /after/);

    // The evidence file itself is unchanged; it is the record.
    assert.equal(readFileSync(path, "utf8"), hostile);
  } finally {
    fixture.close();
  }
});

test("only evidence inside the MABS artifacts directory can be opened", () => {
  const fixture = makeFixture();
  try {
    const outside = join(fixture.root, "outside.log");
    writeFileSync(outside, "secret\n");
    assert.throws(() => assertInsideArtifacts(outside), EvidenceAccessError);
    assert.throws(() => readChunk("/etc/passwd"), EvidenceAccessError);
    assert.throws(() => readChunk(join(fixture.root, "artifacts", "..", "outside.log")), EvidenceAccessError);

    const inside = join(artifactDir(fixture.taskId, fixture.first.id), "worker.log");
    assert.doesNotThrow(() => assertInsideArtifacts(inside));
  } finally {
    fixture.close();
  }
});

test("the tail reads the end of a large file without loading all of it", () => {
  const fixture = makeFixture();
  try {
    const dir = artifactDir(fixture.taskId, fixture.first.id);
    const path = join(dir, "worker.log");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n") + "\n");

    // A window smaller than the file forces the tail to skip the beginning.
    const tail = readTail(path, 10, 2048);
    assert.equal(tail.lines.length, 10);
    assert.equal(tail.lines.at(-1), "line 4999");
    assert.ok(tail.skippedBytes > 0, "the tail read the whole file");
    assert.equal(tail.atEnd, true);

    // A file that fits in the window is read whole, and its final line is shown
    // even without a trailing newline.
    writeFileSync(path, "only line, no newline");
    const small = readTail(path, 10);
    assert.deepEqual(small.lines, ["only line, no newline"]);
    assert.equal(small.skippedBytes, 0);
  } finally {
    fixture.close();
  }
});

test("a step's evidence reference resolves to the right attempt's file", () => {
  const fixture = makeFixture();
  try {
    // Every recorded step points at evidence IDs the Logs surface can open,
    // so a compact summary is never a dead end.
    const steps = stepsForTask(fixture.records, fixture.taskId);
    const listing = listEvidence(fixture.records, { taskId: fixture.taskId });
    const evidenceIds = new Set(listing.entries.map((entry) => entry.id));
    const referenced = steps.flatMap((step) => step.evidenceRefs);
    assert.ok(referenced.length > 0, "no step referenced any evidence");
    for (const ref of referenced) {
      assert.ok(evidenceIds.has(ref), `${ref} is not an evidence record the Logs surface lists`);
    }
    const gateStep = steps.find((step) => step.source === "gate");
    assert.deepEqual(gateStep?.evidenceRefs.length, 1);
    const gateEvidence = listing.entries.find((entry) => entry.id === gateStep?.evidenceRefs[0]);
    assert.equal(gateEvidence?.attemptId, fixture.first.id, "a check opened the wrong attempt's evidence");

    const firstTranscript = listing.entries.find((entry) => entry.id === `transcript:${fixture.first.id}`);
    const secondTranscript = listing.entries.find((entry) => entry.id === `transcript:${fixture.second.id}`);

    assert.deepEqual(readChunk(String(firstTranscript?.path), { offset: 0 }).lines, [
      "attempt one line 1", "attempt one line 2",
    ]);
    assert.deepEqual(readChunk(String(secondTranscript?.path), { offset: 0 }).lines, ["attempt two starting"]);
  } finally {
    fixture.close();
  }
});
