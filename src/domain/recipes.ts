/**
 * Named worker recipes: the exploratory commands a worker may run besides the
 * registered checks, such as running the program it is building.
 *
 * A recipe fixes the executable and leading arguments; the worker may only
 * append a bounded number of validated arguments. There is no shell and no
 * worker-supplied executable, and an unknown recipe never runs. Recipe output
 * is exploration, never acceptance evidence: the controller's checks still
 * decide. Project code run this way is still executable code; a worktree is
 * not a sandbox.
 */
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type { ProfileResolution } from "../profiles/types.ts";

export interface WorkerRecipe {
  name: string;
  description: string;
  /** Fixed executable and leading arguments. */
  command: string[];
  /** How many worker-supplied arguments may follow the fixed command (0-16). */
  maxArgs: number;
  /** Repository-relative working directory. */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export const RECIPE_DEFAULT_TIMEOUT_MS = 60_000;
export const RECIPE_MAX_TIMEOUT_MS = 10 * 60_000;
export const RECIPE_MAX_ARGS = 16;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Never let a recipe rewire how the interpreter or loader finds code. */
const FORBIDDEN_ENV = new Set(["PATH", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONSTARTUP"]);

function relativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

export function validateRecipes(value: unknown): string[] {
  if (!Array.isArray(value)) return ["workerRecipes must be an array."];
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [index, recipe] of value.entries()) {
    const item = recipe as Partial<WorkerRecipe> & Record<string, unknown>;
    const label = typeof item?.name === "string" ? item.name : `recipe[${index}]`;
    const unknown = Object.keys(item ?? {}).filter((key) => !["name", "description", "command", "maxArgs", "cwd", "timeoutMs", "env"].includes(key));
    if (unknown.length > 0) errors.push(`${label}: unknown field(s) ${unknown.join(", ")}.`);
    if (typeof item?.name !== "string" || !NAME.test(item.name)) errors.push(`${label}: name must be lowercase letters, digits, and dashes.`);
    else if (names.has(item.name)) errors.push(`Duplicate recipe name ${item.name}.`);
    else names.add(item.name);
    if (typeof item?.description !== "string" || !item.description.trim()) errors.push(`${label}: description is required.`);
    if (!Array.isArray(item?.command) || item.command.length === 0 || item.command.some((part) => typeof part !== "string" || !part || part.includes("\0"))) {
      errors.push(`${label}: command must be a non-empty argv array.`);
    }
    if (!Number.isSafeInteger(item?.maxArgs) || (item.maxArgs as number) < 0 || (item.maxArgs as number) > RECIPE_MAX_ARGS) {
      errors.push(`${label}: maxArgs must be an integer from 0 to ${RECIPE_MAX_ARGS}.`);
    }
    if (item?.cwd !== undefined && (typeof item.cwd !== "string" || !relativePath(item.cwd))) errors.push(`${label}: cwd must be repository-relative.`);
    if (item?.timeoutMs !== undefined && (!Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 1_000 || item.timeoutMs > RECIPE_MAX_TIMEOUT_MS)) {
      errors.push(`${label}: timeoutMs must be between 1000 and ${RECIPE_MAX_TIMEOUT_MS}.`);
    }
    if (item?.env !== undefined) {
      if (typeof item.env !== "object" || item.env === null || Array.isArray(item.env)) errors.push(`${label}: env must be an object.`);
      else for (const [key, envValue] of Object.entries(item.env)) {
        if (!ENV_NAME.test(key) || FORBIDDEN_ENV.has(key)) errors.push(`${label}: environment variable ${key} is not allowed.`);
        if (typeof envValue !== "string") errors.push(`${label}: environment value for ${key} must be a string.`);
      }
    }
  }
  return errors;
}

/** Placeholder a recipe argument may use for its per-run scratch directory. */
export const RECIPE_TMP_PLACEHOLDER = "{tmp}";

/**
 * Check worker-supplied arguments for one recipe. Arguments are passed as argv
 * (never through a shell); anything that names a path must stay inside the
 * worktree or the run's scratch directory.
 */
export function recipeArgumentErrors(recipe: WorkerRecipe, args: unknown, worktree: string): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return ["args must be an array of strings."];
  const errors: string[] = [];
  if (args.length > recipe.maxArgs) errors.push(`${recipe.name} accepts at most ${recipe.maxArgs} argument(s); got ${args.length}.`);
  for (const arg of args as string[]) {
    if (arg.length > 1_000 || arg.includes("\0")) {
      errors.push("Each argument must be under 1000 characters with no NUL byte.");
      continue;
    }
    const pathLike = arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("../") || arg.includes("/");
    if (!pathLike || arg.startsWith(RECIPE_TMP_PLACEHOLDER)) continue;
    if (arg.startsWith("~")) { errors.push(`Argument ${arg} names a home-directory path; use a worktree path or ${RECIPE_TMP_PLACEHOLDER}.`); continue; }
    // A value like --out=dir/file or a URL-ish string still must not escape.
    const candidate = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) continue;
    const absolute = isAbsolute(candidate) ? candidate : resolve(worktree, recipe.cwd ?? ".", candidate);
    const inside = relative(worktree, absolute);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      errors.push(`Argument ${arg} resolves outside the worktree; use a worktree path or ${RECIPE_TMP_PLACEHOLDER}.`);
    }
  }
  return errors;
}

/**
 * A representative "run the program" recipe for each component whose entry
 * point is a concrete file, derived from the resolved application profile.
 * Nothing is registered when the entry point is ambiguous.
 */
export function smokeRecipes(repoPath: string, resolution: ProfileResolution): WorkerRecipe[] {
  const recipes: WorkerRecipe[] = [];
  for (const component of resolution.components) {
    const entry = component.artifacts.entryPoints.find((path) => {
      const full = join(repoPath, path);
      return existsSync(full) && statSync(full).isFile();
    });
    if (!entry) continue;
    const extension = extname(entry);
    const root = component.root === "." ? "" : `${component.root}/`;
    const local = root && entry.startsWith(root) ? entry.slice(root.length) : entry;
    let command: string[] | null = null;
    if ([".js", ".mjs", ".cjs", ".ts", ".mts"].includes(extension)) command = ["node", local];
    else if (extension === ".py") {
      const runner = component.packageManager === "uv" ? ["uv", "run"] : component.packageManager === "poetry" ? ["poetry", "run"]
        : component.packageManager === "pipenv" ? ["pipenv", "run"] : [];
      command = [...runner, "python3", local];
    }
    if (!command) continue;
    const name = component.root === "." ? "run" : `run-${component.root.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 40);
    if (recipes.some((recipe) => recipe.name === name)) continue;
    recipes.push({
      name,
      description: `Run the ${component.language} program (${entry}) with arguments, to try its behavior. Exploratory only.`,
      command,
      maxArgs: 8,
      ...(component.root === "." ? {} : { cwd: component.root }),
      timeoutMs: RECIPE_DEFAULT_TIMEOUT_MS,
    });
  }
  return recipes;
}
