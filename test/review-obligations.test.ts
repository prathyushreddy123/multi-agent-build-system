import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput, type WorkerOutput } from "../src/domain/contract.ts";
import { reviewPreset, triageReviewOutput, type ReviewPolicy } from "../src/review/policy.ts";
import { Store } from "../src/store/db.ts";
import { Records } from "../src/store/records.ts";
import { CODEX_MODEL, loadCapabilityRegistry, recordEntitlementVerification, type CapabilityRegistry } from "../src/routing/capabilities.ts";
import { resolveReviewChoice } from "../src/domain/project-policy.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

const H1 = JSON.parse(readFileSync(new URL("../fixtures/execution-history/advisory-clarification-review.json", import.meta.url), "utf8")) as {
  expected_obligation: string;
};

function output(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
  return {
    outcome: "completed",
    reason: "done",
    summary: "done",
    evidence: { changed_files: [], result_revision: null, tests: [], artifacts: [] },
    follow_up: { unresolved: [], decisions_requested: [], next_step: null },
    usage: { model: null, input_tokens: null, output_tokens: null },
    addressed_requirements: ["REQ-1"],
    ...overrides,
  };
}

/**
 * One fake provider. As implementer it appends to value.txt; as reviewer it
 * answers with the next scripted review output.
 */
class ScriptedAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name: string;
  readonly reviews: Partial<WorkerOutput>[];
  readonly prompts: { kind: "implement" | "review"; prompt: string }[] = [];
  private readonly results = new Map<string, WorkerOutput>();

  constructor(name: string, reviews: Partial<WorkerOutput>[] = []) {
    this.name = name;
    this.reviews = reviews;
  }

  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    const reviewing = input.prompt.includes('"role":"reviewer"');
    this.prompts.push({ kind: reviewing ? "review" : "implement", prompt: input.prompt });
    let result: WorkerOutput;
    if (reviewing) {
      result = output(this.reviews.shift() ?? {});
    } else {
      const path = join(input.cwd, "value.txt");
      writeFileSync(path, `${readFileSync(path, "utf8")}change ${this.prompts.length}\n`);
      result = output({ evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] } });
    }
    mkdirSync(join(input.cwd, ".mabs"), { recursive: true });
    writeFileSync(join(input.cwd, ".mabs", "result.json"), JSON.stringify(result));
    this.results.set(input.attemptId, result);
    return { attemptId: input.attemptId, pid: null, sessionId: this.name, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(handle: AdapterHandle): Promise<CollectedResult> {
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
        apiEquivalentEstimateUsd: null, sessionId: this.name, raw: "", stderr: "" },
      validation: validateWorkerOutput(this.results.get(handle.attemptId)),
      failureClass: null,
      error: null,
    };
  }
  count(kind: "implement" | "review"): number {
    return this.prompts.filter((prompt) => prompt.kind === kind).length;
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd });
}

