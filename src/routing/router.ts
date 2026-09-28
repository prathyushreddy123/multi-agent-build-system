import type { WorkerAdapter } from "../adapters/types.ts";
import type { Task } from "../store/records.ts";
import {
  DEFAULT_CAPABILITY_REGISTRY,
  DISABLED_DELEGATION,
  evaluateCapability,
  type CapabilityRegistry,
  type DelegationPolicy,
  type EligibilityEvidence,
} from "./capabilities.ts";

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

/**
 * Why the chosen route is not simply the first policy candidate.
 *
 * Fallback and escalation are different decisions and are never conflated:
 * - `provider_fallback`: an earlier candidate was unavailable (quota, auth,
 *   missing adapter, ineligible); capability is not the reason.
 * - `capacity_fallback`: an earlier candidate was only busy, and the
 *   controller was explicitly configured to use a free fallback instead of
 *   waiting.
 * - `capability_escalation`: the task profile demanded a stronger route
 *   class or effort than its declared class provides.
 */
export type RouteDecision =
  | "primary"
  | "provider_fallback"
  | "capacity_fallback"
  | "capability_escalation"
  | "capacity_wait"
  | "no_route"
  | "deterministic";

export interface RouteSelection {
  chosen: RouteCandidate | null;
  eligible: RouteCandidate[];
  deferred: RouteCandidate[];
  rejected: { candidate: RouteCandidate; reason: string }[];
  reason: string;
  policyVersion: string;
  capabilityRegistryVersion: string;
  decision: RouteDecision;
  fallbackReason: string | null;
  escalationReason: string | null;
  quotaDomain: string | null;
  eligibility: EligibilityEvidence[];
  /** What the policy asked for before availability and eligibility filtering. */
  requested: RouteCandidate | null;
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
  /** Quota domains already exhausted at this task boundary; a model switch inside one cannot create capacity. */
  excludedQuotaDomains?: Set<string>;
  availableTools?: Set<string>;
  capabilityRegistry?: CapabilityRegistry;
  delegation?: DelegationPolicy;
  /** `wait` keeps a busy preferred route instead of silently moving to another provider. */
  capacityFallback?: "allow" | "wait";
}): RouteSelection {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const registry = input.capabilityRegistry ?? DEFAULT_CAPABILITY_REGISTRY;
  const taskClass = normalizeTaskClass(input.task.taskClass);
  const escalations: string[] = [];
  const effectiveClass = taskClass === "small_implementation" &&
    (input.task.complexity === "high" || input.task.changeRisk === "high" || input.task.contextSize === "high")
    ? "complex_coding"
    : taskClass;
  if (effectiveClass !== taskClass) {
    escalations.push(`${taskClass} escalated to ${effectiveClass} because complexity, risk, or context is high`);
  }
  const urgent = input.task.deadlineAt !== null && Date.parse(input.task.deadlineAt) - Date.now() < 24 * 60 * 60_000;
  let candidates = policy.routes[effectiveClass].map((candidate) => {
    if (urgent && candidate.adapter === "codex" && candidate.effort !== "high") {
      escalations.push(`codex effort raised from ${candidate.effort ?? "default"} to high for a deadline under 24h`);
      return { ...candidate, effort: "high" };
    }
    return { ...candidate };
  });
  if (input.preferredAdapter) {
    candidates.sort((a, b) => Number(b.adapter === input.preferredAdapter) - Number(a.adapter === input.preferredAdapter));
  }
  const requested = candidates[0] ?? null;

  const providerMap = new Map(input.providers.map((provider) => [provider.provider, provider]));
  const eligible: RouteCandidate[] = [];
  const deferred: RouteCandidate[] = [];
  const rejected: { candidate: RouteCandidate; reason: string }[] = [];
  const eligibility: EligibilityEvidence[] = [];
  const quotaDomainOf = new Map<RouteCandidate, string>();
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
    const evaluation = evaluateCapability(registry, {
      provider: candidate.adapter,
      model: candidate.model,
      effort: candidate.effort,
      delegation: input.delegation ?? DISABLED_DELEGATION,
    });
    eligibility.push(evaluation.evidence);
    if (!evaluation.capability || !evaluation.evidence.eligible) {
      rejected.push({ candidate, reason: `capability ineligible: ${evaluation.evidence.reasons.join("; ")}` });
      continue;
    }
    quotaDomainOf.set(candidate, evaluation.capability.quotaDomain);
    if (input.excludedAdapters?.has(candidate.adapter)) {
      rejected.push({ candidate, reason: "provider already failed for this task boundary" });
      continue;
    }
    if (input.excludedQuotaDomains?.has(evaluation.capability.quotaDomain)) {
      rejected.push({ candidate, reason: `quota domain ${evaluation.capability.quotaDomain} is exhausted for this task boundary` });
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

  let chosen = eligible[0] ?? null;
  const chosenIndex = chosen ? candidates.indexOf(chosen) : -1;
  const busyAhead = chosen ? deferred.filter((candidate) => candidates.indexOf(candidate) < chosenIndex) : [];
  if (chosen && busyAhead.length > 0 && input.capacityFallback === "wait") chosen = null;

  let decision: RouteDecision;
  let fallbackReason: string | null = null;
  const escalationReason = escalations.length > 0 ? `Capability escalation: ${escalations.join("; ")}.` : null;
  if (chosen) {
    if (busyAhead.length > 0) {
      decision = "capacity_fallback";
      fallbackReason = `Capacity fallback: ${busyAhead.map((item) => item.adapter).join(", ")} at configured concurrency; ` +
        `controller permits using free ${chosen.adapter}.`;
    } else if (chosenIndex > 0) {
      decision = "provider_fallback";
      const skipped = rejected.filter((item) => candidates.indexOf(item.candidate) < chosenIndex);
      fallbackReason = `Provider fallback: ${skipped.map((item) => `${item.candidate.adapter} (${item.reason})`).join("; ")}.`;
    } else {
      decision = escalationReason ? "capability_escalation" : "primary";
    }
  } else if (deferred.length > 0) {
    decision = "capacity_wait";
  } else if (candidates.length === 0) {
    decision = "deterministic";
  } else {
    decision = "no_route";
  }

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
  if (chosen) {
    reason = [
      chosen.reason,
      fallbackReason,
      escalationReason,
      `Selected by ${policy.version} for ${effectiveClass} (${profile}).`,
    ].filter(Boolean).join(" ");
  } else if (deferred.length > 0) reason = "Eligible subscription providers are currently at their configured concurrency limits.";
  else if (candidates.length === 0) reason = `${taskClass} is deterministic and has no model route.`;
  else {
    reason = "No eligible subscription provider is available; paid fallback is forbidden.";
    const ineligible = rejected.filter((item) => item.reason.startsWith("capability ineligible"));
    if (ineligible.length === rejected.length) reason += ` ${ineligible.map((item) => item.reason).join(" | ")}`;
  }
  return {
    chosen,
    eligible,
    deferred,
    rejected,
    reason,
    policyVersion: policy.version,
    capabilityRegistryVersion: registry.version,
    decision,
    fallbackReason,
    escalationReason,
    quotaDomain: chosen ? quotaDomainOf.get(chosen) ?? null : null,
    eligibility,
    requested,
  };
}
