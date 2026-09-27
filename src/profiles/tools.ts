/**
 * Tool resolution for a specific component root.
 *
 * `spawnSync("tsc", ["--version"])` answers a different question from the one
 * preflight asks. It searches the controller's PATH, so a compiler installed in
 * the main checkout's `node_modules/.bin` reports as present while the task
 * worktree that has to run the check has no `node_modules` at all. Everything
 * here resolves against the directory the check will actually run in, and
 * resolves by inspection only: no candidate is ever executed.
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type ToolSource = "project_local" | "project_module" | "path" | "explicit_path";

export interface ToolResolution {
  tool: string;
  found: boolean;
  source: ToolSource | null;
  path: string | null;
  /** Project-local locations examined, in order, so evidence names them. */
  localCandidates: string[];
  /** True when PATH was searched, so "absent" can be read precisely. */
  searchedPath: boolean;
}

/** Executable-file test that stats and checks the bit; it never runs the file. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where a component installs its own tools, in resolution order. */
export function projectBinDirs(rootPath: string): string[] {
  return [join(rootPath, "node_modules", ".bin"), join(rootPath, ".venv", "bin")];
}

export function resolveTool(rootPath: string, tool: string, pathEnv?: string): ToolResolution {
  const base: ToolResolution = { tool, found: false, source: null, path: null, localCandidates: [], searchedPath: false };
  if (!tool) return base;

  if (isAbsolute(tool) || tool.includes("/")) {
    const candidate = isAbsolute(tool) ? tool : join(rootPath, tool);
    const found = isExecutableFile(candidate);
    return { ...base, found, source: found ? "explicit_path" : null, path: found ? candidate : null, localCandidates: [candidate] };
  }

  const localCandidates = projectBinDirs(rootPath).map((dir) => join(dir, tool));
  for (const candidate of localCandidates) {
    if (isExecutableFile(candidate)) {
      return { ...base, found: true, source: "project_local", path: candidate, localCandidates };
    }
  }

  const search = pathEnv ?? process.env.PATH ?? "";
  for (const dir of search.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, tool);
    if (isExecutableFile(candidate)) {
      return { ...base, found: true, source: "path", path: candidate, localCandidates, searchedPath: true };
    }
  }
  return { ...base, localCandidates, searchedPath: true };
}

/** Locate an installed Python module inside this worktree's virtualenv. */
export function resolveProjectModule(rootPath: string, module: string): ToolResolution {
  const base: ToolResolution = { tool: module, found: false, source: null, path: null, localCandidates: [], searchedPath: false };
  const modulePath = module.replaceAll("-", "_").replaceAll(".", "/");
  const sitePackages: string[] = [join(rootPath, ".venv", "Lib", "site-packages")];
  for (const lib of [join(rootPath, ".venv", "lib"), join(rootPath, ".venv", "lib64")]) {
    if (!existsSync(lib)) continue;
    try {
      for (const entry of readdirSync(lib, { withFileTypes: true })) {
        if (entry.isDirectory() && /^python\d/.test(entry.name)) sitePackages.push(join(lib, entry.name, "site-packages"));
      }
    } catch {
      // An unreadable virtualenv is reported as unresolved evidence by preflight.
    }
  }
  const candidates = sitePackages.flatMap((directory) => [
    join(directory, `${modulePath}.py`),
    join(directory, modulePath, "__init__.py"),
  ]);
  const path = candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
  return {
    ...base,
    found: path !== null,
    source: path ? "project_module" : null,
    path,
    localCandidates: candidates,
  };
}

const SHELL_OPERATOR = /^(?:&&|\|\||;|\||&)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Executables a package script invokes. A check spec's own command is often just
 * `npm run typecheck`, so the package manager resolving proves nothing about the
 * compiler the script goes on to call.
 */
export function scriptTools(script: string): string[] {
  const tools: string[] = [];
  let expectCommand = true;
  for (const token of script.split(/\s+/).filter(Boolean)) {
    if (SHELL_OPERATOR.test(token)) {
      expectCommand = true;
      continue;
    }
    if (!expectCommand) continue;
    if (ENV_ASSIGNMENT.test(token)) continue;
    tools.push(token);
    expectCommand = false;
  }
  return tools;
}

/** Console scripts that a published package installs under a bin directory. */
const BIN_PACKAGES: Record<string, string> = {
  tsc: "typescript",
  tsserver: "typescript",
  tsx: "tsx",
  eslint: "eslint",
  prettier: "prettier",
  vitest: "vitest",
  jest: "jest",
  mocha: "mocha",
  biome: "@biomejs/biome",
  rollup: "rollup",
  vite: "vite",
  webpack: "webpack",
  esbuild: "esbuild",
};

/** Package that provides an executable, when a manifest could declare it. */
export function providingPackage(tool: string): string {
  return BIN_PACKAGES[tool] ?? tool;
}
