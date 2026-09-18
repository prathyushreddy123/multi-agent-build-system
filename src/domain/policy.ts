/**
 * Approval policy.
 *
 * Enforcement lives in the controller, not in a prompt. A worker never decides
 * that an action was approved; it can only ask the controller to perform one,
 * and the controller refuses without a valid, non-stale approval.
 */
export const ACTIONS = [
  "edit_worktree",
  "run_checks",
  "local_commit",
  "add_runtime_dependency",
  "breaking_interface_change",
  "scope_change",
  "architecture_change",
  "push_branch",
  "open_pull_request",
  "merge",
  "deploy",
  "destructive_migration",
  "shared_data_deletion",
  "waive_required_gate",
  "activate_config_change",
] as const;
export type Action = (typeof ACTIONS)[number];

export type ApprovalRule = "automatic" | "approval_required" | "automatic_if_in_scope" | "standing_authorization";

export interface ProjectApprovalPolicy {
  /** Per-action override of the default policy. */
  overrides: Partial<Record<Action, ApprovalRule>>;
  /** Actions the project owner has pre-authorized, e.g. push_branch. */
  standing: Action[];
}

/** Initial policy from the plan's approval table. */
export const DEFAULT_POLICY: Record<Action, ApprovalRule> = {
  edit_worktree: "automatic",
  run_checks: "automatic",
  local_commit: "automatic",
  add_runtime_dependency: "automatic_if_in_scope",
  breaking_interface_change: "automatic_if_in_scope",
  scope_change: "approval_required",
  architecture_change: "approval_required",
  push_branch: "standing_authorization",
  open_pull_request: "standing_authorization",
  merge: "approval_required",
  deploy: "approval_required",
  destructive_migration: "approval_required",
  shared_data_deletion: "approval_required",
  waive_required_gate: "approval_required",
  activate_config_change: "approval_required",
};

/** Actions whose external effect cannot be safely replayed after an uncertain outcome. */
export const CONSEQUENTIAL_ACTIONS: readonly Action[] = [
  "push_branch",
  "open_pull_request",
  "merge",
  "deploy",
  "destructive_migration",
  "shared_data_deletion",
];

export function isConsequential(action: Action): boolean {
  return CONSEQUENTIAL_ACTIONS.includes(action);
}

export interface ApprovalDecisionInput {
  action: Action;
  policy?: ProjectApprovalPolicy;
  /** True when the task scope explicitly included this action. */
  inScope?: boolean;
}

export interface PolicyDecision {
  requiresApproval: boolean;
  rule: ApprovalRule;
  reason: string;
}

export function evaluate(input: ApprovalDecisionInput): PolicyDecision {
  const rule = input.policy?.overrides?.[input.action] ?? DEFAULT_POLICY[input.action];
  switch (rule) {
    case "automatic":
      return { requiresApproval: false, rule, reason: "Permitted inside the accepted task and assigned worktree." };
    case "approval_required":
      return { requiresApproval: true, rule, reason: "Policy requires an explicit decision for this action." };
    case "automatic_if_in_scope":
      return input.inScope
        ? { requiresApproval: false, rule, reason: "Explicitly included in the accepted task scope." }
        : { requiresApproval: true, rule, reason: "Not included in the accepted scope; requesting approval." };
    case "standing_authorization":
      return input.policy?.standing?.includes(input.action)
        ? { requiresApproval: false, rule, reason: "Covered by configured standing authorization for this project." }
        : { requiresApproval: true, rule, reason: "No standing authorization configured for this project yet." };
  }
}

/**
 * An approval is bound to the exact action, target, revision, and
 * configuration it was granted against. Any drift invalidates it: approving a
 * merge of revision A is not approval to merge revision B.
 */
export interface ApprovalBinding {
  action: Action;
  target: string;
  revision: string;
  configVersion: string;
}

export function bindingMatches(granted: ApprovalBinding, current: ApprovalBinding): boolean {
  return (
    granted.action === current.action &&
    granted.target === current.target &&
    granted.revision === current.revision &&
    granted.configVersion === current.configVersion
  );
}

export function describeStaleness(granted: ApprovalBinding, current: ApprovalBinding): string[] {
  const drift: string[] = [];
  if (granted.action !== current.action) drift.push(`action ${granted.action} -> ${current.action}`);
  if (granted.target !== current.target) drift.push(`target ${granted.target} -> ${current.target}`);
  if (granted.revision !== current.revision) drift.push(`revision ${granted.revision} -> ${current.revision}`);
  if (granted.configVersion !== current.configVersion) {
    drift.push(`config ${granted.configVersion} -> ${current.configVersion}`);
  }
  return drift;
}
