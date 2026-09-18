import type { WorkerAdapter } from "../adapters/types.ts";
import type { Task } from "../store/records.ts";

export const TASK_CLASSES = [
  "mechanical",
  "small_implementation",
  "complex_coding",
  "diagnosis",
  "planning",
  "research",
  "review",
  "troubleshooting",
  "curation",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
export type Complexity = "low" | "medium" | "high";
export type ChangeRisk = "low" | "medium" | "high";
export type Ambiguity = "low" | "medium" | "high";

export interface RouteCandidate {
  adapter: string;
  model: string | null;
  effort: string | null;
  reason: string;
}

export interface RoutingPolicy {
  version: string;
  provisional: boolean;
  routes: Record<TaskClass, RouteCandidate[]>;
}

/**
 * Provisional map from Phase 0 evidence. Codex did not report its actual model,
 * so its model remains null. Claude IDs are exact IDs resolved by the probe.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: "phase2-routing-v1",
  provisional: true,
  routes: {
    mechanical: [],
    small_implementation: [
      { adapter: "codex", model: null, effort: "medium", reason: "Accepted Phase 0 bug-fix and feature tasks." },
      { adapter: "claude", model: "claude-sonnet-5", effort: null, reason: "Subscription fallback with verified model ID." },
    ],
    complex_coding: [
      { adapter: "codex", model: null, effort: "high", reason: "Accepted the resumed Phase 0 complex task." },
      { adapter: "claude", model: "claude-opus-5", effort: null, reason: "Capable fallback; Phase 0 complex run was quota-limited." },
    ],
    diagnosis: [
      { adapter: "codex", model: null, effort: "high", reason: "Accepted the Phase 0 diagnosis task." },
      { adapter: "claude", model: "claude-sonnet-5", effort: null, reason: "Verified subscription fallback." },
    ],
    planning: [
      { adapter: "claude", model: "claude-opus-5", effort: null, reason: "Provisional reasoning route pending representative evaluation." },
      { adapter: "codex", model: null, effort: "high", reason: "Subscription fallback for planning." },
    ],
    research: [
      { adapter: "codex", model: null, effort: "medium", reason: "Provisional research route." },
      { adapter: "claude", model: "claude-sonnet-5", effort: null, reason: "Subscription fallback for research." },
    ],
    review: [
      { adapter: "claude", model: "claude-sonnet-5", effort: null, reason: "Separate-context review route; provisional until Phase 3 evaluation." },
      { adapter: "codex", model: null, effort: "high", reason: "Subscription fallback for review." },
    ],
    troubleshooting: [
      { adapter: "codex", model: null, effort: "high", reason: "Diagnosis-capable default." },
      { adapter: "claude", model: "claude-opus-5", effort: null, reason: "Capable troubleshooting fallback." },
    ],
    curation: [
      { adapter: "claude", model: "claude-opus-5", effort: null, reason: "Provisional curator route; activation remains approval-gated." },
      { adapter: "codex", model: null, effort: "high", reason: "Subscription fallback for curation." },
    ],
  },
};

export interface ProviderAvailability {
  provider: string;
  available: boolean;
  active: number;
  limit: number;
  reason: string | null;
}

export interface RouteSelection {
  chosen: RouteCandidate | null;
  eligible: RouteCandidate[];
  deferred: RouteCandidate[];
  rejected: { candidate: RouteCandidate; reason: string }[];
  reason: string;
  policyVersion: string;
}

export function normalizeTaskClass(value: string): TaskClass {
  if (!TASK_CLASSES.includes(value as TaskClass)) throw new Error(`Unknown task class: ${value}`);
  return value as TaskClass;
}

export function selectRoute(input: {
  task: Task;
  policy?: RoutingPolicy;
  adapters: Map<string, WorkerAdapter>;
  providers: ProviderAvailability[];
  preferredAdapter?: string | null;
  excludedAdapters?: Set<string>;
  availableTools?: Set<string>;
}): RouteSelection {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const taskClass = normalizeTaskClass(input.task.taskClass);
  const effectiveClass = taskClass === "small_implementation" &&
    (input.task.complexity === "high" || input.task.changeRisk === "high" || input.task.contextSize === "high")
    ? "complex_coding"
    : taskClass;
  const urgent = input.task.deadlineAt !== null && Date.parse(input.task.deadlineAt) - Date.now() < 24 * 60 * 60_000;
  let candidates = policy.routes[effectiveClass].map((candidate) => ({
    ...candidate,
    effort: urgent && candidate.adapter === "codex" ? "high" : candidate.effort,
  }));
  if (input.preferredAdapter) {
    candidates.sort((a, b) => Number(b.adapter === input.preferredAdapter) - Number(a.adapter === input.preferredAdapter));
  }

  const providerMap = new Map(input.providers.map((provider) => [provider.provider, provider]));
  const eligible: RouteCandidate[] = [];
  const deferred: RouteCandidate[] = [];
  const rejected: { candidate: RouteCandidate; reason: string }[] = [];
  const missingTools = input.task.requiredTools.filter((tool) => input.availableTools && !input.availableTools.has(tool));
  for (const candidate of candidates) {
    if (missingTools.length > 0) {
      rejected.push({ candidate, reason: `required tools are unavailable: ${missingTools.join(", ")}` });
      continue;
    }
    if (!input.adapters.has(candidate.adapter)) {
      rejected.push({ candidate, reason: "adapter is not installed" });
      continue;
    }
    if (input.excludedAdapters?.has(candidate.adapter)) {
      rejected.push({ candidate, reason: "provider already failed for this task boundary" });
      continue;
    }
    const provider = providerMap.get(candidate.adapter);
    if (provider && !provider.available) {
      rejected.push({ candidate, reason: provider.reason ?? "provider is unavailable" });
      continue;
    }
    if (provider && provider.active >= provider.limit) {
      deferred.push(candidate);
      continue;
    }
    eligible.push(candidate);
  }

  const chosen = eligible[0] ?? null;
  let reason: string;
  const profile = [
    input.task.language ? `language=${input.task.language}` : null,
    input.task.domain ? `domain=${input.task.domain}` : null,
    `complexity=${input.task.complexity}`,
    `ambiguity=${input.task.ambiguity}`,
    `risk=${input.task.changeRisk}`,
    `context=${input.task.contextSize}`,
    urgent ? "urgency=<24h" : null,
  ].filter(Boolean).join(", ");
  if (chosen) reason = `${chosen.reason} Selected by ${policy.version} for ${effectiveClass} (${profile}).`;
  else if (deferred.length > 0) reason = "Eligible subscription providers are currently at their configured concurrency limits.";
  else if (candidates.length === 0) reason = `${taskClass} is deterministic and has no model route.`;
  else reason = "No eligible subscription provider is available; paid fallback is forbidden.";
  return { chosen, eligible, deferred, rejected, reason, policyVersion: policy.version };
}
