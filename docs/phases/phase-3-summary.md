# Phase 3 summary — independent review and workbench feedback

Completed: 18 September 2026

## Outcome

Phase 3 makes quality evidence and independent review part of the normal substantive-task lifecycle, then exposes the resulting plans, outputs, findings, context health, feedback, and approvals through one localhost workbench. A task cannot reach `DONE` under substantive review policy until required gates pass on its current revision and a fresh review context approves that same revision.

## Delivered

### Independent review and bounded feedback

- Project review policies support `required`, `substantive`, and `none` modes.
- New CLI-onboarded projects default to substantive review; mechanical, planning, and research work can be policy-skipped because it does not represent a substantive code diff.
- Review attempts are ordinary capacity-accounted subscription workers with `kind=review` and durable process/session/evidence records.
- Routing prefers an eligible provider other than the implementer. If only one provider is eligible, the controller uses a fresh, separate read-only context and records that rationale.
- Reviewer packets include authoritative requirements, the exact checked revision, the implementation diff, and current gate evidence. They do not depend on the implementer's hidden reasoning.
- The controller rejects a reviewer that changes tracked content or moves the checked revision.
- Reviews persist `approved`, `request_changes`, or `blocked` verdicts, requirement IDs checked, summaries, severity-prefixed findings, and evidence paths.
- Actionable findings consume one bounded code-repair cycle, return to implementation, rerun gates on the new revision, and require a fresh review.
- Provider failures during review can reroute at an attempt boundary without consuming code-repair budget.

### Gate and approval enforcement

- Required gates run before substantive review. Missing or failed required gates cannot reach review or completion.
- Approval preparation checks the exact task revision, required gate evidence, and—when policy requires it—an approved independent review for that revision.
- Approval decisions fail closed when the task revision, project configuration, or merge target changes.
- Changing checks, approval policy, review policy, or the target branch proactively invalidates open approvals.
- Applying a required-gate waiver requires and consumes an exact approved `waive_required_gate` binding.
- Push, pull-request, merge, release, deployment, and destructive-action executors were intentionally not added. Approval records do not execute external actions.

### Plans and durable feedback

- Valid execution plans are now persisted with objective, mode, rationale, assumptions, milestones, item keys, task IDs, and dependencies.
- Plan views show task state, dependency structure, execution rationale, and routing rationale.
- Comments, questions, answers, priority changes, and requested changes are durable SQLite records.
- An unanswered question queues one on-demand, read-only research response task. Its result summary resolves the feedback record; a manual answer cancels the response task when it has not started. There is no permanent orchestrator loop.
- Mutations require the target record version. Stale feedback is rejected rather than silently attached to changed work.
- A requested task change creates a scoped sequential follow-up task linked to the original task, preserving active work and applying the request at a safe dependency boundary.
- Pending versus applied/answered feedback remains visible in the CLI and workbench.

### Workbench and diagnostics

- The localhost workbench now includes projects, plans, active workers, tasks, attempts, route/model/effort, reported usage, latency, gates, review findings, evidence, feedback, approvals, providers, operations, and controller health.
- Task troubleshooting includes the event timeline, failure category/reason, retry/cancel controls, raw evidence links, and context warnings.
- Context diagnostics report mandatory requirement coverage, stale packet revisions, missing manifests, omitted records, and missing evidence without inventing a context-loss percentage.
- Artifact reads are restricted to regular files under the MABS evidence directory and resolve symlinks before enforcing that boundary.
- Browser mutations remain protected by a random per-process capability token and localhost-only binding.
- Pi adds `/mabs-feedback` and `/mabs-approval` commands over the same durable records.

## Verification

```text
npm test                         32 passing
npm run typecheck                passing
git diff --check                 passing
Pi RPC extension load            passing
```

The Phase 3 tests cover:

- gate-before-review lifecycle enforcement;
- review-requested changes returning through one repair, gate rerun, and fresh re-review;
- read-only reviewer enforcement and revision-bound review evidence;
- failed-gate logs preventing completion;
- approval preparation refusal for failing evidence;
- exact approved gate-waiver consumption;
- revision and target/configuration approval invalidation;
- plan persistence and optimistic-version feedback;
- question/answer durability, on-demand response linking, and requested-change follow-up tasks;
- evidence/context diagnostics and workbench mutation protection.

## Real subscription acceptance

Evidence directory:

`~/.local/state/mabs/acceptance/phase3-2026-09-18T14-29-29Z`

A real controller-managed task fixed an intentionally incorrect addition function:

1. Codex implemented the change in its isolated worktree.
2. The discovered `npm test` gate passed against revision `9b2e8b57a34c516d85fe534557f6eb59eb5694fa`.
3. Only after the gate passed, Claude Sonnet 5 received a fresh read-only review packet containing the diff, requirement `REQ-ADD`, and gate evidence.
4. Claude independently approved the exact revision with no findings and explicitly reported checking `REQ-ADD`.
5. The task reached `DONE` with zero repairs.

The retained diagnostics report two context packets, complete mandatory-requirement coverage, no missing evidence, and no observable context warnings. Worker transcripts, completion envelopes, strict outputs, gate logs, review diff, context manifests, controller-cycle logs, SQLite state, `acceptance.json`, and `report.md` remain outside Git in the evidence directory.

For the stale-approval acceptance check, the controller prepared a deployment approval for the checked/reviewed fixture revision without executing any deployment. Changing the fixture target branch invalidated the approval. A subsequent approve command exited non-zero because the decision was no longer pending. No push, merge, release, or deployment occurred.

## Phase 4 handoff

Phase 4 should build the on-demand configuration curator over the existing review, evidence, plan, and approval primitives:

1. Represent configuration proposals and activation/revert history durably.
2. Produce proposals as isolated Git diffs; the curator cannot activate them.
3. Evaluate each proposal on a small representative suite and retain comparison evidence.
4. Require an exact `activate_config_change` approval bound to the proposal revision and current configuration.
5. Prevent repeated rejected suggestions and support reverting an activated version.

Do not add paid API fallback or external publication/deployment executors while implementing the curator.
