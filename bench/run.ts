/**
 * One benchmark run: a fixture implemented by direct Claude, direct Codex, or a
 * MABS checkout driving Claude or Codex, then scored by hidden checks the
 * worker never saw. Appends one JSON row to the results file.
 *
 *   node bench/run.ts --fixture=parse-duration --harness=mabs-claude \
 *     --mabs=/path/to/mabs/checkout --label=v3-baseline --sample=1 [--mode=verified]
 *
 * MABS runs use an isolated state directory, database, and worktree root, so
 * the live MABS database is never touched. Usage from every harness goes
 * through this checkout's normalizer so all rows are measured the same way.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAttemptUsage } from "../src/usage/summary.ts";
import { buildWorkerEnv } from "../src/verify/env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_MODEL = "claude-sonnet-5";
const CODEX_MODEL = "gpt-5.6-sol";
const EFFORT = "medium";
const HARNESSES = ["direct-claude", "direct-codex", "mabs-claude", "mabs-codex"] as const;
type Harness = (typeof HARNESSES)[number];
const MODES = { fast: "off", standard: "risk", verified: "required" } as const;
type Mode = keyof typeof MODES;

interface Fixture {
  name: string;
  dir: string;
  title: string;
  objective: string;
  accept: string[];
  scope: string[];
  taskClass: string;
}

export interface AttemptRow {
  id: string;
  kind: string;
  adapter: string;
  model: string | null;
  effort: string | null;
  state: string;
  durationMs: number | null;
  promptBytes: number | null;
  inputEvents: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoning: number | null;
  turns: number | null;
  denied: number | null;
  costUsd: number | null;
}

export interface RunRow {
  label: string;
  mabsRevision: string | null;
  fixture: string;
  harness: Harness;
  mode: Mode | null;
  sample: number;
  startedAt: string;
  wallMs: number;
  finalState: string;
  blockedReason: string | null;
  attempts: AttemptRow[];
  hidden: { passed: number; total: number; failures: string[] } | null;
}

function option(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function loadFixture(name: string): Fixture {
  const dir = join(HERE, "fixtures", name);
  const meta = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as {
    title: string; objectiveFile: string; acceptFile?: string; accept?: string[]; scope: string[]; taskClass: string;
  };
  const accept = meta.accept ?? readFileSync(join(dir, meta.acceptFile ?? "accept.txt"), "utf8").trim().split(";").map((item) => item.trim()).filter(Boolean);
  return { name, dir, title: meta.title, objective: readFileSync(join(dir, meta.objectiveFile), "utf8").trim(), accept, scope: meta.scope, taskClass: meta.taskClass };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=MABS Bench", "-c", "user.email=bench@local", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function prepareRepo(fixture: Fixture, root: string): string {
  const repo = join(root, "repo");
  cpSync(join(fixture.dir, "template"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "benchmark: starter");
  return repo;
}

/** The same task text a MABS task receives, as one prompt for a direct run. */
function directPrompt(fixture: Fixture): string {
  return `${fixture.objective}\n\nAcceptance criteria:\n${fixture.accept.map((item) => `- ${item}`).join("\n")}\n\n` +
    `Work only in: ${fixture.scope.join(", ")}. Run the project's tests before finishing.`;
}

function evaluate(fixture: Fixture, repo: string): RunRow["hidden"] {
  if (!existsSync(repo)) return null;
  const result = spawnSync(process.execPath, [join(fixture.dir, "evaluate.mjs"), repo], { encoding: "utf8", timeout: 120_000 });
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as RunRow["hidden"];
  } catch {
    return { passed: 0, total: 0, failures: [`evaluator failed: ${(result.stderr || line).slice(0, 300)}`] };
  }
}

function lastJsonLine(text: string, predicate: (value: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (predicate(value)) return value;
    } catch { /* not a JSON event */ }
  }
  return null;
}

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/** Tool calls, denials, and cost observable in a provider's raw output. */
function observe(adapter: string, raw: string): Pick<AttemptRow, "turns" | "denied" | "costUsd"> {
  if (adapter === "claude") {
    const result = lastJsonLine(raw, (value) => value.type === "result") ?? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })();
    return {
      turns: typeof result?.num_turns === "number" ? result.num_turns : null,
      denied: Array.isArray(result?.permission_denials) ? result.permission_denials.length : null,
      costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    };
  }
  let turns = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes('"item.completed"')) continue;
    try {
      const event = JSON.parse(line) as { item?: { type?: string } };
      if (CODEX_TOOL_ITEMS.has(event.item?.type ?? "")) turns += 1;
    } catch { /* partial line */ }
  }
  return { turns, denied: null, costUsd: null };
}

