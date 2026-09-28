import { DEFAULT_CAPABILITY_REGISTRY, type CapabilityRegistry } from "../../src/routing/capabilities.ts";

/**
 * The shipped registry as it stands after `routing verify-entitlement` has
 * proved the pinned Codex model. Controller tests route across both providers;
 * tests about entitlement itself use DEFAULT_CAPABILITY_REGISTRY directly.
 */
export const VERIFIED_REGISTRY: CapabilityRegistry = {
  version: DEFAULT_CAPABILITY_REGISTRY.version,
  entries: DEFAULT_CAPABILITY_REGISTRY.entries.map((entry) => ({ ...entry, entitlement: "verified" })),
};
