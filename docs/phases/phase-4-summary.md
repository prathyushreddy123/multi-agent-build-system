# Phase 4 summary — approval-gated configuration curator

Completed: 18 September 2026

## Outcome

Phase 4 adds an on-demand configuration curator that can analyze recurring operational evidence, materialize a bounded configuration proposal on an isolated local Git branch, evaluate it, and prepare an exact activation approval. It cannot activate its own proposal. Activation and revert both require explicit owner approvals and remain local to MABS configuration.

## Delivered

### Versioned configuration

Project configuration snapshots now include:

- routing profile and verified per-task-class route overrides;
- approval policy and review policy;
- explicit deterministic quality commands;
- bounded implementation, review, and research prompt addenda;
- controller default repair limit.

Every new project starts with an active configuration version. Ordinary changes to checks, policy, review mode, or target branch create new history where applicable and invalidate open approvals. Schema v8 migrates legacy `config_versions` tables before indexing project history.

### Rules-first safety

Candidate validation rejects:

- unknown configuration fields or task classes;
- provider/model/effort combinations not present in the verified routing policy;
- empty, destructive, publication-oriented, or non-local quality commands;
- absolute or escaping quality-command working directories;
- consequential-action policy weakened below `approval_required`;
- prompt text attempting to bypass approval/policy or use paid/API-key access;
- prompt addenda over 4,000 characters;
- automatic repair limits above two.

Activated routing overrides are applied only when their exact verified candidate is currently eligible; otherwise the controller retains an eligible subscription-policy fallback and records the reason. Activated prompt addenda are explicitly subordinate to scope, approval, paid-access, and worker-contract rules.

### Analysis and proposal isolation

- `curator analyze` reads durable task/attempt failures, repair counts, review findings, routing overrides, provider failures, repeated questions, and rejected proposal fingerprints.
- Analysis is explicit and on demand; no model or curator daemon polls continuously.
- `curator snapshot` exports a complete editable configuration.
- `curator suggest` derives a bounded candidate only when recurring code/contract failures, review repairs, repeated questions, or repair pressure match explicit rules; otherwise it refuses to invent a change.
- `curator propose` fingerprints the candidate and evidence, then creates an isolated worktree and local `mabs/curator/<proposal>` branch.
- The branch contains a config-only `.mabs/proposals/<id>.json` commit. A diff is retained outside Git.
- Proposal creation never updates, merges, or pushes the configured target branch.
- Equivalent rejected/open proposals against unchanged evidence are refused. Changed evidence allows reconsideration while retaining prior outcomes.

### Evaluation

`policy-replay-v1` performs deterministic safety cases and compares observable historical metrics for the current and proposed configuration:

- completed, failed, and blocked tasks;
- repair cycles and review-requested changes;
- required gate count;
- route changes;
- prompt size;
- raw reported input/output tokens when every included attempt reported them.

Unknown usage remains null. Evaluation evidence explicitly states that policy replay does not prove candidate product-task quality, subscription spend, or remaining quota. A targeted Phase 5 experiment is required for an improvement claim.

### Approval, activation, and revert

Activation requires:

1. an evaluated proposal with a passing latest evaluation;
2. retained proposal revision and diff evidence;
3. an unchanged base configuration;
4. an approved `activate_config_change` binding matching proposal ID, Git revision, and current config version.

Activation and revert first require a safe checkpoint with no project task in `RUNNING`, `CHECKING`, or `REVIEWING`. The atomic activation transaction then consumes the approval, activates the candidate, updates effective project configuration, records actor/reason/history, invalidates other open approvals, and supersedes competing proposals.

Revert follows the same approval boundary. It copies a selected historical payload into a new version rather than silently making history mutable. Activation history retains the source historical version, previous and new active versions, approval, actor, reason, and timestamp.

### Interfaces

- CLI commands cover analyze, snapshot, rules-first suggest, explicit propose, list/show, evaluate, reject, request activation, activate, request revert, revert, and history.
- Pi adds `/mabs-curate` over the same CLI and SQLite records.
- The workbench shows proposals, candidate configuration, diff/evaluation evidence, activation approvals, activation history, rejection, activation, and revert controls.
- Operational metrics include curator proposal/rejection and configuration activation counts.

## Verification

```text
npm test                         35 passing
npm run typecheck                passing
git diff --check                 passing
node src/cli.ts verify --quick   3/3 passing
Pi RPC extension load            passing
```

Phase 4 tests cover:

- legacy schema migration ordering;
- proposal branch isolation from the target branch;
- strict config validation;
- no self-activation;
- evaluation-before-approval enforcement;
- approval-before-activation and active-task safe-checkpoint enforcement;
- effective routing, prompt, and repair-default changes after activation;
- exact approval consumption and durable history;
- independently approved revert;
- duplicate rejected-suggestion suppression;
- stale approval/config rejection.

## Real acceptance

Evidence directory:

`~/.local/state/mabs/acceptance/phase4-2026-09-18T15-18-10Z`

The acceptance workflow used only the public CLI:

1. Registered a local fixture project and exported its baseline configuration.
2. Proposed a bounded routing, prompt, and repair-default change.
3. Materialized proposal `prp_01M2THHDNBTG3PMD392XGZH9E1` on branch `mabs/curator/prp_01m2thhdnbtg3pmd392xgzh9e1`, revision `b023eb4e53b41e605438c1f3b769ea56457c63a5`.
4. Confirmed the target `main` revision remained unchanged.
5. Confirmed activation failed before evaluation.
6. Ran `policy-replay-v1`; all 17 bounded policy cases passed and comparison evidence was retained.
7. Confirmed activation still failed before approval.
8. Approved the exact activation binding and activated the candidate; the approval was consumed.
9. Prepared and approved a separate revert, restoring the initial payload as a new auditable version.
10. Confirmed history contains both activation and revert, including the source historical version.

`acceptance.json`, `report.md`, analysis, proposal, evaluation, approval decisions, activation/revert results, history, SQLite state, proposal branch/worktree, and diff evidence remain outside Git in the evidence directory.

No subscription API, extra credit, push, merge, release, deployment, or destructive executor was used.

## Phase 5 handoff

Phase 5 should run narrowly targeted experiments only where existing measurements identify a bottleneck or reliability gap. Candidate improvements may involve context selection, routing, or optional infrastructure, but each must compare accepted outcomes, interventions, repair cycles, elapsed time, and raw reported usage against a baseline. Do not present policy replay or API-equivalent estimates as evidence of subscription cost savings.
