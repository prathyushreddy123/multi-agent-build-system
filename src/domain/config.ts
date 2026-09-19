import { createHash } from "node:crypto";

import { ACTIONS, DEFAULT_POLICY, type ProjectApprovalPolicy } from "./policy.ts";
import { DEFAULT_REVIEW_POLICY, normalizeReviewPolicy, validateReviewPolicy } from "../review/policy.ts";
import type { ReviewPolicy } from "../review/policy.ts";
import type { GateSpec, Project } from "../store/records.ts";
import { DEFAULT_ROUTING_POLICY, TASK_CLASSES, type TaskClass } from "../routing/router.ts";

export interface PromptProfile {
  implementationAddendum: string | null;
  reviewAddendum: string | null;
  researchAddendum: string | null;
}

export interface ProjectControllerSettings {
  defaultRepairLimit: number;
  contextBudgetTokens: number;
}

export interface RoutingOverride {
  adapter: "claude" | "codex";
  model: string | null;
  effort: string | null;
}

export type RoutingOverrides = Partial<Record<TaskClass, RoutingOverride>>;

export interface ProjectConfigSnapshot {
  routingProfile: string;
  routingOverrides: RoutingOverrides;
  approvalPolicy: ProjectApprovalPolicy;
  reviewPolicy: ReviewPolicy;
  checkCommands: GateSpec[];
  promptProfile: PromptProfile;
  controllerSettings: ProjectControllerSettings;
}

export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  implementationAddendum: null,
  reviewAddendum: null,
  researchAddendum: null,
};

export const DEFAULT_CONTROLLER_SETTINGS: ProjectControllerSettings = {
  defaultRepairLimit: 2,
  contextBudgetTokens: 12_000,
};

export function normalizeProjectConfig(config: ProjectConfigSnapshot): ProjectConfigSnapshot {
  return {
    ...config,
    routingOverrides: config.routingOverrides ?? {},
    approvalPolicy: config.approvalPolicy ?? { overrides: {}, standing: [] },
    reviewPolicy: normalizeReviewPolicy(config.reviewPolicy ?? DEFAULT_REVIEW_POLICY),
    checkCommands: config.checkCommands ?? [],
    promptProfile: { ...DEFAULT_PROMPT_PROFILE, ...(config.promptProfile ?? {}) },
    controllerSettings: { ...DEFAULT_CONTROLLER_SETTINGS, ...(config.controllerSettings ?? {}) },
  };
}

export function projectConfigSnapshot(project: Project): ProjectConfigSnapshot {
  return {
    routingProfile: project.routingProfile,
    routingOverrides: project.routingOverrides,
    approvalPolicy: project.approvalPolicy,
    reviewPolicy: project.reviewPolicy,
    checkCommands: project.checkCommands,
    promptProfile: project.promptProfile,
    controllerSettings: { ...DEFAULT_CONTROLLER_SETTINGS, ...project.controllerSettings },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

export function canonicalConfig(config: ProjectConfigSnapshot): string {
  return JSON.stringify(stableValue(config));
}

export function configFingerprint(config: ProjectConfigSnapshot): string {
  return createHash("sha256").update(canonicalConfig(config)).digest("hex");
}

function unknownKeys(value: object, allowed: string[], label: string): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => `${label} contains unknown property ${key}.`);
}

