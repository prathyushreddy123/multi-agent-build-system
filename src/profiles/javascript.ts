import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import type { GateSpec } from "../store/records.ts";
import { checkName, findNamedFiles, relativeRoot } from "./files.ts";
import type { ApplicationProfile, ComponentProfile, EnvironmentPlan, PackageManager, ProfileSelection, ScaffoldResult } from "./types.ts";

const VERSION = "javascript-typescript-profile-v1";
const JS_MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

function parsePackage(path: string): PackageJson | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as PackageJson; } catch { return null; }
}

function executable(name: string): boolean {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
}

function managerFor(rootPath: string, pkg: PackageJson): { manager: PackageManager; lockfile: string | null; evidence: string[] } {
  const declared = pkg.packageManager?.split("@")[0];
  const declaredManager = JS_MANAGERS.includes(declared as PackageManager) ? declared as PackageManager : null;
  const locks: [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"],
  ];
  const lock = locks.find(([name]) => existsSync(join(rootPath, name)));
  const manager = lock?.[1] ?? declaredManager ?? "npm";
  return {
    manager,
    lockfile: lock?.[0] ?? null,
    evidence: [...(lock ? [lock[0]] : []), ...(declaredManager ? [`packageManager=${pkg.packageManager}`] : [])],
  };
}

function runScript(manager: PackageManager, name: string): string[] {
  if (manager === "npm") return ["npm", "run", name];
  if (manager === "pnpm") return ["pnpm", "run", name];
  if (manager === "yarn") return ["yarn", name];
  return ["bun", "run", name];
}

function environment(rootPath: string, manager: PackageManager, runtimeVersion: string | null, hasLock: boolean, hasDependencies: boolean): EnvironmentPlan {
  const install = manager === "npm"
    ? ["npm", hasLock ? "ci" : "install"]
    : manager === "pnpm"
      ? ["pnpm", "install", ...(hasLock ? ["--frozen-lockfile"] : [])]
      : manager === "yarn"
        ? ["yarn", "install", ...(hasLock ? ["--immutable"] : [])]
        : ["bun", "install", ...(hasLock ? ["--frozen-lockfile"] : [])];
  const missing = [
    ...(executable("node") ? [] : ["node is required but was not found on PATH."]),
    ...(executable(manager) ? [] : [`${manager} is selected but was not found on PATH.`]),
    ...(hasDependencies && !existsSync(join(rootPath, "node_modules"))
      ? [`Package dependencies are not installed; run: ${install.join(" ")}.`]
      : []),
  ];
  return {
    runtime: `node${runtimeVersion ? ` ${runtimeVersion}` : ""}`,
    versionFile: [".node-version", ".nvmrc"].find((name) => existsSync(join(rootPath, name))) ?? null,
    setupCommands: [install],
    missingPrerequisites: missing,
    notes: ["Setup commands are instructions only; bootstrap does not install packages or modify global runtimes."],
  };
}

function component(repoPath: string, manifest: string): ComponentProfile | null {
  const root = relativeRoot(manifest);
  const rootPath = root === "." ? repoPath : join(repoPath, root);
  const pkg = parsePackage(join(repoPath, manifest));
  if (!pkg) return null;
  const managed = managerFor(rootPath, pkg);
  const versionFile = [".node-version", ".nvmrc"].map((name) => readVersion(join(rootPath, name))).find(Boolean) ?? null;
  const runtimeVersion = versionFile || pkg.engines?.node || null;
  const hasDependencies = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).length > 0;
  const env = environment(rootPath, managed.manager, runtimeVersion, managed.lockfile !== null, hasDependencies);
  const cwd = root === "." ? undefined : root;
  const checks: GateSpec[] = [];
  for (const name of ["format", "lint", "typecheck", "test", "build"] as const) {
    if (typeof pkg.scripts?.[name] !== "string" || !pkg.scripts[name]?.trim()) continue;
    checks.push({
      name: checkName(root, name),
      command: runScript(managed.manager, name),
      required: true,
      timeoutMs: name === "test" || name === "build" ? 15 * 60_000 : 10 * 60_000,
      ...(cwd ? { cwd } : {}),
    });
  }
  const typescript = existsSync(join(rootPath, "tsconfig.json")) || Boolean(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
  return {
    kind: "javascript-typescript",
    version: VERSION,
    root,
    language: typescript ? "TypeScript" : "JavaScript",
    manifest,
    runtimeVersion,
    packageManager: managed.manager,
    lockfile: managed.lockfile ? (root === "." ? managed.lockfile : `${root}/${managed.lockfile}`) : null,
    evidence: [manifest, ...managed.evidence, ...(typescript ? ["TypeScript manifest evidence"] : [])],
    environment: env,
    checks,
    artifacts: {
      entryPoints: [root === "." ? (typescript ? "src/cli.ts" : "src/cli.js") : `${root}/${typescript ? "src/cli.ts" : "src/cli.js"}`],
      buildOutputs: pkg.scripts?.build ? [root === "." ? "dist/" : `${root}/dist/`] : [],
      reports: [root === "." ? "coverage/" : `${root}/coverage/`],
      development: [env.setupCommands[0]?.join(" ") ?? "", ...Object.keys(pkg.scripts ?? {}).map((name) => `${managed.manager} ${managed.manager === "npm" || managed.manager === "pnpm" || managed.manager === "bun" ? "run " : ""}${name}`)].filter(Boolean),
    },
  };
}

