import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";
import {
  USAGE_NORMALIZER_VERSION,
  attemptDuration,
  normalizeProviderUsage,
  normalizeUsageStream,
  summarizeDurations,
  summarizeUsage,
  usageProjectionFields,
  type UsageAttemptSource,
} from "../src/usage/index.ts";

interface UsageFixture {
  adapter: string;
  usage_json: Record<string, number>;
  expected: { known_input_events: number; known_output_tokens: number };
}

interface CohortFixture {
  expected: { known_input_events: number; known_output_tokens: number; missing_usage_attempts: number };
  cohorts: Array<{
    project_id: string;
    known_input_events: number;
    known_output_tokens: number;
    missing_usage_attempts: number;
  }>;
  tasks: Array<{ project_id: string; id: string; attempts: number }>;
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/execution-history/${name}`, import.meta.url), "utf8")) as T;
}

const codex = fixture<UsageFixture>("codex-usage-cached-subset.json");
const claude = fixture<UsageFixture>("claude-usage-separate-cache.json");

/**
 * Rebuild the sanitized historical cohort exactly as `fixtures/execution-history`
 * records it: the first attempt of each cohort carries the whole reported total,
 * later attempts report explicit zeros, and the last five MABS UI attempts have
 * no recorded usage at all.
 */
function historicalSources(summary: CohortFixture, projectId: string): UsageAttemptSource[] {
  const tasks = summary.tasks.filter((task) => task.project_id === projectId);
  const isStudy = projectId === "prj_fixture_study";
  const sources: UsageAttemptSource[] = [];
  let cohortAttempt = 0;
  for (const task of tasks) {
    for (let index = 0; index < task.attempts; index += 1) {
      const missing = !isStudy && cohortAttempt >= 16;
      const zeros = isStudy
        ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
      sources.push({
        attemptId: `${projectId}_att_${String(cohortAttempt).padStart(3, "0")}`,
        adapter: isStudy ? "claude" : "codex",
        raw: missing ? null : JSON.stringify(cohortAttempt === 0 ? (isStudy ? claude.usage_json : codex.usage_json) : zeros),
      });
      cohortAttempt += 1;
    }
  }
  return sources;
}

test("provider cache semantics are preserved and never double-counted", () => {
  const codexUsage = normalizeProviderUsage(codex.adapter, codex.usage_json);
  assert.equal(codexUsage.sourceSemantics, "codex-input-includes-cache");
  assert.equal(codexUsage.coverage, "complete");
  // cached_input_tokens is a documented subset of input_tokens.
  assert.equal(codexUsage.knownInputEvents, codex.expected.known_input_events);
  assert.equal(codexUsage.knownInputEvents, codexUsage.inputTokens);
  assert.equal(codexUsage.cachedInputTokens, 40_000_000);
  assert.equal(codexUsage.uncachedInputTokens, 56_712_129 - 40_000_000);
  assert.equal(codexUsage.cacheReadInputTokens, null);
  assert.equal(codexUsage.outputTokens, codex.expected.known_output_tokens);

  const claudeUsage = normalizeProviderUsage(claude.adapter, claude.usage_json);
  assert.equal(claudeUsage.sourceSemantics, "claude-cache-is-separate");
  assert.equal(claudeUsage.coverage, "complete");
  // Cache read and cache creation are separate reported input events.
  assert.equal(claudeUsage.knownInputEvents, claude.expected.known_input_events);
  assert.equal(claudeUsage.knownInputEvents, 20_000_000 + 6_000_000 + 335_484);
  assert.equal(claudeUsage.cacheReadInputTokens, 6_000_000);
  assert.equal(claudeUsage.cacheWriteInputTokens, 335_484);
  assert.equal(claudeUsage.cachedInputTokens, null);
  assert.equal(claudeUsage.outputTokens, claude.expected.known_output_tokens);

  // An unknown provider is not assumed to share either schema's semantics.
  const unknown = normalizeProviderUsage("some-future-cli", {
    input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 999, cached_input_tokens: 999,
  });
  assert.equal(unknown.sourceSemantics, "generic-reported");
  assert.equal(unknown.knownInputEvents, 10);
  assert.equal(unknown.cacheReadInputTokens, null);
  assert.equal(unknown.cachedInputTokens, null);
});

test("missing, zero, partial, and malformed usage stay distinguishable", () => {
  const zero = normalizeProviderUsage("claude", {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  });
  assert.equal(zero.coverage, "complete");
  assert.equal(zero.knownInputEvents, 0);
  assert.equal(zero.outputTokens, 0);

  for (const absent of [null, undefined, "", "   ", {}]) {
    const missing = normalizeProviderUsage("claude", absent);
    assert.equal(missing.coverage, "missing", `${JSON.stringify(absent)} is missing, not zero`);
    assert.equal(missing.knownInputEvents, null);
    assert.equal(missing.outputTokens, null);
  }

  const partial = normalizeProviderUsage("claude", { input_tokens: 12, output_tokens: 3 });
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.knownInputEvents, 12);
  assert.ok(partial.limitations.some((limitation) => limitation.includes("cache_read_input_tokens is absent")));

  const malformed = normalizeProviderUsage("codex", "not-json");
  assert.equal(malformed.coverage, "malformed");
  assert.equal(malformed.knownInputEvents, null);
  const notAnObject = normalizeProviderUsage("codex", "[1,2,3]");
  assert.equal(notAnObject.coverage, "malformed");
  const invalidFields = normalizeProviderUsage("codex", { input_tokens: -5, output_tokens: 1.5 });
  assert.equal(invalidFields.coverage, "malformed");
  assert.equal(invalidFields.knownInputEvents, null);
  const halfInvalid = normalizeProviderUsage("codex", { input_tokens: 7, output_tokens: "many" });
  assert.equal(halfInvalid.coverage, "partial");
  assert.equal(halfInvalid.knownInputEvents, 7);
  assert.equal(halfInvalid.outputTokens, null);
});

test("cumulative snapshots are not summed while incremental deltas are", () => {
  const cumulative = normalizeUsageStream("codex", [
    { id: "turn-1", sequence: 1, kind: "cumulative", raw: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
    { id: "turn-2", sequence: 2, kind: "cumulative", raw: { input_tokens: 250, cached_input_tokens: 100, output_tokens: 25 } },
  ]);
  assert.equal(cumulative.knownInputEvents, 250);
  assert.equal(cumulative.outputTokens, 25);
  assert.deepEqual(cumulative.countedEvents, ["turn-2"]);
  assert.deepEqual(cumulative.ignoredEvents, ["turn-1"]);

  const deltas = normalizeUsageStream("codex", [
    { id: "turn-1", sequence: 1, kind: "delta", raw: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
    { id: "turn-2", sequence: 2, kind: "delta", raw: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 15 } },
  ]);
  assert.equal(deltas.knownInputEvents, 250);
  assert.equal(deltas.outputTokens, 25);
  assert.deepEqual(deltas.countedEvents, ["turn-1", "turn-2"]);

  // Out-of-order snapshots are ordered by the provider sequence, not arrival.
  const reordered = normalizeUsageStream("codex", [
    { id: "turn-2", sequence: 2, kind: "cumulative", raw: { input_tokens: 250, cached_input_tokens: 100, output_tokens: 25 } },
    { id: "turn-1", sequence: 1, kind: "cumulative", raw: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
  ]);
  assert.equal(reordered.knownInputEvents, 250);
  assert.equal(reordered.coverage, "complete");
});

test("repeated events, final envelopes, and contradictions are handled without double counting", () => {
  const repeated = normalizeUsageStream("codex", [
    { id: "turn-1", sequence: 1, kind: "delta", raw: { input_tokens: 100, output_tokens: 10 } },
    { id: "turn-1", sequence: 1, kind: "delta", raw: { input_tokens: 100, output_tokens: 10 } },
    { id: "turn-2", sequence: 2, kind: "delta", raw: { input_tokens: 50, output_tokens: 5 } },
  ]);
  assert.equal(repeated.knownInputEvents, 150);
  assert.deepEqual(repeated.duplicateEvents, ["turn-1"]);
  assert.equal(repeated.conflicts.length, 0);

  const contradictingRepeat = normalizeUsageStream("codex", [
    { id: "turn-1", sequence: 1, kind: "delta", raw: { input_tokens: 100, output_tokens: 10 } },
    { id: "turn-1", sequence: 1, kind: "delta", raw: { input_tokens: 900, output_tokens: 90 } },
  ]);
  assert.equal(contradictingRepeat.knownInputEvents, 100);
  assert.equal(contradictingRepeat.coverage, "partial");
  assert.ok(contradictingRepeat.conflicts.some((conflict) => conflict.includes("more than once")));

  // A final envelope replaces earlier snapshots instead of adding another total.
  const finalized = normalizeUsageStream("codex", [
    { id: "turn-1", sequence: 1, kind: "cumulative", raw: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
    { id: "turn-2", sequence: 2, kind: "cumulative", raw: { input_tokens: 250, cached_input_tokens: 100, output_tokens: 25 } },
    { id: "completed", sequence: 3, kind: "final", raw: { input_tokens: 250, cached_input_tokens: 100, output_tokens: 25 } },
  ]);
  assert.equal(finalized.knownInputEvents, 250);
  assert.equal(finalized.coverage, "complete");
  assert.deepEqual(finalized.countedEvents, ["completed"]);
  assert.deepEqual(finalized.ignoredEvents, ["turn-1", "turn-2"]);

  // A decreasing cumulative snapshot is contradictory evidence; the latest value
  // is reported, the contradiction is kept, and coverage stops being clean.
  const decreasing = normalizeUsageStream("codex", [
    { id: "turn-1", sequence: 1, kind: "cumulative", raw: { input_tokens: 900, output_tokens: 90 } },
    { id: "turn-2", sequence: 2, kind: "cumulative", raw: { input_tokens: 400, output_tokens: 40 } },
  ]);
  assert.equal(decreasing.knownInputEvents, 400);
  assert.equal(decreasing.coverage, "partial");
  assert.ok(decreasing.conflicts.some((conflict) => conflict.includes("400")));

  // Mixed semantics never add a delta into a snapshot that already contains it.
  const mixed = normalizeUsageStream("codex", [
    { id: "snapshot", sequence: 1, kind: "cumulative", raw: { input_tokens: 300, output_tokens: 30 } },
    { id: "increment", sequence: 2, kind: "delta", raw: { input_tokens: 100, output_tokens: 10 } },
  ]);
  assert.equal(mixed.knownInputEvents, 300);
  assert.equal(mixed.coverage, "partial");
  assert.deepEqual(mixed.ignoredEvents, ["increment"]);

  // Undeclared stream semantics are not guessed.
  const undeclared = normalizeUsageStream("codex", [
    { id: "a", raw: { input_tokens: 100, output_tokens: 10 } },
    { id: "b", raw: { input_tokens: 250, output_tokens: 25 } },
  ]);
  assert.equal(undeclared.knownInputEvents, 250);
  assert.equal(undeclared.coverage, "partial");
  assert.ok(undeclared.limitations.some((limitation) => limitation.includes("cumulative or incremental")));
  assert.equal(normalizeUsageStream("codex", []).coverage, "missing");
});

test("multiple-model usage and reasoning subsets are reported as subsets", () => {
  const multiModel = normalizeProviderUsage("claude", {
    usage: {
      input_tokens: 1_000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100, output_tokens: 200,
    },
    modelUsage: {
      "claude-opus-5": { inputTokens: 900, cacheReadInputTokens: 500, cacheCreationInputTokens: 100, outputTokens: 150, canonicalModel: "claude-opus-5" },
      "claude-haiku-4-5": { inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 50 },
    },
    reported_model: "claude-opus-5",
  });
  assert.equal(multiModel.coverage, "complete");
  assert.equal(multiModel.knownInputEvents, 1_600);
  assert.equal(multiModel.reportedModel, "claude-opus-5");
  assert.deepEqual(multiModel.models.map((model) => model.model), ["claude-haiku-4-5", "claude-opus-5"]);
  assert.equal(multiModel.models.reduce((total, model) => total + (model.knownInputEvents ?? 0), 0), 1_600);
  assert.equal(multiModel.conflicts.length, 0);

  const inconsistent = normalizeProviderUsage("claude", {
    usage: { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 },
    modelUsage: { "claude-opus-5": { inputTokens: 700, outputTokens: 200 } },
  });
  assert.equal(inconsistent.knownInputEvents, 1_000, "the envelope total stays authoritative");
  assert.equal(inconsistent.coverage, "partial");
  assert.ok(inconsistent.conflicts.some((conflict) => conflict.includes("700")));

  const reasoning = normalizeProviderUsage("codex", {
    input_tokens: 500, cached_input_tokens: 200, output_tokens: 120, reasoning_output_tokens: 90,
  });
  assert.equal(reasoning.outputTokens, 120);
  assert.equal(reasoning.reasoningOutputTokens, 90, "reasoning output is a subset, not an addition");
  const nestedReasoning = normalizeProviderUsage("codex", {
    input_tokens: 500, output_tokens: 120, output_tokens_details: { reasoning_tokens: 40 },
  });
  assert.equal(nestedReasoning.reasoningOutputTokens, 40);
  const impossibleReasoning = normalizeProviderUsage("codex", {
    input_tokens: 500, output_tokens: 10, reasoning_output_tokens: 90,
  });
  assert.equal(impossibleReasoning.coverage, "partial");
  assert.ok(impossibleReasoning.conflicts.some((conflict) => conflict.includes("cannot be a subset")));
});

test("historical cohort subtotals reproduce with explicit missing coverage", () => {
  const summary = fixture<CohortFixture>("cohort-summary.json");
  const study = summary.cohorts.find((cohort) => cohort.project_id === "prj_fixture_study");
  const ui = summary.cohorts.find((cohort) => cohort.project_id === "prj_fixture_mabs_ui");
  assert.ok(study);
  assert.ok(ui);

  const studySubtotal = summarizeUsage(historicalSources(summary, study.project_id));
  assert.equal(studySubtotal.knownInputEvents, study.known_input_events);
  assert.equal(studySubtotal.knownOutputTokens, study.known_output_tokens);
  assert.equal(studySubtotal.missingAttempts.length, study.missing_usage_attempts);
  assert.equal(studySubtotal.coverage, "complete");

  const uiSources = historicalSources(summary, ui.project_id);
  const uiSubtotal = summarizeUsage(uiSources);
  assert.equal(uiSubtotal.knownInputEvents, ui.known_input_events);
  assert.equal(uiSubtotal.knownInputEvents, 56_712_129);
  assert.equal(uiSubtotal.knownOutputTokens, ui.known_output_tokens);
  assert.equal(uiSubtotal.knownOutputTokens, 368_642);
  assert.equal(uiSubtotal.missingAttempts.length, ui.missing_usage_attempts);
  assert.equal(uiSubtotal.missingAttempts.length, 5);
  // Five unmeasured attempts make the cohort partial; the known subtotal is
  // still reported instead of collapsing the whole cohort to null.
  assert.equal(uiSubtotal.coverage, "partial");
  assert.equal(uiSubtotal.measuredAttempts, uiSources.length - 5);

  const combined = summarizeUsage([
    ...historicalSources(summary, study.project_id),
    ...uiSources,
  ]);
  assert.equal(combined.knownInputEvents, summary.expected.known_input_events);
  assert.equal(combined.knownInputEvents, 83_047_613);
  assert.equal(combined.knownOutputTokens, summary.expected.known_output_tokens);
  assert.equal(combined.knownOutputTokens, 677_025);
  assert.equal(combined.missingAttempts.length, summary.expected.missing_usage_attempts);
  // The combined figure is descriptive across two different provider schemas.
  assert.match(combined.semantics, /Not unique tokens/);
  assert.match(combined.semantics, /not subscription spend/);
  assert.deepEqual(combined.sourceSemantics, ["claude-cache-is-separate", "codex-input-includes-cache"]);
});

test("a cohort with no measurement stays null and an empty cohort is not applicable", () => {
  const none = summarizeUsage([
    { attemptId: "att_1", adapter: "codex", raw: null },
    { attemptId: "att_2", adapter: "claude", raw: null },
  ]);
  assert.equal(none.coverage, "missing");
  assert.equal(none.knownInputEvents, null, "no measurement is unknown, never zero");
  assert.equal(none.knownOutputTokens, null);
  assert.deepEqual(none.missingAttempts, ["att_1", "att_2"]);

  const empty = summarizeUsage([]);
  assert.equal(empty.coverage, "not_applicable");
  assert.equal(empty.knownInputEvents, null);
  assert.equal(empty.attempts, 0);

  const measuredZero = summarizeUsage([
    { attemptId: "att_1", adapter: "codex", raw: { input_tokens: 0, output_tokens: 0 } },
  ]);
  assert.equal(measuredZero.coverage, "complete");
  assert.equal(measuredZero.knownInputEvents, 0, "a measured zero is not missing");
});

test("recorded duration uses ended_at and reports missing, running, and invalid separately", () => {
  assert.deepEqual(
    attemptDuration({ startedAt: "2026-09-20T00:00:00.000Z", endedAt: "2026-09-20T00:00:05.000Z" }),
    { status: "measured", milliseconds: 5_000, detail: null },
  );
  assert.equal(attemptDuration({ startedAt: "2026-09-20T00:00:00.000Z", endedAt: null, state: "running" }).status, "running");
  assert.equal(attemptDuration({ startedAt: "2026-09-20T00:00:00.000Z", endedAt: null, state: "failed" }).status, "missing");
  assert.equal(
    attemptDuration({ startedAt: "2026-09-20T00:00:05.000Z", endedAt: "2026-09-20T00:00:00.000Z" }).status,
    "invalid",
  );
  assert.equal(attemptDuration({ startedAt: "not-a-date", endedAt: "2026-09-20T00:00:00.000Z" }).status, "invalid");

  const subtotal = summarizeDurations([
    { attemptId: "att_1", startedAt: "2026-09-20T00:00:00.000Z", endedAt: "2026-09-20T00:00:04.000Z", state: "succeeded" },
    // Failed attempts count towards observed worker elapsed time.
    { attemptId: "att_2", startedAt: "2026-09-20T00:00:00.000Z", endedAt: "2026-09-20T00:00:06.000Z", state: "failed" },
    { attemptId: "att_3", startedAt: "2026-09-20T00:00:00.000Z", endedAt: null, state: "running" },
    { attemptId: "att_4", startedAt: "2026-09-20T00:00:09.000Z", endedAt: "2026-09-20T00:00:00.000Z", state: "succeeded" },
  ]);
  assert.equal(subtotal.milliseconds, 10_000);
  assert.equal(subtotal.measuredAttempts, 2);
  assert.deepEqual(subtotal.runningAttempts, ["att_3"]);
  assert.deepEqual(subtotal.invalidAttempts, ["att_4"]);
});

test("a normalized projection is persistable and leaves the raw usage evidence untouched", (t) => {
  const db = new Records(new Store(":memory:"));
  t.after(() => db.store.close());
  const project = db.createProject({
    name: "usage", repoPath: "/tmp/usage", projectType: "personal", reviewChoice: "off",
  });
  const task = db.createTask({ projectId: project.id, title: "usage", objective: "usage" });
  const attempt = db.startAttempt({ taskId: task.id, launchId: "launch-usage", kind: "initial", adapter: "claude" });
  const raw = { ...claude.usage_json };
  db.finishAttempt({ attemptId: attempt.id, state: "succeeded", usage: raw });
  const storedBefore = db.store.get("SELECT usage_json FROM attempts WHERE id = ?", attempt.id)?.usage_json;

  const normalized = normalizeProviderUsage("claude", db.getAttempt(attempt.id)?.usage);
  const projection = db.recordUsageProjection({
    attemptId: attempt.id,
    normalizerVersion: normalized.normalizerVersion,
    normalized: usageProjectionFields(normalized),
    sourceArtifactHash: createHash("sha256").update(String(storedBefore)).digest("hex"),
    sourceOffset: null,
    coverage: normalized.coverage,
    sourceSemantics: normalized.sourceSemantics,
  });
  assert.equal(projection.normalizerVersion, USAGE_NORMALIZER_VERSION);
  assert.equal(projection.coverage, "complete");
  assert.equal(projection.normalized.known_input_events, claude.expected.known_input_events);
  assert.equal(projection.normalized.cache_read_input_tokens, 6_000_000);
  assert.equal(projection.normalized.cached_input_tokens, null);
  assert.equal(projection.normalized.source_semantics, "claude-cache-is-separate");
  assert.equal(
    db.store.get("SELECT usage_json FROM attempts WHERE id = ?", attempt.id)?.usage_json,
    storedBefore,
    "normalization must not rewrite raw provider evidence",
  );
  assert.equal(db.getUsageProjection(attempt.id, USAGE_NORMALIZER_VERSION)?.coverage, "complete");
  for (const value of Object.values(projection.normalized)) {
    assert.ok(value === null || ["number", "string", "boolean"].includes(typeof value));
  }
});
