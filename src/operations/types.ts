export const OPERATIONS_CONFIG_VERSION = "operations-v1";

export type Capability = "ci" | "deployment" | "monitoring" | "scheduling" | "delivery" | "costs";

export interface OperationsConfig {
  contractVersion: typeof OPERATIONS_CONFIG_VERSION;
  ci: {
    mode: "off" | "selected";
    provider: string | null;
    adapter: string | null;
    workflowPath: string | null;
  };
  deployment: {
    mode: "off" | "local" | "vps";
    target: string | null;
    adapter: string | null;
    costProposalRef: string | null;
  };
  monitoring: {
    mode: "off" | "run_health" | "application";
    adapter: string | null;
  };
  scheduling: {
    mode: "manual" | "configured";
    timezone: string | null;
    cadence: string | null;
    overlapLock: boolean;
    retryLimit: number;
    missedRunPolicy: "skip" | "run_once";
  };
  delivery: {
    mode: "local_files" | "configured";
    outputDirectory: string;
    channel: string | null;
    destinationRef: string | null;
    adapter: string | null;
  };
  costs: {
    externalServices: "off" | "proposal_required";
    monthlyCapUsd: number | null;
    proposalRef: string | null;
    paidModelApis: "prohibited";
  };
}

export interface StoredOperationsConfig {
  projectId: string;
  version: number;
  fingerprint: string;
  config: OperationsConfig;
  updatedBy: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export type OperationRunState = "prepared" | "running" | "succeeded" | "failed" | "unknown" | "recovered";

export interface OperationRun {
  id: string;
  projectId: string;
  capability: Capability;
  action: string;
  target: string;
  configFingerprint: string;
  state: OperationRunState;
  dryRun: boolean;
  approvalId: string | null;
  detail: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
}

export interface PreparedOperation {
  capability: Capability;
  status: "disabled" | "manual" | "ready" | "incomplete" | "approval_required";
  target: string | null;
  adapter: string | null;
  dryRun: true;
  commands: string[][];
  generatedFiles: { path: string; content: string }[];
  requirements: string[];
  safeguards: string[];
}

export interface DeploymentAdapter {
  name: string;
  prepare(config: OperationsConfig["deployment"]): Promise<Record<string, unknown>>;
  execute(prepared: Record<string, unknown>): Promise<{ externalId: string | null; detail: Record<string, unknown> }>;
  status(externalId: string | null): Promise<{ state: "succeeded" | "failed" | "unknown"; detail: Record<string, unknown> }>;
  recover(externalId: string | null): Promise<{ recovered: boolean; detail: Record<string, unknown> }>;
}
