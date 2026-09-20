import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_OPERATIONS_CONFIG,
  executeDeployment,
  getOperationsConfig,
  operationsStatus,
  prepareOperation,
  prepareOperationsConfig,
  recoverDeployment,
  requestExternalCostApproval,
  setOperationsConfig,
  validateOperationsConfig,
} from "../src/operations/service.ts";
import type { DeploymentAdapter, OperationsConfig } from "../src/operations/types.ts";
import { SCHEMA_VERSION, Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mabs-e6-"));
  const store = new Store(":memory:");
  const records = new Records(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, records };
}

function configured(base: OperationsConfig, patch: Partial<OperationsConfig>): OperationsConfig {
  return structuredClone({ ...base, ...patch });
}

class SimulatedDeployment implements DeploymentAdapter {
  readonly name = "simulated-local";
  prepares = 0;
  executes = 0;
  recoveries = 0;
  async prepare(config: OperationsConfig["deployment"]) {
    this.prepares += 1;
    return { target: config.target, command: "simulation-only" };
  }
  async execute(_prepared: Record<string, unknown>) {
    this.executes += 1;
    return { externalId: "simulated-deployment-1", detail: { accepted: true } };
  }
  async status(_externalId: string | null) {
    return { state: "failed" as const, detail: { reason: "simulated remote health failure" } };
  }
  async recover(_externalId: string | null) {
    this.recoveries += 1;
    return { recovered: true, detail: { action: "simulated rollback" } };
  }
}

test("all optional operations default disabled or local/manual and preparation has no effects", (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "ops-off", repoPath: root });
  const status = operationsStatus(records, project.id);
  assert.equal(status.configuration.version, 0);
  assert.equal(status.configuration.config.costs.paidModelApis, "prohibited");
  assert.equal(status.effective.ci.status, "disabled");
  assert.equal(status.effective.deployment.status, "disabled");
  assert.equal(status.effective.monitoring.status, "disabled");
  assert.equal(status.effective.scheduling.status, "manual");
  assert.equal(status.effective.delivery.status, "ready");
  assert.equal(status.effective.costs.status, "disabled");
  assert.equal(status.runs.length, 0);
  assert.equal(existsSync(join(root, ".github")), false, "dry-run preparation must not create provider files");
});

test("enabled but incomplete targets, schedules, delivery, and costs fail validation", () => {
  const ci = configured(DEFAULT_OPERATIONS_CONFIG, {
    ci: { mode: "selected", provider: null, adapter: null, workflowPath: "../outside.yml" },
  });
  assert.ok(validateOperationsConfig(ci).some((error) => error.includes("provider")));
  assert.ok(validateOperationsConfig(ci).some((error) => error.includes("workflowPath")));

  const deployment = configured(DEFAULT_OPERATIONS_CONFIG, {
    deployment: { mode: "vps", target: null, adapter: null, costProposalRef: null },
  });
  assert.ok(validateOperationsConfig(deployment).some((error) => error.includes("exact target")));
  assert.ok(validateOperationsConfig(deployment).some((error) => error.includes("cost proposal")));

  const scheduling = configured(DEFAULT_OPERATIONS_CONFIG, {
    scheduling: { mode: "configured", timezone: "not/a-zone", cadence: null, overlapLock: false, retryLimit: 99, missedRunPolicy: "skip" },
  });
  assert.ok(validateOperationsConfig(scheduling).some((error) => error.includes("timezone")));
  assert.ok(validateOperationsConfig(scheduling).some((error) => error.includes("overlapLock")));

  const delivery = configured(DEFAULT_OPERATIONS_CONFIG, {
    delivery: { mode: "configured", outputDirectory: "outputs", channel: null, destinationRef: null, adapter: null },
    costs: { externalServices: "proposal_required", monthlyCapUsd: null, proposalRef: null, paidModelApis: "prohibited" },
  });
  assert.ok(validateOperationsConfig(delivery).some((error) => error.includes("destination")));
  assert.ok(validateOperationsConfig(delivery).some((error) => error.includes("positive proposed monthly cap")));

  const paidModel = structuredClone(DEFAULT_OPERATIONS_CONFIG) as OperationsConfig;
  (paidModel.costs as { paidModelApis: string }).paidModelApis = "allowed";
  assert.ok(validateOperationsConfig(paidModel).some((error) => error.includes("Paid model APIs")));
});

