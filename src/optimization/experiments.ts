import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { artifactDir } from "../core/paths.ts";
import { ids } from "../core/ids.ts";
import { fromJson, nowIso, toJson, type Row } from "../store/db.ts";
import type { Records } from "../store/records.ts";

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
}

export interface ExperimentComparison {
  result: "improved" | "limitation_resolved" | "no_improvement";
  comparableCases: string[];
  baseline: AggregateMetrics;
  candidate: AggregateMetrics;
  safeguardsPassed: boolean;
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
  };
}

function nonNegativeInteger(value: number | null | undefined, field: string): void {
  if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${field} must be a non-negative integer or null`);
}

export function createExperiment(records: Records, input: {
  projectId?: string | null;
  name: string;
  hypothesis: string;
  dimension: string;
  suiteVersion: string;
  baselineConfig: Record<string, unknown>;
  candidateConfig: Record<string, unknown>;
}): OptimizationExperiment {
  if (!input.name.trim() || !input.hypothesis.trim() || !input.dimension.trim() || !input.suiteVersion.trim()) {
    throw new Error("Experiment name, hypothesis, dimension, and suite version are required");
  }
  if (input.projectId && !records.getProject(input.projectId)) throw new Error(`Unknown project ${input.projectId}`);
  const id = ids.experiment();
  records.store.run(
    `INSERT INTO optimization_experiments(id, project_id, name, hypothesis, dimension, suite_version,
       baseline_config, candidate_config, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id, input.projectId ?? null, input.name, input.hypothesis, input.dimension, input.suiteVersion,
    toJson(input.baselineConfig), toJson(input.candidateConfig), "draft", nowIso(),
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

export function recordMeasurement(records: Records, input: Omit<OptimizationMeasurement, "id" | "createdAt">): OptimizationMeasurement {
  const current = getExperiment(records, input.experimentId);
  if (!current) throw new Error(`Unknown experiment ${input.experimentId}`);
  if (current.status === "completed") throw new Error("Completed experiments are immutable");
  if (input.variant !== "baseline" && input.variant !== "candidate") throw new Error("variant must be baseline or candidate");
  if (!input.caseKey.trim()) throw new Error("caseKey is required");
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
         reported_output_tokens, relevant_files, warnings, evidence_path, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.experimentId, input.variant, input.caseKey, input.accepted ? 1 : 0,
      input.requirementViolations, input.repairs, input.interventions, input.durationMs,
      input.reportedInputTokens, input.reportedOutputTokens, input.relevantFiles, input.warnings,
      input.evidencePath, nowIso(),
    );
    records.store.run("UPDATE optimization_experiments SET status = 'running' WHERE id = ?", input.experimentId);
  });
  return measurement(records.store.get("SELECT * FROM optimization_measurements WHERE id = ?", id) as Row);
}

export function listMeasurements(records: Records, experimentId: string): OptimizationMeasurement[] {
  return records.store.all(
    "SELECT * FROM optimization_measurements WHERE experiment_id = ? ORDER BY case_key, variant",
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

export function compareExperiment(records: Records, experimentId: string): ExperimentComparison {
  const measurements = listMeasurements(records, experimentId);
  const baselineByCase = new Map(measurements.filter((item) => item.variant === "baseline").map((item) => [item.caseKey, item]));
  const candidateByCase = new Map(measurements.filter((item) => item.variant === "candidate").map((item) => [item.caseKey, item]));
  const comparableCases = [...baselineByCase.keys()].filter((key) => candidateByCase.has(key)).sort();
  if (comparableCases.length === 0 || comparableCases.length !== baselineByCase.size || comparableCases.length !== candidateByCase.size) {
    throw new Error("Every fixed suite case requires exactly one baseline and one candidate measurement");
  }
  const baselineItems = comparableCases.map((key) => baselineByCase.get(key) as OptimizationMeasurement);
  const candidateItems = comparableCases.map((key) => candidateByCase.get(key) as OptimizationMeasurement);
  const baseline = aggregate(baselineItems);
  const candidate = aggregate(candidateItems);
  const safeguardsPassed = candidate.accepted >= baseline.accepted &&
    candidate.requirementViolations <= baseline.requirementViolations && candidate.interventions <= baseline.interventions;
  const reasons: string[] = [];
  const resolved = baselineItems.every((item) => item.relevantFiles === 0) &&
    candidateItems.every((item) => item.relevantFiles > 0) && safeguardsPassed;
  const improved = safeguardsPassed && (
    candidate.accepted > baseline.accepted || candidate.repairs < baseline.repairs ||
    (candidate.durationMs !== null && baseline.durationMs !== null && candidate.durationMs < baseline.durationMs) ||
    (candidate.reportedInputTokens !== null && baseline.reportedInputTokens !== null && candidate.reportedInputTokens < baseline.reportedInputTokens)
  );
  if (!safeguardsPassed) reasons.push("Candidate regressed accepted work, requirement violations, or interventions.");
  if (resolved) reasons.push("Every fixed case moved from an empty relevant-file manifest to a non-empty manifest without safeguard regression.");
  if (improved) reasons.push("At least one accepted-work, repair, duration, or reported-usage metric improved without safeguard regression.");
  if (!resolved && !improved && safeguardsPassed) reasons.push("Candidate was non-regressing but did not demonstrate the stated improvement or limitation resolution.");
  return { result: resolved ? "limitation_resolved" : improved ? "improved" : "no_improvement", comparableCases, baseline, candidate, safeguardsPassed, reasons };
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
