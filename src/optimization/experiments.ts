import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { artifactDir } from "../core/paths.ts";
import { ids } from "../core/ids.ts";
import { DEFAULT_CAPABILITY_REGISTRY, evaluateCapability } from "../routing/capabilities.ts";
import { fromJson, nowIso, toJson, type Row } from "../store/db.ts";
import type { Records } from "../store/records.ts";
import { normalizeAttemptUsage } from "../usage/summary.ts";

export const EXPERIMENT_PROTOCOL_VERSION = "mabs.experiment-protocol.v1";

export type ExperimentMetric = "accepted" | "repairs" | "interventions" | "durationMs" | "reportedInputTokens" | "reportedOutputTokens";
const MINIMIZED: readonly ExperimentMetric[] = ["repairs", "interventions", "durationMs", "reportedInputTokens", "reportedOutputTokens"];
const USAGE_METRICS: readonly ExperimentMetric[] = ["reportedInputTokens", "reportedOutputTokens"];

/**
 * A predeclared protocol. Nothing about how the comparison is judged is
 * chosen after the measurements are seen.
 */
export interface ExperimentProtocol {
  primaryMetric: ExperimentMetric;
  /** Largest allowed relative increase per secondary metric, e.g. {reportedInputTokens: 0.1}. */
  tolerances: Partial<Record<ExperimentMetric, number>>;
  cases: string[];
  repeats: number;
  /** "strict": any missing usage makes usage claims incomplete. "known_subtotal": report known subtotals, never savings. */
  missingData: "strict" | "known_subtotal";
  budget: { maxTrials: number; maxElapsedMs: number; usageWarningInputTokens: number | null };
}

/** Defaults for experiments recorded before protocols existed. */
const LEGACY_TOLERANCES: Partial<Record<ExperimentMetric, number>> = {
  durationMs: 0.25, reportedInputTokens: 0.1, reportedOutputTokens: 0.1, repairs: 0,
};

export type ExperimentVariant = "baseline" | "candidate";

export interface OptimizationExperiment {
  id: string;
  projectId: string | null;
  name: string;
  hypothesis: string;
  dimension: string;
  suiteVersion: string;
  baselineConfig: Record<string, unknown>;
  candidateConfig: Record<string, unknown>;
  status: "draft" | "running" | "completed";
  conclusion: string | null;
  evidencePath: string | null;
  createdAt: string;
  completedAt: string | null;
  protocolVersion: string | null;
  protocol: ExperimentProtocol | null;
  runAuthorization: { fingerprint: string; authorizedBy: string; at: string } | null;
}

export interface OptimizationMeasurement {
  id: string;
  experimentId: string;
  variant: ExperimentVariant;
  caseKey: string;
  accepted: boolean;
  requirementViolations: number;
  repairs: number;
  interventions: number;
  durationMs: number | null;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  relevantFiles: number;
  warnings: number;
  evidencePath: string | null;
  createdAt: string;
  repeatIndex: number;
  trialState: "completed" | "failed" | "interrupted";
  source: "manual" | "live_trial" | "policy_replay";
  usageCoverage: string | null;
  taskId: string | null;
}

export interface CaseComparison {
  caseKey: string;
  pairedRepeats: number;
  baselineAcceptedRate: number;
  candidateAcceptedRate: number;
  regressed: boolean;
  reasons: string[];
}

export interface ExperimentComparison {
  result: "improved" | "limitation_resolved" | "no_improvement" | "incomplete";
  /** "complete": every declared pair measured. "incomplete": pairs are missing. */
  evidence: "complete" | "incomplete";
  comparableCases: string[];
  missingPairs: string[];
  perCase: CaseComparison[];
  primaryMetric: ExperimentMetric | null;
  baseline: AggregateMetrics;
  candidate: AggregateMetrics;
  safeguardsPassed: boolean;
  tradeOffsWithinTolerance: boolean;
  trials: { total: number; failed: number; interrupted: number };
  sources: string[];
  /** A result may support a curator proposal; it never approves or activates anything. */
  supportsProposal: boolean;
  reasons: string[];
}

