/**
 * One scripted turn of a Pi + MABS conversation, for the idea-to-product
 * benchmark. Pi runs in the MABS checkout (so its MABS extension loads) with
 * only the MABS tools enabled, against an isolated MABS state directory, and
 * continues the same Pi session across turns.
 *
 *   node bench/pi-turn.ts --checkout=<mabs> --state=<dir> --session=<id> --out=<turn.jsonl> "<message>"
 *
 * Prints Pi's reply, the MABS tools it called, and the turn's token usage as
 * Pi reports it per assistant message (input, output, cache read, cache write).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PI_MODEL = { provider: "claude-bridge", model: "claude-sonnet-5", thinking: "medium" } as const;

/** Pi may only act through MABS: no shell, no file edits of its own. */
export const MABS_TOOLS = [
  "mabs_status", "mabs_create_brief", "mabs_update_brief", "mabs_set_project_governance", "mabs_ask_clarifications",
  "mabs_answer_clarification", "mabs_propose_plan", "mabs_accept_plan", "mabs_get_operations", "mabs_prepare_operation",
  "mabs_bootstrap_project", "mabs_submit_plan", "mabs_get_product", "mabs_submit_task",
];

export interface PiUsage { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }

export function mabsEnv(state: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MABS_STATE_DIR: join(state, "mabs"),
    MABS_DB_PATH: join(state, "mabs", "mabs.sqlite"),
    MABS_WORKTREE_ROOT: join(state, "worktrees"),
    NO_COLOR: "1",
  };
  delete env.FORCE_COLOR;
  return env;
}

/** Sum Pi's per-message usage; each assistant message is one model call. */
export function piUsage(jsonl: string): { usage: PiUsage; text: string; tools: string[]; errors: string[] } {
  const usage: PiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  let text = "";
  const tools: string[] = [];
  const errors: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; message?: { role?: string; usage?: Partial<PiUsage>; content?: unknown }; toolName?: string; isError?: boolean; result?: unknown };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const reported = event.message.usage ?? {};
      usage.input += reported.input ?? 0;
      usage.output += reported.output ?? 0;
      usage.cacheRead += reported.cacheRead ?? 0;
      usage.cacheWrite += reported.cacheWrite ?? 0;
      usage.turns += 1;
      const parts = Array.isArray(event.message.content) ? event.message.content as { type?: string; text?: string; name?: string; arguments?: unknown }[] : [];
      const said = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
      if (said) text = said;
      for (const part of parts) if (part.type === "toolCall" || part.type === "tool_use") tools.push(`${part.name}(${JSON.stringify(part.arguments ?? {}).slice(0, 120)})`);
    }
    if (event.type === "tool_execution_end" && event.isError) errors.push(`${event.toolName}: ${JSON.stringify(event.result).slice(0, 300)}`);
  }
  return { usage, text, tools, errors };
}

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const checkout = resolve(option("checkout") ?? "");
  const state = resolve(option("state") ?? "");
  const session = option("session");
  const out = option("out");
  const message = process.argv.slice(2).filter((arg) => !arg.startsWith("--")).join(" ");
  if (!checkout || !state || !session || !out || !message) throw new Error("usage: pi-turn.ts --checkout= --state= --session= --out= <message>");
  mkdirSync(join(state, "pi-sessions"), { recursive: true });
  const started = Date.now();
  const result = spawnSync("pi", [
    "-p", "--mode", "json", "--approve",
    "--provider", PI_MODEL.provider, "--model", PI_MODEL.model, "--thinking", PI_MODEL.thinking,
    "--session-dir", join(state, "pi-sessions"), "--session-id", session,
    "--tools", MABS_TOOLS.join(","),
    message,
  ], { cwd: checkout, env: mabsEnv(state), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60_000 });
  writeFileSync(out, result.stdout);
  const { usage, text, tools, errors } = piUsage(result.stdout);
  const summary = { exit: result.status, wallMs: Date.now() - started, usage, tools, errors, reply: text };
  writeFileSync(out.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ exit: summary.exit, wallMs: summary.wallMs, usage, tools, errors }, null, 1));
  console.log(`--- Pi reply ---\n${text.slice(0, 4000)}`);
  if (result.status !== 0) console.log(`--- stderr ---\n${result.stderr.slice(-2000)}`);
}
