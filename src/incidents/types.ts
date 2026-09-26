export const INCIDENT_CONFIDENCE = ["unknown", "low", "medium", "high", "verified"] as const;
export type IncidentConfidence = (typeof INCIDENT_CONFIDENCE)[number];
export const INCIDENT_LIFECYCLES = ["open", "investigating", "mitigated", "resolved", "superseded"] as const;
export type IncidentLifecycle = (typeof INCIDENT_LIFECYCLES)[number];

export interface Incident {
  id: string;
  signature: string;
  classifierVersion: string;
  category: string;
  layer: string;
  symptom: string;
  hypothesis: string | null;
  confirmedCause: string | null;
  confidence: IncidentConfidence;
  lifecycle: IncidentLifecycle;
  affectedVersionStart: string | null;
  affectedVersionEnd: string | null;
  lessonRefs: string[];
  fixRefs: string[];
  testRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IncidentOccurrence {
  id: string;
  incidentId: string;
  sourceKey: string;
  taskId: string | null;
  stageRunId: string | null;
  attemptId: string | null;
  revision: string | null;
  evidenceRefs: string[];
  observedAt: string;
}