interface AggregateMetrics {
  cases: number;
  accepted: number;
  requirementViolations: number;
  repairs: number;
  interventions: number;
  durationMs: number | null;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  relevantFiles: number;
  warnings: number;
}

function experiment(row: Row): OptimizationExperiment {
  return {
    id: row.id as string, projectId: (row.project_id as string) ?? null, name: row.name as string,
    hypothesis: row.hypothesis as string, dimension: row.dimension as string, suiteVersion: row.suite_version as string,
    baselineConfig: fromJson(row.baseline_config, {}), candidateConfig: fromJson(row.candidate_config, {}),
    status: row.status as OptimizationExperiment["status"], conclusion: (row.conclusion as string) ?? null,
    evidencePath: (row.evidence_path as string) ?? null, createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
    protocolVersion: (row.protocol_version as string) ?? null,
    protocol: row.protocol_version ? {
      ...fromJson<Omit<ExperimentProtocol, "primaryMetric" | "tolerances">>(row.safeguards, { cases: [], repeats: 1, missingData: "strict", budget: { maxTrials: 0, maxElapsedMs: 0, usageWarningInputTokens: null } }),
      primaryMetric: row.primary_metric as ExperimentMetric,
      tolerances: fromJson(row.tolerances, {}),
    } : null,
    runAuthorization: fromJson(row.run_authorization, null),
  };
}

function measurement(row: Row): OptimizationMeasurement {
  return {
    id: row.id as string, experimentId: row.experiment_id as string, variant: row.variant as ExperimentVariant,
    caseKey: row.case_key as string, accepted: Boolean(row.accepted),
    requirementViolations: Number(row.requirement_violations), repairs: Number(row.repairs),
    interventions: Number(row.interventions), durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    reportedInputTokens: row.reported_input_tokens === null ? null : Number(row.reported_input_tokens),
    reportedOutputTokens: row.reported_output_tokens === null ? null : Number(row.reported_output_tokens),
    relevantFiles: Number(row.relevant_files), warnings: Number(row.warnings),
    evidencePath: (row.evidence_path as string) ?? null, createdAt: row.created_at as string,
    repeatIndex: Number(row.repeat_index ?? 0),
    trialState: (row.trial_state as OptimizationMeasurement["trialState"]) ?? "completed",
    source: (row.source as OptimizationMeasurement["source"]) ?? "manual",
    usageCoverage: (row.usage_coverage as string) ?? null,
    taskId: (row.task_id as string) ?? null,
  };
}