function usageFields(attemptId: string, adapter: string, raw: unknown): Pick<AttemptRow, "inputEvents" | "cacheRead" | "cacheWrite" | "cachedInput" | "output" | "reasoning"> {
  const usage = normalizeAttemptUsage({ attemptId, adapter, raw: raw ?? null });
  return {
    inputEvents: usage.knownInputEvents, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheWriteInputTokens,
    cachedInput: usage.cachedInputTokens, output: usage.outputTokens, reasoning: usage.reasoningOutputTokens,
  };
}

async function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

async function runDirect(fixture: Fixture, harness: "direct-claude" | "direct-codex", root: string, timeoutMs: number): Promise<Omit<RunRow, "label" | "mabsRevision" | "sample" | "startedAt">> {
  const repo = prepareRepo(fixture, root);
  const prompt = directPrompt(fixture);
  const { env } = buildWorkerEnv();
  const adapter = harness === "direct-claude" ? "claude" : "codex";
  const args = adapter === "claude"
    ? ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash(npm *)", "Bash(node *)", "Bash(git *)",
      "--disallowedTools", "Agent", "Task", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
      "--model", CLAUDE_MODEL, "--effort", EFFORT]
    : ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-C", repo,
      "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "--ignore-user-config",
      "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"', "-c", "mcp_servers={}",
      "-m", CODEX_MODEL, "-c", `model_reasoning_effort="${EFFORT}"`, prompt];
  const result = await runProcess(adapter, args, repo, env, timeoutMs);
  writeFileSync(join(root, `${adapter}.out`), result.stdout);
  writeFileSync(join(root, `${adapter}.err`), result.stderr);
  let usageRaw: unknown = null;
  if (adapter === "claude") {
    try { usageRaw = (JSON.parse(result.stdout) as { usage?: unknown }).usage ?? null; } catch { usageRaw = null; }
  } else {
    usageRaw = (lastJsonLine(result.stdout, (value) => value.type === "turn.completed")?.usage as unknown) ?? null;
  }
  const attempt: AttemptRow = {
    id: "direct", kind: "initial", adapter, model: adapter === "claude" ? CLAUDE_MODEL : CODEX_MODEL, effort: EFFORT,
    state: result.code === 0 ? "succeeded" : "failed", durationMs: result.ms, promptBytes: Buffer.byteLength(prompt),
    ...usageFields("direct", adapter, usageRaw), ...observe(adapter, result.stdout),
  };
  return {
    fixture: fixture.name, harness, mode: null, wallMs: result.ms, finalState: result.code === 0 ? "DONE" : `EXIT_${result.code}`,
    blockedReason: null, attempts: [attempt], hidden: evaluate(fixture, repo),
  };
}

