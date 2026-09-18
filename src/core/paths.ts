import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Runtime state lives outside the repository: SQLite is authoritative, and
 * large artifacts are files on disk that task records reference by path.
 */
export function stateDir(): string {
  const explicit = process.env.MABS_STATE_DIR;
  if (explicit) return resolve(explicit);
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "mabs");
}

export function dbPath(): string {
  return process.env.MABS_DB_PATH ? resolve(process.env.MABS_DB_PATH) : join(stateDir(), "mabs.sqlite");
}

/** Per-attempt evidence: worker transcripts, gate output, diffs, context packets. */
export function artifactDir(...parts: string[]): string {
  const dir = join(stateDir(), "artifacts", ...parts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function worktreeRoot(): string {
  return process.env.MABS_WORKTREE_ROOT ? resolve(process.env.MABS_WORKTREE_ROOT) : join(homedir(), "worktrees");
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