function setup(t: TestContext, options: {
  reviewPolicy?: Partial<ReviewPolicy>; projectType?: "personal" | "client"; reviewChoice?: "off" | "required";
  ownedRequirements?: string[]; requirements?: string[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "mabs-review-obligations-"));
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  t.after(() => {
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "initial\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const projectType = options.projectType ?? "personal";
  const project = records.createProject({
    name: "reviewed", repoPath: repo, projectType, reviewChoice: options.reviewChoice ?? "required",
    reviewPolicy: { ...reviewPreset(projectType === "client" ? "client" : "personal"), trigger: "required", cadence: "task", ...options.reviewPolicy },
    checkCommands: [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true }],
  });
  for (const id of options.requirements ?? ["REQ-1"]) records.addRequirement(project.id, id, `${id} holds`);
  const task = records.createTask({
    projectId: project.id, title: "change", objective: "Change value.txt.", acceptanceCriteria: ["changed"],
    repairLimit: 2, ownedRequirements: options.ownedRequirements,
  });
  return { records, project, task };
}

async function run(records: Records, adapters: ScriptedAdapter[], taskId: string, until: (state: string) => boolean = (state) => ["DONE", "BLOCKED", "FAILED"].includes(state),
  capabilityRegistry: CapabilityRegistry = VERIFIED_REGISTRY) {
  const controller = new Controller(records, { capabilityRegistry,
    adapters: new Map<string, WorkerAdapter>(adapters.map((adapter) => [adapter.name, adapter])),
    defaultAdapter: "codex", workerLimit: 1,
  });
  const deadline = Date.now() + 15_000;
  do {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
  } while (!until(records.getTask(taskId)?.state ?? "") && Date.now() < deadline);
  await controller.stop();
  return records.getTask(taskId);
}

// ---------------------------------------------------------------------------
// triage

test("REC-18/H1: a non-blocking clarification stays advisory and never becomes a major defect", () => {
  const items = triageReviewOutput({
    unresolved: ["Clarify whether the backlog ordering should follow priority?", "The empty-state copy is non-blocking but could be friendlier"],
    decisionsRequested: ["Should the backlog item be tracked separately"],
    addressedRequirements: ["REQ-1"], mandatoryRequirements: ["REQ-1"], ownedRequirements: null,
    blockingSeverities: ["critical", "major"],
  });
  assert.equal(H1.expected_obligation, "advisory");
  assert.deepEqual(items.map((item) => [item.kind, item.blocking]), [["advisory", false], ["advisory", false], ["advisory", false]]);
  assert.match(items[2]?.text ?? "", /Question for the user \(non-blocking\)/);
});

test("a decision blocks only when marked [blocking] or tied to an owned requirement", () => {
  const items = triageReviewOutput({
    unresolved: [],
    decisionsRequested: ["[blocking] Should refunds be negative line items?", "Does REQ-2 apply to archived invoices?", "Does REQ-9 matter?"],
    addressedRequirements: ["REQ-1", "REQ-2"], mandatoryRequirements: ["REQ-1", "REQ-2", "REQ-9"], ownedRequirements: ["REQ-1", "REQ-2"],
    blockingSeverities: ["critical", "major"],
  });
  assert.deepEqual(items.map((item) => item.kind), ["decision_needed", "decision_needed", "advisory"]);
});

test("requirement evidence is demanded only for owned requirements; unknown ownership stays broad", () => {
  const input = { unresolved: [], decisionsRequested: [], addressedRequirements: ["REQ-1"], mandatoryRequirements: ["REQ-1", "REQ-2"],
    blockingSeverities: ["critical", "major"] as const };
  assert.deepEqual(triageReviewOutput({ ...input, blockingSeverities: [...input.blockingSeverities], ownedRequirements: ["REQ-1"] }), []);
  const legacy = triageReviewOutput({ ...input, blockingSeverities: [...input.blockingSeverities], ownedRequirements: null });
  assert.deepEqual(legacy.map((item) => [item.kind, item.blocking]), [["requirement_evidence", true]]);
  assert.match(legacy[0]?.text ?? "", /REQ-2/);
});

test("REC-20: the same finding restated with different spacing or label maps to one stable key", () => {
  const first = triageReviewOutput({ unresolved: ["[major] Refunds   are counted twice"], decisionsRequested: [], addressedRequirements: [],
    mandatoryRequirements: [], ownedRequirements: [], blockingSeverities: ["critical", "major"] });
  const again = triageReviewOutput({ unresolved: ["Refunds are counted twice", "refunds are counted twice"], decisionsRequested: [], addressedRequirements: [],
    mandatoryRequirements: [], ownedRequirements: [], blockingSeverities: ["critical", "major"] });
  assert.equal(again.length, 1, "duplicates within one review collapse");
  assert.equal(first[0]?.stableKey, again[0]?.stableKey);
});

// ---------------------------------------------------------------------------
// controller

test("REC-18: an H1-style review clarification completes the task without a repair", async (t) => {
  const { records, task } = setup(t);
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude", [{
    summary: "Acceptable; one backlog question.",
    follow_up: { unresolved: [], decisions_requested: ["Should the backlog issue be scheduled next sprint"], next_step: null },
  }]);
  const final = await run(records, [codex, claude], task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "");
  assert.equal(codex.count("implement"), 1, "no repair was launched for a question");
  assert.deepEqual(records.reviewsForTask(task.id).map((review) => review.verdict), ["approved"]);
  const advisory = records.listObligations(task.id).filter((item) => item.kind === "advisory");
  assert.equal(advisory.length, 1);
  assert.equal(advisory[0]?.blocking, false);
});

