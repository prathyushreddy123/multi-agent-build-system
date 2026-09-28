/**
 * Deterministic incident projection over authoritative records.
 *
 * Incidents are systemic, repeatable failures of the delivery machinery
 * (environment, provider, controller, contract), not a task's own code
 * defects, which are tracked as that task's obligations. Each occurrence is
 * keyed by the record it came from (attempt, gate, or stage), so importing the
 * same history twice, or reading the same failure copied into several
 * checkpoints, can never multiply an incident.
 *
 * Nothing here calls a model or runs on a schedule; it runs when asked.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import { diagnoseFailure, type FailureCategory, type FailureDiagnosis } from "../core/failure.ts";
import type { Records } from "../store/records.ts";

export const INCIDENT_CLASSIFIER_VERSION = "mabs.incidents.v1";

/** Categories that describe the machinery rather than the task's product code. */
export const SYSTEMIC_CATEGORIES: readonly FailureCategory[] = [
  "environment", "host_runtime", "controller", "worker_contract", "provider_capacity", "provider_auth", "unknown",
];

export interface ProjectedOccurrence {
  signature: string;
  category: FailureCategory;
  layer: "worker" | "review" | "check" | "controller";
  symptom: string;
  sourceKey: string;
  taskId: string;
  attemptId: string | null;
  stageRunId: string | null;
  revision: string | null;
  evidenceRefs: string[];
  observedAt: string;
  diagnosis: FailureDiagnosis;
}

/**
 * Reduce a failure message to its template so that the same failure with a
 * different id, path, time, or count groups together.
 */
