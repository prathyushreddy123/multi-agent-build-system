import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput, type WorkerOutput } from "../src/domain/contract.ts";
import { validateExecutionUpgrade } from "../src/diagnostics/upgrade.ts";
import { reviewPolicyForGovernance } from "../src/review/policy.ts";
import { canonicalRepoKey } from "../src/scheduling/admission.ts";
import { SCHEMA_VERSION, Store, createLegacyBaselineDatabase } from "../src/store/db.ts";
import { Records, type Task } from "../src/store/records.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

function tempRoot(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---------------------------------------------------------------------------
// upgrade and restore rehearsal

test("the upgrade rehearsal preserves every pre-existing value, reaches the supported schema, and restores exactly", async (t) => {
  const root = tempRoot(t, "mabs-upgrade-");
  const source = join(root, "legacy.sqlite");
  createLegacyBaselineDatabase(source);
  const db = new DatabaseSync(source);
  const at = "2026-09-25T00:00:00.000Z";
  db.exec(`INSERT INTO projects(id, name, repo_path, config_version, created_at, updated_at)
           VALUES('prj_legacy', 'legacy', '/sanitized/legacy', 'cfg_legacy', '${at}', '${at}')`);
  db.exec(`INSERT INTO tasks(id, project_id, title, objective, state, created_at, updated_at)
           VALUES('tsk_legacy', 'prj_legacy', 'legacy', 'kept exactly', 'DONE', '${at}', '${at}')`);
  db.exec(`INSERT INTO attempts(id, task_id, launch_id, attempt_number, adapter, state, usage_json, started_at, ended_at)
           VALUES('att_legacy', 'tsk_legacy', 'lnc_legacy', 1, 'codex', 'succeeded', '{"input_tokens":7}', '${at}', '${at}')`);
  db.exec(`INSERT INTO optimization_experiments(id, project_id, name, hypothesis, dimension, suite_version, baseline_config, candidate_config, status, created_at)
           VALUES('exp_legacy', 'prj_legacy', 'e', 'h', 'd', 'v1', '{}', '{}', 'running', '${at}')`);
  db.exec(`INSERT INTO optimization_measurements(id, experiment_id, variant, case_key, accepted, created_at)
           VALUES('mea_legacy', 'exp_legacy', 'baseline', 'case-1', 1, '${at}')`);
  db.close();
  const sourceHash = fileHash(source);

  const work = join(root, "rehearsal");
  const report = await validateExecutionUpgrade({ sourcePath: source, workDir: work });
  assert.equal(report.passed, true, JSON.stringify(report.changedTables));
  assert.equal(report.sourceSchemaVersion, "14");
  assert.equal(report.upgradedSchemaVersion, SCHEMA_VERSION);
  assert.deepEqual(report.changedTables, []);
  assert.ok(report.preservedTables > 10);
  assert.equal(report.restore.consistent, true);
  assert.deepEqual(report.projectsNeedingGovernance.map((item) => item.projectId), ["prj_legacy"],
    "a legacy project stays unclassified; nothing is inferred");
  assert.equal(fileHash(source), sourceHash, "the source database is byte-for-byte untouched");
  const upgraded = new DatabaseSync(join(work, "upgraded.sqlite"), { readOnly: true });
  const measurement = upgraded.prepare("SELECT repeat_index, trial_state, source FROM optimization_measurements WHERE id = 'mea_legacy'").get();
  upgraded.close();
  assert.deepEqual({ ...measurement }, { repeat_index: 0, trial_state: "completed", source: "manual" });
  await assert.rejects(validateExecutionUpgrade({ sourcePath: source, workDir: work }), /must not exist yet/);
});

// ---------------------------------------------------------------------------
// governance end to end

test("governance is enforced end to end: no type means no task and no worker; client review cannot be off", (t) => {
  const root = tempRoot(t, "mabs-governance-e2e-");
  const records = new Records(new Store(":memory:"));
  t.after(() => records.store.close());
  const unclassified = records.createProject({ name: "u", repoPath: root });
  assert.throws(() => records.createTask({ projectId: unclassified.id, title: "t", objective: "o" }), /project_type|needs|governance|ready/i);
  assert.throws(() => records.createProject({ name: "c", repoPath: root, projectType: "client", reviewChoice: "off" }), /client|review/i);
});

// ---------------------------------------------------------------------------
// deterministic soak

/** Small seeded PRNG so every run makes the same decisions in the same order. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function output(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
  return {
    outcome: "completed", reason: "done", summary: "soak", addressed_requirements: [],
    evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] },
    follow_up: { unresolved: [], decisions_requested: [], next_step: null },
    usage: { model: null, input_tokens: null, output_tokens: null },
    ...overrides,
  };
}

/**
 * Injects quota failures, genuinely failing changes, and review findings from a seeded stream.
 *
 * Both adapters draw from one stream in dispatch order, and dispatch order
 * depends on tick and gate timing, so under machine load the seeded faults can
 * all land on reviews or on moments when both providers are cooling down,
 * leaving the implementation reroute path unexercised. The first
 * implementation attempt therefore always hits quota: nothing else has failed
 * yet, so the other provider is always an eligible fallback.
 */
class SoakAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name: string;
  private readonly rng: () => number;
  private readonly shared: { forcedQuota: boolean };
  private readonly outcomes = new Map<string, "quota" | "ok" | { review: WorkerOutput }>();
  private readonly repaired = new Set<string>();
  private readonly reviewed = new Set<string>();
  private reviewCount = 0;

  constructor(name: string, rng: () => number, shared: { forcedQuota: boolean }) {
    this.name = name;
    this.rng = rng;
    this.shared = shared;
  }

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    const reviewing = input.prompt.includes('"role": "reviewer"');
    const taskId = /"task_id": "([^"]+)"/.exec(input.prompt)?.[1] ?? "unknown";
    const roll = this.rng();
    const forced = !reviewing && !this.shared.forcedQuota;
    if (forced) this.shared.forcedQuota = true;
    if (forced || roll < 0.12) {
      this.outcomes.set(input.attemptId, "quota");
    } else if (reviewing) {
      // Deterministic: every second reviewed task's first review requests changes.
      this.reviewCount += 1;
      const findings = !this.reviewed.has(taskId) && this.reviewCount % 2 === 0 ? ["[major] Soak review finding: rename the value."] : [];
      this.reviewed.add(taskId);
      this.outcomes.set(input.attemptId, { review: output({ follow_up: { unresolved: findings, decisions_requested: [], next_step: null } }) });
      mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
      writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(output({ follow_up: { unresolved: findings, decisions_requested: [], next_step: null } })));
    } else {
      // A first implementation is sometimes wrong; a repair always fixes it.
      const repair = input.prompt.includes("targeted repair");
      const bad = !repair && !this.repaired.has(taskId) && this.rng() < 0.3;
      if (repair) this.repaired.add(taskId);
      writeFileSync(join(input.cwd, `${taskId}.txt`), `${bad ? "bad" : "good"} ${input.attemptId}\n`);
      mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
      writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(output({
        evidence: { changed_files: [`${taskId}.txt`], result_revision: null, tests: [], artifacts: [] },
      })));
      this.outcomes.set(input.attemptId, "ok");
    }
    writeFileSync(input.completionPath, "{}");
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(handle: AdapterHandle): Promise<CollectedResult> {
    const outcome = this.outcomes.get(handle.attemptId);
    const launch = { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
      apiEquivalentEstimateUsd: null, sessionId: null, raw: "", stderr: "" };
    if (outcome === "quota") {
      return {
        launch: { ...launch, exitCode: 1, raw: "HTTP 429 usage limit reached" },
        validation: validateWorkerOutput(null), failureClass: "QUOTA", error: "HTTP 429 usage limit reached",
      };
    }
    const result = typeof outcome === "object" ? outcome.review : output();
    return { launch, validation: validateWorkerOutput(result), failureClass: null, error: null };
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd });
}

