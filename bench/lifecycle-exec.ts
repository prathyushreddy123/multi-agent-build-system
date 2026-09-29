/**
 * Execute a Pi-planned MABS product and record the whole lifecycle's usage:
 * every Pi turn (planning through submission) plus every worker attempt. The
 * product is scored with the fixture's hidden checks on the final task's
 * worktree, which already integrates the tasks it depends on.
 *
 *   node bench/lifecycle-exec.ts --checkout=<mabs> --state=<dir> --adapter=claude|codex --label=lifecycle --fixture=habit-tracker
 *
 * Pi's turn summaries are read from <state>/t*.summary.json (written by pi-turn.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mabsEnv, PI_MODEL, type PiUsage } from "./pi-turn.ts";
import { evaluate, loadFixture, observe, usageFields, type AttemptRow } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = { claude: "claude-sonnet-5", codex: "gpt-5.6-sol" } as const;
const TERMINAL = new Set(["DONE", "FAILED", "BLOCKED", "CANCELLED"]);

function option(name: string, fallback?: string): string {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const checkout = resolve(option("checkout"));
const state = resolve(option("state"));
const adapter = option("adapter") as "claude" | "codex";
const label = option("label", "lifecycle");
const fixture = loadFixture(option("fixture", "habit-tracker"));
const env = mabsEnv(state);

function cli(args: string[]): Record<string, unknown> | Record<string, unknown>[] {
  const result = spawnSync(process.execPath, [join(checkout, "src", "cli.ts"), ...args], { cwd: checkout, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`mabs ${args.join(" ")}: ${(result.stderr || result.stdout).slice(0, 400)}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// Pi: every scripted turn, shared planning turns included.
const piTurns = readdirSync(state).filter((name) => /^t\d+\.summary\.json$/.test(name)).sort().map((name) => ({
  turn: name.replace(".summary.json", ""),
  ...(JSON.parse(readFileSync(join(state, name), "utf8")) as { wallMs: number; usage: PiUsage; tools: string[]; errors: string[] }),
}));

// Execution: the controller builds every submitted task; watching costs no model tokens.
const started = Date.now();
const controller = spawn(process.execPath, [join(checkout, "src", "cli.ts"), "controller", "run", "--workers=1",
  `--adapter=${adapter}`, `--model=${MODELS[adapter]}`, "--effort=medium"], { cwd: checkout, env, stdio: "ignore" });
let tasks: Record<string, unknown>[] = [];
while (Date.now() - started < 60 * 60_000) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  tasks = cli(["task", "list"]) as Record<string, unknown>[];
  if (tasks.length > 0 && tasks.every((task) => TERMINAL.has(String(task.state)))) break;
}
controller.kill("SIGINT");
await new Promise((resolvePromise) => controller.once("close", resolvePromise));

const shows = tasks.map((task) => cli(["task", "show", String(task.id)]) as Record<string, unknown>);
const attempts: (AttemptRow & { task: string })[] = [];
for (const show of shows) {
  const task = show.task as Record<string, unknown>;
  for (const attempt of (show.attempts as Record<string, unknown>[]) ?? []) {
    const id = String(attempt.id);
    let raw = "";
    try {
      raw = String((JSON.parse(readFileSync(join(state, "mabs", "artifacts", String(task.id), id, "completion.json"), "utf8")) as { result?: { raw?: string } }).result?.raw ?? "");
    } catch { /* no completion */ }
    const startedAt = Date.parse(String(attempt.startedAt));
    const endedAt = Date.parse(String(attempt.endedAt));
    attempts.push({
      task: String(task.title), id, kind: String(attempt.kind), adapter: String(attempt.adapter), model: (attempt.model as string) ?? null,
      effort: (attempt.effort as string) ?? null, state: String(attempt.state),
      durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : null, promptBytes: null,
      ...usageFields(id, String(attempt.adapter), attempt.usage), ...observe(String(attempt.adapter), raw),
    });
  }
}
const finishedAt = Math.max(...shows.map((show) => Date.parse(String((show.task as Record<string, unknown>).updatedAt))));
// The last task in dependency order holds the integrated product.
const byDependents = shows.map((show) => show.task as Record<string, unknown>)
  .sort((a, b) => ((b.dependsOn as unknown[] | undefined)?.length ?? 0) - ((a.dependsOn as unknown[] | undefined)?.length ?? 0));
const product = byDependents.find((task) => task.state === "DONE" && task.worktreePath) ?? byDependents[0];
const hidden = product?.worktreePath ? evaluate(fixture, String(product.worktreePath)) : null;

const piUsage = piTurns.reduce((total, turn) => ({
  input: total.input + turn.usage.input, output: total.output + turn.usage.output, cacheRead: total.cacheRead + turn.usage.cacheRead,
  cacheWrite: total.cacheWrite + turn.usage.cacheWrite, turns: total.turns + turn.usage.turns,
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
const row = {
  label, fixture: fixture.name, harness: `pi+mabs-${adapter}`, sample: 1, startedAt: new Date(started).toISOString(),
  pi: { model: PI_MODEL, turns: piTurns.map(({ turn, wallMs, usage, tools, errors }) => ({ turn, wallMs, usage, toolCalls: tools.length, toolErrors: errors.length })), usage: piUsage,
    wallMs: piTurns.reduce((total, turn) => total + turn.wallMs, 0) },
  executionWallMs: finishedAt - started,
  tasks: shows.map((show) => { const task = show.task as Record<string, unknown>; return { id: task.id, title: task.title, state: task.state, blockedReason: task.blockedReason ?? null }; }),
  attempts, hidden, productWorktree: product?.worktreePath ?? null,
};
appendFileSync(join(HERE, "results", `${label}.jsonl`), `${JSON.stringify(row)}\n`);
console.log(JSON.stringify({ harness: row.harness, tasks: row.tasks, piUsage, executionWallMs: row.executionWallMs, attempts: attempts.length, hidden }, null, 1));