function mabsCli(mabs: string, env: NodeJS.ProcessEnv, args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [join(mabs, "src", "cli.ts"), ...args], { cwd: mabs, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`mabs ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { text: result.stdout };
  }
}

const TERMINAL = new Set(["DONE", "FAILED", "BLOCKED", "CANCELLED"]);

async function runMabs(fixture: Fixture, harness: "mabs-claude" | "mabs-codex", mode: Mode, mabs: string, root: string, timeoutMs: number): Promise<Omit<RunRow, "label" | "mabsRevision" | "sample" | "startedAt">> {
  const repo = prepareRepo(fixture, root);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const env = { ...process.env, MABS_STATE_DIR: state, MABS_DB_PATH: join(state, "mabs.sqlite"), MABS_WORKTREE_ROOT: join(root, "worktrees") };
  const adapter = harness === "mabs-claude" ? "claude" : "codex";

  mabsCli(mabs, env, ["project", "add", "bench", repo, "--type=personal", "--goal=Benchmark"]);
  mabsCli(mabs, env, ["project", "governance", "bench", "--type=personal", `--review=${MODES[mode]}`, "--version=0"]);
  // Cross-provider review needs an eligible Codex route; verified once per state, outside the timed run.
  mabsCli(mabs, env, ["routing", "verify-entitlement", "codex", CODEX_MODEL]);
  const added = mabsCli(mabs, env, ["task", "add", "bench", fixture.title, `--objective=${fixture.objective}`,
    `--accept=${fixture.accept.join(";")}`, `--class=${fixture.taskClass}`, `--scope=${fixture.scope.join(",")}`,
    "--mode=single", "--mode-reason=Benchmark task."]);
  const taskId = String((added.id ?? (added.task as Record<string, unknown> | undefined)?.id) as string);

  const started = Date.now();
  const controller: ChildProcess = spawn(process.execPath, [join(mabs, "src", "cli.ts"), "controller", "run", "--workers=1",
    `--adapter=${adapter}`, `--model=${adapter === "claude" ? CLAUDE_MODEL : CODEX_MODEL}`, `--effort=${EFFORT}`],
  { cwd: mabs, env, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  controller.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  controller.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));

  let show: Record<string, unknown> = {};
  let finalState = "TIMEOUT";
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    show = mabsCli(mabs, env, ["task", "show", taskId]);
    const current = String((show.task as Record<string, unknown>).state);
    if (TERMINAL.has(current)) { finalState = current; break; }
  }
  const observedEnd = Date.now();
  if (finalState === "TIMEOUT") {
    const version = Number((show.task as Record<string, unknown>).recordVersion);
    try { mabsCli(mabs, env, ["task", "cancel", taskId, `--version=${version}`]); } catch { /* best effort */ }
  }
  controller.kill("SIGINT");
  await new Promise((resolvePromise) => controller.once("close", resolvePromise));
  writeFileSync(join(root, "controller.log"), log.join(""));
  show = mabsCli(mabs, env, ["task", "show", taskId]);
  writeFileSync(join(root, "task-show.json"), JSON.stringify(show, null, 2));

  // Wall time ends at the recorded terminal transition, not at the next poll.
  const events = (show.events as { kind: string; at: string }[] | undefined) ?? [];
  const lastState = events.filter((event) => event.kind === "task.state").map((event) => Date.parse(event.at)).filter(Number.isFinite);
  const end = finalState === "TIMEOUT" || lastState.length === 0 ? observedEnd : Math.max(...lastState);

  const attempts = ((show.attempts as Record<string, unknown>[] | undefined) ?? []).map((attempt): AttemptRow => {
    const id = String(attempt.id);
    const dir = join(state, "artifacts", taskId, id);
    let raw = "";
    let promptBytes: number | null = null;
    try { raw = String((JSON.parse(readFileSync(join(dir, "completion.json"), "utf8")) as { result?: { raw?: string } }).result?.raw ?? ""); } catch { /* no completion */ }
    try { promptBytes = Buffer.byteLength(String((JSON.parse(readFileSync(join(dir, "launch.json"), "utf8")) as { prompt?: string }).prompt ?? "")); } catch { /* no launch spec */ }
    const startedAt = Date.parse(String(attempt.startedAt));
    const endedAt = Date.parse(String(attempt.endedAt));
    return {
      id, kind: String(attempt.kind), adapter: String(attempt.adapter), model: (attempt.model as string) ?? null, effort: (attempt.effort as string) ?? null,
      state: String(attempt.state), durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : null, promptBytes,
      ...usageFields(id, String(attempt.adapter), attempt.usage), ...observe(String(attempt.adapter), raw),
    };
  });
  const task = show.task as Record<string, unknown>;
  const worktree = typeof task.worktreePath === "string" ? task.worktreePath : join(root, "missing");
  return {
    fixture: fixture.name, harness, mode, wallMs: end - started, finalState, blockedReason: (task.blockedReason as string) ?? null,
    // Scored whatever the final state, so a blocked run still shows the quality it reached.
    attempts, hidden: evaluate(fixture, worktree),
  };
}

async function main(): Promise<void> {
  const fixture = loadFixture(option("fixture"));
  const harness = option("harness") as Harness;
  if (!HARNESSES.includes(harness)) throw new Error(`--harness must be one of ${HARNESSES.join(", ")}`);
  const mode = option("mode", "verified") as Mode;
  if (!(mode in MODES)) throw new Error("--mode must be fast, standard, or verified");
  const label = option("label");
  const sample = Number(option("sample", "1"));
  const timeoutMs = Number(option("timeout-min", "45")) * 60_000;
  const out = resolve(option("out", join(HERE, "results", `${label}.jsonl`)));
  const root = mkdtempSync(join(tmpdir(), `mabs-bench-${fixture.name}-${harness}-`));
  const startedAt = new Date().toISOString();
  let mabsRevision: string | null = null;
  let body: Omit<RunRow, "label" | "mabsRevision" | "sample" | "startedAt">;
  if (harness === "direct-claude" || harness === "direct-codex") {
    body = await runDirect(fixture, harness, root, timeoutMs);
  } else {
    const mabs = resolve(option("mabs"));
    mabsRevision = git(mabs, "rev-parse", "--short", "HEAD");
    body = await runMabs(fixture, harness, mode, mabs, root, timeoutMs);
  }
  const row: RunRow = { label, mabsRevision, sample, startedAt, ...body };
  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  const tokens = row.attempts.reduce((total, attempt) => total + (attempt.inputEvents ?? 0), 0);
  console.log(`${label} ${fixture.name} ${harness} #${sample}: ${row.finalState} in ${(row.wallMs / 1000).toFixed(0)}s, ` +
    `${row.attempts.length} attempt(s), ${tokens} input events, hidden ${row.hidden?.passed}/${row.hidden?.total} (evidence: ${root})`);
}

await main();
