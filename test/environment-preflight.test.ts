import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  inspectWorktreeReadiness,
  preflightWorktree,
  readinessCacheEntry,
  type CheckCapabilityPolicy,
  type WorktreeSnapshot,
} from "../src/environment/index.ts";

function executable(path: string, body = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fixture(t: TestContext, input: { localTsc?: boolean; provider?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mabs-preflight-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(bin);
  const marker = join(root, "launched.txt");
  executable(join(bin, "node"), `#!/bin/sh\nprintf node >> ${JSON.stringify(marker)}\nexit 0\n`);
  executable(join(bin, "npm"), `#!/bin/sh\nprintf npm >> ${JSON.stringify(marker)}\nexit 0\n`);
  if (input.provider !== false) {
    executable(join(bin, "codex"), `#!/bin/sh\nprintf model >> ${JSON.stringify(marker)}\nexit 0\n`);
  }
  if (input.localTsc !== false) {
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    executable(join(repo, "node_modules", ".bin", "tsc"), `#!/bin/sh\nprintf tsc >> ${JSON.stringify(marker)}\nexit 0\n`);
  }
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    packageManager: "npm@11",
    scripts: { typecheck: "tsc --noEmit" },
    devDependencies: { typescript: "1.0.0" },
  }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  writeFileSync(join(repo, "src", "index.ts"), "export const ready = true;\n");
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const snapshot: WorktreeSnapshot = {
    root: repo,
    revision,
    branch: "main",
    dirtyEntries: [],
    integratedRevisions: [revision],
  };
  const policy: CheckCapabilityPolicy = {
    version: "test-policy-v1",
    workerCheckCommands: [],
    controllerCheckRunner: true,
    permissions: { filesystem: "workspace", network: false },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, bin, marker, revision, snapshot, policy, pathEnv: [bin, process.env.PATH ?? ""].join(delimiter) };
}

test("actual-worktree inspection finds project-local check tools without launching them", (t) => {
  const item = fixture(t);
  const result = inspectWorktreeReadiness({
    worktreePath: item.repo,
    worktreeSnapshot: item.snapshot,
    expected: { revision: item.revision, branch: "main", baseRevision: item.revision },
    providerTools: ["codex"],
    capabilityPolicy: item.policy,
    outputPaths: [".mabs/evidence"],
    pathEnv: item.pathEnv,
  });

  assert.equal(result.state, "ready");
  assert.equal(result.revision, item.revision);
  assert.equal(result.setupPlan.executesAutomatically, false);
  assert.equal(result.setupPlan.requiresAuthorization, true);
  assert.equal(result.components[0]?.state, "ready");
  assert.ok(result.evidence.some((item) => item.kind === "tool" && item.summary.includes("tsc is available")));
  assert.equal(existsSync(item.marker), false,
    "preflight must not invoke runtimes, package managers, checks, or provider/model CLIs");
});

test("missing project-local tsc requests authorized setup and never becomes a code failure", (t) => {
  const item = fixture(t, { localTsc: false });
  const result = inspectWorktreeReadiness({
    worktreePath: item.repo,
    worktreeSnapshot: item.snapshot,
    expected: { revision: item.revision, branch: "main" },
    capabilityPolicy: item.policy,
    pathEnv: item.pathEnv,
  });

  assert.equal(result.state, "setup_required");
  assert.deepEqual(result.components[0]?.missingTools, ["tsc"]);
  assert.ok(result.setupPlan.actions.some((action) => action.command.join(" ") === "npm ci"));
  assert.equal(result.setupPlan.executesAutomatically, false);
  assert.equal(existsSync(item.marker), false);
});

test("a missing provider executable and missing check authority are explicit unavailable evidence", (t) => {
  const item = fixture(t, { provider: false });
  const result = inspectWorktreeReadiness({
    worktreePath: item.repo,
    worktreeSnapshot: item.snapshot,
    providerTools: ["claude"],
    capabilityPolicy: { ...item.policy, controllerCheckRunner: false },
    pathEnv: item.bin,
  });

  assert.equal(result.state, "unavailable");
  assert.ok(result.evidence.some((entry) => entry.kind === "provider" && entry.status === "fail"));
  assert.ok(result.evidence.some((entry) => entry.kind === "capability" && entry.status === "fail"));
});

test("explicit filesystem policy denial is evidence and never expands permissions", (t) => {
  const item = fixture(t);
  const result = inspectWorktreeReadiness({
    worktreePath: item.repo,
    worktreeSnapshot: item.snapshot,
    capabilityPolicy: {
      ...item.policy,
      permissions: { worktreeRead: true, outputWrite: false },
    },
    outputPaths: [".mabs/evidence"],
    pathEnv: item.pathEnv,
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.evidence.some((entry) => entry.summary.includes("denies evidence/output writes")));
  assert.equal(existsSync(join(item.repo, ".mabs")), false, "inspection must not create the denied output path");
});

test("Python module readiness is inspected inside the actual worktree virtualenv", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mabs-python-preflight-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "tests"), { recursive: true });
  mkdirSync(bin);
  executable(join(bin, "python3"));
  writeFileSync(join(repo, "pyproject.toml"), "[project]\nname='sample'\nversion='1.0'\n[tool.pytest.ini_options]\n");
  writeFileSync(join(repo, "tests", "test_sample.py"), "def test_sample(): assert True\n");
  const snapshot: WorktreeSnapshot = {
    root: repo, revision: "python-revision", branch: "main", dirtyEntries: [], integratedRevisions: [],
  };
  const input = {
    worktreePath: repo,
    worktreeSnapshot: snapshot,
    capabilityPolicy: { version: "python-policy", workerCheckCommands: [], controllerCheckRunner: true },
    pathEnv: bin,
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missing = inspectWorktreeReadiness(input);
  assert.equal(missing.state, "setup_required");
  assert.ok(missing.components[0]?.missingTools.includes("pytest"));

  const module = join(repo, ".venv", "lib", "python3.12", "site-packages", "pytest");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "__init__.py"), "__version__ = 'test'\n");
  const ready = inspectWorktreeReadiness(input);
  assert.equal(ready.state, "ready");
  assert.ok(ready.evidence.some((entry) => entry.summary.includes("pytest is available")));
});

