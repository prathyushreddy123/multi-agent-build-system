import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const EXCLUDED = new Set([".git", ".mabs", "node_modules", ".venv", "venv", "dist", "build", "coverage", "__pycache__"]);

/** Find component manifests without walking dependency/build trees. */
export function findNamedFiles(root: string, names: readonly string[], maxDepth = 4): string[] {
  const wanted = new Set(names);
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && wanted.has(entry.name)) found.push(relative(root, path).replaceAll("\\", "/") || entry.name);
      else if (entry.isDirectory() && !EXCLUDED.has(entry.name)) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return found.sort();
}

export function relativeRoot(manifest: string): string {
  const index = manifest.lastIndexOf("/");
  return index === -1 ? "." : manifest.slice(0, index);
}

export function checkName(root: string, name: string): string {
  return root === "." ? name : `${root.replaceAll("/", "-")}:${name}`;
}