export function normalizeSymptom(text: string): string {
  return text
    .toLowerCase()
    // Paths first, so ids inside them do not split one path into fragments.
    .replace(/(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b[a-z]{3}_[0-9a-z]{20,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{7,64}\b/g, "<hash>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function incidentSignature(category: string, layer: string, symptom: string): string {
  return createHash("sha256").update(`${INCIDENT_CLASSIFIER_VERSION}|${category}|${layer}|${normalizeSymptom(symptom)}`).digest("hex").slice(0, 24);
}

function tail(path: string | null, bytes = 8_000): string {
  if (!path || !existsSync(path)) return "";
  try {
    const size = statSync(path).size;
    const content = readFileSync(path);
    return content.subarray(Math.max(0, size - bytes)).toString("utf8");
  } catch {
    return "";
  }
}

function occurrence(input: Omit<ProjectedOccurrence, "signature" | "symptom" | "category"> & { diagnosis: FailureDiagnosis }): ProjectedOccurrence | null {
  if (!SYSTEMIC_CATEGORIES.includes(input.diagnosis.category)) return null;
  const symptom = normalizeSymptom(input.diagnosis.symptom);
  return {
    ...input,
    category: input.diagnosis.category,
    symptom,
    signature: incidentSignature(input.diagnosis.category, input.layer, symptom),
  };
}

/** Project systemic failures from recorded evidence. Read-only. */
export function projectIncidents(records: Records, filter: { projectId?: string } = {}): ProjectedOccurrence[] {
  const tasks = records.listTasks(filter.projectId ? { projectId: filter.projectId } : {});
  const projected: ProjectedOccurrence[] = [];
  for (const task of tasks) {
    for (const attempt of records.listAttempts(task.id)) {
      if (attempt.state !== "failed" || !attempt.reason) continue;
      const review = attempt.kind === "review";
      const diagnosis = diagnoseFailure({
        stage: review ? "review" : attempt.kind === "repair" ? "repair" : "implement",
        source: review ? "review" : "worker",
        exitCode: attempt.exitStatus,
        text: attempt.reason,
        legacyFailureClass: attempt.failureClass,
        evidenceIds: [attempt.outputPath].filter((path): path is string => path !== null),
      });
      const item = occurrence({
        diagnosis, layer: review ? "review" : "worker", sourceKey: `attempt:${attempt.id}`, taskId: task.id,
        attemptId: attempt.id, stageRunId: attempt.stageRunId, revision: attempt.baseRevision,
        evidenceRefs: diagnosis.evidenceIds, observedAt: attempt.endedAt ?? attempt.startedAt,
      });
      if (item) projected.push(item);
    }
    for (const gate of records.gatesForTask(task.id)) {
      if (gate.status !== "FAIL" && gate.status !== "ERROR") continue;
      const diagnosis = gate.failureDiagnosis ?? diagnoseFailure({
        stage: "check", source: "gate", exitCode: gate.rawExitStatus ?? null, timedOut: gate.timedOut ?? false,
        text: tail(gate.evidencePath), evidenceIds: [gate.evidencePath].filter((path): path is string => path !== null),
      });
      const item = occurrence({
        diagnosis, layer: "check", sourceKey: `gate:${gate.id}`, taskId: task.id, attemptId: gate.attemptId,
        stageRunId: gate.stageRunId ?? null, revision: gate.revision,
        evidenceRefs: [gate.evidencePath].filter((path): path is string => path !== null), observedAt: gate.createdAt,
      });
      if (item) projected.push(item);
    }
    for (const stage of records.stageRunsForTask(task.id)) {
      // Attempt and gate stages are already represented by their own records.
      if (stage.attemptId || stage.gateId || !stage.failureDetail) continue;
      if (stage.state !== "failed" && stage.state !== "unknown") continue;
      const diagnosis = diagnoseFailure({
        stage: stage.stage, source: "controller", text: stage.failureDetail, legacyFailureClass: stage.failureClass,
      });
      const item = occurrence({
        diagnosis, layer: "controller", sourceKey: `stage:${stage.id}`, taskId: task.id, attemptId: null,
        stageRunId: stage.id, revision: stage.revision, evidenceRefs: [], observedAt: stage.finishedAt ?? stage.reservedAt,
      });
      if (item) projected.push(item);
    }
  }
  return projected.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.sourceKey.localeCompare(right.sourceKey));
}

export interface IncidentImportSummary {
  classifierVersion: string;
  dryRun: boolean;
  occurrences: number;
  newOccurrences: number;
  existingOccurrences: number;
  incidents: { signature: string; category: string; layer: string; symptom: string; occurrences: number; existing: boolean }[];
}

/**
 * Record projected occurrences. Idempotent: re-running imports nothing new.
 * A dry run reports exactly what would be written and writes nothing.
 */
export function importIncidentHistory(records: Records, options: { projectId?: string; dryRun: boolean }): IncidentImportSummary {
  const projected = projectIncidents(records, options);
  const known = new Map(records.listIncidents().filter((incident) => incident.classifierVersion === INCIDENT_CLASSIFIER_VERSION)
    .map((incident) => [incident.signature, incident]));
  const bySignature = new Map<string, IncidentImportSummary["incidents"][number]>();
  let existingOccurrences = 0;
  for (const item of projected) {
    const incident = known.get(item.signature);
    const exists = incident ? records.incidentOccurrences(incident.id).some((occurrence) => occurrence.sourceKey === item.sourceKey) : false;
    if (exists) existingOccurrences += 1;
    const entry = bySignature.get(item.signature) ?? {
      signature: item.signature, category: item.category, layer: item.layer, symptom: item.symptom, occurrences: 0, existing: Boolean(incident),
    };
    entry.occurrences += 1;
    bySignature.set(item.signature, entry);
    if (options.dryRun || exists) continue;
    records.recordIncidentOccurrence({
      signature: item.signature,
      classifierVersion: INCIDENT_CLASSIFIER_VERSION,
      category: item.category,
      layer: item.layer,
      symptom: item.symptom,
      // The classifier's remedy is a hypothesis until someone verifies it.
      hypothesis: item.diagnosis.recoveryAction,
      confidence: item.diagnosis.confidence === "high" ? "medium" : "low",
      sourceKey: item.sourceKey,
      taskId: item.taskId,
      attemptId: item.attemptId,
      stageRunId: item.stageRunId,
      revision: item.revision,
      evidenceRefs: item.evidenceRefs,
      observedAt: item.observedAt,
    });
  }
  return {
    classifierVersion: INCIDENT_CLASSIFIER_VERSION,
    dryRun: options.dryRun,
    occurrences: projected.length,
    newOccurrences: projected.length - existingOccurrences,
    existingOccurrences,
    incidents: [...bySignature.values()].sort((left, right) => right.occurrences - left.occurrences),
  };
}
