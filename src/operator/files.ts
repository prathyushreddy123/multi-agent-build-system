/**
 * Phase 2 — paths, revisions, and changed files.
 *
 * Path resolution is the safety boundary of the Code surface. Everything here
 * canonicalizes against the roots the selected context allows and refuses
 * anything that escapes them. Arguments are always passed to git as arrays, so
 * a filename is never interpolated into a shell command, and `--` separates
 * options from paths so a leading hyphen cannot be read as a flag.
 */
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { exec } from "../core/exec.ts";
import type { TaskContext } from "./context.ts";

export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export type ChangeCategory = "committed" | "staged" | "unstaged" | "untracked";

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface ChangedFile {
  /** Current path. For a rename this is the new path. */
  path: string;
  /** Previous path for a rename or copy, otherwise null. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Every category this path appears in. A path is listed once. */
  categories: ChangeCategory[];
  binary: boolean;
  /** Present in the worktree right now. Deleted files are not. */
  present: boolean;
  sizeBytes: number | null;
  oversize: boolean;
}

export interface ResolvedFile {
  /** Path relative to the worktree root, always forward-slashed. */
  relativePath: string;
  /** Canonical absolute path, or null when read from a revision. */
  absolutePath: string | null;
  /** Root the path was validated against. */
  root: string;
  line: number | null;
  /** Revision to read from, when not reading the live file. */
  revision: string | null;
}

export class FileResolutionError extends Error {}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Turn a user-supplied path into a path inside the selected worktree.
 *
 * Rejected: absolute paths outside the root, traversal, and any URI scheme.
 * `file:` is not accepted here either: the caller decodes links in links.ts and
 * passes a plain path, so this function has one input shape.
 */
export function resolveWorktreePath(root: string, requested: string): { relativePath: string; absolutePath: string } {
  const raw = requested.trim();
  if (raw === "") throw new FileResolutionError("A file path is required");
  if (SCHEME.test(raw) && !isAbsolute(raw)) {
    throw new FileResolutionError(`Refusing to open ${raw}: only plain paths inside the selected worktree are accepted`);
  }
  if (raw.includes("\0")) throw new FileResolutionError("A file path may not contain a null byte");

  const canonicalRoot = resolve(root);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(canonicalRoot, raw);
  const inside = absolute === canonicalRoot || absolute.startsWith(canonicalRoot + sep);
  if (!inside) {
    throw new FileResolutionError(`${requested} resolves outside the selected worktree ${canonicalRoot}`);
  }

  // A symlink may point anywhere. Reading through one that leaves the worktree
  // would silently show a different task's or the base checkout's content.
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // The path may not exist yet; containment of the literal path already held.
  }
  let canonicalRootReal = canonicalRoot;
  try {
    canonicalRootReal = realpathSync(canonicalRoot);
  } catch {
    // The root itself is missing; the caller reports the worktree as unavailable.
  }
  if (canonical !== canonicalRootReal && !canonical.startsWith(canonicalRootReal + sep)) {
    throw new FileResolutionError(`${requested} is a link that leaves the selected worktree ${canonicalRoot}`);
  }

  return {
    relativePath: normalizeSeparators(relative(canonicalRootReal, canonical)) || ".",
    absolutePath: canonical,
  };
}

/**
 * Resolve a file for the given context.
 *
 * When the worktree is gone the path is validated structurally and bound to the
 * recorded revision instead, so a removed worktree can never fall back to the
 * base checkout.
 */
