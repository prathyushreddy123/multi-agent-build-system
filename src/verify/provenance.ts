/**
 * Subscription-auth provenance, checked before any provider process starts.
 *
 * Launch flags make the harnesses ignore user, project, and local
 * configuration, but two sources remain outside MABS's control: the
 * credential the CLI is logged in with, and admin-managed Claude settings,
 * which always apply. Either could route an attempt to billed API access or a
 * model no registry entry approved, so the launch fails closed instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../core/exec.ts";
import { FORBIDDEN_ENV_KEYS } from "./env.ts";

/** A launch refused because its provider route could bill or reroute; classified CONFIG. */
export class ProvenanceError extends Error {
  override name = "ProvenanceError";
}

export interface ProviderProvenance {
  harness: "claude" | "codex";
  authMethod: string | null;
  subscription: string | null;
  managedSettings: string[];
}

/** Admin-managed Claude settings on Linux; they apply regardless of launch flags. */
export const CLAUDE_MANAGED_SETTINGS_DIR = "/etc/claude-code";

/** Managed keys that can select a credential, provider, or model. */
const PROVIDER_SETTING_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "model", "fallbackModel"];

function managedSettingsFiles(directory: string): string[] {
  const files: string[] = [];
  const base = join(directory, "managed-settings.json");
  if (existsSync(base)) files.push(base);
  const dropIns = join(directory, "managed-settings.d");
  if (existsSync(dropIns)) {
    for (const name of readdirSync(dropIns).filter((item) => item.endsWith(".json")).sort()) files.push(join(dropIns, name));
  }
  return files;
}

/** Every managed-setting reason this machine could launch Claude off-subscription. */
export function managedSettingsRefusals(directory = CLAUDE_MANAGED_SETTINGS_DIR): { files: string[]; refusals: string[] } {
  const files = managedSettingsFiles(directory);
  const refusals: string[] = [];
  for (const file of files) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (error) {
      refusals.push(`${file} cannot be read (${error instanceof Error ? error.message : String(error)}); its effect on the provider route is unknown.`);
      continue;
    }
    for (const key of PROVIDER_SETTING_KEYS) {
      if (settings[key] !== undefined) refusals.push(`${file} sets ${key}, which can change the credential or model an attempt uses.`);
    }
    if (settings.forceLoginMethod === "console") refusals.push(`${file} forces console (API-billed) login.`);
    const env = settings.env && typeof settings.env === "object" ? settings.env as Record<string, unknown> : {};
    const forbidden = Object.keys(env).filter((key) => (FORBIDDEN_ENV_KEYS as readonly string[]).includes(key));
    if (forbidden.length > 0) refusals.push(`${file} sets ${forbidden.join(", ")} in env, a paid-access route.`);
  }
  return { files, refusals };
}

/** Claude must be logged in to a claude.ai subscription on the first-party API. */
export function claudeAuthRefusals(status: Record<string, unknown>): string[] {
  const refusals: string[] = [];
  if (status.loggedIn !== true) refusals.push("Claude is not logged in.");
  if (status.authMethod !== "claude.ai") refusals.push(`Claude auth method is ${String(status.authMethod ?? "unknown")}, not a claude.ai subscription.`);
  if (status.apiProvider !== "firstParty") refusals.push(`Claude API provider is ${String(status.apiProvider ?? "unknown")}, not first-party.`);
  return refusals;
}

/** Codex must be logged in with ChatGPT; an API key bills per token. */
export function codexAuthRefusals(output: string): string[] {
  if (/logged in using chatgpt/i.test(output)) return [];
  if (/api key/i.test(output)) return ["Codex is logged in with an API key, not a ChatGPT subscription."];
  return [`Codex subscription login cannot be established: ${output.trim().slice(0, 200) || "no status output"}.`];
}

/**
 * Establish subscription provenance for one launch, or throw ProvenanceError.
 * Runs the harness's own status command in the worker environment.
 */
export async function requireSubscriptionProvenance(
  harness: "claude" | "codex",
  env: NodeJS.ProcessEnv,
  options: { managedSettingsDir?: string } = {},
): Promise<ProviderProvenance> {
  if (harness === "claude") {
    const managed = managedSettingsRefusals(options.managedSettingsDir ?? env.MABS_CLAUDE_MANAGED_SETTINGS_DIR ?? CLAUDE_MANAGED_SETTINGS_DIR);
    const result = await exec("claude", ["auth", "status"], { env, timeoutMs: 30_000, maxBuffer: 64_000 });
    let status: Record<string, unknown> = {};
    try {
      status = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new ProvenanceError(`Claude auth status is not readable JSON; subscription provenance cannot be established. ${result.stderr.trim().slice(0, 200)}`);
    }
    const refusals = [...managed.refusals, ...claudeAuthRefusals(status)];
    if (refusals.length > 0) throw new ProvenanceError(`Refusing to launch Claude: ${refusals.join(" ")}`);
    return {
      harness, authMethod: String(status.authMethod), subscription: typeof status.subscriptionType === "string" ? status.subscriptionType : null,
      managedSettings: managed.files,
    };
  }
  const result = await exec("codex", ["login", "status"], { env, timeoutMs: 30_000, maxBuffer: 64_000 });
  const refusals = codexAuthRefusals(`${result.stdout}\n${result.stderr}`);
  const authFile = join(env.CODEX_HOME ?? join(env.HOME ?? "", ".codex"), "auth.json");
  if (existsSync(authFile)) {
    try {
      const stored = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
      if (typeof stored.OPENAI_API_KEY === "string" && stored.OPENAI_API_KEY.length > 0) {
        refusals.push(`${authFile} stores an API key beside the ChatGPT login; remove it so no attempt can bill per token.`);
      }
    } catch {
      refusals.push(`${authFile} is unreadable; the stored credential cannot be established.`);
    }
  }
  if (result.code !== 0 && refusals.length === 0) refusals.push(`codex login status exited ${result.code}.`);
  if (refusals.length > 0) throw new ProvenanceError(`Refusing to launch Codex: ${refusals.join(" ")}`);
  return { harness, authMethod: "chatgpt", subscription: null, managedSettings: [] };
}
