import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  authorizeRun,
  compareExperiment,
  completeExperiment,
  createExperiment,
  prepareRun,
  recordMeasurement,
  recordTrialFromTask,
  type ExperimentProtocol,
} from "../src/optimization/experiments.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";

interface Fixture {
  protocol: ExperimentProtocol;
  baselineConfig: Record<string, unknown>;
  candidateConfig: Record<string, unknown>;
  measurements: { variant: "baseline" | "candidate"; caseKey: string; repeatIndex: number; accepted: boolean; repairs?: number;
    durationMs?: number | null; reportedInputTokens?: number | null; reportedOutputTokens?: number | null }[];
}

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/optimization/${name}`, import.meta.url), "utf8")) as Fixture;

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-optimizer-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = join(root, "state");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { records, root };
}

function load(records: Records, data: Fixture, overrides: Partial<ExperimentProtocol> = {}, projectId: string | null = null) {
  const experiment = createExperiment(records, {
    projectId, name: "fixture", hypothesis: "declared in advance", dimension: Object.keys(data.candidateConfig)[0] as string,
    suiteVersion: "fixed-suite-v1", baselineConfig: data.baselineConfig, candidateConfig: data.candidateConfig,
    protocol: { ...data.protocol, ...overrides },
  });
  for (const item of data.measurements) {
    recordMeasurement(records, {
      experimentId: experiment.id, variant: item.variant, caseKey: item.caseKey, repeatIndex: item.repeatIndex,
      accepted: item.accepted, requirementViolations: 0, repairs: item.repairs ?? 0, interventions: 0,
      durationMs: item.durationMs ?? null, reportedInputTokens: item.reportedInputTokens === undefined ? null : item.reportedInputTokens,
      reportedOutputTokens: item.reportedOutputTokens ?? null, relevantFiles: 1, warnings: 0, evidencePath: null,
    });
  }
  return experiment;
}

test("a complete, paired, repeated experiment can show an improvement on its primary metric", (t) => {
  const { records } = setup(t);
  const comparison = compareExperiment(records, load(records, fixture("paired-cases.json")).id);
  assert.equal(comparison.evidence, "complete");
  assert.equal(comparison.result, "improved", comparison.reasons.join(" "));
  assert.equal(comparison.primaryMetric, "repairs");
  assert.equal(comparison.perCase.every((item) => item.pairedRepeats === 2), true);
  assert.equal(comparison.supportsProposal, true);
});

test("EVAL-01: one regressed case fails the safeguards despite equal aggregate acceptance", (t) => {
  const { records } = setup(t);
  const comparison = compareExperiment(records, load(records, fixture("per-case-quality-regression.json")).id);
  assert.equal(comparison.baseline.accepted, comparison.candidate.accepted, "aggregates are equal");
  assert.equal(comparison.safeguardsPassed, false);
  assert.equal(comparison.result, "no_improvement");
  assert.deepEqual(comparison.perCase.filter((item) => item.regressed).map((item) => item.caseKey), ["case-a"]);
  assert.match(comparison.reasons.join(), /case-a \(accepted rate fell/);
});

test("EVAL-02: lower latency cannot mask a token increase beyond its declared tolerance", (t) => {
  const { records } = setup(t);
  const data = fixture("paired-cases.json");
  const faster = {
    ...data,
    measurements: data.measurements.map((item) => item.variant === "candidate"
      ? { ...item, repairs: 1, durationMs: 500, reportedInputTokens: 2_000 }
      : { ...item, repairs: 1 }),
  };
  const comparison = compareExperiment(records, load(records, faster, { primaryMetric: "durationMs", tolerances: { reportedInputTokens: 0.1 } }).id);
  assert.ok((comparison.candidate.durationMs ?? 0) < (comparison.baseline.durationMs ?? 0), "the candidate really is faster");
  assert.equal(comparison.tradeOffsWithinTolerance, false);
  assert.equal(comparison.result, "no_improvement");
  assert.match(comparison.reasons.join(), /reportedInputTokens rose .* beyond the 10% tolerance/);
});

test("EVAL-03: missing usage and unmatched trials are incomplete or limited evidence, not demonstrated savings", (t) => {
  const { records } = setup(t);
  const usage = compareExperiment(records, load(records, fixture("incomplete-usage.json")).id);
  assert.notEqual(usage.result, "improved");
  assert.match(usage.reasons.join(), /missing usage; savings cannot be demonstrated/);

  const data = fixture("paired-cases.json");
  const unmatched = { ...data, measurements: data.measurements.filter((item) => !(item.caseKey === "case-b" && item.repeatIndex === 1 && item.variant === "candidate")) };
  const partial = compareExperiment(records, load(records, unmatched).id);
  assert.equal(partial.evidence, "incomplete");
  assert.equal(partial.result, "incomplete");
  assert.deepEqual(partial.missingPairs, ["case-b#1"]);
  assert.equal(partial.supportsProposal, false);
});

test("EVAL-04: a dry run produces a counterbalanced manifest and budget with zero provider calls", (t) => {
  const { records } = setup(t);
  const experiment = load(records, { ...fixture("paired-cases.json"), measurements: [] });
  const { manifest, fingerprint, manifestPath } = prepareRun(records, experiment.id);
  assert.equal(manifest.providerCalls, 0);
  assert.equal(manifest.trials.length, 8);
  assert.deepEqual(manifest.trials.slice(0, 4).map((trial) => trial.variant), ["baseline", "candidate", "candidate", "baseline"]);
  assert.equal(manifest.budget.maxTrials, 8);
  assert.match(fingerprint, /^sha256:/);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).fingerprint, fingerprint);
  assert.equal(prepareRun(records, experiment.id).fingerprint, fingerprint, "the manifest is deterministic");
});

test("protocols demand one changed dimension, a budget that fits, and in-suite measurements", (t) => {
  const { records } = setup(t);
  const data = fixture("paired-cases.json");
  assert.throws(() => createExperiment(records, {
    name: "x", hypothesis: "x", dimension: "effort", suiteVersion: "v1",
    baselineConfig: { effort: "high", model: "a" }, candidateConfig: { effort: "medium", model: "b" }, protocol: data.protocol,
  }), /Exactly one primary dimension may change between variants; found 2/);
  assert.throws(() => createExperiment(records, {
    name: "x", hypothesis: "x", dimension: "effort", suiteVersion: "v1", baselineConfig: data.baselineConfig,
    candidateConfig: data.candidateConfig, protocol: { ...data.protocol, budget: { ...data.protocol.budget, maxTrials: 3 } },
  }), /needs 8 trials, above budget.maxTrials 3/);
  const experiment = load(records, { ...data, measurements: [] });
  assert.throws(() => recordMeasurement(records, {
    experimentId: experiment.id, variant: "baseline", caseKey: "case-z", accepted: true, requirementViolations: 0, repairs: 0,
    interventions: 0, durationMs: null, reportedInputTokens: null, reportedOutputTokens: null, relevantFiles: 0, warnings: 0, evidencePath: null,
  }), /not in the fixed protocol suite/);
});

test("a live run cannot be authorized without fixed trial cases, revisions, and an attempt budget", (t) => {
  const { records, root } = setup(t);
  const project = records.createProject({ name: "exp", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const experiment = load(records, { ...fixture("paired-cases.json"), measurements: [] }, {}, project.id);
  assert.throws(() => authorizeRun(records, experiment.id, { fingerprint: "sha256:stale", authorizedBy: "owner" }), /does not match the current run manifest/);
  const { fingerprint, manifest } = prepareRun(records, experiment.id);
  assert.match(manifest.liveBlockers.join(" "), /maxAttemptsPerTrial is required/);
  assert.match(manifest.liveBlockers.join(" "), /Case case-a needs a starting revision/);
  assert.throws(() => authorizeRun(records, experiment.id, { fingerprint, authorizedBy: "owner" }), /Cannot authorize a live run/);
  assert.throws(() => recordMeasurement(records, {
    experimentId: experiment.id, variant: "baseline", caseKey: "case-a", accepted: true, requirementViolations: 0, repairs: 0,
    interventions: 0, durationMs: null, reportedInputTokens: null, reportedOutputTokens: null, relevantFiles: 0, warnings: 0,
    evidencePath: null, source: "live_trial",
  }), /recorded only from a bound trial task/);
});

test("an ineligible model variant cannot be authorized for a live run", (t) => {
  const { records } = setup(t);
  const data = fixture("paired-cases.json");
  const experiment = createExperiment(records, {
    name: "x", hypothesis: "x", dimension: "model", suiteVersion: "v1",
    baselineConfig: { adapter: "claude", model: "claude-opus-5" }, candidateConfig: { adapter: "claude", model: "claude-new-catalog-model" },
    protocol: data.protocol,
  });
  const { fingerprint, manifest } = prepareRun(records, experiment.id);
  assert.equal(manifest.eligibility.find((item) => item.variant === "candidate")?.eligible, false);
  assert.throws(() => authorizeRun(records, experiment.id, { fingerprint, authorizedBy: "owner" }), /entitlement is unknown/);
});

test("policy replay alone cannot show improvement", (t) => {
  const { records } = setup(t);
  const data = fixture("paired-cases.json");
  const experiment = createExperiment(records, {
    name: "x", hypothesis: "x", dimension: "effort", suiteVersion: "v1", baselineConfig: data.baselineConfig,
    candidateConfig: data.candidateConfig, protocol: data.protocol,
  });
  for (const item of data.measurements) {
    recordMeasurement(records, {
      experimentId: experiment.id, variant: item.variant, caseKey: item.caseKey, repeatIndex: item.repeatIndex, accepted: item.accepted,
      requirementViolations: 0, repairs: item.repairs ?? 0, interventions: 0, durationMs: item.durationMs ?? null,
      reportedInputTokens: item.reportedInputTokens ?? null, reportedOutputTokens: item.reportedOutputTokens ?? null,
      relevantFiles: 1, warnings: 0, evidencePath: null, source: "policy_replay",
    });
  }
  const comparison = compareExperiment(records, experiment.id);
  assert.equal(comparison.result, "no_improvement");
  assert.match(comparison.reasons.join(), /replay cannot show how a model would have performed/);
});

test("EVAL-05: a successful experiment supports a proposal but never activates configuration", (t) => {
  const { records, root } = setup(t);
  const project = records.createProject({ name: "exp", repoPath: root, projectType: "personal", reviewChoice: "off" });
  const before = records.getProject(project.id)?.configVersion;
  const experiment = load(records, fixture("paired-cases.json"), {}, project.id);
  const { comparison } = completeExperiment(records, experiment.id);
  assert.equal(comparison.result, "improved");
  assert.equal(comparison.supportsProposal, true);
  assert.equal(records.getProject(project.id)?.configVersion, before, "configuration is unchanged");
  assert.equal(records.listCuratorProposals(project.id).length, 0, "no proposal was created or activated");
});
