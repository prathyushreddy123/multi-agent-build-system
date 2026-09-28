import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { artifactDir } from "../core/paths.ts";
import { ids } from "../core/ids.ts";
import { evaluateCapability, loadCapabilityRegistry } from "../routing/capabilities.ts";
import { fromJson, nowIso, toJson, type Row } from "../store/db.ts";
import type { TaskClass } from "../routing/router.ts";
import type { Records, Task } from "../store/records.ts";
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
  budget: {
    maxTrials: number;
    maxElapsedMs: number;
    usageWarningInputTokens: number | null;
    /** Provider attempts one trial task may consume; required for a live run. */
    maxAttemptsPerTrial?: number;
  };
  /**
   * The fixed work each case performs in a live run: the same objective from
   * the same starting revision for both variants. Required for a live run.
   */
  trialCases?: Record<string, TrialCase>;
}

export interface TrialCase {
  startingRevision: string;
  title: string;
  objective: string;
  acceptanceCriteria?: string[];
  taskClass?: TaskClass;
}

/**
 * The only configuration a live trial can apply per task. Anything else
 * changes shared project state, so it is measured manually, never live.
 */
export const LIVE_TRIAL_KEYS = ["adapter", "model", "effort"] as const;

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
  /** Declared budget limits the live run exceeded; any breach withholds proposal support. */
  budgetBreaches: string[];
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
  const maxAttempts = protocol.budget?.maxAttemptsPerTrial;
  if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) errors.push("budget.maxAttemptsPerTrial must be a positive integer.");
  for (const caseKey of Object.keys(protocol.trialCases ?? {})) {
    if (!protocol.cases?.includes(caseKey)) errors.push(`trialCases names ${caseKey}, which is not a declared case.`);
  }
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
    protocol ? toJson({ cases: protocol.cases, repeats: protocol.repeats, missingData: protocol.missingData, budget: protocol.budget, trialCases: protocol.trialCases }) : null,
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

/** Manual or replay evidence. Live-trial evidence is recorded only by recordTrialFromTask. */
export function recordMeasurement(records: Records, input: MeasurementInput): OptimizationMeasurement {
  if (input.source === "live_trial") throw new Error("Live-trial measurements are recorded only from a bound trial task (optimization record-trial).");
  return insertMeasurement(records, input);
}

function insertMeasurement(records: Records, input: MeasurementInput): OptimizationMeasurement {
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
  // A run that overspent its declared budget is not the run that was authorized.
  const budgetBreaches = protocol && current.runAuthorization ? experimentBudgetState(records, experimentId).reasons : [];
  if (budgetBreaches.length > 0) reasons.push(`Budget exceeded, so this result cannot support a proposal: ${budgetBreaches.join(" ")}`);
  return {
    result, evidence, comparableCases: cases, missingPairs, perCase, primaryMetric: primary, baseline, candidate,
    safeguardsPassed, tradeOffsWithinTolerance, trials, sources,
    budgetBreaches,
    supportsProposal: (result === "improved" || result === "limitation_resolved") && budgetBreaches.length === 0,
    reasons,
  };
}

export interface RunManifest {
  experimentId: string;
  protocolVersion: string;
  projectId: string | null;
  trials: { caseKey: string; repeatIndex: number; variant: ExperimentVariant; order: number }[];
  budget: ExperimentProtocol["budget"];
  eligibility: { variant: ExperimentVariant; eligible: boolean; reasons: string[] }[];
  /** Exactly what each variant applies to its trial tasks. */
  variants: Record<ExperimentVariant, Record<string, unknown>>;
  trialCases: Record<string, TrialCase> | null;
  /** The project's checks, configuration, and review/governance policy every trial runs under. */
  environment: { configVersion: string | null; checkCommands: unknown; reviewPolicy: unknown; governanceVersion: number | null } | null;
  /** Why this manifest cannot be authorized for live trials; empty when it can. */
  liveBlockers: string[];
  providerCalls: 0;
}

function fingerprintOf(manifest: RunManifest): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