export function resolveFile(
  context: TaskContext,
  requested: string,
  options: { line?: number | null; revision?: string | null } = {},
): ResolvedFile {
  const line = options.line === undefined || options.line === null ? null : Number(options.line);
  if (line !== null && (!Number.isSafeInteger(line) || line < 1)) {
    throw new FileResolutionError("--line must be a positive integer");
  }

  if (context.worktreeAvailable && context.worktreePath) {
    const { relativePath, absolutePath } = resolveWorktreePath(context.worktreePath, requested);
    return {
      relativePath,
      absolutePath: options.revision ? null : absolutePath,
      root: resolve(context.worktreePath),
      line,
      revision: options.revision ?? null,
    };
  }

  const revision = options.revision ?? context.resultRevision;
  if (!revision) {
    throw new FileResolutionError(
      context.viewReason ?? "No worktree and no recorded revision are available for this task.",
    );
  }
  // Structural validation only: there is no directory to canonicalize against.
  const raw = normalizeSeparators(requested.trim());
  if (raw === "" || raw.startsWith("/") || raw.split("/").includes("..")) {
    throw new FileResolutionError(`${requested} is not a repository-relative path`);
  }
  return { relativePath: raw, absolutePath: null, root: context.repoPath, line, revision };
}

// --------------------------------------------------------------------------
// git helpers
// --------------------------------------------------------------------------

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const result = await exec("git", ["--no-pager", ...args], { cwd, timeoutMs });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((entry) => entry !== "");
}

function toStatus(code: string): ChangeStatus {
  switch (code[0]) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

/** Parse `git diff --name-status -z -M` output, which is not line oriented. */
function parseNameStatus(output: string): { status: ChangeStatus; path: string; oldPath: string | null }[] {
  const fields = splitNul(output);
  const entries: { status: ChangeStatus; path: string; oldPath: string | null }[] = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index] as string;
    index += 1;
    const status = toStatus(code);
    if (status === "renamed" || status === "copied") {
      const oldPath = fields[index] as string | undefined;
      const newPath = fields[index + 1] as string | undefined;
      index += 2;
      if (oldPath === undefined || newPath === undefined) break;
      entries.push({ status, path: newPath, oldPath });
      continue;
    }
    const path = fields[index] as string | undefined;
    index += 1;
    if (path === undefined) break;
    entries.push({ status, path, oldPath: null });
  }
  return entries;
}

/** Parse `git diff --numstat -z -M`; binary files report "-" for both counts. */
function parseNumstat(output: string): Map<string, boolean> {
  const fields = splitNul(output);
  const binary = new Map<string, boolean>();
  for (let index = 0; index < fields.length; ) {
    const head = fields[index] as string;
    index += 1;
    const parts = head.split("\t");
    const isBinary = parts[0] === "-" && parts[1] === "-";
    if (parts.length >= 3 && parts[2] !== "") {
      binary.set(parts[2] as string, isBinary);
      continue;
    }
    // Rename form: counts, then old path, then new path, each NUL separated.
    const oldPath = fields[index] as string | undefined;
    const newPath = fields[index + 1] as string | undefined;
    index += 2;
    if (newPath !== undefined) binary.set(newPath, isBinary);
    if (oldPath !== undefined) binary.set(oldPath, isBinary);
  }
  return binary;
}

function fileFacts(root: string | null, path: string): { present: boolean; sizeBytes: number | null } {
  if (!root) return { present: false, sizeBytes: null };
  try {
    const stats = statSync(join(root, path));
    return { present: stats.isFile(), sizeBytes: stats.size };
  } catch {
    return { present: false, sizeBytes: null };
  }
}

// --------------------------------------------------------------------------
// listings
// --------------------------------------------------------------------------

/** Every file in the task worktree: tracked plus untracked, ignoring ignored paths. */
export async function listAllFiles(context: TaskContext): Promise<string[]> {
  if (!context.worktreeAvailable || !context.worktreePath) {
    if (!context.resultRevision) throw new Error(context.viewReason ?? "No content is available for this task.");
    const listing = await git(context.repoPath, ["ls-tree", "-r", "--name-only", "-z", context.resultRevision]);
    return splitNul(listing).sort();
  }
  const tracked = await git(context.worktreePath, ["ls-files", "-z"]);
  const untracked = await git(context.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...splitNul(tracked), ...splitNul(untracked)])].sort();
}

