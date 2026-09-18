import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { GateSpec } from "../store/records.ts";

/** Propose only commands already declared by the repository. No tools are installed. */
export function discoverChecks(repoPath: string): GateSpec[] {
  const checks: GateSpec[] = [];
  const packagePath = join(repoPath, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const name of ["lint", "typecheck", "test"] as const) {
        if (typeof scripts[name] === "string") {
          checks.push({ name, command: ["npm", "run", name], required: true, timeoutMs: name === "test" ? 15 * 60_000 : 10 * 60_000 });
        }
      }
    } catch {
      // Invalid package metadata is left for explicit onboarding review.
    }
  }

  const hasPytest = ["pyproject.toml", "pytest.ini", "setup.cfg"].some((file) => existsSync(join(repoPath, file)));
  if (hasPytest && existsSync(join(repoPath, "tests"))) {
    checks.push({ name: "pytest", command: ["python3", "-m", "pytest"], required: true, timeoutMs: 15 * 60_000 });
  }
  return checks;
}