test("external cost configuration requires and consumes an exact approval", (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "ops-cost", repoPath: root });
  const config = configured(DEFAULT_OPERATIONS_CONFIG, {
    costs: { externalServices: "proposal_required", monthlyCapUsd: 12, proposalRef: "proposal:vps-small", paidModelApis: "prohibited" },
  });
  const prepared = prepareOperationsConfig(records, project.id, config);
  assert.equal(prepared.externalCostApproval?.required, true);
  assert.match(prepared.externalCostApproval?.target ?? "", /^operations-cost:[a-f0-9]{64}$/);
  assert.throws(() => setOperationsConfig(records, {
    projectId: project.id, expectedVersion: 0, config, actor: "operator", reason: "Test cost boundary.",
  }), /approved exact binding/);

  const approval = requestExternalCostApproval(records, {
    projectId: project.id, config,
    reason: "SIMULATED TEST DATA: authorize this exact cost proposal and cap.",
  });
  assert.equal(approval.revision, prepared.candidateFingerprint);
  assert.deepEqual(approval.evidence.costProposal, config.costs);
  records.decideApproval(approval.id, "approved", "human-test", "SIMULATED TEST DATA only.");
  const stored = setOperationsConfig(records, {
    projectId: project.id, expectedVersion: 0, config, actor: "operator", reason: "Test cost boundary.", approvalId: approval.id,
  });
  assert.equal(stored.config.costs.monthlyCapUsd, 12);
  assert.equal(records.getApproval(approval.id)?.state, "consumed");
});

test("versioned configuration generates CI only as a dry-run from registered project checks", (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({
    name: "ops-ci", repoPath: root,
    checkCommands: [{ name: "test", command: ["python3", "-m", "unittest", "discover", "-s", "tests"], required: true }],
  });
  const config = configured(DEFAULT_OPERATIONS_CONFIG, {
    ci: { mode: "selected", provider: "github-actions", adapter: "github-actions-v1", workflowPath: ".github/workflows/quality.yml" },
  });
  const stored = setOperationsConfig(records, {
    projectId: project.id, expectedVersion: 0, config, actor: "operator", reason: "Prepare a reviewed CI draft only.",
  });
  assert.equal(stored.version, 1);
  assert.throws(() => setOperationsConfig(records, {
    projectId: project.id, expectedVersion: 0, config, actor: "operator", reason: "stale",
  }), /current version is 1/);
  const prepared = prepareOperation(records, project.id, "ci");
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.generatedFiles[0]?.path, ".github/workflows/quality.yml");
  assert.match(prepared.generatedFiles[0]?.content ?? "", /python3 -m unittest discover -s tests/);
  assert.doesNotMatch(prepared.generatedFiles[0]?.content ?? "", /OPENAI|ANTHROPIC|api.?key|subscription/i);
  assert.equal(existsSync(join(root, ".github")), false);
});

