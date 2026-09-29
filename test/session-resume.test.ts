import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterHandle, AdapterLaunch, CollectedResult, WorkerAdapter } from "../src/adapters/types.ts";
import { Controller } from "../src/controller/controller.ts";
import { validateWorkerOutput, type WorkerInput } from "../src/domain/contract.ts";
import { assembleResumePrompt } from "../src/prompts/roles.ts";
import { Store } from "../src/store/db.ts";
import { Records, type GateSpec } from "../src/store/records.ts";
import { claudeArgs, codexArgs, launchClaude, missingCliSurface, resumeFailure } from "../src/verify/launch.ts";
import { VERIFIED_REGISTRY } from "./support/capabilities.ts";

function tempRoot(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("resumed launches fork the Claude session and resume the Codex thread with the same isolation", () => {
  const options = { prompt: "brief", model: "claude-sonnet-5", effort: "medium" };
  const claude = claudeArgs(options, null, "sess-1");
  assert.deepEqual(claude.slice(0, 5), ["-p", "brief", "--resume", "sess-1", "--fork-session"]);
  assert.ok(claude.includes("--strict-mcp-config") && claude.includes("--setting-sources"));
  assert.equal(claudeArgs(options).includes("--resume"), false);

  const codex = codexArgs({ ...options, model: "gpt-5.6-sol", cwd: "/w" }, "/tmp/last.txt", "thread-1");
  assert.deepEqual(codex.slice(0, 2), ["exec", "resume"]);
  assert.ok(!codex.includes("-s") && !codex.includes("-C"), "exec resume takes neither flag");
  assert.ok(codex.includes('sandbox_mode="workspace-write"'), "the sandbox is still pinned");
  assert.ok(codex.includes("--ignore-user-config") && codex.includes("mcp_servers={}"));
  assert.deepEqual(codex.slice(-2), ["thread-1", "brief"]);
  const cold = codexArgs({ ...options, model: "gpt-5.6-sol", cwd: "/w" }, "/tmp/last.txt");
  assert.deepEqual(cold.slice(0, 7), ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-C", "/w"]);
});

test("only a resume that did no model work falls back to a cold start", () => {
  const base = { timedOut: false, finalMessage: "", stderr: "" };
  assert.equal(resumeFailure({ ...base, exitCode: 0, usage: null }), null);
  assert.equal(resumeFailure({ ...base, exitCode: 1, usage: { output_tokens: 40 } }), null, "a resumed worker that ran and failed is a real result");
  assert.equal(resumeFailure({ ...base, exitCode: null, timedOut: true, usage: null }), null);
  assert.match(resumeFailure({ ...base, exitCode: 1, usage: { output_tokens: 0 }, stderr: "No conversation found with session ID: x" }) ?? "", /No conversation found/);
  assert.equal(resumeFailure({ ...base, exitCode: 2, usage: null }), "exit 2");
});

test("the CLI surface check requires both resume forms", () => {
  const claude = "  --setting-sources <s>\n  --strict-mcp-config\n  --mcp-config <c>\n  --disallowedTools <t>\n  --allowedTools <t>\n  --effort <l>\n  --model <m>\n  --permission-mode <m>\n";
  const codexExec = "  resume  Resume a previous session\n      --ignore-user-config\n      --json\n  -s, --sandbox <MODE>\n  -c, --config <kv>\n  -m, --model <M>\n";
  const codexFeatures = "multi_agent  stable true\nmulti_agent_v2  experimental false\n";
  assert.deepEqual(missingCliSurface({ claude, codexExec, codexFeatures }), ["claude --resume", "claude --fork-session"]);
  assert.deepEqual(missingCliSurface({ claude: `${claude}  -r, --resume [value]\n  --fork-session\n`, codexExec: codexExec.replace("resume  Resume", "review  Review"), codexFeatures }),
    ["codex exec resume"]);
});

test("a session that cannot be resumed falls back to the full packet in the same attempt", async (t) => {
  const root = tempRoot(t, "mabs-resume-fallback-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const argvLog = join(root, "argv.jsonl");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--resume")) { process.stderr.write("No conversation found with session ID: gone"); process.exit(1); }
process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: "fresh", usage: { input_tokens: 1, output_tokens: 5 },
  modelUsage: { "claude-sonnet-5": { canonicalModel: "claude-sonnet-5", outputTokens: 5 } } }));
