/**
 * Subscription-auth provenance, checked before any provider process starts.
 *
 * Launch flags make the harnesses ignore user, project, and local
 * configuration, but two sources remain outside MABS's control: the
 * credential the CLI is logged in with, and admin-managed Claude settings or
 * system-managed Codex configuration, which always apply. Either could route an attempt to billed API access or a
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

/**
 * The managed directories a launch must inspect. An override adds a directory
 * (tests inject settings this way); it never replaces the system location,
 * because an environment variable must not be able to switch the check off.
 */
export function managedDirectories(system: string, override: string | undefined): string[] {
  return override && override !== system ? [system, override] : [system];
}

/** System-managed Codex configuration on Linux; it applies even with --ignore-user-config. */
export const CODEX_MANAGED_CONFIG_DIR = "/etc/codex";

const CODEX_MANAGED_FILES = ["config.toml", "managed_config.toml", "requirements.toml"];

/** Top-level keys that can select a credential, provider, endpoint, or model. */
const CODEX_PROVIDER_KEYS = ["model", "model_provider", "profile", "forced_login_method", "preferred_auth_method", "openai_base_url", "chatgpt_base_url"];

/** Every system-managed Codex setting that could launch Codex off-subscription or on an unapproved model. */
export function codexManagedConfigRefusals(directory = CODEX_MANAGED_CONFIG_DIR): { files: string[]; refusals: string[] } {
  const files = CODEX_MANAGED_FILES.map((name) => join(directory, name)).filter((file) => existsSync(file));
  const refusals: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      refusals.push(`${file} cannot be read (${error instanceof Error ? error.message : String(error)}); its effect on the provider route is unknown.`);
      continue;
    }
    let table = "";
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
      if (header) {
        table = header[1] ?? "";
        if (/^(model_providers|profiles)(\.|$)/.test(table)) refusals.push(`${file} defines [${table}], which can change the provider or model an attempt uses.`);
        continue;
      }
      const key = line.match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1];
      if (!key || table !== "") continue;
      if (key === "forced_login_method" && /=\s*["']chatgpt["']/.test(line)) continue;
      if (CODEX_PROVIDER_KEYS.includes(key)) refusals.push(`${file} sets ${key}, which can change the credential or model an attempt uses.`);
    }
  }
  return { files, refusals };
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
  options: { managedSettingsDir?: string; codexManagedDir?: string } = {},
): Promise<ProviderProvenance> {
  if (harness === "claude") {
    const managed = { files: [] as string[], refusals: [] as string[] };
    for (const directory of managedDirectories(CLAUDE_MANAGED_SETTINGS_DIR, options.managedSettingsDir ?? env.MABS_CLAUDE_MANAGED_SETTINGS_DIR)) {
      const found = managedSettingsRefusals(directory);
      managed.files.push(...found.files);
      managed.refusals.push(...found.refusals);
    }
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
  const managed = { files: [] as string[], refusals: [] as string[] };
  for (const directory of managedDirectories(CODEX_MANAGED_CONFIG_DIR, options.codexManagedDir ?? env.MABS_CODEX_MANAGED_CONFIG_DIR)) {
    const found = codexManagedConfigRefusals(directory);
    managed.files.push(...found.files);
    managed.refusals.push(...found.refusals);
  }
  const result = await exec("codex", ["login", "status"], { env, timeoutMs: 30_000, maxBuffer: 64_000 });
  const refusals = [...managed.refusals, ...codexAuthRefusals(`${result.stdout}\n${result.stderr}`)];
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
  return { harness, authMethod: "chatgpt", subscription: null, managedSettings: managed.files };
}