function readVersion(path: string): string | null {
  try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
}

function writeMissing(path: string, content: string, files: string[], repoPath: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  files.push(path.slice(repoPath.length + 1).replaceAll("\\", "/"));
}

function packageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "mabs-app";
}

export const javascriptProfile: ApplicationProfile = {
  kind: "javascript-typescript",
  version: VERSION,
  detect(repoPath) {
    return findNamedFiles(repoPath, ["package.json"])
      .map((manifest) => component(repoPath, manifest))
      .filter((item): item is ComponentProfile => item !== null);
  },
  scaffold(repoPath: string, name: string, selection: ProfileSelection): ScaffoldResult {
    if (selection.packageManager && !JS_MANAGERS.includes(selection.packageManager)) {
      throw new Error(`Package manager ${selection.packageManager} is not valid for the JavaScript/TypeScript profile.`);
    }
    const manager = selection.packageManager ?? "npm";
    const typescript = /typescript|\bts\b/i.test(selection.language ?? "");
    const runtime = selection.runtime?.match(/\d+(?:\.\d+){0,2}/)?.[0] ?? "22";
    const extension = typescript ? "ts" : "js";
    const scripts: Record<string, string> = typescript
      ? { start: "node src/cli.ts", build: "tsc -p tsconfig.json", typecheck: "tsc --noEmit", test: "node --test test/*.test.ts" }
      : { start: "node src/cli.js", typecheck: "node --check src/cli.js", test: "node --test" };
    const pkg: PackageJson & { private: boolean; type: string } = {
      name: packageName(name), private: true, type: "module",
      packageManager: `${manager}@${manager === "npm" ? "10" : manager === "pnpm" ? "9" : manager === "yarn" ? "4" : "1"}`,
      engines: { node: `>=${runtime}` },
      scripts,
      ...(typescript ? { devDependencies: { "@types/node": "^22.0.0", typescript: "^5.7.0" } } : {}),
    };
    const files: string[] = [];
    writeMissing(join(repoPath, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, files, repoPath);
    writeMissing(join(repoPath, ".node-version"), `${runtime}\n`, files, repoPath);
    if (typescript) {
      writeMissing(join(repoPath, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist", rootDir: "." }, include: ["src/**/*.ts", "test/**/*.ts"] }, null, 2)}\n`, files, repoPath);
    }
    writeMissing(join(repoPath, "src", `cli.${extension}`), `export function main()${typescript ? ": number" : ""} {\n  console.log("${name} is ready");\n  return 0;\n}\n\nif (import.meta.url === \`file://\${process.argv[1]}\`) process.exitCode = main();\n`, files, repoPath);
    writeMissing(join(repoPath, "test", `cli.test.${extension}`), `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { main } from "../src/cli.${extension}";\n\ntest("starter runs", () => assert.equal(main(), 0));\n`, files, repoPath);
    writeMissing(join(repoPath, ".gitignore"), "node_modules/\ndist/\ncoverage/\n", files, repoPath);
    writeMissing(join(repoPath, "README.md"), `# ${name}\n\nLocal ${typescript ? "TypeScript" : "JavaScript"} application.\n\n## Development\n\n\`\`\`sh\n${manager === "npm" ? "npm install" : `${manager} install`}\n${manager === "npm" ? "npm test" : `${manager} test`}\n\`\`\`\n`, files, repoPath);
    return { kind: "javascript-typescript", files, environment: environment(repoPath, manager, runtime, false, typescript) };
  },
};