`);
  chmodSync(join(bin, "claude"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const evidencePath = join(root, "worker.log");
  const result = await launchClaude({
    cwd: root, prompt: "FULL PACKET", model: "claude-sonnet-5", effort: "medium", timeoutMs: 10_000, evidencePath,
    resume: { sessionId: "gone", prompt: "SHORT BRIEF" },
  });
  const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[1], "SHORT BRIEF");
  assert.equal(calls[1]?.[1], "FULL PACKET", "the cold start receives the complete packet");
  assert.equal(calls[1]?.includes("--resume"), false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "fresh");
  assert.deepEqual({ ...result.resume, fallbackReason: result.resume?.fallbackReason?.slice(0, 20) }, { sessionId: "gone", used: false, fallbackReason: "No conversation foun" });
  assert.ok(existsSync(`${evidencePath}.resume-failed`), "the failed resume's evidence is kept");
});

/** Implements by writing value.txt, reports a provider session per attempt, and records each launch. */
class SessionAdapter implements WorkerAdapter {
  readonly authMode = "test-subscription";
  readonly name = "codex";
  readonly starts: AdapterLaunch[] = [];
  async start(input: AdapterLaunch): Promise<AdapterHandle> {
    this.starts.push(input);
    writeFileSync(join(input.cwd, "value.txt"), `changed ${this.starts.length}\n`);
    return { attemptId: input.attemptId, pid: null, sessionId: null, completionPath: input.completionPath };
  }
  async status(): Promise<"completed"> { return "completed"; }
  async cancel(): Promise<void> {}
  async collectResult(): Promise<CollectedResult> {
    const n = this.starts.length;
    return {
      launch: { exitCode: 0, timedOut: false, durationMs: 1, finalMessage: "", reportedModel: null, usage: null,
        apiEquivalentEstimateUsd: null, sessionId: `sess-${n}`, raw: "", stderr: "",
        resume: this.starts[n - 1]?.resume ? { sessionId: this.starts[n - 1]?.resume?.sessionId as string, used: true, fallbackReason: null } : undefined },
      validation: validateWorkerOutput({
        outcome: "completed", reason: "done", summary: "done",
        evidence: { changed_files: ["value.txt"], result_revision: null, tests: [], artifacts: [] },
        follow_up: { unresolved: [], decisions_requested: [], next_step: null },
        usage: { model: null, input_tokens: null, output_tokens: null }, addressed_requirements: [],
      }),
      failureClass: null,
      error: null,
    };
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@l", ...args], { cwd });
}

function setup(t: TestContext, defaultModel?: string) {
  const root = tempRoot(t, "mabs-session-");
  const previous = { state: process.env.MABS_STATE_DIR, worktrees: process.env.MABS_WORKTREE_ROOT };
  process.env.MABS_STATE_DIR = join(root, "state");
  process.env.MABS_WORKTREE_ROOT = join(root, "worktrees");
  const records = new Records(new Store(":memory:"));
  const adapter = new SessionAdapter();
  const controller = new Controller(records, {
    capabilityRegistry: VERIFIED_REGISTRY, adapters: new Map<string, WorkerAdapter>([["codex", adapter]]), defaultAdapter: "codex", workerLimit: 1,
    defaultModel: defaultModel ?? null,
  });
  t.after(async () => {
    await controller.stop();
    records.store.close();
    if (previous.state === undefined) delete process.env.MABS_STATE_DIR; else process.env.MABS_STATE_DIR = previous.state;
    if (previous.worktrees === undefined) delete process.env.MABS_WORKTREE_ROOT; else process.env.MABS_WORKTREE_ROOT = previous.worktrees;
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "value.txt"), "start\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "start");
  // The first implementation fails the check; the repair passes it.
  const firstFails: GateSpec = { name: "unit", required: true, command: [process.execPath, "-e",
    "if(require('fs').readFileSync('value.txt','utf8')==='changed 1\\n'){console.error('AssertionError [ERR_ASSERTION]: value is wrong');process.exit(1)}"] };
  const project = records.createProject({
    name: "resume", repoPath: repo, projectType: "personal", reviewChoice: "off",
    reviewPolicy: { mode: "none", skipTaskClasses: [] }, checkCommands: [firstFails],
  });
  const task = records.createTask({ projectId: project.id, title: "change", objective: "change value.txt", acceptanceCriteria: ["check passes"], taskClass: "small_implementation" });
  return { records, adapter, controller, task };
}

async function runToRest(controller: Controller, records: Records, taskId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!["DONE", "FAILED", "CANCELLED", "BLOCKED"].includes(records.getTask(taskId)?.state ?? "") && Date.now() < deadline) {
    await controller.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("a repair on the same route continues the implementer's session with a short brief", async (t) => {
  const { records, adapter, controller, task } = setup(t);
  await runToRest(controller, records, task.id);
  assert.equal(records.getTask(task.id)?.state, "DONE", records.getTask(task.id)?.blockedReason ?? "");
  const [implement, repair] = adapter.starts;
  assert.equal(implement?.resume, undefined, "an initial attempt starts cold");
  assert.equal(repair?.resume?.sessionId, "sess-1", "the repair continues the implementer's session");
  assert.ok((repair?.resume?.prompt.length ?? Infinity) < (repair?.prompt.length ?? 0) / 2, "the brief is much smaller than the packet");
  assert.match(repair?.resume?.prompt ?? "", /unit: FAIL/, "the brief carries the failing check");
  assert.match(repair?.prompt ?? "", /"role":"implementer"/, "the full packet stays available as the cold fallback");
  const attempts = records.listAttempts(task.id);
  assert.equal(attempts[0]?.sessionId, "sess-1", "the collected session is persisted");
  assert.equal(attempts[1]?.parentSessionId, "sess-1");
  assert.equal(attempts[1]?.parentAttemptId, attempts[0]?.id);
  assert.equal(records.listEventsOfKind(task.id, "attempt.session_resumed").length, 1);
});

test("a repair on a different model starts cold", async (t) => {
  const { records, adapter, controller, task } = setup(t);
  // The implementer is recorded on another model than the repair's route.
  const original = records.listAttempts.bind(records);
  records.listAttempts = (taskId: string) => original(taskId).map((attempt) => attempt.kind === "initial" ? { ...attempt, model: "another-model" } : attempt);
  await runToRest(controller, records, task.id);
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.starts[1]?.resume, undefined, "another model's session is never continued");
  assert.equal(records.listEventsOfKind(task.id, "attempt.session_resumed").length, 0);
});

test("the resume brief names each open obligation once and keeps the exit condition", () => {
  const input = {
    identity: { attempt_id: "att_2" },
    workspace: { head_revision: "abc123", checks: [{ name: "test", command: "npm run test", required: true }] },
    execution: { harness: "claude" },
    context: {
      obligations: [{ id: "obl_1", kind: "code_defect", severity: "major", blocking: true, summary: "Overflow returns Infinity" }],
      previous_findings: ["[major] Overflow returns Infinity", "unit: FAIL (/state/gate.log)"],
    },
  } as unknown as WorkerInput;
  const brief = assembleResumePrompt(input);
  assert.match(brief, /committed that change as abc123/);
  assert.equal(brief.split("Overflow returns Infinity").length - 1, 1, "a finding restating an obligation is not repeated");
  assert.match(brief, /- obl_1 \[major, blocking\]/);
  assert.match(brief, /- unit: FAIL/);
  assert.match(brief, /run_checks tool/);
  assert.match(brief, /overwrite \.mabs\/result\.json/);
  assert.match(brief, /Do not run git commit/);
});