test("REC-19: a blocking requirement decision waits for the user, then the answer reaches the next packet", async (t) => {
  const { records, task } = setup(t);
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude", [{
    follow_up: { unresolved: [], decisions_requested: ["[blocking] Should refunds be recorded as negative line items?"], next_step: null },
  }]);
  const blocked = await run(records, [codex, claude], task.id);
  assert.equal(blocked?.state, "BLOCKED");
  assert.equal(blocked?.failureClass, "CONTRACT");
  assert.equal(codex.count("implement"), 1, "no worker guesses the answer");
  const decision = records.listObligations(task.id).find((item) => item.kind === "decision_needed");
  assert.ok(decision);
  assert.throws(() => records.decideObligation(
    records.listObligations(task.id).find((item) => item.kind !== "decision_needed")?.id ?? "missing", { answer: "x", decidedBy: "y" },
  ));
  const resolved = records.decideObligation(decision.id, { answer: "Yes, negative line items.", decidedBy: "owner" });
  assert.equal(resolved.state, "resolved");
  assert.match(resolved.resolutionEvidence[0] ?? "", /^decision:.*:owner$/);

  // Resuming is a separate explicit action; the next worker sees the answer.
  const current = records.getTask(task.id);
  records.retryTask(task.id, current?.recordVersion as number);
  claude.reviews.push({});
  const final = await run(records, [codex, claude], task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "");
  const next = codex.prompts.filter((prompt) => prompt.kind === "implement").at(-1)?.prompt ?? "";
  assert.match(next, /User decision \(owner\) on .*negative line items.*: Yes, negative line items\./);
});

test("REC-20: a repaired finding is addressed, reopened when restated, and resolved only by review evidence", async (t) => {
  const { records, task } = setup(t);
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude", [
    { follow_up: { unresolved: ["[major] Refunds are counted twice"], decisions_requested: [], next_step: null } },
    { follow_up: { unresolved: ["[major]  Refunds are counted  twice"], decisions_requested: [], next_step: null } },
    {},
  ]);
  const final = await run(records, [codex, claude], task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "");
  assert.equal(codex.count("implement"), 3, "initial plus two repairs");
  const defects = records.listObligations(task.id).filter((item) => item.kind === "code_defect");
  assert.equal(defects.length, 1, "one durable obligation across three reviews");
  assert.equal(defects[0]?.state, "resolved");
  assert.match(defects[0]?.resolutionEvidence.join() ?? "", /review:.*:not-restated@/);
  const history = records.listEventsOfKind(task.id, "obligation.updated")
    .map((event) => JSON.parse(String(event.data)) as { obligationId: string; state: string; reopened?: boolean })
    .filter((data) => data.obligationId === defects[0]?.id)
    .map((data) => (data.reopened ? "reopened" : data.state));
  assert.deepEqual(history, ["addressed_pending_validation", "reopened", "addressed_pending_validation", "resolved"]);
  // Each repair prompt lists the obligation once, by ID.
  const repairPrompt = codex.prompts[1]?.prompt ?? "";
  assert.equal(repairPrompt.split("Refunds are counted twice").length - 1, 1);
});

test("GOV-08: a client review never falls back to the implementer's provider", async (t) => {
  const { records, task } = setup(t, { projectType: "client" });
  const codex = new ScriptedAdapter("codex");
  const final = await run(records, [codex], task.id);
  assert.equal(final?.state, "BLOCKED");
  assert.notEqual(final?.state, "DONE");
  assert.equal(codex.count("review"), 0, "no same-provider review was substituted");
  assert.match(final?.blockedReason ?? "", /requires a provider other than codex/);
});

test("OBS-03: personal off is labeled not-required; an independent review is labeled approved", async (t) => {
  const off = setup(t, { reviewChoice: "off", reviewPolicy: { trigger: "off", mode: "none", cadence: "task", skipTaskClasses: ["mechanical", "planning", "research"] } });
  const offCodex = new ScriptedAdapter("codex");
  assert.equal((await run(off.records, [offCodex], off.task.id))?.state, "DONE");
  const offAccepted = off.records.listEvents(off.task.id).find((event) => event.kind === "task.accepted");
  assert.deepEqual((JSON.parse(String(offAccepted?.data)) as { review: unknown }).review, { status: "not_required", reviewId: null });
  assert.equal(off.records.reviewsForTask(off.task.id).length, 0);

  const on = setup(t);
  const final = await run(on.records, [new ScriptedAdapter("codex"), new ScriptedAdapter("claude", [{}])], on.task.id);
  assert.equal(final?.state, "DONE");
  const accepted = on.records.listEvents(on.task.id).find((event) => event.kind === "task.accepted");
  const review = (JSON.parse(String(accepted?.data)) as { review: { status: string; reviewId: string } }).review;
  assert.equal(review.status, "approved");
  assert.equal(review.reviewId, on.records.reviewsForTask(on.task.id)[0]?.id);
});

