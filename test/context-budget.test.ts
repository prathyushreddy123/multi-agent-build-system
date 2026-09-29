import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { ContextBudgetExceededError, buildContextPacket, type PacketPurpose } from "../src/context/packet.ts";
import { relevantExcerpt } from "../src/context/retrieval.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { Store } from "../src/store/db.ts";
import { Records, type Project, type Task } from "../src/store/records.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd, encoding: "utf8" }).trim();
}

function setup(t: TestContext, controllerSettings?: Project["controllerSettings"], checkCommands?: Project["checkCommands"]) {
  const root = mkdtempSync(join(tmpdir(), "mabs-context-"));
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
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "ledger.ts"), "export const ledger = 1;\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const project = records.createProject({
    name: "ctx", repoPath: repo, projectType: "personal", reviewChoice: "off",
    reviewPolicy: { mode: "none", skipTaskClasses: [] },
    controllerSettings,
    checkCommands,
  });
  const task = records.createTask({
    projectId: project.id, title: "Ledger", objective: "Update src/ledger.ts totals — naïve café ✓ 数据",
    acceptanceCriteria: ["ledger totals are correct"], taskClass: "small_implementation", allowedScope: ["src"],
  });
  return { root, repo, records, project: records.getProject(project.id) as Project, task: records.getTask(task.id) as Task };
}

function packetFor(records: Records, project: Project, task: Task, repo: string, purpose: PacketPurpose, extra: Partial<Parameters<typeof buildContextPacket>[0]> = {}) {
  const attemptId = `att_${purpose}_${Math.random().toString(16).slice(2)}`;
  mkdirSync(join(process.env.MABS_STATE_DIR as string, "artifacts", task.id, attemptId), { recursive: true });
  return buildContextPacket({
    records, project, task, attemptId,
    workspace: { path: repo, branch: "main", baseRevision: git(repo, "rev-parse", "HEAD") },
    execution: { harness: "codex", model: null, effort: "medium", authMode: "chatgpt-subscription" },
    purpose,
    ...extra,
  });
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("CTX-01: each open obligation appears once and a large omission inventory moves to disk", (t) => {
  const { repo, records, project, task } = setup(t, { defaultRepairLimit: 2, contextBudgetTokens: 1_000 });
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(join(repo, "src", `ledger-part-${index}.ts`), `// ledger totals part ${index}\n${"x".repeat(2_000)}\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "many files");
  const summary = "Totals double-count refunded items in src/ledger.ts";
  const obligation = records.recordObligation({
    taskId: task.id, kind: "code_defect", severity: "blocking", blocking: true, sourceKey: "review:F1", summary,
    introducedRevision: null, evidenceRefs: [],
  });
  records.recordCheckpoint({ taskId: task.id, kind: "review_failed", summary: "review", findings: [summary, summary] });

  const packet = packetFor(records, project, task, repo, "repair", { previousFindings: [summary, `  ${summary}  `] });
  assert.equal(occurrences(packet.prompt, summary), 1, "the obligation text appears exactly once");
  assert.deepEqual(packet.input.context.obligations?.map((item) => item.id), [obligation.id]);
  assert.deepEqual(packet.input.context.checkpoint?.findings, [`See obligation ${obligation.id}.`, `See obligation ${obligation.id}.`]);
  const inventory = packet.input.context.omission_inventory;
  assert.ok(inventory && inventory.total > 20, "large omission list is summarized in the prompt");
  assert.equal(packet.input.context.omissions.length, 20);
  const onDisk = JSON.parse(readFileSync(inventory.path, "utf8")) as { omitted: unknown[] };
  assert.equal(onDisk.omitted.length, inventory.total, "full inventory is on disk");
});

test("CTX-02: recorded prompt bytes and fingerprint match the exact string sent, including Unicode", async (t) => {
  const { records, task } = setup(t);
  const adapter = new CapturingAdapter("codex");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick();
  await controller.stop();
  const sent = adapter.starts[0]?.prompt;
  assert.ok(sent);
  assert.match(sent, /naïve café ✓ 数据/);
  const [packet] = records.packetsForTask(task.id);
  assert.equal(packet?.prompt_bytes, Buffer.byteLength(sent, "utf8"));
  assert.notEqual(packet?.prompt_bytes, sent.length, "bytes, not UTF-16 code units");
  assert.equal(packet?.content_fingerprint, `sha256:${createHash("sha256").update(sent).digest("hex")}`);
  assert.equal(packet?.estimator_version, "utf8-bytes-div4.v1");
  assert.equal(packet?.purpose, "implementation");
  const sections = JSON.parse(String(packet?.section_sizes)) as Record<string, number>;
  assert.equal((sections.instructions ?? 0) + (sections.worker_input ?? 0), packet?.prompt_bytes);
});

test("CTX-03: under the complete-prompt policy, mandatory overflow blocks preparation instead of truncating", async (t) => {
  const { repo, records, project, task } = setup(t, { defaultRepairLimit: 2, contextBudgetTokens: 1_000, contextBudgetPolicy: "mabs.budget.v2" });
  records.addRequirement(project.id, "REQ-BIG", "requirement ".repeat(2_000));
  assert.throws(() => packetFor(records, project, task, repo, "implementation"), ContextBudgetExceededError);
  assert.ok(records.listEvents(task.id).some((event) => event.kind === "context.mandatory_overflow"));

  const adapter = new CapturingAdapter("codex");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  await controller.tick();
  await controller.stop();
  assert.equal(adapter.starts.length, 0, "no worker receives a truncated task");
  const blocked = records.getTask(task.id);
  assert.equal(blocked?.state, "BLOCKED");
  assert.equal(blocked?.failureClass, "CONFIG");
  assert.match(blocked?.blockedReason ?? "", /complete-prompt budget/);
  const decision = records.getContinuation(task.id).openObligations.find((item) => item.kind === "decision_needed");
  assert.ok(decision, "the adjustment is an explicit decision");
});

test("the complete-prompt policy keeps the exact rendered prompt within budget by shedding optional files", (t) => {
  const { repo, records, project, task } = setup(t, { defaultRepairLimit: 2, contextBudgetTokens: 6_000, contextBudgetPolicy: "mabs.budget.v2" });
  for (let index = 0; index < 10; index += 1) {
    writeFileSync(join(repo, "src", `ledger-${index}.ts`), `// "quoted" ledger totals\n${'"\\\\'.repeat(900)}\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "escaping-heavy files");
  const packet = packetFor(records, project, task, repo, "implementation");
  assert.ok(packet.accounting.promptTokenEstimate <= 6_000, `rendered prompt ${packet.accounting.promptTokenEstimate} fits`);
  assert.ok(packet.input.context.file_context.length > 0, "some optional context still fits");
  const [row] = records.packetsForTask(task.id);
  assert.equal(row?.token_estimate, packet.accounting.promptTokenEstimate, "v2 reports the complete prompt as its estimate");
});

test("CTX-04: repair packets carry repair guidance, not initial-only guidance", async (t) => {
  const { repo, records, project, task } = setup(t);
  const packet = packetFor(records, project, task, repo, "repair");
  assert.equal(packet.purpose, "repair");
  assert.ok(packet.guidance.includes("targeted-repair-v1"));
  assert.match(packet.prompt, /targeted repair of an existing revision/);
  const initial = packetFor(records, project, task, repo, "implementation");
  assert.equal(initial.guidance.includes("targeted-repair-v1"), false);
  assert.doesNotMatch(initial.prompt, /targeted repair/);
});

test("CTX-05: a review packet whose source drifted fails closed and records the drift", (t) => {
  const { repo, records, project, task } = setup(t);
  const reviewed = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "ledger.ts"), "export const ledger = 2;\n");
  git(repo, "commit", "-q", "-am", "drift");
  const attemptId = "att_review_drift";
  mkdirSync(join(process.env.MABS_STATE_DIR as string, "artifacts", task.id, attemptId), { recursive: true });
  assert.throws(() => buildContextPacket({
    records, project, task: { ...task, resultRevision: reviewed }, attemptId,
    workspace: { path: repo, branch: "main", baseRevision: reviewed },
    execution: { harness: "claude", model: "claude-sonnet-5", effort: null, authMode: "claude.ai-subscription" },
    purpose: "review",
  }), /would misreport its revision/);
  const drift = records.listEvents(task.id).find((event) => event.kind === "context.revision_drift");
  assert.ok(drift);
  assert.match(String(drift.data), /"failedClosed":true/);
});