function nonNegativeInteger(value: number | null | undefined, field: string): void {
  if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${field} must be a non-negative integer or null`);
}

/** Top-level configuration keys whose values differ between the variants. */
export function changedDimensions(baseline: Record<string, unknown>, candidate: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
  return [...keys].filter((key) => JSON.stringify(baseline[key]) !== JSON.stringify(candidate[key])).sort();
}

export function validateProtocol(protocol: ExperimentProtocol, baseline: Record<string, unknown>, candidate: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const metrics: ExperimentMetric[] = ["accepted", ...MINIMIZED];
  if (!metrics.includes(protocol.primaryMetric)) errors.push(`primaryMetric must be one of ${metrics.join(", ")}.`);
  for (const [metric, tolerance] of Object.entries(protocol.tolerances ?? {})) {
    if (!metrics.includes(metric as ExperimentMetric)) errors.push(`Unknown tolerance metric ${metric}.`);
    if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) errors.push(`Tolerance for ${metric} must be a non-negative number.`);
  }
  if (!Array.isArray(protocol.cases) || protocol.cases.length === 0 || new Set(protocol.cases).size !== protocol.cases.length) {
    errors.push("cases must be a non-empty list of distinct fixed case keys.");
  }
  if (!Number.isSafeInteger(protocol.repeats) || protocol.repeats < 1) errors.push("repeats must be a positive integer.");
  if (protocol.missingData !== "strict" && protocol.missingData !== "known_subtotal") errors.push("missingData must be strict or known_subtotal.");
  const trials = (protocol.cases?.length ?? 0) * 2 * (protocol.repeats ?? 0);
  if (!protocol.budget || !Number.isSafeInteger(protocol.budget.maxTrials) || protocol.budget.maxTrials < 1) errors.push("budget.maxTrials is required.");
  else if (trials > protocol.budget.maxTrials) errors.push(`The protocol needs ${trials} trials, above budget.maxTrials ${protocol.budget.maxTrials}.`);
  if (!protocol.budget || !Number.isSafeInteger(protocol.budget.maxElapsedMs) || protocol.budget.maxElapsedMs < 1) errors.push("budget.maxElapsedMs is required.");
  const changed = changedDimensions(baseline, candidate);
  if (changed.length !== 1) {
    errors.push(`Exactly one primary dimension may change between variants; found ${changed.length}${changed.length ? ` (${changed.join(", ")})` : ""}.`);
  }
  return errors;
}

export function createExperiment(records: Records, input: {
  projectId?: string | null;
  name: string;
  hypothesis: string;
  dimension: string;
  suiteVersion: string;
  baselineConfig: Record<string, unknown>;
  candidateConfig: Record<string, unknown>;
  protocol?: ExperimentProtocol;
}): OptimizationExperiment {
  if (!input.name.trim() || !input.hypothesis.trim() || !input.dimension.trim() || !input.suiteVersion.trim()) {
    throw new Error("Experiment name, hypothesis, dimension, and suite version are required");
  }
  if (input.projectId && !records.getProject(input.projectId)) throw new Error(`Unknown project ${input.projectId}`);
  if (input.protocol) {
    const errors = validateProtocol(input.protocol, input.baselineConfig, input.candidateConfig);
    if (errors.length > 0) throw new Error(`Invalid experiment protocol:\n${errors.join("\n")}`);
  }
  const id = ids.experiment();
  const protocol = input.protocol ?? null;
  records.store.run(
    `INSERT INTO optimization_experiments(id, project_id, name, hypothesis, dimension, suite_version,
       baseline_config, candidate_config, status, created_at, protocol_version, primary_metric, tolerances, safeguards)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, input.projectId ?? null, input.name, input.hypothesis, input.dimension, input.suiteVersion,
    toJson(input.baselineConfig), toJson(input.candidateConfig), "draft", nowIso(),
    protocol ? EXPERIMENT_PROTOCOL_VERSION : null,
    protocol?.primaryMetric ?? null,
    protocol ? toJson(protocol.tolerances) : null,
    protocol ? toJson({ cases: protocol.cases, repeats: protocol.repeats, missingData: protocol.missingData, budget: protocol.budget }) : null,
  );
  records.recordEvent({ kind: "optimization.created", projectId: input.projectId, data: { experimentId: id, dimension: input.dimension } });
  return getExperiment(records, id) as OptimizationExperiment;
}

export function getExperiment(records: Records, id: string): OptimizationExperiment | null {
  const row = records.store.get("SELECT * FROM optimization_experiments WHERE id = ?", id);
  return row ? experiment(row) : null;
}

export function listExperiments(records: Records, projectId?: string): OptimizationExperiment[] {
  const rows = projectId
    ? records.store.all("SELECT * FROM optimization_experiments WHERE project_id = ? ORDER BY created_at DESC", projectId)
    : records.store.all("SELECT * FROM optimization_experiments ORDER BY created_at DESC LIMIT 200");
  return rows.map(experiment);
}

type MeasurementInput = Omit<OptimizationMeasurement, "id" | "createdAt" | "repeatIndex" | "trialState" | "source" | "usageCoverage" | "taskId"> &
  Partial<Pick<OptimizationMeasurement, "repeatIndex" | "trialState" | "source" | "usageCoverage" | "taskId">>;

