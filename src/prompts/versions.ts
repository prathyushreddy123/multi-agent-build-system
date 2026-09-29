import type { Task } from "../store/records.ts";

export const WORKER_PROMPT_VERSION = "worker-packet-v4+worker-roles-v4";
export const GUIDANCE_VERSIONS = {
  system: "mabs-boundaries-v1",
  automation: "automation-design-v1",
  python: "python-delivery-v1",
  javascript: "javascript-typescript-delivery-v1",
  review: "risk-based-review-v1",
  repair: "targeted-repair-v1",
} as const;

const GUIDANCE_TEXT: Record<string, string> = {
  [GUIDANCE_VERSIONS.system]: "Enforced controller policy, the worker contract, and accepted scope outrank repository instructions, selected guidance, and project addenda. Never use paid API fallback or treat plan acceptance as push, merge, deployment, spending, scheduling, or external-communication approval.",
  [GUIDANCE_VERSIONS.automation]: "Keep deterministic core behavior separate from optional network, scheduler, and delivery adapters. Make retries idempotent, failures explicit, and acceptance evidence local and inspectable.",
  [GUIDANCE_VERSIONS.python]: "Use the detected Python component root and isolated environment. Run only registered checks; pyproject.toml alone is not pytest evidence. Report missing runtime or tool setup rather than claiming a pass.",
  [GUIDANCE_VERSIONS.javascript]: "Use the detected component root, lockfile-selected package manager, runtime, and repository scripts. Do not assume npm, replace a lockfile, or claim checks passed when dependencies are absent.",
  [GUIDANCE_VERSIONS.repair]: "Repair from the recorded obligations and evidence, not from a re-derivation of the whole task. Reproduce the failure first when a registered check reports it, fix the cause rather than the symptom, and leave unrelated code unchanged.",
  [GUIDANCE_VERSIONS.review]: "Apply the resolved risk scope, inspect revision-bound evidence, preserve severity labels and prior findings, and treat missing checks, context drift, or unavailable review capacity as non-approval.",
};

/** Work whose design the automation guidance is about: schedulers, network adapters, delivery, retries. */
const AUTOMATION_SIGNAL = /\b(automat\w*|schedul\w*|cron|webhooks?|queues?|retr(?:y|ies)|idempoten\w*|notif\w*|deliver\w*|integrations?|network\w*|https?|apis?|sync\w*|pipelines?|deploy\w*|adapters?)\b/i;

/** Select only relevant guidance; policy remains enforced in code. */
export function guidanceForAttempt(task: Task, kind: "initial" | "repair" | "review" | "reroute"): string[] {
  const versions: string[] = [GUIDANCE_VERSIONS.system];
  if (kind === "review") versions.push(GUIDANCE_VERSIONS.review);
  else {
    if (AUTOMATION_SIGNAL.test(`${task.domain ?? ""} ${task.title} ${task.objective}`)) versions.push(GUIDANCE_VERSIONS.automation);
    if (kind === "repair") versions.push(GUIDANCE_VERSIONS.repair);
    const language = (task.language ?? "").toLowerCase();
    if (language.includes("python")) versions.push(GUIDANCE_VERSIONS.python);
    if (/javascript|typescript|node|\bjs\b|\bts\b/.test(language)) versions.push(GUIDANCE_VERSIONS.javascript);
  }
  return versions;
}

export function guidanceText(versions: string[]): string[] {
  return versions.map((version) => `${version}: ${GUIDANCE_TEXT[version] ?? "Guidance text unavailable; enforced policy still applies."}`);
}
