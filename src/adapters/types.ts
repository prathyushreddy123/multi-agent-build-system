import type { FailureClass } from "../core/failure.ts";
import type { ValidationResult } from "../domain/contract.ts";
import type { LaunchResult } from "../verify/launch.ts";

export type AdapterStatus = "running" | "completed" | "lost";

export interface AdapterLaunch {
  attemptId: string;
  cwd: string;
  prompt: string;
  model: string | null;
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
  status(handle: AdapterHandle): Promise<AdapterStatus>;
  cancel(handle: AdapterHandle): Promise<void>;
  collectResult(handle: AdapterHandle, cwd: string): Promise<CollectedResult>;
}