// Three seeds: repeatability is an automated assertion, not a claim about past sessions.
for (const seed of [20260928, 7, 424242]) test(`soak (seed ${seed}): two projects, hundreds of stage transitions, injected faults, and every invariant on every tick`, async (t) => {
  const root = tempRoot(t, "mabs-soak-");
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
  });
  const check = [{
    name: "soak-check", required: true,
    command: [process.execPath, "-e",
      "const fs=require('fs');for(const f of fs.readdirSync('.').filter(n=>n.endsWith('.txt')&&n.startsWith('tsk_'))){if(fs.readFileSync(f,'utf8').startsWith('bad')){console.error('AssertionError [ERR_ASSERTION]: '+f+' is bad');process.exit(1)}}"],
  }];
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "README.md"), "soak\n");
    git(path, "init", "-q", "-b", "main");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "init");
    return path;
  };
  const quiet = records.createProject({
    name: "quiet", repoPath: repo("quiet"), projectType: "personal", reviewChoice: "off",
    reviewPolicy: { mode: "none", skipTaskClasses: [] }, checkCommands: check,
  });
  const reviewed = records.createProject({
    name: "reviewed", repoPath: repo("reviewed"), projectType: "personal", reviewChoice: "required",
    reviewPolicy: { ...reviewPolicyForGovernance("personal", "required"), capacityAction: "pending" }, checkCommands: check,
  });
  const tasks: Task[] = [];
  for (const project of [quiet, reviewed]) {
    let previousTask: Task | null = null;
    for (let index = 0; index < 8; index += 1) {
      const created: Task = records.createTask({
        projectId: project.id, title: `${project.name}-${index}`, objective: `change ${index}`, acceptanceCriteria: ["check passes"],
        taskClass: "small_implementation", repairLimit: 2,
        // Every third task depends on the previous one, exercising cherry-pick integration.
        dependsOn: index % 3 === 2 && previousTask ? [previousTask.id] : [],
      });
      tasks.push(created);
      previousTask = created;
    }
  }
  const rng = mulberry32(seed);
  const shared = { forcedQuota: false };
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", new SoakAdapter("codex", rng, shared)], ["claude", new SoakAdapter("claude", rng, shared)]]),
    defaultAdapter: "codex", workerLimit: 2, providerLimits: { codex: 1, claude: 1 }, quotaCooldownMs: 40, gateLimit: 1,
  });
  const repoOf = new Map([[quiet.id, canonicalRepoKey(quiet.repoPath)], [reviewed.id, canonicalRepoKey(reviewed.repoPath)]]);
  const terminal = new Set(["DONE", "FAILED", "CANCELLED"]);
  let peak = 0;
  const deadline = Date.now() + 120_000;
  let ticks = 0;
  while (Date.now() < deadline) {
    await controller.tick();
    ticks += 1;
    // Invariants, every tick.
    const running = records.listRunningAttempts();
    peak = Math.max(peak, running.length);
    assert.ok(running.length <= 2, `model cap violated: ${running.length}`);
    for (const provider of ["codex", "claude"]) {
      assert.ok(running.filter((attempt) => attempt.adapter === provider).length <= 1, `${provider} cap violated`);
    }
    const checks = records.listActiveStageRuns().filter((stage) => stage.stage === "check" && ["launching", "running"].includes(stage.state));
    assert.ok(checks.length <= 1, `gate cap violated: ${checks.length}`);
    const holders = records.listTasks().filter((task) => ["RUNNING", "CHECKING", "REVIEWING"].includes(task.state));
    for (const key of repoOf.values()) {
      const inRepo = holders.filter((task) => repoOf.get(task.projectId) === key);
      assert.ok(inRepo.length <= 1, `exclusive repository lock violated: ${inRepo.map((task) => task.id).join(", ")}`);
    }
    // Revive provider-blocked tasks once so quota faults exercise recovery rather than ending the soak.
    for (const task of records.listTasks({ state: "BLOCKED" })) {
      if ((task.failureClass === "QUOTA" || task.failureClass === "AUTH") && records.listEventsOfKind(task.id, "task.retry_requested").length < 3) {
        for (const provider of ["codex", "claude"]) records.resetProvider(provider, "soak: cooldown elapsed");
        records.retryTask(task.id, task.recordVersion);
      }
    }
    const states = tasks.map((task) => records.getTask(task.id)?.state ?? "");
    if (states.every((state) => terminal.has(state) || state === "BLOCKED") && records.listRunningAttempts().length === 0 &&
        records.listActiveStageRuns().length === 0) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  await controller.stop();

  const final = tasks.map((task) => records.getTask(task.id) as Task);
  const unfinished = final.filter((task) => !terminal.has(task.state) && task.state !== "BLOCKED");
  assert.deepEqual(unfinished.map((task) => `${task.id}:${task.state}`), [], "every task reached a resting state");
  const done = final.filter((task) => task.state === "DONE").length;
  assert.ok(done >= 12, `most tasks complete despite injected faults (${done}/16 done)`);
  const transitions = records.store.all("SELECT COUNT(*) AS n FROM events WHERE kind = 'stage.finished'")[0]?.n as number;
  assert.ok(transitions >= 100, `hundreds of stage transitions exercised (${transitions})`);
  assert.equal(peak, 2, "the soak actually ran two workers at once");
  // No leaked reservations, duplicate obligations, or unbounded retries.
  assert.equal(records.store.all("SELECT * FROM admission_leases WHERE status IN ('reserved','active')").length, 0, "no leaked admission leases");
  const duplicates = records.store.all(
    "SELECT task_id, kind, summary, COUNT(*) AS n FROM task_obligations WHERE state IN ('open','addressed_pending_validation') GROUP BY task_id, kind, summary HAVING n > 1",
  );
  assert.deepEqual(duplicates, [], "no duplicate open obligations");
  for (const task of final) {
    assert.ok(records.listAttempts(task.id).length <= 14, `${task.id} retried without bound (${records.listAttempts(task.id).length} attempts)`);
    assert.ok(task.repairsUsed <= task.repairLimit, `${task.id} exceeded its repair limit`);
  }
  // The faults were really injected, not merely allowed.
  const count = (sql: string) => Number(records.store.all(sql)[0]?.n ?? 0);
  assert.ok(count("SELECT COUNT(*) AS n FROM attempts WHERE failure_class = 'QUOTA'") > 0, "quota faults occurred");
  assert.ok(count("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'reroute'") > 0, "quota faults were rerouted");
  assert.ok(count("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'repair'") > 0, "failing checks forced repairs");
  assert.ok(count("SELECT COUNT(*) AS n FROM review_results WHERE verdict = 'request_changes'") > 0, "reviews requested changes");
  assert.ok(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'task.dependencies_integrated'") > 0, "dependencies were integrated");
  assert.ok(ticks > 0);
});
