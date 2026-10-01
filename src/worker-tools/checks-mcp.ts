#!/usr/bin/env node
/**
 * A stdio MCP server that gives a worker exactly one tool: run the project's
 * registered checks in its worktree.
 *
 * A worker told to make checks pass must be able to run them. Allowing
 * `Bash(npm *)` is neither narrow (any npm script) nor reliable (the provider's
 * own command-safety check can still deny it), and denied attempts burn whole
 * model turns. An MCP tool is permitted by exact name, and it can only run the
 * argv the controller registered: no shell, no worker-supplied command. The
 * controller still re-runs every check as the source of truth.
 *
 *   node checks-mcp.ts <spec.json>   spec: {cwd, checks: GateSpec[], logPath?}
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { exec } from "../core/exec.ts";
import { RECIPE_DEFAULT_TIMEOUT_MS, RECIPE_TMP_PLACEHOLDER, recipeArgumentErrors, type WorkerRecipe } from "../domain/recipes.ts";
import type { GateSpec } from "../store/records.ts";

export const CHECKS_SERVER_NAME = "mabs";
export const CHECKS_TOOL_NAME = "run_checks";
/** The name Claude Code gives the tool: mcp__<server>__<tool>. */
export const CHECKS_TOOL_PERMISSION = `mcp__${CHECKS_SERVER_NAME}__${CHECKS_TOOL_NAME}`;
export const RECIPE_TOOL_NAME = "run_recipe";
export const RECIPE_TOOL_PERMISSION = `mcp__${CHECKS_SERVER_NAME}__${RECIPE_TOOL_NAME}`;
const OUTPUT_TAIL_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface ChecksSpec {
  cwd: string;
  checks: GateSpec[];
  /** Named exploratory commands; run_recipe is offered only when there are some. */
  recipes?: WorkerRecipe[];
  logPath?: string;
}

