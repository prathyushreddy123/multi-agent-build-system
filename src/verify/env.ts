/**
 * Worker environment construction.
 *
 * The plan forbids paid API, extra-credit, and automatic upgrade fallback. A
 * subscription-authenticated harness silently switches to billed API access
 * when a key is present in its environment, so the controller removes those
 * variables instead of trusting that they are unset.
 */
export const FORBIDDEN_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "AZURE_OPENAI_API_KEY",
] as const;

export interface WorkerEnvResult {
  env: NodeJS.ProcessEnv;
  removed: string[];
}

/** Build a worker environment with every paid-access route stripped. */
export function buildWorkerEnv(parent: NodeJS.ProcessEnv = process.env): WorkerEnvResult {
  const env: NodeJS.ProcessEnv = { ...parent };
  const removed: string[] = [];
  for (const key of FORBIDDEN_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  return { env, removed };
}

/** Fail closed: never launch a worker whose environment could bill an API account. */
export function assertNoPaidFallback(env: NodeJS.ProcessEnv): void {
  const present = FORBIDDEN_ENV_KEYS.filter((key) => env[key] !== undefined);
  if (present.length > 0) {
    throw new Error(`Refusing to launch a worker with paid-access variables present: ${present.join(", ")}`);
  }
}
