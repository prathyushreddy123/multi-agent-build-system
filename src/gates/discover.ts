import { resolveApplicationProfiles } from "../profiles/index.ts";
import type { GateSpec } from "../store/records.ts";

/**
 * Discover only checks declared by a supported application profile. No package
 * or runtime is installed here. Missing prerequisites stay visible on the
 * profile resolution rather than being mistaken for passing quality coverage.
 */
export function discoverChecks(repoPath: string): GateSpec[] {
  return resolveApplicationProfiles(repoPath).checks;
}
