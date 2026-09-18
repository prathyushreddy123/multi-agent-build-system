import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { exec } from "../core/exec.ts";
import { artifactDir, worktreeRoot } from "../core/paths.ts";
import {
  canonicalConfig,
  configFingerprint,
  projectConfigSnapshot,
  validateProjectConfig,
  type ProjectConfigSnapshot,
} from "../domain/config.ts";
import { DEFAULT_POLICY } from "../domain/policy.ts";
import { DEFAULT_ROUTING_POLICY, TASK_CLASSES } from "../routing/router.ts";
import type { Records } from "../store/records.ts";
import type { CuratorEvaluation, CuratorProposal, CuratorSignals, EvaluationCase, EvaluationMetrics, ProposalInput } from "./types.ts";

export const CURATOR_SUITE_VERSION = "policy-replay-v1";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await exec("git", args, { cwd, timeoutMs });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function analyzeProject(records: Records, projectId: string): CuratorSignals {
  const project = records.getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  const tasks = records.listTasks({ projectId });
  const failuresByClass: Record<string, number> = {};
  let repairs = 0;
  let reviewChangesRequested = 0;
  for (const task of tasks) {
    repairs += task.repairsUsed;
    const failedAttempts = records.listAttempts(task.id).filter((attempt) => attempt.failureClass !== null);
    if (failedAttempts.length > 0) {
      for (const attempt of failedAttempts) {
        const failure = attempt.failureClass as string;
        failuresByClass[failure] = (failuresByClass[failure] ?? 0) + 1;
      }
    } else if (task.failureClass) {
      failuresByClass[task.failureClass] = (failuresByClass[task.failureClass] ?? 0) + 1;
    }
    reviewChangesRequested += records.reviewsForTask(task.id).filter((review) => review.verdict === "request_changes").length;
  }
  const events = records.store.all(
    "SELECT kind, data FROM events WHERE project_id = ? OR project_id IS NULL ORDER BY rowid DESC LIMIT 2000",
    projectId,
  );
  const questionCounts = new Map<string, number>();
  for (const feedback of records.listFeedback({ projectId })) {
    if (feedback.kind !== "question") continue;
    const key = feedback.body.trim().toLowerCase();
    questionCounts.set(key, (questionCounts.get(key) ?? 0) + 1);
  }
  const signals: CuratorSignals = {
    projectId,
    configVersion: project.configVersion,
    observedAt: new Date().toISOString(),
    taskCount: tasks.length,
    failuresByClass,
    repairCycles: repairs,
    reviewChangesRequested,
    routingOverrides: events.filter((event) => event.kind === "routing.override").length,
    providerFailures: events.filter((event) => event.kind === "provider.failure").length,
    repeatedQuestions: [...questionCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0),
    rejectedFingerprints: records.listCuratorProposals(projectId)
      .filter((proposal) => proposal.status === "rejected")
      .map((proposal) => proposal.fingerprint),
  };
  const path = join(artifactDir("curator", projectId, `analysis-${Date.now()}`), "signals.json");
  writeFileSync(path, JSON.stringify(signals, null, 2), { mode: 0o600 });
  records.recordEvent({ kind: "curator.analysis", projectId, data: { path, ...signals } });
  return signals;
}

export function suggestProjectConfig(records: Records, projectId: string, signals: CuratorSignals): {
  config: ProjectConfigSnapshot;
  reasons: string[];
} {
  const project = records.getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  const config = JSON.parse(canonicalConfig(projectConfigSnapshot(project))) as ProjectConfigSnapshot;
  const reasons: string[] = [];
  const implementationFailures = (signals.failuresByClass.CODE ?? 0) + (signals.failuresByClass.CONTRACT ?? 0);
  if (implementationFailures > 0 && !config.promptProfile.implementationAddendum) {
    config.promptProfile.implementationAddendum = "Before reporting completion, inspect the actual diff, run registered checks, and reconcile changed files with every acceptance criterion.";
    reasons.push(`${implementationFailures} code or contract failure(s) were observed.`);
  }
  if (signals.reviewChangesRequested > 0 && !config.promptProfile.reviewAddendum) {
    config.promptProfile.reviewAddendum = "Prioritize correctness and requirement violations; cite exact files and evidence for every actionable finding.";
    reasons.push(`${signals.reviewChangesRequested} review cycle(s) requested changes.`);
  }
  if (signals.repeatedQuestions > 0 && !config.promptProfile.researchAddendum) {
    config.promptProfile.researchAddendum = "Answer recurring questions from authoritative project records first and state clearly when retained evidence is insufficient.";
    reasons.push(`${signals.repeatedQuestions} repeated project question(s) were observed.`);
  }
  if (signals.repairCycles > config.controllerSettings.defaultRepairLimit && config.controllerSettings.defaultRepairLimit < 2) {
    config.controllerSettings.defaultRepairLimit = Math.min(2, config.controllerSettings.defaultRepairLimit + 1);
    reasons.push("Observed repair cycles exceeded the configured per-task default; the bounded default was raised by one.");
  }
  if (reasons.length === 0) throw new Error("No recurring evidence currently supports a rules-first configuration suggestion");
  return { config, reasons };
}

