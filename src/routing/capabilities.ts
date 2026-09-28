import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "../core/paths.ts";

/**
 * Versioned launch-capability registry.
 *
 * A route may launch only when its exact provider/model/effort combination is
 * recorded here with verified subscription entitlement. A model appearing in a
 * provider catalog is not entitlement evidence and never enters this registry
 * by itself; adding an entry is a reviewed code change with a new version.
 */
export const CAPABILITY_REGISTRY_VERSION = "mabs.capabilities.v3";

export type Entitlement = "verified" | "unknown";

/**
 * How native child agents (Claude's Agent tool, Codex multi-agent) are
 * controlled on a route.
 *
 * - `enforced`: the launch contract can switch delegation off.
 * - `unenforceable`: no launch control is known, so a disabled policy cannot be
 *   guaranteed and the route is rejected.
 */
export type DelegationControl = "enforced" | "unenforceable";

export interface RouteCapability {
  provider: string;
  /** Always an exact model ID; a provider's configured default is never launchable. */
  model: string;
  efforts: readonly string[];
  authModes: readonly string[];
  /** Models in one subscription account share quota; switching models cannot create capacity. */
  quotaDomain: string;
  entitlement: Entitlement;
  delegationControl: DelegationControl;
  /** True when the provider reports child-agent counts after a run. */
  delegationObservable: boolean;
  evidence: string;
}

export interface CapabilityRegistry {
  version: string;
  entries: RouteCapability[];
}

export interface EligibilityEvidence {
  registryVersion: string;
  provider: string;
  model: string | null;
  effort: string | null;
  eligible: boolean;
  reasons: string[];
  /** Every eligible launch names its effort; provider defaults are never inherited. */
  effortSource: "explicit" | "missing";
  quotaDomain: string | null;
  checkedAt: string;
}

/**
 * MABS does not admit native child agents until child admission and usage
 * accounting exist, so the only supported policy is off.
 */
export interface DelegationPolicy {
  mode: "disabled";
}

export const DISABLED_DELEGATION: DelegationPolicy = { mode: "disabled" };

const CODEX_AUTH = ["chatgpt-subscription"] as const;
const CLAUDE_AUTH = ["claude.ai-subscription"] as const;
/** Deliberately excludes xhigh/max: the plan forbids unrequested maximum reasoning. */
const BOUNDED_EFFORTS = ["low", "medium", "high"] as const;

export const QUOTA_DOMAINS = {
  codex: "openai:chatgpt-subscription",
  claude: "anthropic:claude-ai-subscription",
} as const;

/** The exact Codex model every Codex route names; never the local config default. */
export const CODEX_MODEL = "gpt-5.6-sol";

export const DEFAULT_CAPABILITY_REGISTRY: CapabilityRegistry = {
  version: CAPABILITY_REGISTRY_VERSION,
  entries: [
    {
      provider: "codex",
      model: CODEX_MODEL,
      efforts: BOUNDED_EFFORTS,
      authModes: CODEX_AUTH,
      quotaDomain: QUOTA_DOMAINS.codex,
      // Phase 0 ran on the locally configured default, which exec does not
      // report, so this exact ID is unproven until `routing verify-entitlement`.
      entitlement: "unknown",
      delegationControl: "enforced",
      delegationObservable: false,
      evidence: "Pinned with -m; entitlement requires an explicit-model probe. " +
        "Effort via -c model_reasoning_effort; delegation via -c features.multi_agent=false.",
    },
    ...["claude-sonnet-5", "claude-opus-5"].map((model): RouteCapability => ({
      provider: "claude",
      model,
      efforts: BOUNDED_EFFORTS,
      authModes: CLAUDE_AUTH,
      quotaDomain: QUOTA_DOMAINS.claude,
      entitlement: "verified",
      delegationControl: "enforced",
      delegationObservable: true,
      evidence: "Phase 0 probe resolved this exact ID on the Claude subscription. " +
        "Effort via --effort; delegation via --disallowedTools Agent; result envelope reports subagent_stats.",
    })),
  ],
};

/** One probe that proved an exact registered route answers on its subscription. */
export interface EntitlementVerification {
  provider: string;
  model: string;
  effort: string;
  verifiedAt: string;
  evidencePath: string;
}

export function entitlementOverlayPath(): string {
  return join(stateDir(), "capability-entitlements.json");
}

