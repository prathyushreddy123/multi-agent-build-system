import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { resolveApplicationProfiles } from "../profiles/index.ts";
import { resolveProjectModule, resolveTool, type ToolResolution } from "../profiles/tools.ts";
import type { ComponentProfile, ToolRequirement } from "../profiles/types.ts";

export const ENVIRONMENT_PREFLIGHT_VERSION = "mabs.environment-preflight.v1";

export type ReadinessState = "ready" | "setup_required" | "unavailable" | "unknown";
export type EvidenceStatus = "pass" | "fail" | "unknown";

export interface PreflightEvidence {
  id: string;
  kind: "worktree" | "runtime" | "tool" | "check" | "capability" | "filesystem" | "provider";
  status: EvidenceStatus;
  summary: string;
  details: Record<string, unknown>;
}

export interface SetupAction {
  component: string;
  reason: string;
  command: string[];
}

export interface SetupPlan {
  requiresAuthorization: true;
  executesAutomatically: false;
  actions: SetupAction[];
}

export interface WorktreeExpectation {
  /** Exact revision expected at HEAD. */
  revision?: string | null;
  branch?: string | null;
  /** Revision that must be an ancestor of HEAD. */
  baseRevision?: string | null;
  /** Dependency revisions that must already be integrated into HEAD. */
  dependencyRevisions?: readonly string[];
  /** Dirty paths known to belong to the current stage. Empty means clean. */
  allowedDirtyPaths?: readonly string[];
}

/**
 * Explicit execution policy. Preflight never widens it. A registered check is
 * invokable only when the worker is allowed that exact argv or the bounded
 * controller runner is available.
 */
export interface CheckCapabilityPolicy {
  version: string;
  workerCheckCommands: readonly (readonly string[])[];
  controllerCheckRunner: boolean;
  /** Adapter-specific permission/capability facts included in cache identity. */
  permissions?: {
    worktreeRead?: boolean;
    outputWrite?: boolean;
    [key: string]: unknown;
  };
}

export interface PreflightInput {
  worktreePath: string;
  expected?: WorktreeExpectation;
  /** Optional controller-collected Git facts, useful when subprocess policy denies Git. */
  worktreeSnapshot?: WorktreeSnapshot;
  providerTools?: readonly string[];
  capabilityPolicy?: CheckCapabilityPolicy;
  outputPaths?: readonly string[];
  minimumFreeBytes?: number;
  pathEnv?: string;
}

export interface WorktreeSnapshot {
  root: string;
  revision: string | null;
  branch: string | null;
  dirtyEntries: string[];
  integratedRevisions: string[];
  errors?: string[];
}

export interface PreflightComponent {
  root: string;
  profile: string;
  state: ReadinessState;
  missingTools: string[];
  setupCommands: string[][];
}

export interface PreflightResult {
  version: typeof ENVIRONMENT_PREFLIGHT_VERSION;
  state: ReadinessState;
  fingerprint: string;
  checkedAt: string;
  worktreePath: string;
  revision: string | null;
  branch: string | null;
  evidence: PreflightEvidence[];
  components: PreflightComponent[];
  setupPlan: SetupPlan;
  cacheHit: boolean;
}

export interface ReadinessCacheEntry {
  fingerprint: string;
  result: PreflightResult;
}

interface GitInspection {
  available: boolean;
  root: string | null;
  revision: string | null;
  branch: string | null;
  dirtyEntries: string[];
  errors: string[];
}

interface ToolFact {
  component: string;
  requirement: ToolRequirement;
  resolution: ToolResolution;
  fileFingerprint: string | null;
}