function revisionExists(repoPath: string, revision: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The deterministic manifest, with no file or event written. */
function buildManifest(records: Records, current: OptimizationExperiment): RunManifest {
  if (!current.protocol) throw new Error("A run manifest requires a declared experiment protocol.");
  const protocol = current.protocol;
  const trials: RunManifest["trials"] = [];
  let order = 0;
  protocol.cases.forEach((caseKey, caseIndex) => {
    for (let repeatIndex = 0; repeatIndex < protocol.repeats; repeatIndex += 1) {
      // Counterbalanced: alternate which variant runs first across pairs.
      const first: ExperimentVariant = (caseIndex + repeatIndex) % 2 === 0 ? "baseline" : "candidate";
      const second: ExperimentVariant = first === "baseline" ? "candidate" : "baseline";
      trials.push({ caseKey, repeatIndex, variant: first, order: order++ }, { caseKey, repeatIndex, variant: second, order: order++ });
    }
  });
  const registry = loadCapabilityRegistry();
  const eligibility = (["baseline", "candidate"] as const).map((variant) => {
    const config = (variant === "baseline" ? current.baselineConfig : current.candidateConfig) as { adapter?: string; model?: string | null; effort?: string | null };
    if (!config.adapter) return { variant, eligible: true, reasons: ["variant does not change the launch route"] };
    const evidence = evaluateCapability(registry, { provider: config.adapter, model: config.model ?? null, effort: config.effort ?? null }).evidence;
    return { variant, eligible: evidence.eligible, reasons: evidence.reasons };
  });
  if (trials.length > protocol.budget.maxTrials) throw new Error(`Run needs ${trials.length} trials, above budget.maxTrials ${protocol.budget.maxTrials}.`);

  const project = current.projectId ? records.getProject(current.projectId) : null;
  const liveBlockers: string[] = [];
  if (!project) liveBlockers.push("A live run needs the experiment's project; trials run under its governance and checks.");
  for (const variant of ["baseline", "candidate"] as const) {
    const keys = Object.keys(variant === "baseline" ? current.baselineConfig : current.candidateConfig);
    const unsupported = keys.filter((key) => !(LIVE_TRIAL_KEYS as readonly string[]).includes(key));
    if (unsupported.length > 0) liveBlockers.push(`${variant} changes ${unsupported.join(", ")}, which a live trial cannot apply per task; measure it manually.`);
  }
  const maxAttempts = protocol.budget.maxAttemptsPerTrial;
  if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1) liveBlockers.push("budget.maxAttemptsPerTrial is required for a live run.");
  for (const caseKey of protocol.cases) {
    const trialCase = protocol.trialCases?.[caseKey];
    if (!trialCase?.startingRevision || !trialCase.objective?.trim() || !trialCase.title?.trim()) {
      liveBlockers.push(`Case ${caseKey} needs a starting revision, title, and objective for a live run.`);
    } else if (project && !revisionExists(project.repoPath, trialCase.startingRevision)) {
      liveBlockers.push(`Case ${caseKey} starting revision ${trialCase.startingRevision} is not a commit in ${project.repoPath}.`);
    }
  }
  return {
    experimentId: current.id,
    protocolVersion: current.protocolVersion ?? EXPERIMENT_PROTOCOL_VERSION,
    projectId: current.projectId,
    trials,
    budget: protocol.budget,
    eligibility,
    variants: { baseline: current.baselineConfig, candidate: current.candidateConfig },
    trialCases: protocol.trialCases ?? null,
    environment: project ? {
      configVersion: project.configVersion ?? null,
      checkCommands: project.checkCommands,
      reviewPolicy: project.reviewPolicy,
      governanceVersion: project.governance?.version ?? null,
    } : null,
    liveBlockers,
    providerCalls: 0 as const,
  };
}

/**
 * Plan a run without executing it: the exact trials, their counterbalanced
 * order, the work and starting revision of each case, the project checks and
 * review policy they run under, the budget, and model eligibility. Zero
 * provider calls. The returned fingerprint is what an operator authorizes.
 */