test("deployment execution consumes exact approval, records simulated failure, and requires separate recovery approval", async (t) => {
  const { root, records } = setup(t);
  const project = records.createProject({ name: "ops-deploy", repoPath: root });
  const config = configured(DEFAULT_OPERATIONS_CONFIG, {
    deployment: { mode: "local", target: "local:acceptance", adapter: "simulated-local", costProposalRef: null },
  });
  const stored = setOperationsConfig(records, {
    projectId: project.id, expectedVersion: 0, config, actor: "operator", reason: "Simulation fixture only.",
  });
  const adapter = new SimulatedDeployment();
  assert.equal(prepareOperation(records, project.id, "deployment").status, "approval_required");
  await assert.rejects(() => executeDeployment(records, { projectId: project.id, approvalId: "missing", adapter }), /matching approved/);

  const approval = records.requestApproval({
    projectId: project.id, binding: {
      action: "deploy", target: "local:acceptance", revision: stored.fingerprint, configVersion: project.configVersion,
    }, reason: "Authorize one simulated failure-path execution.", evidence: { simulation: true },
  });
  records.decideApproval(approval.id, "approved", "human-test", "Simulation only.");
  const failed = await executeDeployment(records, { projectId: project.id, approvalId: approval.id, adapter });
  assert.equal(failed.state, "failed");
  assert.equal(records.getApproval(approval.id)?.state, "consumed");
  assert.equal(adapter.executes, 1);
  await assert.rejects(() => executeDeployment(records, { projectId: project.id, approvalId: approval.id, adapter }), /matching approved/);

  const unknownApproval = records.requestApproval({
    projectId: project.id, binding: {
      action: "deploy", target: "local:acceptance", revision: stored.fingerprint, configVersion: project.configVersion,
    }, reason: "Authorize one simulated uncertain execution.", evidence: { simulation: true },
  });
  records.decideApproval(unknownApproval.id, "approved", "human-test", "Simulation only.");
  const uncertainAdapter = new SimulatedDeployment();
  uncertainAdapter.execute = async () => { throw new Error("simulated lost connection"); };
  const unknown = await executeDeployment(records, { projectId: project.id, approvalId: unknownApproval.id, adapter: uncertainAdapter });
  assert.equal(unknown.state, "unknown");
  assert.match(String(unknown.detail.error), /lost connection/);
  assert.equal(records.getApproval(unknownApproval.id)?.state, "consumed");

  const recovery = records.requestApproval({
    projectId: project.id, binding: {
      action: "deploy", target: "recovery:local:acceptance", revision: stored.fingerprint, configVersion: project.configVersion,
    }, reason: "Authorize simulated recovery only.", evidence: { simulation: true },
  });
  records.decideApproval(recovery.id, "approved", "human-test", "Simulation only.");
  const recovered = await recoverDeployment(records, { runId: failed.id, approvalId: recovery.id, adapter });
  assert.equal(recovered.state, "recovered");
  assert.equal(adapter.recoveries, 1);
  assert.equal(records.getApproval(recovery.id)?.state, "consumed");
});

test("schema 13 upgrades operation configuration and run evidence additively", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-e6-migration-"));
  const dbPath = join(root, "migration.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = new Store(dbPath);
  const records = new Records(old);
  const project = records.createProject({ name: "schema13-project", repoPath: root });
  old.run("DROP TABLE operation_runs");
  old.run("DROP TABLE operation_configs");
  old.run("UPDATE schema_meta SET value = '13' WHERE key = 'schema_version'");
  old.close();

  const upgraded = new Store(dbPath);
  assert.equal(upgraded.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")?.value, SCHEMA_VERSION);
  const current = getOperationsConfig(new Records(upgraded), project.id);
  assert.equal(current.version, 0);
  assert.ok(upgraded.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_runs'"));
  upgraded.close();
});

test("the real CLI exposes disabled operational status without writing configuration", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-e6-cli-"));
  const dbPath = join(root, "cli.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = new Records(new Store(dbPath));
  const project = records.createProject({ name: "ops-cli", repoPath: root });
  records.store.close();
  const output = execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "ops", "status", project.id], {
    encoding: "utf8", env: { ...process.env, MABS_DB_PATH: dbPath, MABS_STATE_DIR: join(root, "state") },
  });
  const status = JSON.parse(output) as { configuration: { version: number }; effective: Record<string, { status: string }> };
  assert.equal(status.configuration.version, 0);
  assert.equal(status.effective.deployment?.status, "disabled");
  assert.equal(status.effective.scheduling?.status, "manual");
});