function canonical(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(worktreePath: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    code: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function inspectGit(worktreePath: string): GitInspection {
  const errors: string[] = [];
  const root = git(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) {
    return { available: false, root: null, revision: null, branch: null, dirtyEntries: [], errors: [root.stderr.trim() || "git worktree identity is unavailable"] };
  }
  const revision = git(worktreePath, ["rev-parse", "HEAD"]);
  const branch = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  for (const result of [revision, branch, status]) {
    if (result.code !== 0) errors.push(result.stderr.trim() || "git inspection failed");
  }
  return {
    available: errors.length === 0,
    root: root.stdout.trim() || null,
    revision: revision.code === 0 ? revision.stdout.trim() || null : null,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    dirtyEntries: status.code === 0 ? status.stdout.split("\0").filter(Boolean).sort() : [],
    errors,
  };
}

function pathFromDirtyEntry(entry: string): string {
  return /^[ MADRCU?!][ MADRCU?!] /.test(entry) ? entry.slice(3) : entry;
}

function pathAllowed(path: string, allowed: readonly string[]): boolean {
  return allowed.some((candidate) => path === candidate || path.startsWith(`${candidate.replace(/\/$/, "")}/`));
}

function fileFingerprint(path: string, memo: Map<string, string>): string | null {
  const prior = memo.get(path);
  if (prior) return prior;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const fingerprint = digest(readFileSync(path));
    memo.set(path, fingerprint);
    return fingerprint;
  } catch {
    return null;
  }
}

function requirementResolution(rootPath: string, requirement: ToolRequirement, pathEnv: string | undefined): ToolResolution {
  if (requirement.kind === "project_module") return resolveProjectModule(rootPath, requirement.tool);
  if (requirement.kind === "project_local") {
    return resolveTool(rootPath, requirement.localPath ?? requirement.tool, "");
  }
  return resolveTool(rootPath, requirement.tool, pathEnv);
}

function nearestExisting(path: string): string | null {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

function evidenceId(kind: PreflightEvidence["kind"], summary: string, details: Record<string, unknown>): string {
  return `env_${digest(canonical({ kind, summary, details })).slice(7, 23)}`;
}

function stateForFlags(flags: Set<Exclude<ReadinessState, "ready">>): ReadinessState {
  if (flags.has("unavailable")) return "unavailable";
  if (flags.has("setup_required")) return "setup_required";
  if (flags.has("unknown")) return "unknown";
  return "ready";
}

function commandKey(command: readonly string[]): string {
  return canonical(command);
}

/**
 * Inspect the actual worktree without running a model, package installer,
 * project check, or provider CLI. Git is invoked only for read-only identity
 * and status queries; executable readiness itself is established by file
 * inspection.
 */
export function inspectWorktreeReadiness(input: PreflightInput): PreflightResult {
  const checkedAt = new Date().toISOString();
  let worktreePath: string;
  try {
    worktreePath = realpathSync(input.worktreePath);
  } catch (error) {
    const requestedPath = resolve(input.worktreePath);
    const details = { requestedPath, error: error instanceof Error ? error.message : String(error) };
    const missingEvidence: PreflightEvidence = {
      id: evidenceId("worktree", "The requested worktree is unavailable.", details),
      kind: "worktree",
      status: "fail",
      summary: "The requested worktree is unavailable.",
      details,
    };
    return {
      version: ENVIRONMENT_PREFLIGHT_VERSION,
      state: "unavailable",
      fingerprint: digest(canonical({ version: ENVIRONMENT_PREFLIGHT_VERSION, input: { ...input, worktreePath: requestedPath }, details })),
      checkedAt,
      worktreePath: requestedPath,
      revision: null,
      branch: null,
      evidence: [missingEvidence],
      components: [],
      setupPlan: { requiresAuthorization: true, executesAutomatically: false, actions: [] },
      cacheHit: false,
    };
  }
  const profileResolution = resolveApplicationProfiles(worktreePath);
  const gitFacts: GitInspection = input.worktreeSnapshot
    ? {
        available: (input.worktreeSnapshot.errors ?? []).length === 0,
        root: input.worktreeSnapshot.root,
        revision: input.worktreeSnapshot.revision,
        branch: input.worktreeSnapshot.branch,
        dirtyEntries: [...input.worktreeSnapshot.dirtyEntries].sort(),
        errors: [...(input.worktreeSnapshot.errors ?? [])],
      }
    : inspectGit(worktreePath);
  const evidence: PreflightEvidence[] = [];
  const flags = new Set<Exclude<ReadinessState, "ready">>();
  const componentFlags = new Map<string, Set<Exclude<ReadinessState, "ready">>>();
  const setupActions: SetupAction[] = [];
  const fileFingerprints = new Map<string, string>();
  const toolFacts: ToolFact[] = [];

  const addEvidence = (
    kind: PreflightEvidence["kind"],
    status: EvidenceStatus,
    summary: string,
    details: Record<string, unknown> = {},
  ): void => {
    evidence.push({ id: evidenceId(kind, summary, details), kind, status, summary, details });
  };
  const flag = (state: Exclude<ReadinessState, "ready">, root?: string): void => {
    flags.add(state);
    if (root) {
      const current = componentFlags.get(root) ?? new Set<Exclude<ReadinessState, "ready">>();
      current.add(state);
      componentFlags.set(root, current);
    }
  };

  if (!gitFacts.available || !gitFacts.root) {
    flag("unknown");
    addEvidence("worktree", "unknown", "Git could not establish the worktree identity.", { errors: gitFacts.errors });
  } else {
    const actualRoot = realpathSync(gitFacts.root);
    if (actualRoot !== worktreePath) {
      flag("unavailable");
      addEvidence("worktree", "fail", "The inspected path is not the root of the actual worktree.", { expectedRoot: worktreePath, actualRoot });
    } else {
      addEvidence("worktree", "pass", "Git identified the actual worktree and revision.", {
        root: actualRoot,
        revision: gitFacts.revision,
        branch: gitFacts.branch,
      });
    }
  }

  const expected = input.expected ?? {};
  if (expected.revision && gitFacts.revision !== expected.revision) {
    flag("unavailable");
    addEvidence("worktree", "fail", "HEAD does not match the pinned revision.", { expected: expected.revision, actual: gitFacts.revision });
  }
  if (expected.branch && gitFacts.branch !== expected.branch) {
    flag("unavailable");
    addEvidence("worktree", "fail", "The worktree branch does not match the expected branch.", { expected: expected.branch, actual: gitFacts.branch });
  }
  const dependencies = new Set(expected.dependencyRevisions ?? []);
  for (const ancestor of [expected.baseRevision, ...(expected.dependencyRevisions ?? [])].filter((item): item is string => Boolean(item))) {
    let integrated = input.worktreeSnapshot
      ? { code: input.worktreeSnapshot.integratedRevisions.includes(ancestor) || input.worktreeSnapshot.revision === ancestor ? 0 : 1, stdout: "", stderr: "" }
      : git(worktreePath, ["merge-base", "--is-ancestor", ancestor, "HEAD"]);
    if (integrated.code === 1 && dependencies.has(ancestor) && !input.worktreeSnapshot) {
      // Dependencies are integrated by cherry-pick, which never reuses the
      // source hash. They are integrated when every commit they introduce is
      // present by patch identity: `git cherry` marks those with "-".
      const cherry = git(worktreePath, ["cherry", "HEAD", ancestor]);
      if (cherry.code === 0) {
        const pending = cherry.stdout.split("\n").filter((line) => line.startsWith("+"));
        integrated = { code: pending.length === 0 ? 0 : 1, stdout: cherry.stdout, stderr: "" };
      } else {
        integrated = { code: 2, stdout: "", stderr: cherry.stderr };
      }
    }
    if (integrated.code === 1) {
      flag("unavailable");
      addEvidence("worktree", "fail", "A required base or dependency revision is not integrated.", { revision: ancestor });
    } else if (integrated.code !== 0) {
      flag("unknown");
      addEvidence("worktree", "unknown", "Dependency integration could not be determined.", { revision: ancestor, error: integrated.stderr.trim() });
    } else {
      addEvidence("worktree", "pass", "A required base or dependency revision is integrated.", { revision: ancestor });
    }
  }
  const allowedDirty = expected.allowedDirtyPaths ?? [];
  const unexpectedDirty = gitFacts.dirtyEntries.filter((entry) => !pathAllowed(pathFromDirtyEntry(entry), allowedDirty));
  if (unexpectedDirty.length > 0) {
    flag("unavailable");
    addEvidence("worktree", "fail", "The worktree contains unexpected changes.", { entries: unexpectedDirty });
  } else if (gitFacts.available) {
    addEvidence("worktree", "pass", "The worktree dirty state matches the stage expectation.", { entries: gitFacts.dirtyEntries });
  }

  if (profileResolution.components.length === 0) {
    flag("unknown");
    addEvidence("runtime", "unknown", "No supported application profile was detected.", {});
  }
  if (profileResolution.unsupported.length > 0) {
    flag("unavailable");
    addEvidence("runtime", "fail", "Unsupported components require explicit custom gates.", { unsupported: profileResolution.unsupported });
  }

  for (const component of profileResolution.components) {
    const rootPath = component.root === "." ? worktreePath : join(worktreePath, component.root);
    for (const requirement of component.toolRequirements) {
      const resolution = requirementResolution(rootPath, requirement, input.pathEnv);
      const executableFingerprint = resolution.path ? fileFingerprint(resolution.path, fileFingerprints) : null;
      toolFacts.push({ component: component.root, requirement, resolution, fileFingerprint: executableFingerprint });
      if (resolution.found) {
        addEvidence(requirement.kind === "runtime" ? "runtime" : "tool", "pass", `${requirement.tool} is available for ${component.root}.`, {
          component: component.root,
          kind: requirement.kind,
          source: resolution.source,
          path: resolution.path,
          fileFingerprint: executableFingerprint,
          checks: requirement.checks,
        });
      } else {
        const state = requirement.kind === "project_local" || requirement.kind === "project_module" ? "setup_required" : "unavailable";
        flag(state, component.root);
        addEvidence(requirement.kind === "runtime" ? "runtime" : "tool", "fail", `${requirement.tool} is unavailable for ${component.root}.`, {
          component: component.root,
          kind: requirement.kind,
          expectedLocalPath: requirement.localPath,
          declaredIn: requirement.declaredIn,
          checks: requirement.checks,
          searchedPath: resolution.searchedPath,
        });
        if (state === "setup_required") {
          for (const command of component.environment.setupCommands) {
            setupActions.push({ component: component.root, reason: `${requirement.tool} is required by ${requirement.checks.join(", ")}.`, command: [...command] });
          }
        }
      }
    }

    for (const check of component.checks) {
      const cwd = check.cwd ? resolve(worktreePath, check.cwd) : worktreePath;
      let cwdReady = false;
      try { cwdReady = statSync(cwd).isDirectory(); } catch { cwdReady = false; }
      const commandResolution = check.command[0]
        ? resolveTool(cwd, check.command[0], input.pathEnv)
        : { tool: "", found: false, source: null, path: null, localCandidates: [], searchedPath: false } satisfies ToolResolution;
      if (!cwdReady || !commandResolution.found) {
        flag("unavailable", component.root);
        addEvidence("check", "fail", `Registered check ${check.name} cannot be invoked in this worktree.`, {
          cwd,
          cwdReady,
          command: check.command,
          commandResolved: commandResolution.found,
        });
      } else {
        addEvidence("check", "pass", `Registered check ${check.name} has an available command and working directory.`, {
          cwd,
          command: check.command,
          commandPath: commandResolution.path,
        });
      }
    }
  }

  const policy = input.capabilityPolicy;
  if (!policy) {
    flag("unknown");
    addEvidence("capability", "unknown", "Check execution capability policy was not supplied.", {});
  } else {
    if (policy.permissions?.worktreeRead === false) {
      flag("unavailable");
      addEvidence("filesystem", "fail", "The active permission policy denies worktree reads.", { policyVersion: policy.version });
    }
    if ((input.outputPaths?.length ?? 0) > 0 && policy.permissions?.outputWrite === false) {
      flag("unavailable");
      addEvidence("filesystem", "fail", "The active permission policy denies evidence/output writes.", {
        policyVersion: policy.version,
        outputPaths: input.outputPaths,
      });
    }
    const allowed = new Set(policy.workerCheckCommands.map(commandKey));
    const uncovered = profileResolution.checks
      .filter((check) => !allowed.has(commandKey(check.command)) && !policy.controllerCheckRunner)
      .map((check) => check.name);
    if (uncovered.length > 0) {
      flag("unavailable");
      addEvidence("capability", "fail", "Some registered checks have no authorized execution route.", {
        checks: uncovered,
        controllerCheckRunner: policy.controllerCheckRunner,
      });
    } else {
      addEvidence("capability", "pass", "Every registered check has an existing bounded execution route.", {
        policyVersion: policy.version,
        controllerCheckRunner: policy.controllerCheckRunner,
      });
    }
  }

  const providerFacts = (input.providerTools ?? []).map((tool) => {
    const resolution = resolveTool(worktreePath, tool, input.pathEnv);
    const executableFingerprint = resolution.path ? fileFingerprint(resolution.path, fileFingerprints) : null;
    if (!resolution.found) {
      flag("unavailable");
      addEvidence("provider", "fail", `Provider tool ${tool} is not executable in this environment.`, { tool, searchedPath: resolution.searchedPath });
    } else {
      addEvidence("provider", "pass", `Provider tool ${tool} is present with executable permissions; no model was launched.`, {
        tool,
        path: resolution.path,
        fileFingerprint: executableFingerprint,
      });
    }
    return { tool, resolution, fileFingerprint: executableFingerprint };
  });

  const outputFacts = (input.outputPaths ?? []).map((path) => {
    const absolute = isAbsolute(path) ? path : join(worktreePath, path);
    const existing = nearestExisting(absolute);
    let writable = false;
    if (existing) {
      try { accessSync(existing, constants.W_OK); writable = true; } catch { writable = false; }
    }
    if (!writable) {
      flag("unavailable");
      addEvidence("filesystem", "fail", "An evidence/output path is not writable under the current permissions.", { path: absolute, existingParent: existing });
    } else {
      addEvidence("filesystem", "pass", "An evidence/output path is writable under the current permissions.", { path: absolute, existingParent: existing });
    }
    return { path: absolute, existingParent: existing, writable };
  });

  let freeBytes: number | null = null;
  try {
    const fs = statfsSync(worktreePath);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
    if (input.minimumFreeBytes !== undefined && freeBytes < input.minimumFreeBytes) {
      flag("unavailable");
      addEvidence("filesystem", "fail", "The worktree filesystem has insufficient free space.", { freeBytes, minimumFreeBytes: input.minimumFreeBytes });
    } else {
      addEvidence("filesystem", "pass", "The worktree filesystem has sufficient observed free space.", { freeBytes, minimumFreeBytes: input.minimumFreeBytes ?? null });
    }
  } catch (error) {
    flag("unknown");
    addEvidence("filesystem", "unknown", "Filesystem headroom could not be inspected.", { error: error instanceof Error ? error.message : String(error) });
  }

  const uniqueActions = [...new Map(setupActions.map((action) => [canonical(action), action])).values()];
  const componentResults: PreflightComponent[] = profileResolution.components.map((component) => ({
    root: component.root,
    profile: component.kind,
    state: stateForFlags(componentFlags.get(component.root) ?? new Set()),
    missingTools: toolFacts
      .filter((fact) => fact.component === component.root && !fact.resolution.found)
      .map((fact) => fact.requirement.tool),
    setupCommands: component.environment.setupCommands.map((command) => [...command]),
  }));

  const profileInputs = profileResolution.components.map((component: ComponentProfile) => ({
    root: component.root,
    kind: component.kind,
    version: component.version,
    manifest: component.manifest,
    manifestFingerprint: fileFingerprint(join(worktreePath, component.manifest), fileFingerprints),
    lockfile: component.lockfile,
    lockfileFingerprint: component.lockfile ? fileFingerprint(join(worktreePath, component.lockfile), fileFingerprints) : null,
    runtimeVersion: component.runtimeVersion,
    packageManager: component.packageManager,
    checks: component.checks,
    toolRequirements: component.toolRequirements,
    setupCommands: component.environment.setupCommands,
  }));
  const fingerprintInputs = {
    version: ENVIRONMENT_PREFLIGHT_VERSION,
    worktreePath,
    git: gitFacts,
    expected,
    profilesVersion: profileResolution.version,
    profileInputs,
    unsupported: profileResolution.unsupported,
    tools: toolFacts,
    providers: providerFacts,
    capabilityPolicy: policy ?? null,
    worktreeSnapshot: input.worktreeSnapshot ?? null,
    outputFacts,
    // The headroom verdict, not the byte count: free space changes with every
    // write on the filesystem, and hashing it would make the cache never hit.
    freeSpace: freeBytes === null
      ? "unknown"
      : input.minimumFreeBytes === undefined || freeBytes >= input.minimumFreeBytes ? "sufficient" : "insufficient",
    minimumFreeBytes: input.minimumFreeBytes ?? null,
    pathEnv: input.pathEnv ?? process.env.PATH ?? "",
  };
  const fingerprint = digest(canonical(fingerprintInputs));

  return {
    version: ENVIRONMENT_PREFLIGHT_VERSION,
    state: stateForFlags(flags),
    fingerprint,
    checkedAt,
    worktreePath,
    revision: gitFacts.revision,
    branch: gitFacts.branch,
    evidence,
    components: componentResults,
    setupPlan: { requiresAuthorization: true, executesAutomatically: false, actions: uniqueActions },
    cacheHit: false,
  };
}

/** Reuse a result only when every readiness-relevant input fingerprint matches. */
export function preflightWorktree(input: PreflightInput, cached?: ReadinessCacheEntry | null): PreflightResult {
  const inspected = inspectWorktreeReadiness(input);
  if (
    cached && cached.result.version === ENVIRONMENT_PREFLIGHT_VERSION &&
    cached.fingerprint === inspected.fingerprint && cached.result.fingerprint === inspected.fingerprint
  ) {
    return { ...cached.result, cacheHit: true };
  }
  return inspected;
}

export function readinessCacheEntry(result: PreflightResult): ReadinessCacheEntry {
  return { fingerprint: result.fingerprint, result: { ...result, cacheHit: false } };
}