test("a task that owns REQ-1 is not blocked by an unrelated mandatory requirement; legacy tasks still are", async (t) => {
  const owned = setup(t, { requirements: ["REQ-1", "REQ-2"], ownedRequirements: ["REQ-1"] });
  const ownedFinal = await run(owned.records, [new ScriptedAdapter("codex"), new ScriptedAdapter("claude", [{}])], owned.task.id);
  assert.equal(ownedFinal?.state, "DONE", ownedFinal?.blockedReason ?? "");
  assert.deepEqual(owned.records.requirementOwnership(owned.task.id)?.requirementIds, ["REQ-1"]);

  const legacy = setup(t, { requirements: ["REQ-1", "REQ-2"] });
  const legacyFinal = await run(legacy.records, [new ScriptedAdapter("codex"), new ScriptedAdapter("claude", [{}])], legacy.task.id);
  assert.equal(legacy.records.requirementOwnership(legacy.task.id), null, "no mapping is legacy broad coverage");
  assert.equal(legacyFinal?.state, "BLOCKED");
  assert.ok(legacy.records.listObligations(legacy.task.id).some((item) => item.kind === "requirement_evidence" && /REQ-2/.test(item.summary)));
});

test("a task cannot own a requirement the project does not define", (t) => {
  const { records, project } = setup(t);
  assert.throws(() => records.createTask({ projectId: project.id, title: "x", objective: "y", ownedRequirements: ["REQ-404"] }), /unknown requirement/);
});

test("REC-17: review evidence gathered under an older configuration is stale and the review reruns", async (t) => {
  const { records, project, task } = setup(t);
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude", [{}, {}]);
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["codex", codex], ["claude", claude]]), defaultAdapter: "codex", workerLimit: 1,
  });
  // Tick until the review has been launched but not yet collected.
  const deadline = Date.now() + 15_000;
  while (claude.count("review") === 0 && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
  }
  assert.equal(claude.count("review"), 1);
  records.updateProjectChecks(project.id, [{ name: "unit", command: [process.execPath, "-e", "process.exit(0)"], required: true, timeoutMs: 60_000 }]);
  const until = Date.now() + 15_000;
  while (!["DONE", "BLOCKED", "FAILED"].includes(records.getTask(task.id)?.state ?? "") && Date.now() < until) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
  }
  await controller.stop();
  assert.ok(records.listEvents(task.id).some((event) => event.kind === "review.evidence_stale"));
  assert.equal(claude.count("review"), 2, "the stale review was repeated, not reused");
  assert.equal(records.reviewsForTask(task.id).length, 1, "the stale result was never recorded as a review verdict");
});

test("RES-01: a required review that no provider is entitled to perform blocks before any implementation", async (t) => {
  const { records, task } = setup(t, { projectType: "client" });
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude");
  // The fresh-state deadlock: the only independent reviewer's entitlement was never verified.
  const unverifiedClaude: CapabilityRegistry = { ...VERIFIED_REGISTRY,
    entries: VERIFIED_REGISTRY.entries.map((entry) => entry.provider === "claude" ? { ...entry, entitlement: "unknown" } : entry) };
  const final = await run(records, [codex, claude], task.id, undefined, unverifiedClaude);
  assert.equal(final?.state, "BLOCKED");
  assert.equal(final?.failureClass, "CONFIG");
  assert.equal(codex.count("implement"), 0, "no worker was spent on a result that could never be accepted");
  assert.match(final?.blockedReason ?? "", /Nothing was launched/);
  assert.match(final?.blockedReason ?? "", /entitlement is unknown/);
  assert.equal(claude.count("review"), 0);
});

test("RES-02: a reviewer that is only cooling down does not stop implementation, and a retry after the blocked review resumes at review", async (t) => {
  const { records, task } = setup(t, { projectType: "client" });
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude", [{}]);
  records.configureProvider("claude", 1);
  records.noteProviderFailure("claude", "QUOTA", "usage limit reached", 60 * 60_000);
  const blocked = await run(records, [codex, claude], task.id);
  assert.equal(blocked?.state, "BLOCKED");
  assert.equal(codex.count("implement"), 1, "a temporary reviewer outage is not a preflight refusal");
  assert.ok(records.getContinuation(task.id).openObligations.some((item) => item.sourceKey.startsWith("review-recovery:")));

  records.resetProvider("claude", "quota window reopened");
  records.retryTask(task.id, (records.getTask(task.id) as { recordVersion: number }).recordVersion);
  const final = await run(records, [codex, claude], task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "");
  assert.equal(codex.count("implement"), 1, "the finished revision was reviewed, not re-implemented");
  assert.equal(claude.count("review"), 1);
  assert.deepEqual(records.listAttempts(task.id).map((attempt) => attempt.kind), ["initial", "review"]);
  assert.equal(records.getContinuation(task.id).openObligations.filter((item) => item.sourceKey.startsWith("review-recovery:")).length, 0);
});

