import type { FailureClass } from "../core/failure.ts";
import type { ValidationResult } from "../domain/contract.ts";
import type { DelegationPolicy } from "../routing/capabilities.ts";
import type { LaunchResult } from "../verify/launch.ts";

/**
 * - `launching`: a launch specification exists but the process has not yet
 *   identified itself, and the launch grace window is still open.
 * - `ambiguous`: the grace window passed and the process can neither be found
 *   nor ruled out; it may still be editing the worktree.
 * - `lost`: the process is proven absent and wrote no completion envelope.
 */
export type AdapterStatus = "running" | "completed" | "lost" | "launching" | "ambiguous";

export interface AdapterLaunch {
  attemptId: string;
  cwd: string;
  prompt: string;
  model: string | null;
  /** Null is ineligible and rejected before launch; the provider default is never inherited. */
  effort: string | null;
  delegation?: DelegationPolicy;
  timeoutMs: number;
  evidencePath: string;
  completionPath: string;
}

export interface AdapterHandle {
  attemptId: string;
  pid: number | null;
  sessionId: string | null;
  completionPath: string;
}

export interface CollectedResult {
  launch: LaunchResult | null;
  validation: ValidationResult;
  failureClass: FailureClass | null;
  error: string | null;
}

export interface WorkerAdapter {
  readonly name: string;
  readonly authMode: string;
  start(input: AdapterLaunch): Promise<AdapterHandle>;
  status(handle: AdapterHandle, options?: { launchGraceMs?: number }): Promise<AdapterStatus>;
  /**
   * The process identity a crash may have kept out of the durable record,
   * recovered from the adapter's own launch marker. Absent means none.
   */
  recoverHandle?(handle: AdapterHandle): AdapterHandle;
  cancel(handle: AdapterHandle): Promise<void>;
  collectResult(handle: AdapterHandle, cwd: string): Promise<CollectedResult>;
}
