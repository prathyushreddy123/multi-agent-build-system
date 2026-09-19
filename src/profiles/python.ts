import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import type { GateSpec } from "../store/records.ts";
import { checkName, findNamedFiles, relativeRoot } from "./files.ts";
import type { ApplicationProfile, ComponentProfile, EnvironmentPlan, PackageManager, ProfileSelection, ScaffoldResult } from "./types.ts";

const VERSION = "python-profile-v1";

function read(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function executable(name: string): boolean {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
}

function pythonManager(root: string, manifestText: string): { manager: PackageManager; lockfile: string | null } {
  if (existsSync(join(root, "uv.lock"))) return { manager: "uv", lockfile: "uv.lock" };
  if (existsSync(join(root, "poetry.lock"))) return { manager: "poetry", lockfile: "poetry.lock" };
  if (existsSync(join(root, "Pipfile.lock"))) return { manager: "pipenv", lockfile: "Pipfile.lock" };
  if (/\[tool\.uv\]/.test(manifestText)) return { manager: "uv", lockfile: null };
  if (/\[tool\.poetry\]/.test(manifestText)) return { manager: "poetry", lockfile: null };
  return { manager: "python", lockfile: null };
}

function runner(manager: PackageManager, command: string[]): string[] {
  if (manager === "uv") return ["uv", "run", ...command];
  if (manager === "poetry") return ["poetry", "run", ...command];
  if (manager === "pipenv") return ["pipenv", "run", ...command];
  return command;
}

function environment(rootPath: string, manager: PackageManager, runtimeVersion: string | null): EnvironmentPlan {
  const setupCommands: string[][] = [];
  if (manager === "uv") setupCommands.push(["uv", "sync"]);
  else if (manager === "poetry") setupCommands.push(["poetry", "install"]);
  else if (manager === "pipenv") setupCommands.push(["pipenv", "sync", "--dev"]);
  else {
    setupCommands.push(["python3", "-m", "venv", ".venv"]);
    if (existsSync(join(rootPath, "requirements.txt"))) setupCommands.push([".venv/bin/python", "-m", "pip", "install", "-r", "requirements.txt"]);
    else setupCommands.push([".venv/bin/python", "-m", "pip", "install", "-e", ".[dev]"]);
  }
  const tool = manager === "python" ? "python3" : manager;
  return {
    runtime: `python${runtimeVersion ? ` ${runtimeVersion}` : ""}`,
    versionFile: existsSync(join(rootPath, ".python-version")) ? ".python-version" : null,
    setupCommands,
    missingPrerequisites: executable(tool) ? [] : [`${tool} is required but was not found on PATH.`],
    notes: ["Setup commands are instructions only; bootstrap never modifies a shared global Python environment."],
  };
}

function checksFor(rootPath: string, root: string, manifestText: string, manager: PackageManager): GateSpec[] {
  const checks: GateSpec[] = [];
  const cwd = root === "." ? undefined : root;
  const testsPath = join(rootPath, "tests");
  const add = (name: string, command: string[], timeoutMs = 10 * 60_000) =>
    checks.push({ name: checkName(root, name), command: runner(manager, command), required: true, timeoutMs, ...(cwd ? { cwd } : {}) });

  const pytestConfigured = /\[tool\.pytest(?:\.ini_options)?\]/.test(manifestText) ||
    existsSync(join(rootPath, "pytest.ini")) || /\[pytest\]/.test(read(join(rootPath, "setup.cfg")));
  if (existsSync(testsPath)) {
    if (pytestConfigured) add("test", ["python3", "-m", "pytest"], 15 * 60_000);
    else add("test", ["python3", "-m", "unittest", "discover", "-s", "tests"], 15 * 60_000);
  }
  const ruffConfigured = /\[tool\.ruff(?:\.|\])/.test(manifestText) || existsSync(join(rootPath, "ruff.toml"));
  if (ruffConfigured) {
    add("format", ["ruff", "format", "--check", "."]);
    add("lint", ["ruff", "check", "."]);
  }
  const mypyConfigured = /\[tool\.mypy\]/.test(manifestText) || existsSync(join(rootPath, "mypy.ini"));
  if (mypyConfigured) add("typecheck", ["python3", "-m", "mypy", "."]);
  if (/\[build-system\]/.test(manifestText)) add("build", ["python3", "-m", "build"], 15 * 60_000);
  // Syntax compilation is deterministic and requires no third-party package.
  if (!checks.some((check) => check.name === checkName(root, "typecheck"))) {
    add("compile", ["python3", "-m", "compileall", "-q", "."]);
  }
  return checks;
}

function component(repoPath: string, manifest: string): ComponentProfile {
  const root = relativeRoot(manifest);
  const rootPath = root === "." ? repoPath : join(repoPath, root);
  const manifestText = read(join(repoPath, manifest));
  const managed = pythonManager(rootPath, manifestText);
  const versionFile = read(join(rootPath, ".python-version")).trim();
  const requires = manifestText.match(/requires-python\s*=\s*["']([^"']+)/)?.[1] ?? null;
  const runtimeVersion = versionFile || requires;
  const env = environment(rootPath, managed.manager, runtimeVersion);
  const srcRoot = existsSync(join(rootPath, "src")) ? "src" : ".";
  const detectedEntries = findNamedFiles(rootPath, ["cli.py"], 3).map((path) => root === "." ? path : `${root}/${path}`);
  return {
    kind: "python",
    version: VERSION,
    root,
    language: "Python",
    manifest,
    runtimeVersion,
    packageManager: managed.manager,
    lockfile: managed.lockfile ? (root === "." ? managed.lockfile : `${root}/${managed.lockfile}`) : null,
    evidence: [manifest, ...(managed.lockfile ? [managed.lockfile] : []), ...(versionFile ? [".python-version"] : [])],
    environment: env,
    checks: checksFor(rootPath, root, manifestText, managed.manager),
    artifacts: {
      entryPoints: detectedEntries.length > 0 ? detectedEntries : [root === "." ? srcRoot : `${root}/${srcRoot}`],
      buildOutputs: [root === "." ? "dist/" : `${root}/dist/`],
      reports: [root === "." ? ".pytest_cache/" : `${root}/.pytest_cache/`],
      development: env.setupCommands.map((command) => command.join(" ")),
    },
  };
}

function writeMissing(path: string, content: string, files: string[], repoPath: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  files.push(path.slice(repoPath.length + 1).replaceAll("\\", "/"));
}

function slug(name: string): string {
  const value = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return value || "app";
}

export const pythonProfile: ApplicationProfile = {
  kind: "python",
  version: VERSION,
  detect(repoPath) {
    return findNamedFiles(repoPath, ["pyproject.toml", "setup.py", "requirements.txt"])
      .filter((manifest, index, all) => all.findIndex((candidate) => relativeRoot(candidate) === relativeRoot(manifest)) === index)
      .map((manifest) => component(repoPath, manifest));
  },
  scaffold(repoPath: string, name: string, selection: ProfileSelection): ScaffoldResult {
    if (selection.packageManager && !["python", "uv", "poetry", "pipenv"].includes(selection.packageManager)) {
      throw new Error(`Package manager ${selection.packageManager} is not valid for the Python profile.`);
    }
    const manager = selection.packageManager ?? "python";
    const module = slug(name);
    const runtime = selection.runtime?.match(/\d+(?:\.\d+){0,2}/)?.[0] ?? "3.11";
    const files: string[] = [];
    const managerSection = manager === "uv" ? "\n[tool.uv]\ndev-dependencies = []\n" : manager === "poetry" ? "\n[tool.poetry]\npackage-mode = false\n" : "";
    writeMissing(join(repoPath, "pyproject.toml"), `[project]\nname = "${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}"\nversion = "0.1.0"\nrequires-python = ">=${runtime}"\ndependencies = []\n${managerSection}`, files, repoPath);
    writeMissing(join(repoPath, ".python-version"), `${runtime}\n`, files, repoPath);
    writeMissing(join(repoPath, "src", module, "__init__.py"), "", files, repoPath);
    writeMissing(join(repoPath, "src", module, "cli.py"), `"""Local command-line entry point."""\n\ndef main() -> int:\n    print("${name} is ready")\n    return 0\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n`, files, repoPath);
    writeMissing(join(repoPath, "tests", "test_cli.py"), `import sys\nimport unittest\nfrom pathlib import Path\n\nsys.path.insert(0, str(Path(__file__).parents[1] / "src"))\nfrom ${module}.cli import main\n\nclass CliTest(unittest.TestCase):\n    def test_main(self):\n        self.assertEqual(main(), 0)\n\nif __name__ == "__main__":\n    unittest.main()\n`, files, repoPath);
    writeMissing(join(repoPath, ".gitignore"), ".venv/\n__pycache__/\n*.pyc\ndist/\nbuild/\n", files, repoPath);
    writeMissing(join(repoPath, "README.md"), `# ${name}\n\nLocal Python application.\n\n## Development\n\nCreate an isolated environment, then run:\n\n\`\`\`sh\npython3 -m unittest discover -s tests\npython3 src/${module}/cli.py\n\`\`\`\n`, files, repoPath);
    const env = environment(repoPath, manager, runtime);
    return { kind: "python", files, environment: env };
  },
};