test("readiness cache fingerprints invalidate for lockfile, executable, check, and policy changes", (t) => {
  const item = fixture(t);
  const input = {
    worktreePath: item.repo,
    worktreeSnapshot: item.snapshot,
    capabilityPolicy: item.policy,
    providerTools: ["codex"],
    pathEnv: item.pathEnv,
  };
  const first = preflightWorktree(input);
  const cached = readinessCacheEntry(first);
  assert.equal(preflightWorktree(input, cached).cacheHit, true);

  const changedPolicy = preflightWorktree({
    ...input,
    capabilityPolicy: { ...item.policy, permissions: { filesystem: "read-only", network: false } },
  }, cached);
  assert.equal(changedPolicy.cacheHit, false);
  assert.notEqual(changedPolicy.fingerprint, first.fingerprint);

  executable(join(item.bin, "codex"), "#!/bin/sh\nexit 7\n");
  const changedRuntime = preflightWorktree(input, cached);
  assert.equal(changedRuntime.cacheHit, false);
  assert.notEqual(changedRuntime.fingerprint, first.fingerprint);

  writeFileSync(join(item.repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { changed: {} } }));
  const changedLock = preflightWorktree(input, cached);
  assert.equal(changedLock.cacheHit, false);
  assert.notEqual(changedLock.fingerprint, first.fingerprint);

  writeFileSync(join(item.repo, "package.json"), JSON.stringify({
    packageManager: "npm@11",
    scripts: { typecheck: "tsc --pretty false --noEmit" },
    devDependencies: { typescript: "1.0.0" },
  }));
  const changedCheck = preflightWorktree(input, cached);
  assert.equal(changedCheck.cacheHit, false);
  assert.notEqual(changedCheck.fingerprint, first.fingerprint);
});

test("pinned identity, dependency integration, and dirty state are evidenced", (t) => {
  const item = fixture(t);
  writeFileSync(join(item.repo, "src", "index.ts"), "export const ready = false;\n");
  const result = inspectWorktreeReadiness({
    worktreePath: item.repo,
    worktreeSnapshot: { ...item.snapshot, dirtyEntries: [" M src/index.ts"] },
    expected: { revision: "not-the-current-revision", branch: "other", dependencyRevisions: [item.revision] },
    capabilityPolicy: item.policy,
    pathEnv: item.pathEnv,
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.evidence.some((entry) => entry.summary.includes("pinned revision")));
  assert.ok(result.evidence.some((entry) => entry.summary.includes("unexpected changes")));
  assert.ok(result.evidence.some((entry) => entry.summary.includes("is integrated")));
});

test("a missing worktree returns structured unavailable evidence instead of throwing", (t) => {
  const item = fixture(t);
  const missing = join(item.root, "does-not-exist");
  const result = inspectWorktreeReadiness({ worktreePath: missing, capabilityPolicy: item.policy });
  assert.equal(result.state, "unavailable");
  assert.equal(result.worktreePath, missing);
  assert.equal(result.evidence[0]?.kind, "worktree");
  assert.equal(result.evidence[0]?.status, "fail");
});