export function readEntitlementVerifications(path = entitlementOverlayPath()): EntitlementVerification[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { verifications?: EntitlementVerification[] };
  return Array.isArray(parsed.verifications) ? parsed.verifications : [];
}

/**
 * The registry the runtime launches with: the reviewed code registry, with
 * `unknown` entitlement flipped to `verified` only where a recorded probe of
 * that exact provider/model succeeded. The overlay can never add a model.
 */
export function loadCapabilityRegistry(path = entitlementOverlayPath()): CapabilityRegistry {
  const verified = readEntitlementVerifications(path);
  return {
    version: DEFAULT_CAPABILITY_REGISTRY.version,
    entries: DEFAULT_CAPABILITY_REGISTRY.entries.map((entry) => {
      const proof = verified.find((item) => item.provider === entry.provider && item.model === entry.model);
      if (!proof || entry.entitlement === "verified") return entry;
      return { ...entry, entitlement: "verified", evidence: `${entry.evidence} Verified by probe at ${proof.verifiedAt} (${proof.evidencePath}).` };
    }),
  };
}

export function recordEntitlementVerification(verification: EntitlementVerification, path = entitlementOverlayPath()): void {
  if (!findCapability(DEFAULT_CAPABILITY_REGISTRY, verification.provider, verification.model)) {
    throw new Error(`${verification.provider}:${verification.model} is not a registered route; the registry is a reviewed code change`);
  }
  const verifications = readEntitlementVerifications(path)
    .filter((item) => !(item.provider === verification.provider && item.model === verification.model));
  verifications.push(verification);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ verifications }, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export function findCapability(registry: CapabilityRegistry, provider: string, model: string | null): RouteCapability | null {
  return registry.entries.find((entry) => entry.provider === provider && entry.model === model) ?? null;
}

/** Quota domains a provider's routes consume. Unknown providers get their own domain. */
export function quotaDomainsFor(registry: CapabilityRegistry, provider: string): string[] {
  const domains = new Set(registry.entries.filter((entry) => entry.provider === provider).map((entry) => entry.quotaDomain));
  return domains.size > 0 ? [...domains] : [`provider:${provider}`];
}

/**
 * Decide, before any process exists, whether a launch is permitted. Unknown
 * means no: an absent entry, unverified entitlement, or unsupported effort all
 * fail closed with an actionable reason.
 */
export function evaluateCapability(
  registry: CapabilityRegistry,
  request: { provider: string; model: string | null; effort: string | null; authMode?: string; delegation?: DelegationPolicy },
  now = new Date(),
): { capability: RouteCapability | null; evidence: EligibilityEvidence } {
  const capability = findCapability(registry, request.provider, request.model);
  const reasons: string[] = [];
  const label = `${request.provider}:${request.model ?? "default"}`;
  if (request.model === null) reasons.push(`${label} names no model; a launch requires an exact model ID, never the provider default`);
  if (request.effort === null) reasons.push(`${label} names no effort; a launch requires an explicit bounded effort, never the provider default`);
  if (!capability) {
    if (request.model !== null) reasons.push(`${label} is not in ${registry.version}; model entitlement is unknown`);
  } else {
    if (capability.entitlement !== "verified") reasons.push(`${label} subscription entitlement is ${capability.entitlement}`);
    if (request.effort !== null && !capability.efforts.includes(request.effort)) {
      reasons.push(`effort ${request.effort} is unsupported for ${label} (supported: ${capability.efforts.join(", ")})`);
    }
    if (request.authMode !== undefined && !capability.authModes.includes(request.authMode)) {
      reasons.push(`auth mode ${request.authMode} is not permitted for ${label}`);
    }
    const delegation = request.delegation ?? DISABLED_DELEGATION;
    if (delegation.mode !== "disabled") reasons.push("native delegation has no child admission accounting and must stay disabled");
    if (capability.delegationControl !== "enforced") reasons.push(`${label} cannot enforce disabled native delegation`);
  }
  return {
    capability,
    evidence: {
      registryVersion: registry.version,
      provider: request.provider,
      model: request.model,
      effort: request.effort,
      eligible: capability !== null && reasons.length === 0,
      reasons,
      effortSource: request.effort === null ? "missing" : "explicit",
      quotaDomain: capability?.quotaDomain ?? null,
      checkedAt: now.toISOString(),
    },
  };
}
