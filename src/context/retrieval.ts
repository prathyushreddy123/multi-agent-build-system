import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import type { Project, Task } from "../store/records.ts";

export interface RetrievedFile {
  path: string;
  absolutePath: string;
  reason: string;
  score: number;
  sizeBytes: number;
  excerpt: string;
  excerptTruncated: boolean;
  estimatedTokens: number;
}

export interface OmittedFile {
  path: string;
  reason: string;
}

export interface RetrievalResult {
  files: RetrievedFile[];
  omitted: OmittedFile[];
  warnings: string[];
  estimatedTokens: number;
  budgetTokens: number;
  /** The checkout excerpts were actually read from. */
  sourceWorkspace: string;
  /** The revision that checkout was on while it was read. */
  inspectedRevision: string | null;
}

const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
  "tsconfig.json", "README.md", "CONTRIBUTING.md", ".github/workflows",
]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "must", "should", "task",
  "work", "change", "implement", "implementation", "registered", "project", "result", "review",
  "src", "lib", "app", "dist", "test", "tests", "packages", "node_modules", "bin", "docs",
  "return", "returns", "returning", "function", "const", "let", "var", "true", "false", "null",
  "undefined", "import", "export", "class", "public", "private", "static", "void", "string",
  "number", "boolean", "interface", "type", "new", "async", "await", "module", "exports", "require",
]);
const SECRET_PATH = /(^|\/)(\.env(?:\.|$)|credentials?(?:\.|$)|auth\.json$)|\.(pem|key|p12|pfx)$/i;
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".json",
  ".jsx", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx",
  ".txt", ".yaml", ".yml", ".xml",
]);

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])
    .filter((term) => !STOP_WORDS.has(term)))].slice(0, 80);
}