export function validateProjectConfig(config: ProjectConfigSnapshot): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") return ["Configuration must be an object."];
  errors.push(...unknownKeys(config, [
    "routingProfile", "routingOverrides", "approvalPolicy", "reviewPolicy", "checkCommands", "promptProfile", "controllerSettings",
  ], "configuration"));
  if (typeof config.routingProfile !== "string" || !config.routingProfile.trim()) errors.push("routingProfile is required.");
  if (!config.routingOverrides || typeof config.routingOverrides !== "object" || Array.isArray(config.routingOverrides)) {
    errors.push("routingOverrides must be an object.");
  } else {
    for (const [taskClass, override] of Object.entries(config.routingOverrides)) {
      if (!TASK_CLASSES.includes(taskClass as TaskClass)) {
        errors.push(`Unknown routing override task class: ${taskClass}.`);
        continue;
      }
      if (!override || typeof override !== "object") {
        errors.push(`${taskClass}: routing override must be an object.`);
        continue;
      }
      const typed = override as RoutingOverride;
      errors.push(...unknownKeys(typed, ["adapter", "model", "effort"], `${taskClass} routing override`));
      const verified = DEFAULT_ROUTING_POLICY.routes[taskClass as TaskClass].some((candidate) =>
        candidate.adapter === typed.adapter && candidate.model === typed.model && candidate.effort === typed.effort,
      );
      if (!verified) errors.push(`${taskClass}: route must exactly match a verified candidate in ${DEFAULT_ROUTING_POLICY.version}.`);
    }
  }

  errors.push(...validateReviewPolicy(config.reviewPolicy));

  if (!Array.isArray(config.checkCommands)) errors.push("checkCommands must be an array.");
  else for (const [index, gate] of config.checkCommands.entries()) {
    if (gate && typeof gate === "object") {
      errors.push(...unknownKeys(gate, ["name", "command", "required", "timeoutMs", "cwd", "versionCommand"], `checkCommands[${index}]`));
    }
    if (!gate || typeof gate.name !== "string" || !gate.name.trim()) errors.push(`checkCommands[${index}] requires a name.`);
    if (typeof gate?.required !== "boolean") errors.push(`checkCommands[${index}] required must be boolean.`);
    if (gate?.timeoutMs !== undefined && (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs <= 0)) {
      errors.push(`checkCommands[${index}] timeoutMs must be a positive integer.`);
    }
    if (gate?.versionCommand !== undefined && (!Array.isArray(gate.versionCommand) || gate.versionCommand.some((part) => typeof part !== "string" || !part))) {
      errors.push(`checkCommands[${index}] versionCommand must be an explicit command array.`);
    }
    if (!Array.isArray(gate?.command) || gate.command.length === 0 || gate.command.some((part) => typeof part !== "string" || !part)) {
      errors.push(`checkCommands[${index}] requires an explicit command array.`);
    } else {
      const rendered = gate.command.join(" ");
      if (/^(sudo|rm)\b|\bgit\s+(push|merge)\b|\b(curl|wget)\b|\b(deploy|release)\b/i.test(rendered)) {
        errors.push(`checkCommands[${index}] contains a command outside deterministic local quality checks.`);
      }
    }
    if (gate?.cwd && (gate.cwd.startsWith("/") || gate.cwd.replaceAll("\\", "/").split("/").includes(".."))) {
      errors.push(`checkCommands[${index}] cwd must remain repository-relative.`);
    }
  }

  if (Array.isArray(config.checkCommands)) {
    const names = config.checkCommands.map((gate) => gate?.name).filter((name): name is string => typeof name === "string");
    if (new Set(names).size !== names.length) errors.push("checkCommands contains duplicate gate names.");
  }

  if (config.approvalPolicy && typeof config.approvalPolicy === "object") {
    errors.push(...unknownKeys(config.approvalPolicy, ["overrides", "standing"], "approvalPolicy"));
  }
  const approvalRules = ["automatic", "approval_required", "automatic_if_in_scope", "standing_authorization"];
  for (const [action, rule] of Object.entries(config.approvalPolicy?.overrides ?? {})) {
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) errors.push(`Unknown approval action: ${action}.`);
    if (!approvalRules.includes(String(rule))) errors.push(`${action}: unknown approval rule ${String(rule)}.`);
  }
  const consequential = ["merge", "deploy", "destructive_migration", "shared_data_deletion", "waive_required_gate", "activate_config_change"] as const;
  for (const action of consequential) {
    const rule = config.approvalPolicy?.overrides?.[action] ?? DEFAULT_POLICY[action];
    if (rule !== "approval_required") errors.push(`${action} cannot be weakened from approval_required by a curated configuration.`);
  }
  if (!Array.isArray(config.approvalPolicy?.standing)) errors.push("approvalPolicy.standing must be an array.");
  else if (config.approvalPolicy.standing.some((action) => !ACTIONS.includes(action))) errors.push("approvalPolicy.standing contains an unknown action.");

  const prompts = config.promptProfile;
  if (!prompts || typeof prompts !== "object") errors.push("promptProfile is required.");
  else {
    errors.push(...unknownKeys(prompts, ["implementationAddendum", "reviewAddendum", "researchAddendum"], "promptProfile"));
    for (const [name, value] of Object.entries(prompts)) {
      if (value !== null && typeof value !== "string") errors.push(`${name} must be a string or null.`);
      if (typeof value === "string" && value.length > 4_000) errors.push(`${name} exceeds the 4,000 character limit.`);
      if (typeof value === "string" && /(ignore|bypass).{0,30}(approval|policy)|use.{0,20}api.?key|paid.?api/is.test(value)) {
        errors.push(`${name} contains an instruction that could weaken approval or paid-access boundaries.`);
      }
    }
  }

  if (config.controllerSettings && typeof config.controllerSettings === "object") {
    errors.push(...unknownKeys(config.controllerSettings, ["defaultRepairLimit", "contextBudgetTokens"], "controllerSettings"));
  }
  const repairLimit = config.controllerSettings?.defaultRepairLimit;
  if (!Number.isSafeInteger(repairLimit) || repairLimit < 0 || repairLimit > 2) {
    errors.push("controllerSettings.defaultRepairLimit must be an integer from 0 through 2.");
  }
  const contextBudget = config.controllerSettings?.contextBudgetTokens;
  if (!Number.isSafeInteger(contextBudget) || contextBudget < 1_000 || contextBudget > 100_000) {
    errors.push("controllerSettings.contextBudgetTokens must be an integer from 1,000 through 100,000.");
  }
  return [...new Set(errors)];
}
