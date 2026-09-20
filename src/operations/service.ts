import { createHash } from "node:crypto";

import { ids } from "../core/ids.ts";
import { resolveApplicationProfiles } from "../profiles/index.ts";
import type { Approval, Project, Records } from "../store/records.ts";
import type {
  Capability,
  DeploymentAdapter,
  OperationRun,
  OperationsConfig,
  PreparedOperation,
  StoredOperationsConfig,
} from "./types.ts";
import { OPERATIONS_CONFIG_VERSION } from "./types.ts";

const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return value === null || value === undefined ? fallback : JSON.parse(String(value)) as T; }
  catch { return fallback; }
};
const now = (): string => new Date().toISOString();

export const DEFAULT_OPERATIONS_CONFIG: OperationsConfig = {
  contractVersion: OPERATIONS_CONFIG_VERSION,
  ci: { mode: "off", provider: null, adapter: null, workflowPath: null },
  deployment: { mode: "off", target: null, adapter: null, costProposalRef: null },
  monitoring: { mode: "off", adapter: null },
  scheduling: { mode: "manual", timezone: null, cadence: null, overlapLock: true, retryLimit: 0, missedRunPolicy: "skip" },
  delivery: { mode: "local_files", outputDirectory: "outputs", channel: null, destinationRef: null, adapter: null },
  costs: { externalServices: "off", monthlyCapUsd: null, proposalRef: null, paidModelApis: "prohibited" },
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

export function operationsFingerprint(config: OperationsConfig): string {
  return createHash("sha256").update(JSON.stringify(stable(config))).digest("hex");
}

function relativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

export function validateOperationsConfig(config: OperationsConfig): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") return ["Operations configuration must be an object."];
  if (config.contractVersion !== OPERATIONS_CONFIG_VERSION) errors.push(`contractVersion must be ${OPERATIONS_CONFIG_VERSION}.`);

  if (!config.ci || !["off", "selected"].includes(config.ci.mode)) errors.push("ci.mode must be off or selected.");
  else if (config.ci.mode === "selected") {
    if (!config.ci.provider?.trim()) errors.push("Selected CI requires a provider.");
    if (!config.ci.adapter?.trim()) errors.push("Selected CI requires an adapter.");
    if (!config.ci.workflowPath || !relativePath(config.ci.workflowPath)) errors.push("Selected CI requires a repository-relative workflowPath.");
  }

  if (!config.deployment || !["off", "local", "vps"].includes(config.deployment.mode)) errors.push("deployment.mode must be off, local, or vps.");
  else if (config.deployment.mode !== "off") {
    if (!config.deployment.target?.trim()) errors.push("Enabled deployment requires an exact target.");
    if (!config.deployment.adapter?.trim()) errors.push("Enabled deployment requires an adapter.");
    if (config.deployment.mode === "vps" && !config.deployment.costProposalRef?.trim()) {
      errors.push("VPS deployment requires a cost proposal reference before preparation.");
    }
  }

  if (!config.monitoring || !["off", "run_health", "application"].includes(config.monitoring.mode)) {
    errors.push("monitoring.mode must be off, run_health, or application.");
  } else if (config.monitoring.mode === "application" && !config.monitoring.adapter?.trim()) {
    errors.push("Application monitoring requires an adapter.");
  }

  if (!config.scheduling || !["manual", "configured"].includes(config.scheduling.mode)) errors.push("scheduling.mode must be manual or configured.");
  else {
    if (!Number.isSafeInteger(config.scheduling.retryLimit) || config.scheduling.retryLimit < 0 || config.scheduling.retryLimit > 5) {
      errors.push("scheduling.retryLimit must be an integer from 0 through 5.");
    }
    if (!config.scheduling.overlapLock) errors.push("Scheduling must keep overlapLock enabled.");
    if (!["skip", "run_once"].includes(config.scheduling.missedRunPolicy)) errors.push("Unknown missedRunPolicy.");
    if (config.scheduling.mode === "configured") {
      if (!config.scheduling.timezone) errors.push("Configured scheduling requires an IANA timezone.");
      else try { new Intl.DateTimeFormat("en", { timeZone: config.scheduling.timezone }).format(); }
      catch { errors.push(`Invalid scheduling timezone: ${config.scheduling.timezone}.`); }
      if (!config.scheduling.cadence?.trim()) errors.push("Configured scheduling requires a cadence.");
    }
  }

  if (!config.delivery || !["local_files", "configured"].includes(config.delivery.mode)) errors.push("delivery.mode must be local_files or configured.");
  else {
    if (!relativePath(config.delivery.outputDirectory)) errors.push("delivery.outputDirectory must remain repository-relative.");
    if (config.delivery.mode === "configured") {
      if (!config.delivery.channel?.trim()) errors.push("Configured delivery requires a channel.");
      if (!config.delivery.destinationRef?.trim()) errors.push("Configured delivery requires a destination reference.");
      if (!config.delivery.adapter?.trim()) errors.push("Configured delivery requires an adapter.");
    }
  }

  if (!config.costs || config.costs.paidModelApis !== "prohibited") errors.push("Paid model APIs must remain prohibited.");
  else if (!["off", "proposal_required"].includes(config.costs.externalServices)) errors.push("Unknown external-services cost mode.");
  else if (config.costs.externalServices === "proposal_required") {
    if (!config.costs.proposalRef?.trim()) errors.push("External services require a cost proposal reference.");
    if (config.costs.monthlyCapUsd === null || !Number.isFinite(config.costs.monthlyCapUsd) || config.costs.monthlyCapUsd <= 0) {
      errors.push("External services require a positive proposed monthly cap.");
    }
  } else if (config.costs.monthlyCapUsd !== null || config.costs.proposalRef !== null) {
    errors.push("Cost cap/proposal must be null while external services are off.");
  }
  return [...new Set(errors)];
}

