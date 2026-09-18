import type { FailureClass } from "../core/failure.ts";

/**
 * Worker contract v1.
 *
 * Both halves are validated. A missing or malformed worker output can never
 * silently become success: it is a CONTRACT failure with the raw transcript
 * preserved as evidence.
 */
export const CONTRACT_VERSION = "1.0.0";

export type WorkerRole = "implementer" | "reviewer" | "researcher" | "troubleshooter" | "curator";

export interface WorkerInput {
  identity: {
    project_id: string;
    task_id: string;
    attempt_id: string;
    role: WorkerRole;
    contract_version: string;
  };
  task: {
    objective: string;
    acceptance_criteria: string[];
    dependencies: string[];
    deadline_at: string | null;
    repairs_used: number;
    repair_limit: number;
  };
  workspace: {
    worktree_path: string;
    base_revision: string;
    branch: string;
    allowed_scope: string[];
    allowed_actions: string[];
    forbidden_actions: string[];
  };
  execution: {
    harness: string;
    model: string | null;
    effort: string | null;
    auth_mode: string;
  };
  context: {
    packet_id: string;
    requirements: { id: string; text: string }[];
    files: string[];
    previous_findings: string[];
    artifacts: string[];
    config_version: string;
  };
}

export type WorkerOutcome = "completed" | "blocked" | "failed";

export interface WorkerOutput {
  outcome: WorkerOutcome;
  reason: string;
  summary: string;
  evidence: {
    changed_files: string[];
    result_revision: string | null;
    tests: string[];
    artifacts: string[];
  };
  follow_up: {
    unresolved: string[];
    decisions_requested: string[];
    next_step: string | null;
  };
  usage: {
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
  };
  addressed_requirements: string[];
}

export interface ContractViolation {
  path: string;
  message: string;
}

/** The JSON shape workers are told to emit. Kept in one place so the prompt, */
/** the validator, and the harness output schema cannot drift apart. */
export const WORKER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "reason", "summary", "evidence", "follow_up", "usage", "addressed_requirements"],
  properties: {
    outcome: { type: "string", enum: ["completed", "blocked", "failed"] },
    reason: { type: "string" },
    summary: { type: "string" },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["changed_files", "result_revision", "tests", "artifacts"],
      properties: {
        changed_files: { type: "array", items: { type: "string" } },
        result_revision: { type: ["string", "null"] },
        tests: { type: "array", items: { type: "string" } },
        artifacts: { type: "array", items: { type: "string" } },
      },
    },
    follow_up: {
      type: "object",
      additionalProperties: false,
      required: ["unresolved", "decisions_requested", "next_step"],
      properties: {
        unresolved: { type: "array", items: { type: "string" } },
        decisions_requested: { type: "array", items: { type: "string" } },
        next_step: { type: ["string", "null"] },
      },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["model", "input_tokens", "output_tokens"],
      properties: {
        model: { type: ["string", "null"] },
        input_tokens: { type: ["integer", "null"] },
        output_tokens: { type: ["integer", "null"] },
      },
    },
    addressed_requirements: { type: "array", items: { type: "string" } },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  violations: ContractViolation[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) violations.push({ path: `${path}.${key}`, message: "unexpected property" });
  }
}

function stringArray(value: unknown, path: string, violations: ContractViolation[]): string[] {
  if (!Array.isArray(value)) {
    violations.push({ path, message: "expected an array of strings" });
    return [];
  }
  const strings: string[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") strings.push(item);
    else violations.push({ path: `${path}[${index}]`, message: "expected a string" });
  });
  return strings;
}

function nullableString(value: unknown, path: string, violations: ContractViolation[]): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  violations.push({ path, message: "expected a string or null" });
  return null;
}

function nullableInt(value: unknown, path: string, violations: ContractViolation[]): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  violations.push({ path, message: "expected a non-negative integer or null" });
  return null;
}

export interface ValidationResult {
  ok: boolean;
  output: WorkerOutput | null;
  violations: ContractViolation[];
}

/**
 * Validate worker output. Unknown usage values stay null rather than being
 * estimated: the plan forbids presenting a derived number as reported usage.
 */
export function validateWorkerOutput(raw: unknown): ValidationResult {
  const violations: ContractViolation[] = [];
  if (!isRecord(raw)) {
    return { ok: false, output: null, violations: [{ path: "$", message: "worker output is not a JSON object" }] };
  }

  rejectUnknownKeys(
    raw,
    ["outcome", "reason", "summary", "evidence", "follow_up", "usage", "addressed_requirements"],
    "$",
    violations,
  );

  const outcome = raw.outcome;
  if (outcome !== "completed" && outcome !== "blocked" && outcome !== "failed") {
    violations.push({ path: "$.outcome", message: `expected completed|blocked|failed, got ${JSON.stringify(outcome)}` });
  }
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") {
    violations.push({ path: "$.summary", message: "expected a non-empty summary" });
  }
  if (typeof raw.reason !== "string") {
    violations.push({ path: "$.reason", message: "expected a structured reason string" });
  }

  const evidence = isRecord(raw.evidence) ? raw.evidence : {};
  if (!isRecord(raw.evidence)) violations.push({ path: "$.evidence", message: "expected an evidence object" });
  else rejectUnknownKeys(evidence, ["changed_files", "result_revision", "tests", "artifacts"], "$.evidence", violations);

  const followUp = isRecord(raw.follow_up) ? raw.follow_up : {};
  if (!isRecord(raw.follow_up)) violations.push({ path: "$.follow_up", message: "expected a follow_up object" });
  else rejectUnknownKeys(followUp, ["unresolved", "decisions_requested", "next_step"], "$.follow_up", violations);

  const usage = isRecord(raw.usage) ? raw.usage : {};
  if (!isRecord(raw.usage)) violations.push({ path: "$.usage", message: "expected a usage object" });
  else rejectUnknownKeys(usage, ["model", "input_tokens", "output_tokens"], "$.usage", violations);

  const output: WorkerOutput = {
    outcome: outcome === "completed" || outcome === "blocked" || outcome === "failed" ? outcome : "failed",
    reason: typeof raw.reason === "string" ? raw.reason : "",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    evidence: {
      changed_files: stringArray(evidence.changed_files, "$.evidence.changed_files", violations),
      result_revision: nullableString(evidence.result_revision, "$.evidence.result_revision", violations),
      tests: stringArray(evidence.tests, "$.evidence.tests", violations),
      artifacts: stringArray(evidence.artifacts, "$.evidence.artifacts", violations),
    },
    follow_up: {
      unresolved: stringArray(followUp.unresolved, "$.follow_up.unresolved", violations),
      decisions_requested: stringArray(followUp.decisions_requested, "$.follow_up.decisions_requested", violations),
      next_step: nullableString(followUp.next_step, "$.follow_up.next_step", violations),
    },
    usage: {
      model: nullableString(usage.model, "$.usage.model", violations),
      input_tokens: nullableInt(usage.input_tokens, "$.usage.input_tokens", violations),
      output_tokens: nullableInt(usage.output_tokens, "$.usage.output_tokens", violations),
    },
    addressed_requirements: stringArray(raw.addressed_requirements, "$.addressed_requirements", violations),
  };

  return { ok: violations.length === 0, output: violations.length === 0 ? output : null, violations };
}

/** A contract violation is its own failure class; it is never a code failure. */
export const CONTRACT_FAILURE: FailureClass = "CONTRACT";
