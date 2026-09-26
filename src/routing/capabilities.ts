export const CAPABILITY_REGISTRY_VERSION = "mabs.capabilities.v1";

export interface RouteCapability {
  provider: string;
  model: string | null;
  efforts: readonly string[];
  authModes: readonly string[];
  quotaDomain: string;
  supportsDelegation: boolean;
  maxDelegationDepth: number;
}

export interface CapabilityRegistry {
  version: string;
  entries: RouteCapability[];
}

export interface EligibilityEvidence {
  registryVersion: string;
  eligible: boolean;
  reasons: string[];
  checkedAt: string;
}
