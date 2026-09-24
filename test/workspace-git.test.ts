import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workspaceChangedFiles } from "../src/workspace/git.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("workspaceChangedFiles expands a new untracked directory into its individual files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mabs-workspace-git-"));
  writeFileSync(join(repo, "existing.txt"), "initial\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "initial");
  const baseRevision = git(repo, "rev-parse", "HEAD");

  mkdirSync(join(repo, "plugins", "herdr"), { recursive: true });
  writeFileSync(join(repo, "plugins", "herdr", "README.md"), "docs\n");
  writeFileSync(join(repo, "plugins", "herdr", "config.example.toml"), "id = \"example\"\n");

  const changed = await workspaceChangedFiles(repo, baseRevision);

  // A collapsed "plugins/" entry would falsely fail an allowed-scope check for
  // "plugins/herdr/"; the individual files must be listed instead.
  assert.ok(!changed.includes("plugins/"), `expected no collapsed directory entry, got: ${changed.join(", ")}`);
  assert.ok(changed.includes("plugins/herdr/README.md"), `expected individual file, got: ${changed.join(", ")}`);
  assert.ok(changed.includes("plugins/herdr/config.example.toml"), `expected individual file, got: ${changed.join(", ")}`);
});