export interface RecipeOutcome {
  name: string;
  status: "EXITED" | "TIMEOUT" | "REFUSED";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/**
 * Run one named recipe with validated arguments. An unknown recipe or a bad
 * argument is refused before anything starts. `{tmp}` in an argument names a
 * scratch directory that exists only for this run.
 */
export async function runRecipe(spec: ChecksSpec, name: unknown, args: unknown): Promise<RecipeOutcome> {
  const refused = (output: string): RecipeOutcome => ({ name: String(name), status: "REFUSED", exitCode: null, durationMs: 0, output });
  const recipe = (spec.recipes ?? []).find((item) => item.name === name);
  if (!recipe) return refused(`Unknown recipe ${String(name)}; not run. Available: ${(spec.recipes ?? []).map((item) => item.name).join(", ") || "none"}.`);
  const errors = recipeArgumentErrors(recipe, args, spec.cwd);
  if (errors.length > 0) return refused(`Refused, not run: ${errors.join(" ")}`);
  const scratch = mkdtempSync(join(tmpdir(), "mabs-recipe-"));
  try {
    const [command, ...fixed] = recipe.command as [string, ...string[]];
    const supplied = ((args as string[] | undefined) ?? []).map((arg) => arg.replaceAll(RECIPE_TMP_PLACEHOLDER, scratch));
    const result = await exec(command, [...fixed, ...supplied], {
      cwd: recipe.cwd ? resolve(spec.cwd, recipe.cwd) : spec.cwd,
      timeoutMs: recipe.timeoutMs ?? RECIPE_DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(recipe.env ?? {}), MABS_RECIPE_TMP: scratch },
    });
    const combined = `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
    return {
      name: recipe.name, status: result.timedOut ? "TIMEOUT" : "EXITED", exitCode: result.code, durationMs: result.durationMs,
      output: combined.length > OUTPUT_TAIL_CHARS ? `[first ${combined.length - OUTPUT_TAIL_CHARS} characters omitted]\n${combined.slice(-OUTPUT_TAIL_CHARS)}` : combined,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function renderRecipe(outcome: RecipeOutcome): string {
  const head = outcome.status === "REFUSED"
    ? `REFUSED ${outcome.name}`
    : `${outcome.status} ${outcome.name} (exit ${outcome.exitCode ?? "none"}, ${(outcome.durationMs / 1000).toFixed(1)}s)`;
  return `${head}. Exploratory run, not acceptance evidence; the controller's checks decide.\n${outcome.output}`;
}

export interface CheckOutcome {
  name: string;
  status: "PASS" | "FAIL" | "ERROR";
  exitCode: number | null;
  durationMs: number;
  /** Bounded tail of combined output; empty for a pass, which needs no detail. */
  output: string;
}

/** Run the named registered checks (all when none are named). Unknown names are refused, never executed. */
export async function runRegisteredChecks(spec: ChecksSpec, names?: string[]): Promise<{ outcomes: CheckOutcome[]; unknown: string[] }> {
  const wanted = names && names.length > 0 ? new Set(names) : null;
  const unknown = wanted ? [...wanted].filter((name) => !spec.checks.some((check) => check.name === name)) : [];
  const outcomes: CheckOutcome[] = [];
  for (const check of spec.checks) {
    if (wanted && !wanted.has(check.name)) continue;
    const [command, ...args] = check.command;
    if (!command) {
      outcomes.push({ name: check.name, status: "ERROR", exitCode: null, durationMs: 0, output: "The registered check has an empty command." });
      continue;
    }
    const cwd = check.cwd ? resolve(spec.cwd, check.cwd) : spec.cwd;
    const result = await exec(command, args, { cwd, timeoutMs: check.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const status = result.timedOut || result.code === null || result.code === 127 ? "ERROR" : result.code === 0 ? "PASS" : "FAIL";
    const combined = `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}${result.timedOut ? "\n[timed out]" : ""}`;
    outcomes.push({
      name: check.name, status, exitCode: result.code, durationMs: result.durationMs,
      output: status === "PASS" ? "" : combined.slice(-OUTPUT_TAIL_CHARS),
    });
  }
  return { outcomes, unknown };
}

export function renderOutcomes(outcomes: CheckOutcome[], unknown: string[]): string {
  const lines = outcomes.map((item) => `${item.status} ${item.name} (exit ${item.exitCode ?? "none"}, ${(item.durationMs / 1000).toFixed(1)}s)`);
  if (unknown.length > 0) lines.push(`Not registered, not run: ${unknown.join(", ")}`);
  for (const item of outcomes.filter((outcome) => outcome.status !== "PASS")) lines.push(`\n--- ${item.name} output (tail) ---\n${item.output}`);
  if (outcomes.length === 0) lines.push("No registered checks matched.");
  return lines.join("\n");
}

const TOOL = {
  name: CHECKS_TOOL_NAME,
  description: "Run this project's registered checks (tests, typecheck, lint) in the worktree and report pass/fail with the failing output. " +
    "These are the same checks the controller runs to accept the change. Takes no command: only registered checks can run.",
  inputSchema: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" }, description: "Optional subset of check names; omit to run all." } },
    additionalProperties: false,
  },
};

function recipeTool(recipes: WorkerRecipe[]) {
  return {
    name: RECIPE_TOOL_NAME,
    description: "Run one of this project's named recipes (for example, run the program you are building) with optional arguments, " +
      "and see its exit code and output. Exploratory only: it is never acceptance evidence. No shell; unknown recipes and arguments " +
      `that point outside the worktree are refused. Use ${RECIPE_TMP_PLACEHOLDER} in an argument for a scratch directory. Recipes: ` +
      recipes.map((recipe) => `${recipe.name} (${recipe.command.join(" ")} + up to ${recipe.maxArgs} args): ${recipe.description}`).join("; "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", enum: recipes.map((recipe) => recipe.name) },
        args: { type: "array", items: { type: "string" }, description: "Arguments appended to the recipe's fixed command." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

interface Request { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> }

async function handle(spec: ChecksSpec, request: Request): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mabs-checks", version: "1" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: (spec.recipes ?? []).length > 0 ? [TOOL, recipeTool(spec.recipes ?? [])] : [TOOL] };
    case "tools/call": {
      if (request.params?.name === RECIPE_TOOL_NAME && (spec.recipes ?? []).length > 0) {
        const args = (request.params?.arguments ?? {}) as { name?: unknown; args?: unknown };
        const outcome = await runRecipe(spec, args.name, args.args);
        if (spec.logPath) {
          appendFileSync(spec.logPath, `${JSON.stringify({ at: new Date().toISOString(), kind: "recipe", name: outcome.name, status: outcome.status, exitCode: outcome.exitCode, durationMs: outcome.durationMs })}\n`, { mode: 0o600 });
        }
        return { content: [{ type: "text", text: renderRecipe(outcome) }], isError: outcome.status === "REFUSED" };
      }
      if (request.params?.name !== CHECKS_TOOL_NAME) throw Object.assign(new Error(`Unknown tool ${String(request.params?.name)}`), { code: -32602 });
      const args = (request.params?.arguments ?? {}) as { names?: unknown };
      const names = Array.isArray(args.names) ? args.names.filter((item): item is string => typeof item === "string") : undefined;
      const { outcomes, unknown } = await runRegisteredChecks(spec, names);
      if (spec.logPath) {
        appendFileSync(spec.logPath, `${JSON.stringify({ at: new Date().toISOString(), names: names ?? null, outcomes: outcomes.map(({ output: _output, ...rest }) => rest), unknown })}\n`, { mode: 0o600 });
      }
      return { content: [{ type: "text", text: renderOutcomes(outcomes, unknown) }], isError: false };
    }
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}

/** Serve newline-delimited JSON-RPC on stdio, one request at a time. */
export async function serve(spec: ChecksSpec, input: NodeJS.ReadableStream, write: (line: string) => void): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      continue;
    }
    // Notifications carry no id and get no response.
    if (request.id === undefined || request.id === null) continue;
    try {
      write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: await handle(spec, request) }));
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32603;
      write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message: error instanceof Error ? error.message : String(error) } }));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const specPath = process.argv[2];
  if (!specPath) throw new Error("checks-mcp requires a spec path");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as ChecksSpec;
  await serve(spec, process.stdin, (line) => process.stdout.write(`${line}\n`));
}
