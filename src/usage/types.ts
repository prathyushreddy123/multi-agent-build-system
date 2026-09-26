export const USAGE_COVERAGE = ["complete", "partial", "missing", "malformed"] as const;
export type UsageCoverage = (typeof USAGE_COVERAGE)[number];

export interface UsageProjection {
  attemptId: string;
  normalizerVersion: string;
  normalized: Record<string, number | string | boolean | null>;
  sourceArtifactHash: string;
  sourceOffset: number | null;
  coverage: UsageCoverage;
  sourceSemantics: string;
  updatedAt: string;
}
