/**
 * The runtime a live experiment is authorized under.
 *
 * A comparison is only fair if baseline and candidate ran on the same
 * controller code, capability registry and entitlement evidence, provider
 * CLIs, and Node. Each is fingerprinted into the run manifest, which is
 * re-derived before every trial launch, so drift stops the run instead of
 * silently confounding it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { loadCapabilityRegistry } from "../routing/capabilities.ts";

export interface RuntimeFingerprint {
  /** The MABS checkout's commit, and whether it has uncommitted changes. */
  engine: { revision: string | null; dirty: boolean | null };
  /** Registry entries plus the entitlement proofs overlaid on them. */
  capabilityRegistry: string;
  cli: { claude: string | null; codex: string | null };
  node: string;
  /** MABS's own dependency lockfile. */
  lockfile: string | null;
}

const ENGINE_ROOT = resolve(import.meta.dirname, "..", "..");

function sha(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", ENGINE_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The executable a bare command resolves to on PATH, if any. */
function onPath(command: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, command);
    if (directory && existsSync(candidate)) return candidate;
  }
  return null;
}

// `--version` is re-run only when the resolved executable changes, so the
// fingerprint stays cheap enough to check before every launch.
const versions = new Map<string, { key: string; version: string | null }>();

function cliVersion(command: "claude" | "codex"): string | null {
  const path = onPath(command);
  if (!path) return null;
  let key: string;
  try {
    const stat = statSync(path);
    key = `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const cached = versions.get(command);
  if (cached?.key === key) return cached.version;
  let version: string | null = null;
  try {
    version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] ?? null;
  } catch {
    version = null;
  }
  versions.set(command, { key, version });
  return version;
}

export function runtimeFingerprint(): RuntimeFingerprint {
  const status = git("status", "--porcelain", "--untracked-files=no");
  const lockfile = join(ENGINE_ROOT, "package-lock.json");
  return {
    engine: { revision: git("rev-parse", "HEAD"), dirty: status === null ? null : status.length > 0 },
    capabilityRegistry: sha(JSON.stringify(loadCapabilityRegistry())),
    cli: { claude: cliVersion("claude"), codex: cliVersion("codex") },
    node: process.version,
    lockfile: existsSync(lockfile) ? sha(readFileSync(lockfile)) : null,
  };
}
