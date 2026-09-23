#!/usr/bin/env node
/**
 * Link the globally installed Pi packages into node_modules.
 *
 * MABS deliberately does not depend on Pi: the extension is loaded by whichever
 * Pi the user has installed, and pinning a copy here would let the two drift.
 * That also means `tsc` and `node --test` cannot resolve `@earendil-works/*`
 * from this checkout.
 *
 * This script creates a symlink to the installed global package so the
 * extension can be typechecked and load-tested locally. It installs nothing,
 * upgrades nothing, and is safe to re-run. Remove the link with
 * `npm run link-pi -- --remove`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@earendil-works";
const target = join(ROOT, "node_modules", SCOPE);
const remove = process.argv.includes("--remove");

function globalScopeDir() {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return join(root, SCOPE);
}

function linkNames(source) {
  // Pi's peer packages (pi-ai, pi-tui, pi-agent-core, ...) are nested inside
  // the CLI package, so linking only the scope root would leave them
  // unresolvable. Link each package the extensions can import.
  const names = new Map();
  for (const entry of readdirSync(source)) names.set(entry, join(source, entry));
  const nested = join(source, "pi-coding-agent", "node_modules", "@earendil-works");
  if (existsSync(nested)) {
    for (const entry of readdirSync(nested)) {
      if (!names.has(entry)) names.set(entry, join(nested, entry));
    }
  }
  return names;
}

if (remove) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${target}`);
  } else {
    console.log(`No link directory at ${target}; nothing to remove.`);
  }
  process.exit(0);
}

const source = globalScopeDir();
if (!existsSync(join(source, "pi-coding-agent", "package.json"))) {
  console.error(`No global Pi install found at ${source}. Install Pi first, or skip: the link is optional.`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const [name, packagePath] of linkNames(source)) {
  const link = join(target, name);
  if (existsSync(link) || lstatSyncSafe(link)) {
    if (lstatSync(link).isSymbolicLink() && resolve(readlinkSync(link)) === resolve(packagePath)) continue;
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(packagePath, link, "dir");
}
console.log(`Linked ${[...linkNames(source).keys()].join(", ")} into ${target}`);
console.log("Now available: npm run typecheck:extensions, and the extension load test.");

function lstatSyncSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