/**
 * Changed files for this task, one entry per path.
 *
 * Committed work is measured against the recorded base revision, not against
 * the project's current branch tip, so a task's changes stay stable while other
 * work lands.
 */
export async function listChangedFiles(context: TaskContext): Promise<ChangedFile[]> {
  const merged = new Map<string, ChangedFile>();
  const root = context.worktreeAvailable ? context.worktreePath : null;

  const add = (
    entry: { status: ChangeStatus; path: string; oldPath: string | null },
    category: ChangeCategory,
    binary: boolean,
  ) => {
    const existing = merged.get(entry.path);
    if (existing) {
      if (!existing.categories.includes(category)) existing.categories.push(category);
      // A later category refines the status only when the earlier one said nothing.
      if (existing.status === "unknown") existing.status = entry.status;
      if (!existing.oldPath && entry.oldPath) existing.oldPath = entry.oldPath;
      existing.binary = existing.binary || binary;
      return;
    }
    const facts = fileFacts(root, entry.path);
    merged.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      categories: [category],
      binary,
      present: facts.present,
      sizeBytes: facts.sizeBytes,
      oversize: facts.sizeBytes !== null && facts.sizeBytes > MAX_INLINE_BYTES,
    });
  };

  const collect = async (cwd: string, args: string[], category: ChangeCategory) => {
    const nameStatus = parseNameStatus(await git(cwd, ["diff", "--no-ext-diff", "--name-status", "-M", "-z", ...args]));
    const binary = parseNumstat(await git(cwd, ["diff", "--no-ext-diff", "--numstat", "-M", "-z", ...args]));
    for (const entry of nameStatus) add(entry, category, binary.get(entry.path) === true);
  };

  if (context.baseRevision) {
    const cwd = root ?? context.repoPath;
    const head = root ? "HEAD" : context.resultRevision;
    if (head) await collect(cwd, [`${context.baseRevision}...${head}`], "committed");
  }

  if (root) {
    await collect(root, ["--cached"], "staged");
    await collect(root, [], "unstaged");
    for (const path of splitNul(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
      add({ status: "added", path, oldPath: null }, "untracked", false);
    }
  }

  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export interface FileContent {
  relativePath: string;
  /** Null when the content could not be produced. */
  text: string | null;
  source: "worktree" | "revision";
  revision: string | null;
  binary: boolean;
  sizeBytes: number | null;
  truncated: boolean;
  /** Set when text is null: why, in plain language. */
  unavailableReason: string | null;
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8000);
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

/** Read one file from the live worktree or from a recorded revision. */
export async function readFileForContext(
  context: TaskContext,
  target: ResolvedFile,
  options: { maxBytes?: number } = {},
): Promise<FileContent> {
  const maxBytes = options.maxBytes ?? MAX_INLINE_BYTES;

  if (target.absolutePath && !target.revision) {
    let bytes: Buffer;
    try {
      bytes = await readFile(target.absolutePath);
    } catch (error) {
      return {
        relativePath: target.relativePath, text: null, source: "worktree", revision: null,
        binary: false, sizeBytes: null, truncated: false,
        unavailableReason: `Cannot read ${target.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const binary = looksBinary(bytes);
    return {
      relativePath: target.relativePath,
      text: binary ? null : bytes.subarray(0, maxBytes).toString("utf8"),
      source: "worktree",
      revision: null,
      binary,
      sizeBytes: bytes.byteLength,
      truncated: !binary && bytes.byteLength > maxBytes,
      unavailableReason: binary ? `${target.relativePath} is a binary file (${bytes.byteLength} bytes); it is not rendered as text.` : null,
    };
  }

  const revision = target.revision ?? context.resultRevision;
  if (!revision) {
    return {
      relativePath: target.relativePath, text: null, source: "revision", revision: null,
      binary: false, sizeBytes: null, truncated: false,
      unavailableReason: context.viewReason ?? "No worktree and no recorded revision are available.",
    };
  }
  const cwd = context.worktreeAvailable && context.worktreePath ? context.worktreePath : context.repoPath;
  const result = await exec("git", ["--no-pager", "show", `${revision}:${target.relativePath}`], { cwd, timeoutMs: 60_000, maxBuffer: maxBytes * 2 });
  if (result.code !== 0) {
    return {
      relativePath: target.relativePath, text: null, source: "revision", revision,
      binary: false, sizeBytes: null, truncated: false,
      unavailableReason:
        `${target.relativePath} is not available at revision ${revision}. ` +
        `This is not the base checkout's copy: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
    };
  }
  const bytes = Buffer.from(result.stdout, "utf8");
  const binary = looksBinary(bytes);
  return {
    relativePath: target.relativePath,
    text: binary ? null : result.stdout.slice(0, maxBytes),
    source: "revision",
    revision,
    binary,
    sizeBytes: bytes.byteLength,
    truncated: !binary && bytes.byteLength > maxBytes,
    unavailableReason: binary ? `${target.relativePath} is binary at revision ${revision}; it is not rendered as text.` : null,
  };
}

export interface FileDiff {
  relativePath: string;
  oldPath: string | null;
  /** Unified diff text, or null when one could not be produced. */
  text: string | null;
  from: string;
  to: string;
  binary: boolean;
  unavailableReason: string | null;
}

/**
 * Diff one path against the task's recorded base revision.
 *
 * Renames and deletions are expressed through the revision pair, so a deleted
 * file still produces a diff rather than an unreadable-file error.
 */
export async function diffFileForContext(context: TaskContext, target: ResolvedFile): Promise<FileDiff> {
  const base = context.baseRevision;
  if (!base) {
    return {
      relativePath: target.relativePath, oldPath: null, text: null, from: "unknown", to: "unknown", binary: false,
      unavailableReason: "This task has no recorded base revision, so there is nothing to diff against.",
    };
  }
  const usingWorktree = context.worktreeAvailable && Boolean(context.worktreePath);
  const cwd = usingWorktree ? (context.worktreePath as string) : context.repoPath;
  const to = usingWorktree ? null : context.resultRevision;
  if (!usingWorktree && !to) {
    return {
      relativePath: target.relativePath, oldPath: null, text: null, from: base, to: "unknown", binary: false,
      unavailableReason: context.viewReason ?? "No worktree and no recorded revision are available.",
    };
  }

  const range = to ? [base, to] : [base];

  // Rename detection compares the whole diff. Limiting the pathspec to the new
  // path alone hides the source, and git then reports a rename as an unrelated
  // added file. Find the pair first, then ask for both paths.
  let pathspec = [target.relativePath];
  try {
    const nameStatus = parseNameStatus(
      await git(cwd, ["diff", "--no-ext-diff", "--name-status", "-M", "-z", ...range]),
    );
    const entry = nameStatus.find((item) => item.path === target.relativePath || item.oldPath === target.relativePath);
    if (entry?.oldPath) pathspec = [entry.oldPath, entry.path];
  } catch {
    // Without the pair the single-path diff is still correct for every other case.
  }

  const result = await exec(
    "git",
    ["--no-pager", "diff", "--no-ext-diff", "-M", "--find-renames", ...range, "--", ...pathspec],
    { cwd, timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    return {
      relativePath: target.relativePath, oldPath: null, text: null, from: base, to: to ?? "worktree", binary: false,
      unavailableReason: `git diff failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
    };
  }
  const text = result.stdout;
  const renamed = text.match(/^rename from (.+)$/m)?.[1] ?? null;
  return {
    relativePath: target.relativePath,
    oldPath: renamed,
    text: text.trim() === "" ? "" : text,
    from: base,
    to: to ?? "worktree",
    binary: /^Binary files .* differ$/m.test(text),
    unavailableReason: null,
  };
}