test("REC-01: a quota reroute keeps prior findings and labels the quota text as operational", (t) => {
  const { repo, records, project, task } = setup(t);
  records.recordObligation({
    taskId: task.id, kind: "code_defect", severity: "blocking", blocking: true, sourceKey: "review:F1",
    summary: "F1: refunds counted twice", introducedRevision: null, evidenceRefs: [],
  });
  records.recordObligation({
    taskId: task.id, kind: "code_defect", severity: "blocking", blocking: true, sourceKey: "review:F2",
    summary: "F2: currency rounding drops cents", introducedRevision: null, evidenceRefs: [],
  });
  records.recordCheckpoint({ taskId: task.id, kind: "review_failed", summary: "changes requested", findings: ["F3 advisory: rename helper"] });
  records.recordCheckpoint({ taskId: task.id, kind: "attempt_failed", summary: "QUOTA: usage limit", findings: ["HTTP 429 usage limit"] });

  const packet = packetFor(records, project, task, repo, "repair", { operationalFailure: "HTTP 429 usage limit" });
  assert.deepEqual(packet.input.context.obligations?.map((item) => item.summary), ["F1: refunds counted twice", "F2: currency rounding drops cents"]);
  assert.equal(packet.input.context.checkpoint?.kind, "review_failed", "progress checkpoint, not the quota failure");
  assert.ok(packet.input.context.previous_findings.includes("F3 advisory: rename helper"));
  assert.equal(packet.input.context.previous_findings.some((finding) => /429/.test(finding)), false);
  assert.equal(packet.input.context.last_operational_failure, "HTTP 429 usage limit");
});