export async function createSuggestedProposal(records: Records, input: {
  projectId: string;
  title: string;
  rationale: string;
  proposedBy: string;
}): Promise<CuratorProposal> {
  const signals = analyzeProject(records, input.projectId);
  const suggestion = suggestProjectConfig(records, input.projectId, signals);
  return createProposal(records, {
    ...input,
    rationale: `${input.rationale}\n\nRules-first evidence: ${suggestion.reasons.join(" ")}`,
    config: suggestion.config,
    signals,
  });
}

export async function createProposal(records: Records, input: ProposalInput): Promise<CuratorProposal> {
  const project = records.getProject(input.projectId);
  if (!project) throw new Error(`Unknown project ${input.projectId}`);
  const errors = validateProjectConfig(input.config);
  if (errors.length > 0) throw new Error(`Invalid proposed configuration:\n${errors.join("\n")}`);
  if (configFingerprint(input.config) === configFingerprint(projectConfigSnapshot(project))) {
    throw new Error("Proposed configuration is identical to the active project configuration");
  }
  records.ensureProjectConfigVersion(project.id, projectConfigSnapshot(project));
  const evidenceFingerprint = hash({
    configVersion: input.signals.configVersion,
    failuresByClass: input.signals.failuresByClass,
    repairs: input.signals.repairCycles,
    reviews: input.signals.reviewChangesRequested,
    providerFailures: input.signals.providerFailures,
    repeatedQuestions: input.signals.repeatedQuestions,
  });
  const proposal = records.createCuratorProposal({
    projectId: project.id,
    title: input.title,
    rationale: input.rationale,
    fingerprint: configFingerprint(input.config),
    evidenceFingerprint,
    config: input.config,
    proposedBy: input.proposedBy,
  });

  try {
    const repo = project.repoPath;
    const baseRevision = await git(repo, ["rev-parse", project.baseBranch]);
  const branch = `mabs/curator/${proposal.id.toLowerCase()}`;
  const path = join(worktreeRoot(), "curator", project.id, proposal.id);
  if (existsSync(path)) throw new Error(`Curator workspace already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await git(repo, ["worktree", "add", "-b", branch, path, baseRevision]);
  const proposalPath = join(path, ".mabs", "proposals", `${proposal.id}.json`);
  mkdirSync(dirname(proposalPath), { recursive: true, mode: 0o700 });
  writeFileSync(proposalPath, JSON.stringify({
    proposalId: proposal.id,
    projectId: project.id,
    baseConfigVersion: project.configVersion,
    title: input.title,
    rationale: input.rationale,
    signals: input.signals,
    config: input.config,
  }, null, 2), { mode: 0o600 });
  await git(path, ["add", ".mabs"]);
  await git(path, [
    "-c", "user.name=MABS Curator",
    "-c", "user.email=mabs-curator@local",
    "commit", "-m", `mabs curator: ${input.title}`,
  ]);
  const resultRevision = await git(path, ["rev-parse", "HEAD"]);
  const diff = await git(path, ["diff", "--no-ext-diff", baseRevision, resultRevision]);
  const diffPath = join(artifactDir("curator", project.id, proposal.id), "proposal.patch");
  writeFileSync(diffPath, diff, { mode: 0o600 });
    return records.updateCuratorProposalEvidence(proposal.id, {
      branch, worktreePath: path, baseRevision, resultRevision, diffPath,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    records.failCuratorProposal(proposal.id, reason);
    throw error;
  }
}

function reportedUsage(records: Records, projectId: string): { input: number | null; output: number | null } {
  const attempts = records.listTasks({ projectId }).flatMap((task) => records.listAttempts(task.id));
  if (attempts.length === 0) return { input: null, output: null };
  const values = attempts.map((attempt) => ({
    input: attempt.usage?.input_tokens,
    output: attempt.usage?.output_tokens,
  }));
  if (values.some((value) => typeof value.input !== "number" || typeof value.output !== "number")) {
    return { input: null, output: null };
  }
  return {
    input: values.reduce((sum, value) => sum + Number(value.input), 0),
    output: values.reduce((sum, value) => sum + Number(value.output), 0),
  };
}

function policyCases(baseline: ProjectConfigSnapshot, candidate: ProjectConfigSnapshot): EvaluationCase[] {
  const cases: EvaluationCase[] = TASK_CLASSES.map((taskClass) => {
    const baselineRoute = baseline.routingOverrides[taskClass] ?? DEFAULT_ROUTING_POLICY.routes[taskClass][0] ?? null;
    const candidateRoute = candidate.routingOverrides[taskClass] ?? DEFAULT_ROUTING_POLICY.routes[taskClass][0] ?? null;
    const display = (route: typeof candidateRoute) => route ? `${route.adapter}:${route.model ?? "default"}:${route.effort ?? "default"}` : "deterministic";
    return {
      id: `route:${taskClass}`,
      kind: "routing" as const,
      baselineOutcome: display(baselineRoute),
      candidateOutcome: display(candidateRoute),
      expected: taskClass === "mechanical" ? "deterministic" : "verified subscription route",
      passed: taskClass === "mechanical" ? candidateRoute === null : candidateRoute !== null,
    };
  });
  cases.push({
    id: "review:substantive-code",
    kind: "review",
    baselineOutcome: baseline.reviewPolicy.mode,
    candidateOutcome: candidate.reviewPolicy.mode,
    expected: "declared review mode and skip classes are internally consistent",
    passed: candidate.reviewPolicy.mode !== "required" || candidate.reviewPolicy.skipTaskClasses.length === 0,
  });
  for (const action of ["merge", "deploy", "destructive_migration", "shared_data_deletion", "waive_required_gate", "activate_config_change"] as const) {
    const baselineRule = baseline.approvalPolicy.overrides[action] ?? DEFAULT_POLICY[action];
    const candidateRule = candidate.approvalPolicy.overrides[action] ?? DEFAULT_POLICY[action];
    cases.push({
      id: `approval:${action}`,
      kind: "approval",
      baselineOutcome: baselineRule,
      candidateOutcome: candidateRule,
      expected: "approval_required",
      passed: candidateRule === "approval_required",
    });
  }
  for (const gate of candidate.checkCommands) {
    cases.push({
      id: `quality:${gate.name}`,
      kind: "quality",
      baselineOutcome: baseline.checkCommands.some((item) => item.name === gate.name) ? "registered" : "not registered",
      candidateOutcome: gate.required ? "required" : "optional",
      expected: "explicit local command",
      passed: gate.command.length > 0,
    });
  }
  cases.push({
    id: "prompt:bounded",
    kind: "prompt",
    baselineOutcome: String(Object.values(baseline.promptProfile).reduce((sum, value) => sum + (value?.length ?? 0), 0)),
    candidateOutcome: String(Object.values(candidate.promptProfile).reduce((sum, value) => sum + (value?.length ?? 0), 0)),
    expected: "safe addenda at or below 4,000 characters each",
    passed: Object.values(candidate.promptProfile).every((value) => value === null || value.length <= 4_000),
  });
  return cases;
}

function metrics(records: Records, projectId: string, config: ProjectConfigSnapshot, baseline: ProjectConfigSnapshot, caseCount: number): EvaluationMetrics {
  const tasks = records.listTasks({ projectId }).slice(0, 20);
  const usage = reportedUsage(records, projectId);
  const routingChanges = TASK_CLASSES.filter((taskClass) =>
    JSON.stringify(config.routingOverrides[taskClass] ?? null) !== JSON.stringify(baseline.routingOverrides[taskClass] ?? null),
  ).length;
  return {
    cases: tasks.length + caseCount,
    completedTasks: tasks.filter((task) => task.state === "DONE").length,
    failedTasks: tasks.filter((task) => task.state === "FAILED").length,
    blockedTasks: tasks.filter((task) => task.state === "BLOCKED").length,
    repairCycles: tasks.reduce((sum, task) => sum + task.repairsUsed, 0),
    reviewChangesRequested: tasks.reduce((sum, task) =>
      sum + records.reviewsForTask(task.id).filter((review) => review.verdict === "request_changes").length, 0),
    requiredGates: config.checkCommands.filter((gate) => gate.required).length,
    routingChanges,
    promptCharacters: Object.values(config.promptProfile).reduce((sum, value) => sum + (value?.length ?? 0), 0),
    reportedInputTokens: usage.input,
    reportedOutputTokens: usage.output,
  };
}

export function evaluateProposal(records: Records, proposalId: string): CuratorEvaluation {
  const startedAt = new Date().toISOString();
  const proposal = records.getCuratorProposal(proposalId);
  if (!proposal || proposal.status !== "proposed") throw new Error(`Proposal ${proposalId} is not ready for evaluation`);
  const project = records.getProject(proposal.projectId);
  const version = records.getConfigVersion(proposal.proposedConfigVersion);
  if (!project || !version) throw new Error(`Proposal ${proposalId} has missing project or configuration state`);
  const baseline = projectConfigSnapshot(project);
  const errors = validateProjectConfig(version.payload);
  if (proposal.baseConfigVersion !== project.configVersion) errors.push("Proposal base configuration is stale.");
  if (!proposal.diffPath || !existsSync(proposal.diffPath)) errors.push("Proposal Git diff evidence is unavailable.");
  const cases = policyCases(baseline, version.payload);
  for (const failed of cases.filter((item) => !item.passed)) errors.push(`${failed.id}: expected ${failed.expected}, got ${failed.candidateOutcome}.`);
  const baselineMetrics = metrics(records, project.id, baseline, baseline, cases.length);
  const candidateMetrics = metrics(records, project.id, version.payload, baseline, cases.length);
  const status = errors.length === 0 ? "passed" : "failed";
  const evidencePath = join(artifactDir("curator", project.id, proposal.id), "evaluation.json");
  writeFileSync(evidencePath, JSON.stringify({
    suiteVersion: CURATOR_SUITE_VERSION,
    proposalId,
    status,
    errors,
    interpretation: "Policy replay validates safety and compares observable historical metrics. It does not claim candidate product-task quality or subscription spend.",
    baselineMetrics,
    candidateMetrics,
    cases,
    baselineConfig: baseline,
    candidateConfig: version.payload,
  }, null, 2), { mode: 0o600 });
  return records.recordCuratorEvaluation({
    proposalId,
    suiteVersion: CURATOR_SUITE_VERSION,
    status,
    baselineMetrics,
    candidateMetrics,
    cases,
    errors,
    evidencePath,
    startedAt,
  });
}

export function requestActivationApproval(records: Records, proposalId: string, reason: string) {
  if (!reason.trim()) throw new Error("Activation approval reason is required");
  const proposal = records.getCuratorProposal(proposalId);
  if (!proposal || proposal.status !== "evaluated" || !proposal.resultRevision) throw new Error(`Proposal ${proposalId} is not evaluated`);
  const evaluation = records.evaluationsForProposal(proposalId).at(-1);
  if (!evaluation || evaluation.status !== "passed") throw new Error(`Proposal ${proposalId} has no passing evaluation`);
  const project = records.getProject(proposal.projectId);
  if (!project || project.configVersion !== proposal.baseConfigVersion) throw new Error(`Proposal ${proposalId} is stale`);
  return records.requestApproval({
    projectId: project.id,
    binding: {
      action: "activate_config_change",
      target: proposal.id,
      revision: proposal.resultRevision,
      configVersion: project.configVersion,
    },
    reason,
    evidence: { proposalId, diffPath: proposal.diffPath, evaluation },
  });
}

export function requestRevertApproval(records: Records, projectId: string, targetConfigVersion: string, reason: string) {
  if (!reason.trim()) throw new Error("Revert approval reason is required");
  const project = records.getProject(projectId);
  const target = records.getConfigVersion(targetConfigVersion);
  if (!project || !target || target.project_id !== project.id) throw new Error(`Unknown target configuration ${targetConfigVersion}`);
  if (targetConfigVersion === project.configVersion) throw new Error("Target configuration is already active");
  return records.requestApproval({
    projectId,
    binding: {
      action: "activate_config_change",
      target: `revert:${targetConfigVersion}`,
      revision: targetConfigVersion,
      configVersion: project.configVersion,
    },
    reason,
    evidence: { targetConfigVersion, currentConfigVersion: project.configVersion },
  });
}

export function proposalDetail(records: Records, proposalId: string) {
  const proposal = records.getCuratorProposal(proposalId);
  if (!proposal) throw new Error(`Unknown proposal ${proposalId}`);
  return {
    proposal,
    config: records.getConfigVersion(proposal.proposedConfigVersion),
    evaluations: records.evaluationsForProposal(proposalId),
    approvals: records.listApprovals().filter((approval) =>
      approval.projectId === proposal.projectId && approval.action === "activate_config_change" && approval.target === proposal.id),
  };
}

export function parseConfigFile(raw: string): ProjectConfigSnapshot {
  const config = JSON.parse(raw) as ProjectConfigSnapshot;
  const errors = validateProjectConfig(config);
  if (errors.length > 0) throw new Error(`Invalid configuration:\n${errors.join("\n")}`);
  // Canonicalization here guarantees proposal fingerprints are independent of key order.
  return JSON.parse(canonicalConfig(config)) as ProjectConfigSnapshot;
}
