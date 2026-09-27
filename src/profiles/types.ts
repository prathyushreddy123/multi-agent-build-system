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

/**
 * One executable or Python module a registered check needs, and where the
 * project itself would provide it. `kind` is what makes "installed here"
 * different from "on PATH": project-local requirements must exist under the
 * component root, so a dependency in the main checkout never counts as
 * readiness for a task worktree.
 */
export interface ToolRequirement {
  tool: string;
  kind: "runtime" | "package_manager" | "project_local" | "project_module" | "system";
  /** Manifest field declaring the providing package, when it is declared. */
  declaredIn: string | null;
  /** Expected project-local location, relative to the component root. */
  localPath: string | null;
  /** Registered checks that cannot run without it. */
  checks: string[];
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
  /** Executables the checks above need, with project-local provenance. */
  toolRequirements: ToolRequirement[];
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