test("RES-03: an entitlement verified while the controller runs takes effect on the next tick", async (t) => {
  const { records } = setup(t);
  const overlay = join(process.env.MABS_STATE_DIR as string, "capability-entitlements.json");
  const adopted: CapabilityRegistry[] = [];
  const codex = Object.assign(new ScriptedAdapter("codex"), { setCapabilityRegistry: (registry: CapabilityRegistry) => { adopted.push(registry); } });
  const controller = new Controller(records, {
    capabilityRegistry: loadCapabilityRegistry(overlay),
    capabilityRegistrySource: { path: overlay, load: loadCapabilityRegistry },
    adapters: new Map<string, WorkerAdapter>([["codex", codex]]), defaultAdapter: "codex", workerLimit: 1,
  });
  const codexEntry = () => controller.capabilityRegistry.entries.find((entry) => entry.provider === "codex" && entry.model === CODEX_MODEL);
  await controller.tick();
  assert.equal(codexEntry()?.entitlement, "unknown");
  recordEntitlementVerification({ provider: "codex", model: CODEX_MODEL, effort: "low", verifiedAt: new Date().toISOString(), evidencePath: "/probe.log" }, overlay);
  await controller.tick();
  assert.equal(codexEntry()?.entitlement, "verified");
  assert.equal(adopted.length, 1, "the adapter's own launch check adopted the reloaded registry");
  await controller.tick();
  assert.equal(adopted.length, 1, "an unchanged overlay is not reloaded again");
  await controller.stop();
});

test("DEL-01: delivery modes are exactly the review choices, and a conflicting pair is refused", () => {
  assert.equal(resolveReviewChoice("fast", undefined), "off");
  assert.equal(resolveReviewChoice("standard", undefined), "risk");
  assert.equal(resolveReviewChoice("verified", "required"), "required");
  assert.equal(resolveReviewChoice(undefined, "risk"), "risk");
  assert.equal(resolveReviewChoice(undefined, undefined), undefined);
  assert.throws(() => resolveReviewChoice("fast", "required"), /conflicts/);
  assert.throws(() => resolveReviewChoice("careful", undefined), /Unknown delivery mode/);
});

async function reviewEffortFor(t: TestContext, changeRisk: "medium" | "high"): Promise<string | null> {
  const { records, project } = setup(t, { projectType: "client" });
  const task = records.createTask({ projectId: project.id, title: `risk ${changeRisk}`, objective: "Change value.txt.", acceptanceCriteria: ["changed"],
    taskClass: "small_implementation", changeRisk });
  // Claude implements, so the independent reviewer is the Codex route, listed at high effort.
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY,
    adapters: new Map<string, WorkerAdapter>([["claude", new ScriptedAdapter("claude")], ["codex", new ScriptedAdapter("codex", [{}])]]),
    defaultAdapter: "claude", workerLimit: 1 });
  const deadline = Date.now() + 15_000;
  while (!["DONE", "BLOCKED", "FAILED"].includes(records.getTask(task.id)?.state ?? "") && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
  }
  await controller.stop();
  return records.listAttempts(task.id).find((attempt) => attempt.kind === "review")?.effort ?? null;
}

test("DEL-02: a small, non-high-risk change is reviewed at medium effort; a high-risk one keeps the route's depth", async (t) => {
  assert.equal(await reviewEffortFor(t, "medium"), "medium");
  assert.equal(await reviewEffortFor(t, "high"), "high");
});

test("DEL-03: a verified re-review after a repair focuses on the delta and the open obligations", async (t) => {
  const { records, task } = setup(t, { projectType: "client" });
  const codex = new ScriptedAdapter("codex");
  const claude = new ScriptedAdapter("claude", [
    { follow_up: { unresolved: ["[major] value.txt must end with a newline marker"], decisions_requested: [], next_step: null } },
    {},
  ]);
  const final = await run(records, [codex, claude], task.id);
  assert.equal(final?.state, "DONE", final?.blockedReason ?? "");
  const reviews = claude.prompts.filter((prompt) => prompt.kind === "review");
  assert.equal(reviews.length, 2);
  assert.doesNotMatch(reviews[0]?.prompt ?? "", /re-review after a repair/);
  assert.match(reviews[1]?.prompt ?? "", /re-review after a repair/);
  assert.match(reviews[1]?.prompt ?? "", /review-delta\.patch/);
  assert.match(reviews[1]?.prompt ?? "", /review-diff\.patch/, "the whole change stays available");
});
