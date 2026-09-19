import { existsSync } from "node:fs";
import { join } from "node:path";

import { javascriptProfile } from "./javascript.ts";
import { pythonProfile } from "./python.ts";
import type { ApplicationProfile, ProfileKind, ProfileResolution, ProfileSelection, ScaffoldResult } from "./types.ts";

export type * from "./types.ts";

export const APPLICATION_PROFILE_VERSION = "application-profiles-v1" as const;
export const APPLICATION_PROFILES: readonly ApplicationProfile[] = [pythonProfile, javascriptProfile];

export function inferProfile(selection: ProfileSelection): ProfileKind {
  if (selection.kind && selection.kind !== "auto") return selection.kind;
  const language = `${selection.language ?? ""}`.toLowerCase();
  if (language.includes("python")) return "python";
  if (/javascript|typescript|node|\bjs\b|\bts\b/.test(language)) return "javascript-typescript";
  if (["python", "uv", "poetry", "pipenv"].includes(selection.packageManager ?? "")) return "python";
  return "javascript-typescript";
}

export function scaffoldProfile(repoPath: string, name: string, selection: ProfileSelection): ScaffoldResult {
  const kind = inferProfile(selection);
  const profile = APPLICATION_PROFILES.find((candidate) => candidate.kind === kind);
  if (!profile) throw new Error(`No scaffold profile for ${kind}`);
  return profile.scaffold(repoPath, name, selection);
}

/** Compose every detected component; one repository may contain Python and JS/TS together. */
export function resolveApplicationProfiles(repoPath: string): ProfileResolution {
  const components = APPLICATION_PROFILES.flatMap((profile) => profile.detect(repoPath))
    .sort((left, right) => left.root.localeCompare(right.root) || left.kind.localeCompare(right.kind));
  const checks = components.flatMap((component) => component.checks);
  const duplicate = checks.map((check) => check.name).find((name, index, all) => all.indexOf(name) !== index);
  if (duplicate) throw new Error(`Application profiles produced duplicate check name ${duplicate}`);
  const supportedRoots = new Set(components.map((component) => component.root));
  const unsupported: string[] = [];
  if (existsSync(join(repoPath, "Cargo.toml")) && !supportedRoots.has(".")) unsupported.push("Cargo.toml (custom gates required; Rust is not a tested profile yet)");
  if (existsSync(join(repoPath, "go.mod")) && !supportedRoots.has(".")) unsupported.push("go.mod (custom gates required; Go is not a tested profile yet)");
  return {
    version: APPLICATION_PROFILE_VERSION,
    components,
    checks,
    missingPrerequisites: [...new Set(components.flatMap((component) => component.environment.missingPrerequisites))],
    unsupported,
  };
}
