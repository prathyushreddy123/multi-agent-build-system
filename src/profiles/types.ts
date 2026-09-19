import type { GateSpec } from "../store/records.ts";

export type ProfileKind = "python" | "javascript-typescript";
export type PackageManager = "python" | "uv" | "poetry" | "pipenv" | "npm" | "pnpm" | "yarn" | "bun";

export interface EnvironmentPlan {
  runtime: string;
  versionFile: string | null;
  setupCommands: string[][];
  missingPrerequisites: string[];
  notes: string[];
}

export interface ArtifactPlan {
  entryPoints: string[];
  buildOutputs: string[];
  reports: string[];
  development: string[];
}

export interface ComponentProfile {
  kind: ProfileKind;
  version: string;
  root: string;
  language: string;
  manifest: string;
  runtimeVersion: string | null;
  packageManager: PackageManager;
  lockfile: string | null;
  evidence: string[];
  environment: EnvironmentPlan;
  checks: GateSpec[];
  artifacts: ArtifactPlan;
}

export interface ProfileResolution {
  version: "application-profiles-v1";
  components: ComponentProfile[];
  checks: GateSpec[];
  missingPrerequisites: string[];
  unsupported: string[];
}

export interface ProfileSelection {
  kind?: ProfileKind | "auto";
  packageManager?: PackageManager;
  language?: string | null;
  runtime?: string | null;
}

export interface ScaffoldResult {
  kind: ProfileKind;
  files: string[];
  environment: EnvironmentPlan;
}

export interface ApplicationProfile {
  kind: ProfileKind;
  version: string;
  detect(repoPath: string): ComponentProfile[];
  scaffold(repoPath: string, name: string, selection: ProfileSelection): ScaffoldResult;
}