function mentionedPaths(text: string): Set<string> {
  const found = text.match(/(?:^|[\s`'"(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),:;])/g) ?? [];
  return new Set(found.map((value) => normalize(value.trim().replace(/^[`'"(]|[`'"),:;]$/g, ""))));
}

function trackedFiles(repoPath: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean).slice(0, 5_000);
}

/** The revision a checkout is on right now, so a packet can be labeled honestly. */
export function headRevision(workspacePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8", maxBuffer: 64_000 }).trim() || null;
  } catch {
    return null;
  }
}

function isText(path: string): boolean {
  const extension = extname(path);
  return TEXT_EXTENSIONS.has(extension) || extension === "";
}

/**
 * Rules-first retrieval. It never reads untracked files or known credential
 * paths, and it reads from exactly one explicitly supplied workspace: the
 * checkout the worker will operate on, not the project's base clone.
 */
export function retrieveContext(input: {
  project: Project;
  task: Task;
  /** Checkout to read from. Callers pass the task worktree during execution. */
  sourceWorkspace: string;
  requirementTexts: string[];
  dependencyFiles?: string[];
  budgetTokens?: number;
}): RetrievalResult {
  const sourceWorkspace = input.sourceWorkspace;
  const inspectedRevision = headRevision(sourceWorkspace);
  const budgetTokens = input.budgetTokens ?? input.project.controllerSettings.contextBudgetTokens ?? 12_000;
  const sourceText = [input.task.title, input.task.objective, ...input.task.acceptanceCriteria, ...input.requirementTexts].join("\n");
  const explicit = mentionedPaths(sourceText);
  const keywordText = [...explicit].reduce((text, path) => text.split(path).join(" "), sourceText);
  const keywords = terms(keywordText);
  const dependencyFiles = new Set((input.dependencyFiles ?? []).map(normalize));
  const scopes = input.task.allowedScope.map(normalize);
  const omitted: OmittedFile[] = [];
  const warnings: string[] = [];
  let tracked: string[];
  try {
    tracked = trackedFiles(sourceWorkspace);
  } catch (error) {
    return {
      files: [], omitted: [],
      warnings: [`Could not enumerate tracked repository files: ${error instanceof Error ? error.message : String(error)}`],
      estimatedTokens: 0, budgetTokens, sourceWorkspace, inspectedRevision,
    };
  }

  const candidates: RetrievedFile[] = [];
  for (const original of tracked) {
    const path = normalize(original);
    if (SECRET_PATH.test(path)) {
      omitted.push({ path, reason: "known credential or secret path" });
      continue;
    }
    if (!isText(path)) continue;
    let metadata;
    try { metadata = statSync(join(sourceWorkspace, path)); } catch { continue; }
    if (!metadata.isFile() || metadata.size > 512_000) {
      if (explicit.has(path)) omitted.push({ path, reason: "file is unavailable or exceeds the 512KB retrieval limit" });
      continue;
    }

    const reasons: string[] = [];
    let score = 0;
    if (explicit.has(path) || explicit.has(basename(path))) { score += 100; reasons.push("explicitly referenced by task or requirement"); }
    if (dependencyFiles.has(path)) { score += 90; reasons.push("changed by a completed dependency"); }
    if (scopes.some((scope) => path === scope || path.startsWith(`${scope}/`))) { score += 60; reasons.push("inside declared task scope"); }
    if (MANIFESTS.has(path) || [...MANIFESTS].some((manifest) => path.startsWith(`${manifest}/`))) {
      score += 40; reasons.push("repository manifest or project guidance");
    }
    const lowerPath = path.toLowerCase();
    const nameMatches = keywords.filter((term) => lowerPath.includes(term));
    if (nameMatches.length > 0) { score += Math.min(40, nameMatches.length * 10); reasons.push(`path matches: ${nameMatches.slice(0, 4).join(", ")}`); }

    let content: string;
    try {
      const bytes = readFileSync(join(sourceWorkspace, path));
      if (bytes.includes(0)) continue;
      content = bytes.subarray(0, 64_000).toString("utf8");
    } catch { continue; }
    if (score < 40) {
      const contentMatches = keywords.filter((term) => content.toLowerCase().includes(term)).slice(0, 6);
      if (contentMatches.length >= 2) {
        score += contentMatches.length * 5;
        reasons.push(`content matches: ${contentMatches.join(", ")}`);
      }
    }
    if (score === 0) continue;
    const maxExcerpt = score >= 90 ? 6_000 : 3_000;
    const excerpt = content.slice(0, maxExcerpt);
    const estimatedTokens = estimateTokens(`${path}\n${reasons.join("; ")}\n${excerpt}`);
    candidates.push({
      path,
      absolutePath: join(sourceWorkspace, path),
      reason: reasons.join("; "),
      score,
      sizeBytes: metadata.size,
      excerpt,
      excerptTruncated: content.length > excerpt.length || metadata.size > Buffer.byteLength(content),
      estimatedTokens,
    });
  }

  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selected: RetrievedFile[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const remaining = budgetTokens - used;
    if (candidate.estimatedTokens <= remaining) {
      selected.push(candidate);
      used += candidate.estimatedTokens;
      continue;
    }
    if (candidate.score >= 90 && remaining >= 128) {
      const budgetChars = Math.max(0, remaining * 4 - Buffer.byteLength(`${candidate.path}\n${candidate.reason}\n`));
      const excerpt = candidate.excerpt.slice(0, budgetChars);
      const shortened = { ...candidate, excerpt, excerptTruncated: true };
      shortened.estimatedTokens = estimateTokens(`${shortened.path}\n${shortened.reason}\n${shortened.excerpt}`);
      selected.push(shortened);
      used += shortened.estimatedTokens;
    } else {
      omitted.push({ path: candidate.path, reason: "context budget exhausted after higher-scoring files" });
    }
  }
  if (omitted.some((item) => item.reason.includes("budget"))) warnings.push("Optional file context was omitted to stay within the configured budget.");
  for (const path of explicit) {
    if (!selected.some((file) => file.path === path || basename(file.path) === path) && !omitted.some((item) => item.path === path)) {
      warnings.push(`Explicitly referenced path was not found among tracked retrievable files: ${path}`);
    }
  }
  return { files: selected, omitted, warnings, estimatedTokens: used, budgetTokens, sourceWorkspace, inspectedRevision };
}
