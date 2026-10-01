import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { WorkerInput } from "../src/domain/contract.ts";
import { assembleWorkerPrompt, checkInstructions } from "../src/prompts/roles.ts";
import type { GateSpec } from "../src/store/records.ts";
import { checkServerMcpConfig, claudeArgs } from "../src/verify/launch.ts";
import { CHECKS_TOOL_PERMISSION, RECIPE_TOOL_PERMISSION, renderOutcomes, runRecipe, runRegisteredChecks, serve } from "../src/worker-tools/checks-mcp.ts";
import { validateRecipes, type WorkerRecipe } from "../src/domain/recipes.ts";

const SERVER = fileURLToPath(new URL("../src/worker-tools/checks-mcp.ts", import.meta.url));

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "mabs-worker-checks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const node = (script: string): string[] => [process.execPath, "-e", script];
const passing: GateSpec = { name: "unit", required: true, command: node("console.log('all good')") };
const failing: GateSpec = { name: "lint", required: true, command: node("console.log('x'.repeat(9000)); console.error('lint: bad'); process.exit(2)") };

test("a Claude worker with registered checks gets exactly one MCP server and its exact-name tool permission", () => {
  const plain = claudeArgs({ prompt: "p", model: "claude-sonnet-5", effort: "medium" });
  assert.equal(plain.includes(CHECKS_TOOL_PERMISSION), false);
  assert.equal(plain[plain.indexOf("--mcp-config") + 1], JSON.stringify({ mcpServers: {} }));

  const args = claudeArgs({ prompt: "p", model: "claude-sonnet-5", effort: "medium" }, { specPath: "/tmp/spec.json" });
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.ok(allowed.includes(CHECKS_TOOL_PERMISSION));
  assert.ok(!allowed.some((tool) => /npm|node|Bash\(\*/.test(tool)), "no broad shell pattern is added");
  assert.ok(args.includes("--strict-mcp-config"), "no other MCP configuration can load");
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1] as string) as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(Object.keys(config.mcpServers), ["mabs"]);
  assert.deepEqual(config.mcpServers.mabs?.args, [SERVER, "/tmp/spec.json"]);
  assert.equal(args[args.indexOf("--mcp-config") + 1], checkServerMcpConfig({ specPath: "/tmp/spec.json" }));
});

