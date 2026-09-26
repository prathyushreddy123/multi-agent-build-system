export const ADMISSION_STATES = ["reserved", "active", "released", "expired", "cancelled"] as const;
export type AdmissionState = (typeof ADMISSION_STATES)[number];

export interface AdmissionLease {
  id: string;
  stageRunId: string;
  controllerId: string;
  fencingToken: string;
  provider: string | null;
  quotaDomain: string | null;
  projectId: string;
  resources: string[];
  status: AdmissionState;
  grantedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

export interface AdmissionExplanation {
  admitted: boolean;
  reasons: string[];
  limits: Record<string, number | null>;
  observed: Record<string, number>;
}
