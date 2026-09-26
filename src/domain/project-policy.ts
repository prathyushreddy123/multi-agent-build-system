export const PROJECT_POLICY_VERSION = "mabs.project-governance.v1";

export const PROJECT_TYPES = ["personal", "client", "other"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const REVIEW_CHOICES = ["off", "risk", "required"] as const;
export type ReviewChoice = (typeof REVIEW_CHOICES)[number];

export interface ProjectGovernance {
  projectType: ProjectType | null;
  reviewChoice: ReviewChoice | null;
  decisionState: "unresolved" | "confirmed";
  decisionId: string | null;
  policyVersion: string;
  version: number;
}

export interface GovernanceQuestion {
  key: "project_type" | "review_choice";
  prompt: string;
  choices: readonly string[];
}

export interface ProjectReadiness {
  ready: boolean;
  missing: string[];
  conflicts: string[];
  questions: GovernanceQuestion[];
}

export interface ProjectPolicyDecision {
  id: string;
  projectId: string | null;
  briefId: string | null;
  expectedVersion: number;
  projectType: ProjectType;
  reviewChoice: ReviewChoice;
  resolvedPolicy: Record<string, unknown>;
  actor: string;
  source: string;
  sourceRef: string | null;
  createdAt: string;
}

export function unresolvedGovernance(): ProjectGovernance {
  return {
    projectType: null,
    reviewChoice: null,
    decisionState: "unresolved",
    decisionId: null,
    policyVersion: PROJECT_POLICY_VERSION,
    version: 0,
  };
}

/** Pure readiness evaluation. Null means missing input, never permission. */
export function evaluateProjectReadiness(governance: ProjectGovernance): ProjectReadiness {
  const missing: string[] = [];
  const conflicts: string[] = [];
  const questions: GovernanceQuestion[] = [];

  if (governance.projectType === null) {
    missing.push("project_type");
    questions.push({
      key: "project_type",
      prompt: "Is this a personal, client, or another type of project?",
      choices: PROJECT_TYPES,
    });
  } else if (governance.projectType === "client") {
    if (governance.reviewChoice === "off") {
      conflicts.push("Client code changes require independent review; review cannot be off.");
    } else if (governance.reviewChoice === null) {
      missing.push("review_choice");
      questions.push({
        key: "review_choice",
        prompt: "Confirm the mandatory independent-review policy for this client project.",
        choices: ["required"],
      });
    }
  } else if (governance.reviewChoice === null) {
    missing.push("review_choice");
    questions.push({
      key: "review_choice",
      prompt: governance.projectType === "personal"
        ? "Choose no automatic review, risk-based review, or review for every code change."
        : "Choose an explicit review policy for this project.",
      choices: REVIEW_CHOICES,
    });
  }

  if (governance.decisionState !== "confirmed" || governance.decisionId === null || governance.version < 1) {
    missing.push("confirmed_decision");
  }
  return {
    ready: missing.length === 0 && conflicts.length === 0,
    missing: [...new Set(missing)],
    conflicts,
    questions,
  };
}

export function assertGovernanceDecision(projectType: ProjectType, reviewChoice: ReviewChoice): void {
  if (!PROJECT_TYPES.includes(projectType)) throw new Error(`Unknown project type: ${projectType}`);
  if (!REVIEW_CHOICES.includes(reviewChoice)) throw new Error(`Unknown review choice: ${reviewChoice}`);
  if (projectType === "client" && reviewChoice !== "required") {
    throw new Error("Client projects require the required review choice.");
  }
}