export function prepareRun(records: Records, experimentId: string): { manifest: RunManifest; fingerprint: string; manifestPath: string } {
  const current = getExperiment(records, experimentId);
  if (!current) throw new Error(`Unknown experiment ${experimentId}`);
  const manifest = buildManifest(records, current);
  const fingerprint = fingerprintOf(manifest);
  const manifestPath = join(artifactDir("optimization", experimentId), "run-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ fingerprint, manifest }, null, 2), { mode: 0o600 });
  records.recordEvent({ kind: "optimization.run_prepared", projectId: current.projectId, data: { experimentId, fingerprint, trials: manifest.trials.length, providerCalls: 0 } });
  return { manifest, fingerprint, manifestPath };
}

/** Bind live execution to one exact manifest. Ineligible or incompletely specified runs cannot be authorized. */
export function authorizeRun(records: Records, experimentId: string, input: { fingerprint: string; authorizedBy: string }): OptimizationExperiment {
  if (!input.authorizedBy.trim()) throw new Error("Authorization requires a named person.");
  const prepared = prepareRun(records, experimentId);
  if (prepared.fingerprint !== input.fingerprint) {
    throw new Error(`Authorization does not match the current run manifest (${prepared.fingerprint}); prepare the run again and review it.`);
  }
  const ineligible = prepared.manifest.eligibility.filter((item) => !item.eligible);
  if (ineligible.length > 0) throw new Error(`Cannot authorize: ${ineligible.map((item) => `${item.variant}: ${item.reasons.join("; ")}`).join(" | ")}`);
  if (prepared.manifest.liveBlockers.length > 0) throw new Error(`Cannot authorize a live run: ${prepared.manifest.liveBlockers.join(" ")}`);
  const authorization = { fingerprint: input.fingerprint, authorizedBy: input.authorizedBy, at: nowIso() };
  records.store.run("UPDATE optimization_experiments SET run_authorization = ? WHERE id = ?", toJson(authorization), experimentId);
  const current = getExperiment(records, experimentId) as OptimizationExperiment;
  records.recordEvent({ kind: "optimization.run_authorized", projectId: current.projectId, data: { experimentId, ...authorization } });
  return current;
}

export interface TrialBinding {
  experimentId: string;
  variant: ExperimentVariant;
  caseKey: string;
  repeatIndex: number;
  taskId: string;
  manifestFingerprint: string;
  startingRevision: string;
  appliedConfig: Record<string, unknown>;
  createdAt: string;
}

function binding(row: Row): TrialBinding {
  return {
    experimentId: row.experiment_id as string, variant: row.variant as ExperimentVariant, caseKey: row.case_key as string,
    repeatIndex: Number(row.repeat_index), taskId: row.task_id as string, manifestFingerprint: row.manifest_fingerprint as string,
    startingRevision: row.starting_revision as string, appliedConfig: fromJson(row.applied_config, {}), createdAt: row.created_at as string,
  };
}

export function trialBindingForTask(records: Records, taskId: string): TrialBinding | null {
  const row = records.store.get("SELECT * FROM optimization_trial_bindings WHERE task_id = ?", taskId);
  return row ? binding(row) : null;
}

export function listTrialBindings(records: Records, experimentId: string): TrialBinding[] {
  return records.store.all("SELECT * FROM optimization_trial_bindings WHERE experiment_id = ? ORDER BY created_at, rowid", experimentId).map(binding);
}

/** The authorized manifest, re-derived: live trials stop the moment anything it fingerprints has changed. */
function authorizedManifest(records: Records, current: OptimizationExperiment): RunManifest {
  if (!current.runAuthorization) throw new Error("Live trials require an authorized run manifest.");
  const manifest = buildManifest(records, current);
  if (fingerprintOf(manifest) !== current.runAuthorization.fingerprint) {
    throw new Error("The run manifest changed after authorization (cases, revisions, checks, review policy, or variants); prepare and authorize it again.");
  }
  return manifest;
}

export interface ExperimentBudgetState {
  authorizedAt: string | null;
  elapsedMs: number | null;
  maxElapsedMs: number;
  elapsedExceeded: boolean;
  /** Live trials recorded after the elapsed budget ran out. */
  lateTrials: number;
  reportedInputTokens: number;
  usageWarningInputTokens: number | null;
  usageWarning: boolean;
  maxAttemptsPerTrial: number | null;
  attemptsByTask: Record<string, number>;
  attemptCapExceeded: boolean;
  reasons: string[];
}

/** What a live run has consumed against its declared budget. */
export function experimentBudgetState(records: Records, experimentId: string, now = new Date()): ExperimentBudgetState {
  const current = getExperiment(records, experimentId);
  if (!current?.protocol) throw new Error(`Experiment ${experimentId} has no protocol budget`);
  const budget = current.protocol.budget;
  const authorizedAt = current.runAuthorization?.at ?? null;
  const elapsedMs = authorizedAt ? now.getTime() - Date.parse(authorizedAt) : null;
  const deadline = authorizedAt ? Date.parse(authorizedAt) + budget.maxElapsedMs : null;
  const live = listMeasurements(records, experimentId).filter((item) => item.source === "live_trial");
  const lateTrials = deadline === null ? 0 : live.filter((item) => Date.parse(item.createdAt) > deadline).length;
  const reportedInputTokens = live.reduce((total, item) => total + (item.reportedInputTokens ?? 0), 0);
  const attemptsByTask = Object.fromEntries(listTrialBindings(records, experimentId).map((item) => [item.taskId, records.listAttempts(item.taskId).length]));
  const maxAttemptsPerTrial = budget.maxAttemptsPerTrial ?? null;
  const state: ExperimentBudgetState = {
    authorizedAt, elapsedMs, maxElapsedMs: budget.maxElapsedMs,
    elapsedExceeded: elapsedMs !== null && elapsedMs >= budget.maxElapsedMs,
    lateTrials, reportedInputTokens, usageWarningInputTokens: budget.usageWarningInputTokens,
    usageWarning: budget.usageWarningInputTokens !== null && reportedInputTokens > budget.usageWarningInputTokens,
    maxAttemptsPerTrial, attemptsByTask,
    attemptCapExceeded: maxAttemptsPerTrial !== null && Object.values(attemptsByTask).some((count) => count > maxAttemptsPerTrial),
    reasons: [],
  };
  if (lateTrials > 0) state.reasons.push(`${lateTrials} live trial(s) finished after the ${budget.maxElapsedMs} ms elapsed budget.`);
  if (state.usageWarning) state.reasons.push(`Reported input tokens ${reportedInputTokens} exceeded the ${budget.usageWarningInputTokens} warning threshold.`);
  if (state.attemptCapExceeded) state.reasons.push(`A trial used more than ${maxAttemptsPerTrial} provider attempt(s).`);
  return state;
}

/**
 * Start one live trial: create the case's task in the experiment's project,
 * pinned to the case's starting revision and bound to exactly this manifest
 * slot. The controller then runs it through normal governance, admission,
 * checks, and review, applying the variant's route and attempt budget.
 */
export function startTrial(records: Records, input: {
  experimentId: string;
  variant: ExperimentVariant;
  caseKey: string;
  repeatIndex: number;
}, now = new Date()): { task: Task; binding: TrialBinding } {
  const current = getExperiment(records, input.experimentId);
  if (!current) throw new Error(`Unknown experiment ${input.experimentId}`);
  if (current.status === "completed") throw new Error("Completed experiments are immutable");
  const manifest = authorizedManifest(records, current);
  const slot = manifest.trials.find((item) => item.variant === input.variant && item.caseKey === input.caseKey && item.repeatIndex === input.repeatIndex);
  if (!slot) throw new Error(`${input.variant} ${input.caseKey}#${input.repeatIndex} is not a slot in the authorized manifest.`);
  const bound = listTrialBindings(records, current.id);
  const key = (item: { variant: string; caseKey: string; repeatIndex: number }) => `${item.variant}:${item.caseKey}#${item.repeatIndex}`;
  const boundKeys = new Set(bound.map(key));
  if (boundKeys.has(key(input))) throw new Error(`Slot ${key(input)} already has a trial task.`);
  // Counterbalancing only holds if trials start in manifest order.
  const next = manifest.trials.find((item) => !boundKeys.has(key(item)));
  if (next && next.order !== slot.order) throw new Error(`Trials start in manifest order; the next slot is ${key(next)}.`);
  const budget = experimentBudgetState(records, current.id, now);
  if (budget.elapsedExceeded) throw new Error(`The ${budget.maxElapsedMs} ms elapsed budget is spent; no further trials start.`);
  if (bound.length >= manifest.budget.maxTrials) throw new Error(`budget.maxTrials ${manifest.budget.maxTrials} is spent.`);
  const trialCase = manifest.trialCases?.[input.caseKey] as TrialCase;
  const appliedConfig = manifest.variants[input.variant];
  return records.store.tx(() => {
    const task = records.createTask({
      projectId: current.projectId as string,
      title: `${trialCase.title} [trial ${current.id} ${input.variant} ${input.caseKey}#${input.repeatIndex}]`,
      objective: trialCase.objective,
      acceptanceCriteria: trialCase.acceptanceCriteria ?? [],
      taskClass: trialCase.taskClass,
    });
    // Both variants of a case start from the same fixed revision.
    records.updateTaskFields(task.id, { base_revision: trialCase.startingRevision });
    const createdAt = nowIso();
    records.store.run(
      `INSERT INTO optimization_trial_bindings(experiment_id, variant, case_key, repeat_index, task_id,
         manifest_fingerprint, starting_revision, applied_config, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      current.id, input.variant, input.caseKey, input.repeatIndex, task.id,
      current.runAuthorization?.fingerprint, trialCase.startingRevision, toJson(appliedConfig), createdAt,
    );
    records.recordEvent({
      kind: "optimization.trial_started", projectId: current.projectId, taskId: task.id,
      data: { experimentId: current.id, variant: input.variant, caseKey: input.caseKey, repeatIndex: input.repeatIndex, appliedConfig },
    });
    return { task: records.getTask(task.id) as Task, binding: trialBindingForTask(records, task.id) as TrialBinding };
  });
}

const RESTING_STATES = new Set(["DONE", "FAILED", "CANCELLED", "BLOCKED"]);

/**
 * Record the live trial of a task that `startTrial` created for exactly this
 * slot. The task must belong to the experiment's project, start from the
 * case's revision, and have run through the controller on the variant's
 * route. Every outcome is recorded: a failed or interrupted task becomes a
 * failed or interrupted, unaccepted trial, never a dropped one.
 */
export function recordTrialFromTask(records: Records, input: {
  experimentId: string;
  variant: ExperimentVariant;
  caseKey: string;
  repeatIndex: number;
  taskId: string;
}, now = new Date()): OptimizationMeasurement {
  const current = getExperiment(records, input.experimentId);
  if (!current) throw new Error(`Unknown experiment ${input.experimentId}`);
  if (!current.runAuthorization) throw new Error("Live trials require an authorized run manifest.");
  const task = records.getTask(input.taskId);
  if (!task) throw new Error(`Unknown task ${input.taskId}`);
  const bound = trialBindingForTask(records, task.id);
  const slot = `${input.variant} ${input.caseKey}#${input.repeatIndex}`;
  if (!bound || bound.experimentId !== current.id) throw new Error(`Task ${task.id} was not started as a trial of ${current.id}; only startTrial tasks are live evidence.`);
  if (bound.variant !== input.variant || bound.caseKey !== input.caseKey || bound.repeatIndex !== input.repeatIndex) {
    throw new Error(`Task ${task.id} is bound to ${bound.variant} ${bound.caseKey}#${bound.repeatIndex}, not ${slot}.`);
  }
  if (bound.manifestFingerprint !== current.runAuthorization.fingerprint) throw new Error("The trial was started under a different authorization.");
  if (task.projectId !== current.projectId) throw new Error(`Task ${task.id} belongs to ${task.projectId}, not the experiment's project ${current.projectId}.`);
  if (task.baseRevision !== bound.startingRevision) throw new Error(`Task ${task.id} started from ${task.baseRevision}, not the case revision ${bound.startingRevision}.`);
  if (!RESTING_STATES.has(task.state)) throw new Error(`Task ${task.id} is ${task.state}; a trial is recorded once it comes to rest.`);
  const stages = records.stageRunsForTask(task.id);
  if (stages.length === 0) throw new Error(`Task ${task.id} has no controller stage; it did not run through normal execution.`);
  const attempts = records.listAttempts(task.id);
  for (const attempt of attempts) {
    if (!attempt.stageRunId || !records.admissionForStage(attempt.stageRunId)) {
      throw new Error(`Attempt ${attempt.id} has no admitted stage; the trial bypassed controller admission.`);
    }
    if (attempt.kind === "review") continue;
    const applied = bound.appliedConfig as { adapter?: string; model?: string | null; effort?: string | null };
    const mismatch = [
      applied.adapter !== undefined && attempt.adapter !== applied.adapter ? `adapter ${attempt.adapter}` : null,
      applied.model !== undefined && attempt.requestedModel !== applied.model ? `model ${attempt.requestedModel}` : null,
      applied.effort !== undefined && attempt.requestedEffort !== applied.effort ? `effort ${attempt.requestedEffort}` : null,
    ].filter((item): item is string => item !== null);
    if (mismatch.length > 0) throw new Error(`Attempt ${attempt.id} ran ${mismatch.join(", ")}, not the ${input.variant} configuration.`);
  }
  const trialState: OptimizationMeasurement["trialState"] =
    task.state === "DONE" ? "completed" : task.state === "FAILED" || task.state === "CANCELLED" ? "failed" : "interrupted";
  const durations = attempts.map((attempt) => attempt.endedAt ? Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt) : null);
  const usage = attempts.map((attempt) => normalizeAttemptUsage({ attemptId: attempt.id, adapter: attempt.adapter, raw: attempt.usage }));
  const complete = usage.every((item) => item.coverage === "complete");
  const sumKnown = (pick: (item: (typeof usage)[number]) => number | null) => {
    const values = usage.map(pick);
    return complete && values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + (value as number), 0) : null;
  };
  const reportedInputTokens = sumKnown((item) => item.knownInputEvents);
  const before = experimentBudgetState(records, current.id, now);
  const warnings: string[] = [];
  if (before.elapsedExceeded) warnings.push(`recorded after the ${before.maxElapsedMs} ms elapsed budget`);
  const budget = current.protocol?.budget;
  if (budget?.usageWarningInputTokens != null && before.reportedInputTokens + (reportedInputTokens ?? 0) > budget.usageWarningInputTokens) {
    warnings.push(`input tokens passed the ${budget.usageWarningInputTokens} warning threshold`);
  }
  if (budget?.maxAttemptsPerTrial != null && attempts.length > budget.maxAttemptsPerTrial) {
    warnings.push(`${attempts.length} attempts exceeded the ${budget.maxAttemptsPerTrial}-attempt trial budget`);
  }
  const recorded = insertMeasurement(records, {
    experimentId: input.experimentId,
    variant: input.variant,
    caseKey: input.caseKey,
    repeatIndex: input.repeatIndex,
    accepted: trialState === "completed",
    requirementViolations: records.listObligations(task.id).filter((item) => item.kind === "requirement_evidence" && item.state !== "resolved").length,
    repairs: task.repairsUsed,
    interventions: records.listEventsOfKind(task.id, "task.retry_requested").length,
    durationMs: durations.every((value) => value !== null) ? durations.reduce<number>((total, value) => total + (value as number), 0) : null,
    reportedInputTokens,
    reportedOutputTokens: sumKnown((item) => item.outputTokens),
    relevantFiles: records.packetsForTask(task.id).reduce((total, packet) => total + (Array.isArray(packet.files) ? (packet.files as unknown[]).length : 0), 0),
    warnings: warnings.length,
    evidencePath: null,
    trialState,
    source: "live_trial",
    usageCoverage: complete ? "complete" : "partial",
    taskId: task.id,
  });
  if (warnings.length > 0) {
    records.recordEvent({
      kind: "optimization.budget_warning", projectId: current.projectId, taskId: task.id,
      data: { experimentId: current.id, measurementId: recorded.id, warnings },
    });
  }
  return recorded;
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