test("relevant spans replace blind prefixes for long files", () => {
  const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
  lines[300] = "export function refundTotals() { return 0; }";
  const { excerpt, spans } = relevantExcerpt(lines.join("\n"), ["refundtotals"], 3_000);
  assert.ok(excerpt.length <= 3_000);
  assert.match(excerpt, /refundTotals/, "the relevant span survives even though it is past the prefix");
  assert.match(excerpt, /filler0 = 0/, "the file head is kept");
  assert.match(excerpt, /lines omitted; excerpt resumes at line/);
  assert.ok(spans >= 2);
  const small = relevantExcerpt("short file", ["x"], 3_000);
  assert.deepEqual(small, { excerpt: "short file", spans: 1 });
});

class CapturingAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name: string;
  starts: AdapterLaunch[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input);
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"running"> { return "running"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> { throw new Error("not collected"); }
}

test("omission inventory is not written when the inline list is complete", (t) => {
  const { repo, records, project, task } = setup(t);
  const packet = packetFor(records, project, task, repo, "implementation");
  assert.equal(packet.input.context.omission_inventory, null);
  assert.equal(existsSync(join(process.env.MABS_STATE_DIR as string, "artifacts", task.id, packet.input.identity.attempt_id, "omitted-files.json")), false);
});

/** Completes immediately with a small edit, so a failing gate drives a real repair. */
class EditingAdapter extends CapturingAdapter {
  override async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input);
    writeFileSync(join(input.cwd, "src", "ledger.ts"), `export const ledger = ${this.starts.length + 1};\n`);
    writeFileSync(input.completionPath, "{}");
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  override async status(): Promise<"running"> {
    return "completed" as "running";
  }
  override async collectResult(): Promise<CollectedResult> {
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
        apiEquivalentEstimateUsd: null, sessionId: null, raw: "", stderr: "" },
      validation: validateWorkerOutput({
        outcome: "completed", reason: "done", summary: "edited ledger",
        evidence: { changed_files: ["src/ledger.ts"], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null },
        addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

test("CTX-04: a repair launched by a failing gate receives the current change as a delta artifact", async (t) => {
  const { records, task } = setup(t, undefined, [{ name: "unit", command: [process.execPath, "-e", "console.error(\"AssertionError [ERR_ASSERTION]: expected 2 to equal 3\"); process.exit(1)"], required: true }]);
  const adapter = new EditingAdapter("codex");
  const controller = new Controller(records, { capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1 });
  const deadline = Date.now() + 15_000;
  while (adapter.starts.length < 2 && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  await controller.stop();
  assert.equal(adapter.starts.length, 2, "initial attempt plus one repair");
  const repairPrompt = adapter.starts[1]?.prompt ?? "";
  assert.match(repairPrompt, /repair-delta\.patch/);
  assert.match(repairPrompt, /targeted-repair-v1/);
  const repairPacket = records.packetsForTask(task.id).at(-1);
  assert.equal(repairPacket?.purpose, "repair");
});

test("CTX-LEAN: the worker brief states the worktree root once and omits empty, duplicate, and pretty-print bytes", (t) => {
  const { repo, records, project, task } = setup(t, undefined, [{ name: "test", required: true, command: ["npm", "run", "test"] }]);
  const packet = packetFor(records, project, task, repo, "implementation");
  const prompt = packet.prompt;
  const input = prompt.slice(prompt.indexOf("Worker input:\n") + "Worker input:\n".length).split("\n")[0] as string;
  const rendered = JSON.parse(input) as { workspace: Record<string, unknown>; context: Record<string, unknown> };

  // worktree_path, plus source_workspace naming the checkout the excerpts came from.
  assert.equal(occurrences(prompt, repo), 2, "absolute paths are not repeated per scope entry or file");
  assert.deepEqual(rendered.workspace.allowed_scope, ["src"]);
  assert.equal((rendered.context.file_context as { path: string }[])[0]?.path, "src/ledger.ts");
  assert.equal(rendered.context.files, undefined, "file_context already names every file");
  assert.equal(rendered.context.previous_findings, undefined, "empty lists are omitted");
  assert.equal(rendered.context.checkpoint, undefined, "null fields are omitted");
  assert.doesNotMatch(input, /\n {2}/, "the worker input is compact JSON");
  assert.deepEqual(rendered.workspace.checks, [{ name: "test", command: "npm run test", required: true }]);
  assert.doesNotMatch(prompt, /automation-design-v1/, "automation guidance is not selected for a plain code change");
  assert.doesNotMatch(prompt, /final message must contain the same JSON/, "the result is written once, to the file");

  // The stored packet keeps the complete input and the absolute manifest.
  assert.deepEqual(packet.input.context.previous_findings, []);
  assert.ok((records.packetsForTask(task.id).at(-1)?.files as string[]).every((path) => path.startsWith(repo)));
});