export function recordMeasurement(records: Records, input: MeasurementInput): OptimizationMeasurement {
  const current = getExperiment(records, input.experimentId);
  if (!current) throw new Error(`Unknown experiment ${input.experimentId}`);
  if (current.status === "completed") throw new Error("Completed experiments are immutable");
  if (input.variant !== "baseline" && input.variant !== "candidate") throw new Error("variant must be baseline or candidate");
  if (!input.caseKey.trim()) throw new Error("caseKey is required");
  nonNegativeInteger(input.repeatIndex ?? 0, "repeatIndex");
  if (current.protocol) {
    if (!current.protocol.cases.includes(input.caseKey)) throw new Error(`Case ${input.caseKey} is not in the fixed protocol suite.`);
    if ((input.repeatIndex ?? 0) >= current.protocol.repeats) throw new Error(`Repeat ${input.repeatIndex} exceeds the declared ${current.protocol.repeats} repeat(s).`);
  }
  for (const [field, value] of Object.entries({
    requirementViolations: input.requirementViolations, repairs: input.repairs, interventions: input.interventions,
    durationMs: input.durationMs, reportedInputTokens: input.reportedInputTokens,
    reportedOutputTokens: input.reportedOutputTokens, relevantFiles: input.relevantFiles, warnings: input.warnings,
  })) nonNegativeInteger(value, field);
  const id = ids.measurement();
  records.store.tx(() => {
    records.store.run(
      `INSERT INTO optimization_measurements(id, experiment_id, variant, case_key, accepted,
         requirement_violations, repairs, interventions, duration_ms, reported_input_tokens,
         reported_output_tokens, relevant_files, warnings, evidence_path, created_at,
         repeat_index, trial_state, source, usage_coverage, task_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.experimentId, input.variant, input.caseKey, input.accepted ? 1 : 0,
      input.requirementViolations, input.repairs, input.interventions, input.durationMs,
      input.reportedInputTokens, input.reportedOutputTokens, input.relevantFiles, input.warnings,
      input.evidencePath, nowIso(), input.repeatIndex ?? 0, input.trialState ?? "completed",
      input.source ?? "manual", input.usageCoverage ?? null, input.taskId ?? null,
    );
    records.store.run("UPDATE optimization_experiments SET status = 'running' WHERE id = ?", input.experimentId);
  });
  return measurement(records.store.get("SELECT * FROM optimization_measurements WHERE id = ?", id) as Row);
}

export function listMeasurements(records: Records, experimentId: string): OptimizationMeasurement[] {
  return records.store.all(
    "SELECT * FROM optimization_measurements WHERE experiment_id = ? ORDER BY case_key, repeat_index, variant",
    experimentId,
  ).map(measurement);
}

function aggregate(items: OptimizationMeasurement[]): AggregateMetrics {
  const sumNullable = (field: "durationMs" | "reportedInputTokens" | "reportedOutputTokens"): number | null => {
    const values = items.map((item) => item[field]).filter((value): value is number => value !== null);
    return values.length === items.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    cases: items.length, accepted: items.filter((item) => item.accepted).length,
    requirementViolations: items.reduce((sum, item) => sum + item.requirementViolations, 0),
    repairs: items.reduce((sum, item) => sum + item.repairs, 0),
    interventions: items.reduce((sum, item) => sum + item.interventions, 0),
    durationMs: sumNullable("durationMs"), reportedInputTokens: sumNullable("reportedInputTokens"),
    reportedOutputTokens: sumNullable("reportedOutputTokens"),
    relevantFiles: items.reduce((sum, item) => sum + item.relevantFiles, 0),
    warnings: items.reduce((sum, item) => sum + item.warnings, 0),
  };
}

function metricValue(aggregateMetrics: AggregateMetrics, metric: ExperimentMetric): number | null {
  return aggregateMetrics[metric];
}

/**
 * Judge a candidate against the baseline under the experiment's declared rules.
 *
 * - Pairs are (case, repeat). A missing pair makes the evidence incomplete, and
 *   incomplete evidence can never demonstrate an improvement.
 * - Quality is checked per case: one regressed case fails the safeguards even
 *   when the aggregate is unchanged.
 * - Only the declared primary metric can make a result "improved"; every other
 *   metric must stay within its declared tolerance. Faster is not better if
 *   tokens grew beyond their limit.
 * - Failed and interrupted trials are retained and count as unaccepted.
 * - Policy replay is not a live measurement and cannot show improvement.
 */
export function compareExperiment(records: Records, experimentId: string): ExperimentComparison {
  const current = getExperiment(records, experimentId);
  if (!current) throw new Error(`Unknown experiment ${experimentId}`);
  const measurements = listMeasurements(records, experimentId);
  if (measurements.length === 0) throw new Error("Every fixed suite case requires exactly one baseline and one candidate measurement");
  const protocol = current.protocol;
  const key = (item: OptimizationMeasurement) => `${item.caseKey}#${item.repeatIndex}`;
  const baselineByPair = new Map(measurements.filter((item) => item.variant === "baseline").map((item) => [key(item), item]));
  const candidateByPair = new Map(measurements.filter((item) => item.variant === "candidate").map((item) => [key(item), item]));
  const declaredPairs = protocol
    ? protocol.cases.flatMap((caseKey) => Array.from({ length: protocol.repeats }, (_, repeat) => `${caseKey}#${repeat}`))
    : [...new Set([...baselineByPair.keys(), ...candidateByPair.keys()])];
  const paired = declaredPairs.filter((pair) => baselineByPair.has(pair) && candidateByPair.has(pair)).sort();
  const missingPairs = declaredPairs.filter((pair) => !paired.includes(pair)).sort();
  const baselineItems = paired.map((pair) => baselineByPair.get(pair) as OptimizationMeasurement);
  const candidateItems = paired.map((pair) => candidateByPair.get(pair) as OptimizationMeasurement);
  const baseline = aggregate(baselineItems);
  const candidate = aggregate(candidateItems);
  const reasons: string[] = [];

  const cases = [...new Set(paired.map((pair) => pair.slice(0, pair.lastIndexOf("#"))))].sort();
  const perCase: CaseComparison[] = cases.map((caseKey) => {
    const base = baselineItems.filter((item) => item.caseKey === caseKey);
    const cand = candidateItems.filter((item) => item.caseKey === caseKey);
    const rate = (items: OptimizationMeasurement[]) => items.filter((item) => item.accepted && item.trialState === "completed").length / items.length;
    const caseReasons: string[] = [];
    if (rate(cand) < rate(base)) caseReasons.push(`accepted rate fell from ${rate(base).toFixed(2)} to ${rate(cand).toFixed(2)}`);
    const sum = (items: OptimizationMeasurement[], field: "requirementViolations" | "interventions") => items.reduce((total, item) => total + item[field], 0);
    if (sum(cand, "requirementViolations") > sum(base, "requirementViolations")) caseReasons.push("more requirement violations");
    if (sum(cand, "interventions") > sum(base, "interventions")) caseReasons.push("more operator interventions");
    return { caseKey, pairedRepeats: base.length, baselineAcceptedRate: rate(base), candidateAcceptedRate: rate(cand), regressed: caseReasons.length > 0, reasons: caseReasons };
  });
  const regressedCases = perCase.filter((item) => item.regressed);
  const safeguardsPassed = regressedCases.length === 0;
  if (!safeguardsPassed) {
    reasons.push(`Candidate regressed accepted work, requirement violations, or interventions in ${regressedCases.map((item) => `${item.caseKey} (${item.reasons.join("; ")})`).join(", ")}.`);
  }

  const tolerances = protocol?.tolerances ?? LEGACY_TOLERANCES;
  const tradeOffViolations: string[] = [];
  const unverifiable: string[] = [];
  for (const [metric, tolerance] of Object.entries(tolerances) as [ExperimentMetric, number][]) {
    if (metric === protocol?.primaryMetric) continue;
    const before = metricValue(baseline, metric);
    const after = metricValue(candidate, metric);
    if (before === null || after === null) {
      unverifiable.push(metric);
      continue;
    }
    if (after > before * (1 + tolerance) + (before === 0 ? tolerance : 0)) {
      tradeOffViolations.push(`${metric} rose from ${before} to ${after}, beyond the ${Math.round(tolerance * 100)}% tolerance`);
    }
  }
  const tradeOffsWithinTolerance = tradeOffViolations.length === 0;
  if (!tradeOffsWithinTolerance) reasons.push(`Trade-off limit exceeded: ${tradeOffViolations.join("; ")}.`);

  const trials = {
    total: measurements.length,
    failed: measurements.filter((item) => item.trialState === "failed").length,
    interrupted: measurements.filter((item) => item.trialState === "interrupted").length,
  };
  const sources = [...new Set(measurements.map((item) => item.source))].sort();
  const replayOnly = sources.length === 1 && sources[0] === "policy_replay";
  const evidence: ExperimentComparison["evidence"] = missingPairs.length === 0 && paired.length > 0 ? "complete" : "incomplete";

  let improved: boolean;
  const primary = protocol?.primaryMetric ?? null;
  if (primary) {
    const before = metricValue(baseline, primary);
    const after = metricValue(candidate, primary);
    const usageMissing = USAGE_METRICS.includes(primary) && (before === null || after === null);
    if (usageMissing) reasons.push(`Primary metric ${primary} has missing usage; savings cannot be demonstrated.`);
    improved = !usageMissing && before !== null && after !== null &&
      (MINIMIZED.includes(primary) ? after < before : after > before);
  } else {
    improved = candidate.accepted > baseline.accepted || candidate.repairs < baseline.repairs ||
      (candidate.durationMs !== null && baseline.durationMs !== null && candidate.durationMs < baseline.durationMs) ||
      (candidate.reportedInputTokens !== null && baseline.reportedInputTokens !== null && candidate.reportedInputTokens < baseline.reportedInputTokens);
  }
  if (unverifiable.length > 0 && improved) {
    reasons.push(`Trade-offs could not be verified for ${unverifiable.join(", ")} because usage or timing is missing.`);
    if (protocol?.missingData !== "known_subtotal") improved = false;
  }
  const resolved = !primary && baselineItems.every((item) => item.relevantFiles === 0) &&
    candidateItems.every((item) => item.relevantFiles > 0) && safeguardsPassed && evidence === "complete";

  let result: ExperimentComparison["result"];
  if (evidence === "incomplete") {
    result = "incomplete";
    reasons.push(`Evidence is incomplete: ${missingPairs.length} declared case/repeat pair(s) lack a baseline or candidate result (${missingPairs.slice(0, 10).join(", ")}).`);
  } else if (replayOnly && (improved || resolved)) {
    result = "no_improvement";
    reasons.push("Only policy replay was measured; replay cannot show how a model would have performed.");
  } else if (resolved && tradeOffsWithinTolerance) {
    result = "limitation_resolved";
    reasons.push("Every fixed case moved from an empty relevant-file manifest to a non-empty manifest without safeguard regression.");
  } else if (improved && safeguardsPassed && tradeOffsWithinTolerance) {
    result = "improved";
    reasons.push(primary
      ? `Primary metric ${primary} improved from ${metricValue(baseline, primary)} to ${metricValue(candidate, primary)} with every case and trade-off within limits.`
      : "At least one accepted-work, repair, duration, or reported-usage metric improved without safeguard regression.");
  } else {
    result = "no_improvement";
    if (safeguardsPassed && tradeOffsWithinTolerance) reasons.push("Candidate was non-regressing but did not demonstrate the stated improvement or limitation resolution.");
  }
  if (trials.failed + trials.interrupted > 0) reasons.push(`${trials.failed} failed and ${trials.interrupted} interrupted trial(s) are retained and counted as not accepted.`);
  return {
    result, evidence, comparableCases: cases, missingPairs, perCase, primaryMetric: primary, baseline, candidate,
    safeguardsPassed, tradeOffsWithinTolerance, trials, sources,
    supportsProposal: result === "improved" || result === "limitation_resolved",
    reasons,
  };
}

/**
 * Plan a run without executing it: the exact trials, their counterbalanced
 * order, the budget, and model eligibility. Zero provider calls. The returned
 * fingerprint is what an operator authorizes.
 */
export function prepareRun(records: Records, experimentId: string): {
  manifest: {
    experimentId: string;
    protocolVersion: string;
    trials: { caseKey: string; repeatIndex: number; variant: ExperimentVariant; order: number }[];
    budget: ExperimentProtocol["budget"];
    eligibility: { variant: ExperimentVariant; eligible: boolean; reasons: string[] }[];
    providerCalls: 0;
  };
  fingerprint: string;
  manifestPath: string;
} {
  const current = getExperiment(records, experimentId);
  if (!current) throw new Error(`Unknown experiment ${experimentId}`);
  if (!current.protocol) throw new Error("A run manifest requires a declared experiment protocol.");
  const protocol = current.protocol;
  const trials: { caseKey: string; repeatIndex: number; variant: ExperimentVariant; order: number }[] = [];
  let order = 0;
  protocol.cases.forEach((caseKey, caseIndex) => {
    for (let repeatIndex = 0; repeatIndex < protocol.repeats; repeatIndex += 1) {
      // Counterbalanced: alternate which variant runs first across pairs.
      const first: ExperimentVariant = (caseIndex + repeatIndex) % 2 === 0 ? "baseline" : "candidate";
      const second: ExperimentVariant = first === "baseline" ? "candidate" : "baseline";
      trials.push({ caseKey, repeatIndex, variant: first, order: order++ }, { caseKey, repeatIndex, variant: second, order: order++ });
    }
  });
  const eligibility = (["baseline", "candidate"] as const).map((variant) => {
    const config = (variant === "baseline" ? current.baselineConfig : current.candidateConfig) as { adapter?: string; model?: string | null; effort?: string | null };
    if (!config.adapter) return { variant, eligible: true, reasons: ["variant does not change the launch route"] };
    const evidence = evaluateCapability(DEFAULT_CAPABILITY_REGISTRY, { provider: config.adapter, model: config.model ?? null, effort: config.effort ?? null }).evidence;
    return { variant, eligible: evidence.eligible, reasons: evidence.reasons };
  });
  if (trials.length > protocol.budget.maxTrials) throw new Error(`Run needs ${trials.length} trials, above budget.maxTrials ${protocol.budget.maxTrials}.`);
  const manifest = {
    experimentId, protocolVersion: current.protocolVersion ?? EXPERIMENT_PROTOCOL_VERSION, trials, budget: protocol.budget, eligibility, providerCalls: 0 as const,
  };
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify({ manifest, baseline: current.baselineConfig, candidate: current.candidateConfig })).digest("hex")}`;
  const manifestPath = join(artifactDir("optimization", experimentId), "run-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ fingerprint, manifest }, null, 2), { mode: 0o600 });
  records.recordEvent({ kind: "optimization.run_prepared", projectId: current.projectId, data: { experimentId, fingerprint, trials: trials.length, providerCalls: 0 } });
  return { manifest, fingerprint, manifestPath };
}

/** Bind live execution to one exact manifest. Ineligible variants cannot be authorized. */
export function authorizeRun(records: Records, experimentId: string, input: { fingerprint: string; authorizedBy: string }): OptimizationExperiment {
  if (!input.authorizedBy.trim()) throw new Error("Authorization requires a named person.");
  const prepared = prepareRun(records, experimentId);
  if (prepared.fingerprint !== input.fingerprint) {
    throw new Error(`Authorization does not match the current run manifest (${prepared.fingerprint}); prepare the run again and review it.`);
  }
  const ineligible = prepared.manifest.eligibility.filter((item) => !item.eligible);
  if (ineligible.length > 0) throw new Error(`Cannot authorize: ${ineligible.map((item) => `${item.variant}: ${item.reasons.join("; ")}`).join(" | ")}`);
  const authorization = { fingerprint: input.fingerprint, authorizedBy: input.authorizedBy, at: nowIso() };
  records.store.run("UPDATE optimization_experiments SET run_authorization = ? WHERE id = ?", toJson(authorization), experimentId);
  const current = getExperiment(records, experimentId) as OptimizationExperiment;
  records.recordEvent({ kind: "optimization.run_authorized", projectId: current.projectId, data: { experimentId, ...authorization } });
  return current;
}

/**
 * Record a live trial from a task that ran through normal governance and
 * admission. Only an authorized run accepts live trials. Every outcome is
 * recorded: a failed or interrupted task becomes a failed or interrupted,
 * unaccepted trial, never a dropped one.
 */
export function recordTrialFromTask(records: Records, input: {
  experimentId: string;
  variant: ExperimentVariant;
  caseKey: string;
  repeatIndex: number;
  taskId: string;
}): OptimizationMeasurement {
  const current = getExperiment(records, input.experimentId);
  if (!current) throw new Error(`Unknown experiment ${input.experimentId}`);
  if (!current.runAuthorization) throw new Error("Live trials require an authorized run manifest.");
  const task = records.getTask(input.taskId);
  if (!task) throw new Error(`Unknown task ${input.taskId}`);
  const trialState: OptimizationMeasurement["trialState"] =
    task.state === "DONE" ? "completed" : task.state === "FAILED" || task.state === "CANCELLED" ? "failed" : "interrupted";
  const attempts = records.listAttempts(task.id);
  const durations = attempts.map((attempt) => attempt.endedAt ? Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt) : null);
  const usage = attempts.map((attempt) => normalizeAttemptUsage({ attemptId: attempt.id, adapter: attempt.adapter, raw: attempt.usage }));
  const complete = usage.every((item) => item.coverage === "complete");
  const sumKnown = (pick: (item: (typeof usage)[number]) => number | null) => {
    const values = usage.map(pick);
    return complete && values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + (value as number), 0) : null;
  };
  return recordMeasurement(records, {
    experimentId: input.experimentId,
    variant: input.variant,
    caseKey: input.caseKey,
    repeatIndex: input.repeatIndex,
    accepted: trialState === "completed",
    requirementViolations: records.listObligations(task.id).filter((item) => item.kind === "requirement_evidence" && item.state !== "resolved").length,
    repairs: task.repairsUsed,
    interventions: records.listEventsOfKind(task.id, "task.retry_requested").length,
    durationMs: durations.every((value) => value !== null) ? durations.reduce<number>((total, value) => total + (value as number), 0) : null,
    reportedInputTokens: sumKnown((item) => item.knownInputEvents),
    reportedOutputTokens: sumKnown((item) => item.outputTokens),
    relevantFiles: records.packetsForTask(task.id).reduce((total, packet) => total + (Array.isArray(packet.files) ? (packet.files as unknown[]).length : 0), 0),
    warnings: 0,
    evidencePath: null,
    trialState,
    source: "live_trial",
    usageCoverage: complete ? "complete" : "partial",
    taskId: task.id,
  });
}

export function completeExperiment(records: Records, experimentId: string): { experiment: OptimizationExperiment; comparison: ExperimentComparison } {
  const current = getExperiment(records, experimentId);
  if (!current) throw new Error(`Unknown experiment ${experimentId}`);
  if (current.status === "completed") throw new Error("Completed experiments are immutable");
  const comparison = compareExperiment(records, experimentId);
  const dir = artifactDir("optimization", experimentId);
  const evidencePath = join(dir, "comparison.json");
  writeFileSync(evidencePath, JSON.stringify({ experiment: current, measurements: listMeasurements(records, experimentId), comparison }, null, 2), { mode: 0o600 });
  const conclusion = comparison.reasons.join(" ");
  records.store.run(
    "UPDATE optimization_experiments SET status = 'completed', conclusion = ?, evidence_path = ?, completed_at = ? WHERE id = ?",
    conclusion, evidencePath, nowIso(), experimentId,
  );
  records.recordEvent({ kind: "optimization.completed", projectId: current.projectId, data: { experimentId, result: comparison.result, evidencePath } });
  return { experiment: getExperiment(records, experimentId) as OptimizationExperiment, comparison };
}

export function experimentDetail(records: Records, id: string): {
  experiment: OptimizationExperiment;
  measurements: OptimizationMeasurement[];
  comparison: ExperimentComparison | null;
} {
  const current = getExperiment(records, id);
  if (!current) throw new Error(`Unknown experiment ${id}`);
  const measurements = listMeasurements(records, id);
  let comparison: ExperimentComparison | null = null;
  try { comparison = compareExperiment(records, id); } catch { /* incomplete fixed suite */ }
  return { experiment: current, measurements, comparison };
}