test("only registered checks run; passes are terse and failures return a bounded tail", async (t) => {
  const cwd = tempDir(t);
  const spec = { cwd, checks: [passing, failing] };
  const all = await runRegisteredChecks(spec);
  assert.deepEqual(all.outcomes.map((item) => [item.name, item.status]), [["unit", "PASS"], ["lint", "FAIL"]]);
  assert.equal(all.outcomes[0]?.output, "", "a pass carries no output");
  assert.ok((all.outcomes[1]?.output.length ?? 0) <= 4_000);
  assert.match(all.outcomes[1]?.output ?? "", /lint: bad/, "the tail keeps the end of the output, where failures are");

  const subset = await runRegisteredChecks(spec, ["unit", "rm -rf /"]);
  assert.deepEqual(subset.outcomes.map((item) => item.name), ["unit"]);
  assert.deepEqual(subset.unknown, ["rm -rf /"], "an unregistered name is reported, never executed");
  assert.match(renderOutcomes(subset.outcomes, subset.unknown), /Not registered, not run: rm -rf \//);
});

test("the server speaks MCP over newline-delimited JSON-RPC", async (t) => {
  const cwd = tempDir(t);
  const input = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  const done = serve({ cwd, checks: [passing], logPath: join(cwd, "calls.log") }, input, (line) => replies.push(JSON.parse(line) as Record<string, unknown>));
  const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_checks", arguments: {} } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shell", arguments: { command: "id" } } });
  send({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  input.end();
  await done;
  assert.deepEqual(replies.map((reply) => reply.id), [1, 2, 3, 4, 5], "the notification got no reply");
  assert.equal((replies[0]?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.deepEqual((replies[1]?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), ["run_checks"]);
  assert.match(((replies[2]?.result as { content: { text: string }[] }).content[0]?.text) ?? "", /^PASS unit/);
  assert.equal((replies[3]?.error as { code: number }).code, -32602, "an unknown tool is refused");
  assert.equal((replies[4]?.error as { code: number }).code, -32601);
  assert.equal(readFileSync(join(cwd, "calls.log"), "utf8").trim().split("\n").length, 1, "every tool call is logged");
});

test("the server entry point runs as a real stdio process", async (t) => {
  const cwd = tempDir(t);
  const specPath = join(cwd, "spec.json");
  writeFileSync(specPath, JSON.stringify({ cwd, checks: [failing] }));
  const child = spawn(process.execPath, [SERVER, specPath], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_checks", arguments: {} } })}\n`);
  child.stdin.end();
  await new Promise((resolvePromise) => child.once("close", resolvePromise));
  const reply = JSON.parse(out.trim()) as { result: { content: { text: string }[] } };
  assert.match(reply.result.content[0]?.text ?? "", /^FAIL lint \(exit 2/);
});

function workerInput(harness: string, checks: WorkerInput["workspace"]["checks"]): WorkerInput {
  return {
    identity: { project_id: "p", task_id: "t", attempt_id: "a", role: "implementer", contract_version: "1.3.0" },
    task: { objective: "o", acceptance_criteria: [], dependencies: [], profile: { task_class: "small_implementation", complexity: "low", ambiguity: "low",
      change_risk: "low", language: null, domain: null, context_size: "small", required_tools: [], execution_mode: "single", execution_reason: null },
    deadline_at: null, repairs_used: 0, repair_limit: 2 },
    workspace: { worktree_path: "/w", base_revision: "b", head_revision: "b", branch: "x", allowed_scope: [], allowed_actions: [], forbidden_actions: [], checks },
    execution: { harness, model: "m", effort: "medium", auth_mode: "sub" },
  } as unknown as WorkerInput;
}

test("the prompt tells each harness how to verify, and says nothing when there is nothing to run", () => {
  const checks = [{ name: "test", command: "npm run test", required: true }];
  assert.match(checkInstructions(workerInput("claude", checks), "implementation").join(), /run_checks tool/);
  assert.match(checkInstructions(workerInput("codex", checks), "repair").join(), /running the commands in workspace\.checks exactly/);
  assert.deepEqual(checkInstructions(workerInput("claude", checks), "review"), []);
  assert.deepEqual(checkInstructions(workerInput("claude", []), "implementation"), []);
  const prompt = assembleWorkerPrompt({ purpose: "implementation", workerInput: workerInput("claude", checks), projectAddendum: null, guidance: [] });
  assert.match(prompt, /run_checks tool/);
});

// --- EXEC-01: named recipes ---------------------------------------------------

/** A tiny program that echoes its arguments and writes a marker when it runs. */
function programIn(cwd: string): WorkerRecipe {
  writeFileSync(join(cwd, "app.js"), [
    "const fs = require('node:fs');",
    "fs.writeFileSync('ran.marker', 'yes');",
    "const [cmd, ...rest] = process.argv.slice(2);",
    "if (cmd === 'write') { fs.writeFileSync(rest[0], 'data'); console.log('wrote ' + rest[0]); }",
    "else if (cmd === 'sleep') setTimeout(() => {}, 60_000);",
    "else if (cmd === 'loud') console.log('y'.repeat(9000) + ' END');",
    "else console.log('args: ' + JSON.stringify([cmd, ...rest]) + ' tmp=' + process.env.MABS_RECIPE_TMP);",
  ].join("\n"));
  return { name: "run", description: "Run the app.", command: [process.execPath, "app.js"], maxArgs: 3, timeoutMs: 1_000 };
}

test("EXEC-01: a Claude worker gets run_recipe by exact name only when the project has recipes", () => {
  const base = { prompt: "p", model: "claude-sonnet-5", effort: "medium" };
  const allowed = (args: string[]) => args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.equal(allowed(claudeArgs(base, { specPath: "/tmp/s.json" })).includes(RECIPE_TOOL_PERMISSION), false);
  const withRecipes = allowed(claudeArgs(base, { specPath: "/tmp/s.json", recipes: true }));
  assert.ok(withRecipes.includes(RECIPE_TOOL_PERMISSION));
  assert.ok(!withRecipes.some((tool) => /npm|node|Bash\(\*/.test(tool)), "no broad shell pattern is added");
});

test("EXEC-01: a recipe runs with validated arguments and a scratch directory that is removed afterwards", async (t) => {
  const cwd = tempDir(t);
  const recipe = programIn(cwd);
  const outcome = await runRecipe({ cwd, checks: [], recipes: [recipe] }, "run", ["hello", "src/x.txt"]);
  assert.equal(outcome.status, "EXITED");
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.output, /args: \["hello","src\/x.txt"\]/);
  const scratch = outcome.output.match(/tmp=(\S+)/)?.[1] ?? "";
  assert.ok(scratch && !existsSync(scratch), "the scratch directory does not outlive the run");

  const wrote = await runRecipe({ cwd, checks: [], recipes: [recipe] }, "run", ["write", "{tmp}/out.txt"]);
  assert.equal(wrote.exitCode, 0);
  assert.doesNotMatch(wrote.output, /\{tmp\}/, "the placeholder is replaced with the real scratch path");
});

test("EXEC-01: unknown recipes, extra arguments, and paths outside the worktree are refused without running", async (t) => {
  const cwd = tempDir(t);
  const recipe = programIn(cwd);
  const spec = { cwd, checks: [], recipes: [recipe] };
  for (const [name, args, pattern] of [
    ["rm", [], /Unknown recipe rm; not run/],
    ["run", ["a", "b", "c", "d"], /at most 3 argument/],
    ["run", ["../outside.txt"], /outside the worktree/],
    ["run", ["/etc/passwd"], /outside the worktree/],
    ["run", ["--out=../../x"], /outside the worktree/],
    ["run", ["~/.ssh/id_rsa"], /home-directory path/],
    ["run", "not-an-array", /args must be an array/],
  ] as [string, unknown, RegExp][]) {
    const outcome = await runRecipe(spec, name, args);
    assert.equal(outcome.status, "REFUSED", `${name} ${JSON.stringify(args)}`);
    assert.match(outcome.output, pattern);
  }
  assert.equal(existsSync(join(cwd, "ran.marker")), false, "no refused call started the program");
});

test("EXEC-01: a recipe timeout is observable and output stays bounded", async (t) => {
  const cwd = tempDir(t);
  const recipe = programIn(cwd);
  const slow = await runRecipe({ cwd, checks: [], recipes: [recipe] }, "run", ["sleep"]);
  assert.equal(slow.status, "TIMEOUT");
  const loud = await runRecipe({ cwd, checks: [], recipes: [recipe] }, "run", ["loud"]);
  assert.ok(loud.output.length < 4_200, `output is ${loud.output.length} characters`);
  assert.match(loud.output, /^\[first \d+ characters omitted\]/);
  assert.match(loud.output, /END/, "the end of the output is kept");
});

test("EXEC-01: the MCP server lists run_recipe only with recipes, labels output as exploratory, and logs calls", async (t) => {
  const cwd = tempDir(t);
  const recipe = programIn(cwd);
  const ask = async (spec: Parameters<typeof serve>[0], messages: object[]) => {
    const input = new PassThrough();
    const replies: Record<string, unknown>[] = [];
    const done = serve(spec, input, (line) => replies.push(JSON.parse(line) as Record<string, unknown>));
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    input.end();
    await done;
    return replies;
  };
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const without = await ask({ cwd, checks: [passing] }, [list]);
  assert.deepEqual((without[0]?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), ["run_checks"]);

  const log = join(cwd, "calls.log");
  const replies = await ask({ cwd, checks: [passing], recipes: [recipe], logPath: log }, [
    list,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_recipe", arguments: { name: "run", args: ["hi"] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_recipe", arguments: { name: "nope" } } },
  ]);
  const tools = (replies[0]?.result as { tools: { name: string; inputSchema: { properties: { name: { enum: string[] } } } }[] }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["run_checks", "run_recipe"]);
  assert.deepEqual(tools[1]?.inputSchema.properties.name.enum, ["run"]);
  const ran = replies[1]?.result as { content: { text: string }[]; isError: boolean };
  assert.match(ran.content[0]?.text ?? "", /^EXITED run \(exit 0.*Exploratory run, not acceptance evidence/s);
  assert.equal(ran.isError, false);
  assert.equal((replies[2]?.result as { isError: boolean }).isError, true);
  const logged = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; status: string });
  assert.deepEqual(logged.map((entry) => [entry.kind, entry.status]), [["recipe", "EXITED"], ["recipe", "REFUSED"]]);
});

test("EXEC-01: recipe definitions are validated before they can be registered", () => {
  const good: WorkerRecipe = { name: "run", description: "Run it.", command: ["node", "src/cli.js"], maxArgs: 4 };
  assert.deepEqual(validateRecipes([good]), []);
  const errors = validateRecipes([
    { ...good, name: "Run It" },
    { ...good, maxArgs: 99 },
    { ...good, name: "env", env: { PATH: "/tmp", NODE_OPTIONS: "--require x" } },
    { ...good, name: "cwd", cwd: "../elsewhere" },
    { ...good, name: "extra", shell: true },
    good, good,
  ]).join(" ");
  for (const pattern of [/lowercase letters/, /maxArgs must be/, /PATH is not allowed/, /NODE_OPTIONS is not allowed/, /cwd must be repository-relative/, /unknown field\(s\) shell/, /Duplicate recipe name run/]) {
    assert.match(errors, pattern);
  }
});

test("EXEC-01: workers are told how to try the program; reviewers are not", () => {
  const input = (harness: string, recipes: unknown[]) => ({
    workspace: { checks: [], recipes },
    execution: { harness },
  }) as unknown as WorkerInput;
  const recipe = [{ name: "run", command: "node src/cli.js", max_args: 4, description: "Run it." }];
  assert.match(checkInstructions(input("claude", recipe), "implementation").join(" "), /run_recipe tool/);
  assert.match(checkInstructions(input("codex", recipe), "repair").join(" "), /run a command from workspace.recipes/);
  assert.deepEqual(checkInstructions(input("claude", recipe), "review"), []);
  assert.deepEqual(checkInstructions(input("claude", []), "implementation"), [], "no recipes, no recipe instruction");
});