function requireProject(records: Records, projectId: string): Project {
  const project = records.getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  return project;
}

function toStored(row: Record<string, unknown>): StoredOperationsConfig {
  return {
    projectId: String(row.project_id), version: Number(row.version), fingerprint: String(row.fingerprint),
    config: parse(row.config, DEFAULT_OPERATIONS_CONFIG), updatedBy: String(row.updated_by), reason: String(row.reason),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function getOperationsConfig(records: Records, projectId: string): StoredOperationsConfig {
  const project = requireProject(records, projectId);
  const row = records.store.get("SELECT * FROM operation_configs WHERE project_id = ?", projectId);
  if (row) return toStored(row);
  return {
    projectId, version: 0, fingerprint: operationsFingerprint(DEFAULT_OPERATIONS_CONFIG),
    config: structuredClone(DEFAULT_OPERATIONS_CONFIG), updatedBy: "system-default", reason: "All optional operations default disabled.",
    createdAt: project.createdAt, updatedAt: project.updatedAt,
  };
}

export function prepareOperationsConfig(records: Records, projectId: string, config: OperationsConfig): {
  currentVersion: number;
  candidateFingerprint: string;
  externalCostApproval: { required: true; action: "external_cost"; target: string; configVersion: string } | null;
} {
  const project = requireProject(records, projectId);
  const errors = validateOperationsConfig(config);
  if (errors.length > 0) throw new Error(`Invalid operations configuration:\n${errors.join("\n")}`);
  const fingerprint = operationsFingerprint(config);
  return {
    currentVersion: getOperationsConfig(records, projectId).version,
    candidateFingerprint: fingerprint,
    externalCostApproval: config.costs.externalServices === "proposal_required"
      ? { required: true, action: "external_cost", target: `operations-cost:${fingerprint}`, configVersion: project.configVersion }
      : null,
  };
}

export function requestExternalCostApproval(records: Records, input: {
  projectId: string; config: OperationsConfig; reason: string;
}) {
  if (!input.reason.trim()) throw new Error("An external-cost approval request requires a reason.");
  const prepared = prepareOperationsConfig(records, input.projectId, input.config);
  if (!prepared.externalCostApproval) throw new Error("This configuration does not enable an external cost.");
  return records.requestApproval({
    projectId: input.projectId,
    binding: {
      action: prepared.externalCostApproval.action,
      target: prepared.externalCostApproval.target,
      revision: prepared.candidateFingerprint,
      configVersion: prepared.externalCostApproval.configVersion,
    },
    reason: input.reason,
    evidence: {
      contractVersion: input.config.contractVersion,
      candidateFingerprint: prepared.candidateFingerprint,
      costProposal: input.config.costs,
    },
  });
}

export function setOperationsConfig(records: Records, input: {
  projectId: string; expectedVersion: number; config: OperationsConfig; actor: string; reason: string;
  approvalId?: string | null;
}): StoredOperationsConfig {
  const project = requireProject(records, input.projectId);
  if (!input.actor.trim() || !input.reason.trim()) throw new Error("Configuration changes require an actor and reason.");
  const prepared = prepareOperationsConfig(records, project.id, input.config);
  const current = getOperationsConfig(records, project.id);
  if (current.version !== input.expectedVersion) throw new Error(`Operations configuration changed since version ${input.expectedVersion}; current version is ${current.version}.`);
  const fingerprint = prepared.candidateFingerprint;
  const costApproval = prepared.externalCostApproval === null ? null : records.getApproval(input.approvalId ?? "");
  const approvalTask = costApproval?.taskId ? records.getTask(costApproval.taskId) : null;
  if (prepared.externalCostApproval !== null && (
    !costApproval || costApproval.state !== "approved" || costApproval.projectId !== project.id ||
    costApproval.action !== prepared.externalCostApproval.action || costApproval.target !== prepared.externalCostApproval.target ||
    costApproval.revision !== fingerprint || costApproval.configVersion !== project.configVersion ||
    (costApproval.taskId !== null && approvalTask?.resultRevision !== costApproval.revision)
  )) {
    throw new Error(
      `Enabling external cost requires an approved exact binding: action external_cost, target ` +
      `${prepared.externalCostApproval.target}, project configuration ${project.configVersion}.`,
    );
  }
  const timestamp = now();
  records.store.tx(() => {
    records.store.run(
      `INSERT INTO operation_configs(project_id, version, config, fingerprint, updated_by, reason, created_at, updated_at)
       VALUES(?,1,?,?,?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET version = operation_configs.version + 1, config = excluded.config,
         fingerprint = excluded.fingerprint, updated_by = excluded.updated_by, reason = excluded.reason, updated_at = excluded.updated_at`,
      project.id, json(input.config), fingerprint, input.actor, input.reason, timestamp, timestamp,
    );
    records.store.run(
      `UPDATE approvals SET state = 'invalidated', decided_at = ?
       WHERE project_id = ? AND task_id IS NULL AND action = 'deploy' AND state IN ('pending','approved')`,
      timestamp, project.id,
    );
    records.recordEvent({ kind: "operations.config_changed", projectId: project.id, data: {
      version: current.version + 1, fingerprint, actor: input.actor, reason: input.reason,
      approvalId: costApproval?.id ?? null,
    } });
    if (costApproval) records.markApprovalConsumed(costApproval.id);
  });
  return getOperationsConfig(records, project.id);
}

function shellQuote(part: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'"'"'`)}'`;
}

export function prepareOperation(records: Records, projectId: string, capability: Capability): PreparedOperation {
  const project = requireProject(records, projectId);
  const stored = getOperationsConfig(records, project.id);
  const safeguards = [
    "Preparation is dry-run only and performs no external action.",
    "Subscription credentials are never embedded in hosted CI, deployment, or delivery configuration.",
    "Paid model APIs remain prohibited.",
  ];
  if (capability === "ci") {
    if (stored.config.ci.mode === "off") return { capability, status: "disabled", target: null, adapter: null, dryRun: true, commands: [], generatedFiles: [], requirements: ["Select a CI provider and adapter explicitly."], safeguards };
    const commands = project.checkCommands.map((gate) => gate.command);
    const profile = resolveApplicationProfiles(project.repoPath);
    const setupCommands = profile.components.flatMap((component) => component.environment.setupCommands);
    if (stored.config.ci.provider === "github-actions") {
      const setupSteps = setupCommands.map((command, index) => `      - name: Profile setup ${index + 1}\n        run: ${command.map(shellQuote).join(" ")}`).join("\n");
      const checkSteps = commands.map((command, index) => `      - name: ${project.checkCommands[index]?.name ?? `check-${index + 1}`}\n        run: ${command.map(shellQuote).join(" ")}`).join("\n");
      const content = `name: quality\non: [workflow_dispatch]\njobs:\n  checks:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${setupSteps ? `${setupSteps}\n` : ""}${checkSteps}\n`;
      return { capability, status: "ready", target: stored.config.ci.workflowPath, adapter: stored.config.ci.adapter, dryRun: true, commands: [...setupCommands, ...commands], generatedFiles: [{ path: stored.config.ci.workflowPath as string, content }], requirements: ["Review profile setup and check commands, then explicitly authorize writing/publishing the workflow."], safeguards };
    }
    return { capability, status: "incomplete", target: stored.config.ci.workflowPath, adapter: stored.config.ci.adapter, dryRun: true, commands, generatedFiles: [], requirements: [`No workflow generator is registered for provider ${stored.config.ci.provider}.`], safeguards };
  }
  if (capability === "deployment") {
    const value = stored.config.deployment;
    if (value.mode === "off") return { capability, status: "disabled", target: null, adapter: null, dryRun: true, commands: [], generatedFiles: [], requirements: ["Choose local or VPS deployment and an exact target."], safeguards };
    return { capability, status: "approval_required", target: value.target, adapter: value.adapter, dryRun: true, commands: [], generatedFiles: [], requirements: ["Prepare and approve an exact deploy binding before adapter execution.", ...(value.mode === "vps" ? ["Approve the referenced VPS cost proposal separately."] : [])], safeguards };
  }
  if (capability === "monitoring") {
    const value = stored.config.monitoring;
    return { capability, status: value.mode === "off" ? "disabled" : "ready", target: value.mode, adapter: value.adapter, dryRun: true, commands: [], generatedFiles: [], requirements: value.mode === "application" ? ["Application telemetry must run independently of WSL when remotely hosted."] : [], safeguards };
  }
  if (capability === "scheduling") {
    const value = stored.config.scheduling;
    return { capability, status: value.mode === "manual" ? "manual" : "approval_required", target: value.timezone, adapter: null, dryRun: true, commands: [], generatedFiles: [], requirements: value.mode === "manual" ? ["Choose timezone, cadence, retry, and missed-run policy before activation."] : ["Scheduling activation requires explicit authorization; overlap lock remains mandatory."], safeguards };
  }
  if (capability === "delivery") {
    const value = stored.config.delivery;
    return { capability, status: value.mode === "local_files" ? "ready" : "approval_required", target: value.mode === "local_files" ? value.outputDirectory : value.destinationRef, adapter: value.adapter, dryRun: true, commands: [], generatedFiles: [], requirements: value.mode === "local_files" ? [] : ["Confirm the exact destination and authorize external delivery before sending."], safeguards };
  }
  const value = stored.config.costs;
  return { capability, status: value.externalServices === "off" ? "disabled" : "approval_required", target: value.proposalRef, adapter: null, dryRun: true, commands: [], generatedFiles: [], requirements: value.externalServices === "off" ? ["No paid external service is configured."] : [`Approve the cost proposal and cap of USD ${String(value.monthlyCapUsd)} separately.`], safeguards };
}

function toRun(row: Record<string, unknown>): OperationRun {
  return {
    id: String(row.id), projectId: String(row.project_id), capability: String(row.capability) as Capability,
    action: String(row.action), target: String(row.target), configFingerprint: String(row.config_fingerprint),
    state: String(row.state) as OperationRun["state"], dryRun: Boolean(row.dry_run),
    approvalId: row.approval_id === null ? null : String(row.approval_id), detail: parse(row.detail, {}),
    startedAt: String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at),
  };
}

export function listOperationRuns(records: Records, projectId: string): OperationRun[] {
  requireProject(records, projectId);
  return records.store.all("SELECT * FROM operation_runs WHERE project_id = ? ORDER BY started_at DESC", projectId).map(toRun);
}

function matchingApproval(records: Records, project: Project, stored: StoredOperationsConfig, approvalId: string, target: string): Approval {
  const approval = records.getApproval(approvalId);
  if (!approval || approval.state !== "approved" || approval.projectId !== project.id || approval.taskId !== null ||
      approval.action !== "deploy" || approval.target !== target || approval.revision !== stored.fingerprint ||
      approval.configVersion !== project.configVersion) {
    throw new Error("Deployment requires a matching approved project, target, operations fingerprint, and project configuration.");
  }
  return approval;
}

/** Adapter execution exists for tested boundaries; no production adapter or CLI execute command is registered. */
export async function executeDeployment(records: Records, input: {
  projectId: string; approvalId: string; adapter: DeploymentAdapter;
}): Promise<OperationRun> {
  const project = requireProject(records, input.projectId);
  const stored = getOperationsConfig(records, project.id);
  const config = stored.config.deployment;
  if (config.mode === "off" || !config.target || !config.adapter) throw new Error("Deployment is disabled or incomplete.");
  if (input.adapter.name !== config.adapter) throw new Error(`Configured deployment adapter is ${config.adapter}, not ${input.adapter.name}.`);
  matchingApproval(records, project, stored, input.approvalId, config.target);
  const prepared = await input.adapter.prepare(config);
  const id = ids.operationRun();
  const started = now();
  records.store.tx(() => {
    records.markApprovalConsumed(input.approvalId);
    records.store.run(
      `INSERT INTO operation_runs(id, project_id, capability, action, target, config_fingerprint, state, dry_run, approval_id, detail, started_at)
       VALUES(?,?,?,?,?,?,'running',0,?,?,?)`,
      id, project.id, "deployment", "execute", config.target, stored.fingerprint, input.approvalId, json({ prepared }), started,
    );
  });
  try {
    const executed = await input.adapter.execute(prepared);
    const status = await input.adapter.status(executed.externalId);
    const ended = now();
    records.store.run("UPDATE operation_runs SET state = ?, detail = ?, ended_at = ? WHERE id = ?",
      status.state, json({ prepared, executed, status }), ended, id);
  } catch (error) {
    records.store.run("UPDATE operation_runs SET state = 'unknown', detail = ?, ended_at = ? WHERE id = ?",
      json({ prepared, error: error instanceof Error ? error.message : String(error), recovery: "required_before_retry" }), now(), id);
  }
  return toRun(records.store.get("SELECT * FROM operation_runs WHERE id = ?", id) as Record<string, unknown>);
}

export async function recoverDeployment(records: Records, input: {
  runId: string; approvalId: string; adapter: DeploymentAdapter;
}): Promise<OperationRun> {
  const row = records.store.get("SELECT * FROM operation_runs WHERE id = ?", input.runId);
  if (!row) throw new Error(`Unknown operation run ${input.runId}`);
  const run = toRun(row);
  if (run.capability !== "deployment" || !["failed", "unknown"].includes(run.state)) throw new Error("Only failed or unknown deployments can be recovered.");
  const project = requireProject(records, run.projectId);
  const stored = getOperationsConfig(records, project.id);
  matchingApproval(records, project, stored, input.approvalId, `recovery:${run.target}`);
  if (input.adapter.name !== stored.config.deployment.adapter) throw new Error("Recovery adapter does not match the configured deployment adapter.");
  const externalId = typeof run.detail.executed === "object" && run.detail.executed !== null
    ? String((run.detail.executed as Record<string, unknown>).externalId ?? "") || null : null;
  records.store.tx(() => {
    records.markApprovalConsumed(input.approvalId);
    records.store.run("UPDATE operation_runs SET state = 'unknown', detail = ?, ended_at = NULL WHERE id = ?",
      json({ ...run.detail, recovery: { state: "started", approvalId: input.approvalId } }), run.id);
  });
  try {
    const result = await input.adapter.recover(externalId);
    records.store.run("UPDATE operation_runs SET state = ?, detail = ?, ended_at = ? WHERE id = ?",
      result.recovered ? "recovered" : "failed", json({ ...run.detail, recovery: result }), now(), run.id);
  } catch (error) {
    records.store.run("UPDATE operation_runs SET state = 'unknown', detail = ?, ended_at = ? WHERE id = ?",
      json({ ...run.detail, recovery: { state: "unknown", error: error instanceof Error ? error.message : String(error) } }), now(), run.id);
  }
  return toRun(records.store.get("SELECT * FROM operation_runs WHERE id = ?", run.id) as Record<string, unknown>);
}

export function operationsStatus(records: Records, projectId: string) {
  const project = requireProject(records, projectId);
  const stored = getOperationsConfig(records, project.id);
  const tasks = records.listTasks({ projectId: project.id });
  const runs = listOperationRuns(records, project.id);
  return {
    project: { id: project.id, name: project.name, repoPath: project.repoPath },
    configuration: stored,
    effective: {
      ci: prepareOperation(records, project.id, "ci"), deployment: prepareOperation(records, project.id, "deployment"),
      monitoring: prepareOperation(records, project.id, "monitoring"), scheduling: prepareOperation(records, project.id, "scheduling"),
      delivery: prepareOperation(records, project.id, "delivery"), costs: prepareOperation(records, project.id, "costs"),
    },
    health: {
      lastSuccess: runs.find((run) => run.state === "succeeded")?.endedAt ?? null,
      failedRuns: runs.filter((run) => run.state === "failed" || run.state === "unknown").length,
      missedSchedules: 0,
      backlog: tasks.filter((task) => !["DONE", "CANCELLED"].includes(task.state)).length,
      controller: records.latestHealth() ?? null,
      source: "local_mabs_records",
    },
    runs,
  };
}
