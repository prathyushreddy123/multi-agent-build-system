# MABS reliability, efficiency, and adaptive execution

> **Detailed implementation and validation guide — proposed, not authorized for execution.**
> This document is the repository-local implementation reference. SQLite remains authoritative for proposal acceptance, task execution, approvals, and evidence. Nothing in this file starts workers, enables reviews, changes model settings, migrates the live database, or raises concurrency.

## Document control

| Field | Value |
| --- | --- |
| Document version | 1.1 |
| Prepared | 2026-09-25 |
| Inspected repository revision | `c613f93fc0ab347b5c374d4a5adbbd04318bb502` |
| Inspected SQLite schema | `14` |
| Historical snapshot time | `2026-09-25T09:57:19.347631+00:00` |
| Consolidated brief | `brf_01M3BZCKEKVVKJFEHPY5ZJ2TFC`, version 2 |
| Validated proposal | `prv_01M3C138YAVZKGNM4W1F0GKVNK`, version 2 |
| Proposal fingerprint | `3538c929ba0e39109bce5b8ec95f940c698f0b84756c1832b1c32622c8dbd099` |
| Acceptance | **Not recorded. Ask for acceptance of the exact proposal before implementation.** |
| Primary codebase | Existing MABS TypeScript/Node.js application, npm lockfile, native SQLite |
| Historical review debt | Report only; any retrospective review is separately authorized |

Proposal version 2 supersedes the preparatory version 1. It explicitly includes the intake record mapper in T02 and affected legacy test fixtures in T03, so governance changes do not require a hidden scope expansion or a test-only enforcement bypass. Neither proposal has been accepted for execution.

The user accepted the planning recommendations, with an important correction: **review policy must depend on an explicitly supplied project type. Personal projects require a review choice; client code changes require independent review; an absent type must cause a question, not an inferred default.** Acceptance of that direction is not acceptance of this implementation proposal.

Earlier discussion briefs are `brf_01M3BGZ89SDVX046EW8QZF7F77` (diagnosis) and `brf_01M3BYESYJ7B0RNGHA0JARKCA3` (routing/parallelism). This consolidated brief and proposal supersede them as the planning reference; do not submit three overlapping plans.

### How to use this guide

1. Read sections 1–4 before coding. They define the evidence, scope, invariants, and mandatory project-policy behavior.
2. Read sections 5–13 as component specifications. Paths marked **new** are proposed, not existing features.
3. Execute the work packages in section 14 only after exact-plan acceptance and required project decisions. Check their allowed scope in the stored proposal.
4. Use the test matrix and commands in sections 15–16. A command proposed here is not an existing CLI capability unless explicitly labeled existing.
5. Use sections 17–18 for controlled activation and rollback. Implementation completion is not production activation.
6. Update this guide with implemented interfaces and actual evidence. Do not silently expand scope; materially changed tasks or policies require a revised proposal and acceptance.

## Contents

1. [Objectives, decisions, and exclusions](#1-objectives-decisions-and-exclusions)
2. [Historical evidence and baseline](#2-historical-evidence-and-baseline)
3. [Architecture and ownership](#3-architecture-and-ownership)
4. [Explicit project type and review governance](#4-explicit-project-type-and-review-governance)
5. [Database contracts and migration design](#5-database-contracts-and-migration-design)
6. [Durable execution and recovery](#6-durable-execution-and-recovery)
7. [Environment readiness and failure classification](#7-environment-readiness-and-failure-classification)
8. [Usage accounting, budgets, and context](#8-usage-accounting-budgets-and-context)
9. [Model routing and agent roles](#9-model-routing-and-agent-roles)
10. [Parallel tasks and shared worker scheduling](#10-parallel-tasks-and-shared-worker-scheduling)
11. [Observability and operator experience](#11-observability-and-operator-experience)
12. [Incident memory and curator](#12-incident-memory-and-curator)
13. [Controlled optimizer experiments](#13-controlled-optimizer-experiments)
14. [Ordered implementation work packages](#14-ordered-implementation-work-packages)
15. [Detailed validation matrix](#15-detailed-validation-matrix)
16. [Commands, fixtures, and evidence production](#16-commands-fixtures-and-evidence-production)
17. [Rollout and activation gates](#17-rollout-and-activation-gates)
18. [Rollback and operational runbooks](#18-rollback-and-operational-runbooks)
19. [Completion checklist and unresolved activation prerequisites](#19-completion-checklist-and-unresolved-activation-prerequisites)
20. [References](#20-references)

## 1. Objectives, decisions, and exclusions

### 1.1 Objective

Reduce **total resources, elapsed time, and operator intervention per quality-verified change**, including failed attempts and recovery. Do not optimize merely for a cheaper initial worker, fewer reviews, or a larger number of concurrent agents.

The preferred architecture is a deterministic core with bounded model reasoning, durable evidence, and measured adaptation. Preserve the existing modular application rather than introducing microservices or a permanent team of model agents.

### 1.2 Accepted planning direction

- Native MABS CLI/UI observability first; SQLite and local artifact files remain the foundation.
- Add optional standard telemetry export, disabled until explicitly configured. No external observability stack is installed by this plan.
- Extend the existing curator and optimizer. Include bounded, manually triggered evaluations, not a separate AI-evaluation platform.
- Keep the current one-worker production setting until reliability and accounting validation succeeds.
- Provide an explicitly enabled two-model-worker pilot, initially one per provider. Higher ceilings can be represented but are not activated by this document.
- Ask for project type if missing. Never classify a project from its name, directory, language, existing preset, or the agent's judgment.
- For personal projects, record the user's independent-review decision before implementation. For client projects, enforce independent review of code changes.
- Existing required checks remain required even when a personal project explicitly chooses no independent review.
- Do not silently reopen completed historical tasks or rewrite their outcomes.
- Preserve existing permissions, subscription-only boundaries, and approval enforcement. New security-hardening work is out of scope.

### 1.3 Explicit assumptions and activation prerequisites

Subscription tiers have not been supplied. The observed local settings are baseline evidence, not proof that additional models are available or included in a subscription. **Unknown entitlement blocks activation of a new model.** Do not infer a dollar cap, remaining quota, or ability to buy credits.

The type/review choice for the MABS project itself is not yet supplied. That does not block writing this guide, but it blocks starting its implementation. The same applies to other existing projects before their next implementation.

Real benchmark budgets, provider-specific concurrency tolerance, and optimal effort settings remain to be measured. A dry-run experiment can be prepared without those values; actual model execution cannot.

### 1.4 Non-goals

- No paid API fallback, extra credits, automatic subscription upgrades, or additional provider adapter.
- No Terraform/Kubernetes deployment, vector database, autonomous monitoring agent, or distributed workflow-engine migration.
- No default use of the newest/largest model, Max/Ultra reasoning, or unbounded native subagents.
- No global restoration of reviews regardless of project type.
- No claim that policy replay proves reduced token use or code quality.
- No push, merge, deployment, live database upgrade, retrospective UI review, or production concurrency increase as a side effect of implementation.

### 1.5 Requirements and traceability

| Requirement | Deliverable | Primary work packages |
| --- | --- | --- |
| REQ-01 | Reproducible historical baseline; preserve raw evidence | T01, T04, T12 |
| REQ-02 | Explicit project classification and missing-type question | T02, T03, T14 |
| REQ-03 | Personal review consent; mandatory client review | T03, T09, T14 |
| REQ-04 | Durable stage continuation and unresolved obligations | T02, T06, T08 |
| REQ-05 | Environment preflight and correct failure/recovery treatment | T05, T06 |
| REQ-06 | Provider-normalized, coverage-aware accounting | T04, T07, T10 |
| REQ-07 | Complete-prompt budget and compact purpose-specific context | T08 |
| REQ-08 | Effective model/effort settings and eligibility-aware routing | T07 |
| REQ-09 | Safe shared-pool parallelism and fair resource admission | T06, T11 |
| REQ-10 | Live progress, scorecards, improvement board, optional export | T10, T14 |
| REQ-11 | Evidence-linked incidents, lessons, and recurrence | T12 |
| REQ-12 | Curator proposals and bounded quality-preserving experiments | T12, T13 |
| REQ-13 | Safe versioned database evolution | T01, T02, T15 |
| REQ-14 | Regression/fault tests and engine/config/environment provenance | All; final gate T15 |
| REQ-15 | Separate implementation, activation, and experiment authorization | T03, T07, T11, T13, T15 |

## 2. Historical evidence and baseline

### 2.1 Sources and observation limits

Inspected sources:

- Runtime SQLite: `/home/prat/.local/state/mabs/mabs.sqlite`, opened using SQLite read-only mode rather than the application's migrating `Store` constructor.
- Attempt artifacts under `$MABS_STATE_DIR/artifacts/<task>/<attempt>/`: `launch.json`, `context.json`, completion envelopes, worker results, review results, and gate logs.
- Current source at the repository revision in Document control.
- Local CLI help/configuration and public model documentation, read without launching inference.

The database was queried in a read transaction for the baseline. Historical tasks are complete; planning/intake records and controller heartbeats can continue to change. Audit reports must specify their table selection, task selection, observation time, parser version, and missing artifacts.

Historical-table digest observed during planning:

```text
b16adfda940a148746a71f5db4caebb3537f86f4d00dd6d6185009c006deee9b
```

Digest method: SHA-256 over the table name followed by canonical JSON (`sort_keys=True`, compact separators, rows ordered by `rowid`) for `projects`, `tasks`, `task_dependencies`, `attempts`, `gate_results`, `review_results`, and `task_checkpoints`, in that order. This is an observation identifier, not a permanent checksum of the evolving live database. A later legitimate configuration change can alter it. Fixture checks must compare an explicitly selected snapshot, not require the live database to match forever.

### 2.2 All historical tasks

`A` = attempts including failed launches; `R` = recorded completed reviews; `CR` = review change requests; `Retry` = explicit retry-request events. A successful worker process is not equivalent to an approved task.

| Ref | Project/task | Task ID | A | R | CR | Retry |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| H1 | Study assistant: learner assessment, curriculum, persistence, CLI | `tsk_01M2XJXQYX7XMBTQGQTC7YR4NH` | 6 | 3 | 2 | 0 |
| H2 | Study assistant: evidence-verified resource retrieval | `tsk_01M2XJXQYXT5FD2S9T3HNJ1AQY` | 4 | 2 | 1 | 1 |
| H3 | Study assistant: daily packets and reports | `tsk_01M2XJXQYYKNT105TJVGKXNWPF` | 4 | 2 | 1 | 0 |
| H4 | Study assistant: vertical-slice hardening | `tsk_01M2XJXQYYAY0EA9CMBRTNH705` | 4 | 2 | 1 | 0 |
| H5 | Study assistant: requested follow-up change | `tsk_01M2XQKVHW2QHKNEF17M4KZWFN` | 2 | 1 | 0 | 0 |
| H6 | MABS UI: popup launcher (T1 in earlier discussion) | `tsk_01M3A915GRHN8A1VE6AH7V8QAE` | 5 | 1 | 0 | 2 |
| H7 | MABS UI: reusable Tasks/Logs tabs (earlier T2) | `tsk_01M3A915GRJPGY0KT99K6EXJ5N` | 10 | 2 | 2 | 4 |
| H8 | MABS UI: VS Code integration (earlier T3) | `tsk_01M3A915GS5HCR3ME8XX9Y4QBD` | 2 | 0 | 0 | 1 |
| H9 | MABS UI: verification/documentation (earlier T4) | `tsk_01M3A915GS53XEK9RJKCQPX4T6` | 4 | 0 | 0 | 1 |
| Total | 9 tasks, all historically DONE | | 41 | 13 | 7 | 9 |

Additional totals: 40 gate results (37 PASS, 1 FAIL, 2 ERROR), 60 checkpoints, one applied request-change feedback record, and zero curator proposals/optimization experiments at the historical execution snapshot. Planning records created while writing this guide are not execution experiments.

### 2.3 Usage baseline

| Cohort | Known input/cache token events | Known output tokens | Missing-usage attempts | Worker elapsed milliseconds |
| --- | ---: | ---: | ---: | ---: |
| Study assistant H1–H5 | 26,335,484 | 308,383 | 0 | 5,950,278 |
| MABS UI H6–H9 | 56,712,129 | 368,642 | 5 | 6,640,128 |
| Combined | 83,047,613 | 677,025 | 5 | 12,590,406 |

The historical calculation uses Codex `input_tokens` **without adding its cached subset again**. Claude input events include `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. These are repeated provider-reported input events, not unique tokens or subscription charges. Preserve per-provider dimensions; the combined number is descriptive, not a normalized billing unit.

The UI figures are incomplete known subtotals. Missing usage must not become zero. Worker elapsed time is the sum of completed attempt durations, not total wall-clock lead time, and includes failed attempts.

### 2.4 Confirmed findings and regression seeds

| Evidence | Observation | Required response |
| --- | --- | --- |
| H6 first implementation, `att_01M3A91MCWXPE4AE13NXXMB9KX` | Recorded CONTRACT failure: `plugins/` classified outside allowed scope | Preserve regression for untracked directory expansion; current `workspaceChangedFiles` already contains the fix |
| H6 review launch, `att_01M3AC43D3CN6V5NDERB18ZEY5` | Missing Claude native binary recorded as CODE; subsequent retry ran implementation again | Classify missing binary operationally; resume REVIEW, not IMPLEMENT |
| H7 repair `att_01M3ATD35EDRBG83MGE5ZFSAGT` to fallback `att_01M3ATD90N0SSYNZQYXV0PA178` | Latest quota checkpoint replaced supplied repair findings with `Reading additional input from stdin...` | Preserve obligations independently of operational failure checkpoints |
| H7 Claude worker results and `src/verify/launch.ts` | Worker could not run Node/npm checks with its allowed tools | Model-free readiness/capability validation and controlled check execution; do not broadly bypass permissions |
| H8/H9 initial typecheck logs | Exit 127, `tsc: not found`, gate ERROR followed by model repair | Environment recovery must not consume code-repair budget |
| H7 FAILED followed by DONE; H8 retry event | Downstream dependency block required manual retry | Re-evaluate dependency-only blocks when prerequisites change |
| H7 repeated dependency integration events | Historical repeated integration; current Git code has retained-worktree/empty-cherry-pick handling | Regression-test current fixes; do not claim they remain wholly unimplemented |
| Actual `launch.json` versus `context.json` | Sent prompts roughly 80–82 KB, manifests roughly 144–156 KB; reported estimate near 12,000 tokens | Budget actual assembled prompt; do not mistake manifest duplication for model input |
| H7 repair packet | Roughly 16 KB of omitted-file inventory, repeated findings in multiple sections | Keep diagnostic inventory in artifacts; deduplicate findings by stable identity |
| Local defaults and adapter types | Sol/high and Opus/high configured locally; per-task effort absent from launch contract | Carry explicit settings, test argv, and record effective-setting uncertainty |
| `src/optimization/routing.ts` | Uses nonexistent `finished_at`; ignores Claude cache fields; eventual DONE credits failed routes | Normalize duration/usage and distinguish contribution from successful completion |
| `src/optimization/experiments.ts` | Aggregate safeguards permit some cost regressions when another metric improves | Predeclare primary metric/tolerances and use per-case quality safeguards |
| H1 second review `rev_01M2XKZDVS0J2JXG46XJ7J19WD` | Review calls backlog issue non-blocking, but clarification becomes `[major] Decision required` and triggers repair | Distinguish advisory questions, genuine blockers, and reproducible defects; do not rewrite historical verdict |
| H2 review | Double retrieval and missing CLI integration coverage detected | Include integration-boundary tests; review found useful product defects |
| H3 review | Incorrect cross-topic resource reuse detected despite passing tests | Requirement coverage must validate behavior, not just test exit codes |
| H4/H5 reviews | Real rendering/evidence defects and later minor advisories | Preserve review value; reducing cycles must not hide defects or force minor advice into repair |

### 2.5 Review coverage and interpretation

H1–H6 have an approved review matching their final task revision. H7–H9 do not. MABS's review policy was explicitly switched off during the UI execution with a recorded user reason; this guide neither reverses that historical decision nor claims those final revisions were reviewed.

Record a visible follow-up item for each gap. Running those reviews requires separate scope/authorization. Do not change old DONE tasks to FAILED, backdate approval, or invent evidence.

Only three completed reviews belong to the UI cohort, accounting for about 6.55 million known input/cache events. The majority of consumption was elsewhere. Do not use the incident as justification for disabling all independent review.

### 2.6 Candidate defects requiring tests before classification as incidents

Source inspection suggests additional scaling risks: head-of-line blocking in candidate scanning, active-project admission checked on a stale candidate list, shared checks running inside the controller tick, prefix-only scope normalization, and independent-provider review falling back to the same provider. Build focused tests first. Record these as hypotheses until reproduced; do not present them as historical causes of the observed token total.

## 3. Architecture and ownership

### 3.1 Logical layers, not new services

```text
User decisions / accepted project configuration
                    |
                    v
Intake readiness -> deterministic controller -> bounded job admission
                         |                          |
                         |                +---------+----------+
                         |                |                    |
                         |          model adapters       check workers
                         |                |                    |
                         +------ durable evidence / stage results
                                          |
                        SQLite journal + bounded local artifacts
                                          |
                    +---------------------+-------------------+
                    |                     |                   |
              native diagnostics    incident projection   usage projection
                    |                     |                   |
                    +---------------- curator suggestions ----+
                                          |
                           bounded optimizer experiments
                                          |
                           exact-version human approval
                                          |
                              safe configuration activation
```

### 3.2 Ownership map

| Owner/module | Responsibility | Must not do |
| --- | --- | --- |
| `src/intake/`, **new** `src/domain/project-policy.ts` | Ask/store type and review decisions; readiness evaluation | Infer type or treat absent personal choice as no |
| `src/store/` | Transactional authoritative state and versioned records | Rewrite source evidence during analytics backfill |
| `src/controller/`, **new** `src/domain/execution.ts` | Stage transitions, obligations, recovery, acceptance | Decide model truth from prose alone; launch outside admission |
| **new** `src/environment/`, existing `src/profiles/` | Actual-workspace readiness and setup plans | Install packages or expand permissions implicitly |
| `src/core/failure.ts` | Evidence-based failure category and safe action | Treat unknown nonzero exit as automatically a code defect |
| `src/adapters/`, `src/verify/launch.ts` | Explicit launch settings, streaming parsing, cancellation | Change global user configuration or hide child agents |
| **new** `src/usage/` | Versioned provider accounting and coverage | Estimate missing usage as measured zero |
| `src/context/`, `src/prompts/` | Purpose-specific full-budget handoff | Copy all incident history or omit mandatory obligations silently |
| `src/gates/`, `src/review/` | Check evidence, independent review, finding lifecycle | Self-approve implementation or conflate questions with defects |
| **new** `src/scheduling/` | Common bounded admission and project fairness | Raise approved capacity ceilings or buy quota |
| **new** `src/telemetry/`, existing diagnostics/operator | Live visibility, redacted metadata, optional export | Become authoritative task state or block on exporter outage |
| **new** `src/incidents/` | Incidents, verified lessons, recurrence | Treat hypotheses as verified root causes |
| `src/curator/` | Bounded evidence-backed proposal generation | Fix engine defects by silently increasing prompts/repair limits |
| `src/optimization/` | Controlled comparisons and experiment evidence | Claim replay proves candidate code quality; activate own result |

Skills may guide diagnosis, repair, and review reasoning. Permissions, state transitions, review consent, budgets, and activation belong in typed contracts and code. No additional permanent agent role is required for monitoring or aggregation.

### 3.3 Core invariants

1. Every worker/check launch has a durable stage ID, idempotency key, admission reservation, and exact work identity before external work begins.
2. At most one active mutation owner exists for a task workspace. Check/review snapshots cannot drift underneath their evidence.
3. Operational failures never replace open code/requirement obligations.
4. Required reviews and checks are satisfied by revision-bound evidence, not by a worker's completion prose.
5. Unknown project type or required personal choice means **not ready for implementation**.
6. Client review cannot be disabled by routing, curator, capacity shortage, or an intake default.
7. Missing telemetry remains missing; source evidence survives revised accounting.
8. All paths to initial, repair, review, reroute, and resumed jobs use the same admission authority.
9. Stop admitting new work under pressure; do not kill useful workers merely to shrink desired concurrency.
10. No derived incident/metric/export failure can fabricate task progress.

## 4. Explicit project type and review governance

### 4.1 Separate project type from review preset

The existing `ReviewPreset` (`experiment`, `personal`, `client`, `custom`) is not proof of the user's project type. `DEFAULT_REVIEW_POLICY` currently selects personal behavior; that default must no longer satisfy intake readiness.

Proposed typed contract:

```ts
// Proposed interface; implement in domain/project-policy.ts, not as prompt text.
type ProjectType = "personal" | "client" | "other";
type ReviewChoice = "off" | "risk" | "required";
interface ProjectGovernance {
  projectType: ProjectType | null;
  reviewChoice: ReviewChoice | null;
  decisionState: "unresolved" | "confirmed";
  decisionId: string | null;
  policyVersion: string;
}
```

`other` is an explicit user category, not a fallback for missing information. It requires an explicit review policy before implementation. `null` is permissible for a draft or migrated project, never as permission to dispatch implementation.

### 4.2 Decision table

| Explicit type | User review answer | Implementation readiness | Resulting behavior |
| --- | --- | --- | --- |
| Missing | Any | Blocked awaiting project type | Ask: “Is this personal, client, or another type of project?” |
| Personal | Missing | Blocked awaiting review choice | Ask before implementation; offer no review, risk-based, or every change |
| Personal | No/off | Ready if other gates satisfied | No automatic independent review; required checks remain |
| Personal | Yes, with no narrower policy specified | Ready after showing resolved policy | Proposed interpretation: independent review for code changes (`required`); record this resolution, not silent risk-only review |
| Personal | Risk-based | Ready | Existing risk rules determine when an independent review is required |
| Client | Missing | Ready once client policy is presented/bound and other gates satisfied | Independent code review is mandatory; do not ask whether it can be disabled |
| Client | Off | Not ready: conflicting request | Explain mandatory client review; do not silently accept off or recategorize |
| Other | Missing | Blocked awaiting explicit quality decision | Ask; no inferred default |
| Other | Explicit supported policy | Ready if policy valid | Apply exact recorded policy |
| Legacy unclassified | Existing preset any value | New implementation blocked | Preserve old policy and outcomes; ask type/choice before new implementation |

This guide chooses conservative task-level independent review for client code-producing tasks, with final integration coverage as needed. It does not introduce release-only deferred review as a shortcut. Existing required behavior must not be weakened silently. Pure read-only research or deterministic no-change checks need no separate code-review worker; record a specific no-code-change reason based on observed changes, not only a task label.

For personal projects, ask once per unresolved project decision, not before every task after the user has made a durable choice. Ask again if classification/policy changes, the answer is missing/stale, or a task requests an exception requiring a separate decision.

### 4.3 Intake and all entry points

Implement one pure readiness evaluator returning:

```ts
// Proposed result contract.
{ ready: boolean, missing: string[], conflicts: string[], questions: Question[] }
```

Call it from:

- Brief creation/update/proposal/acceptance preparation.
- Bootstrap and existing-project registration.
- Accepted-plan submission and direct task submission.
- CLI commands and Pi tools.
- Controller dispatch as a final backstop.
- Configuration activation/revert and curator validation.

For unknown type, allow draft record creation, inspection, and non-mutating plan discussion. Persist a deduplicated clarification keyed by subject and decision version. Do not create a new identical question every controller tick.

Noninteractive CLI submission must return structured `needs_input` with the missing decision, not block forever on stdin or assume a value. It must create zero implementation attempts. Pi translates that result into a user question.

When a brief links to an existing project, an explicitly confirmed project decision may be reused if compatible; do not overwrite it with the brief's absent/default fields. A conflicting explicit brief decision requires a visible new project decision and policy version.

### 4.4 Storage and acceptance

Add explicit classification fields to briefs/projects and an append-only decision record containing actor, supplied answer, resolved policy, subject version, timestamp, and source clarification/event.

Bind proposal/configuration fingerprints to governance changes. If classification or personal-review choice changes materially after acceptance, invalidate stale acceptance and ask again. A human can explicitly reclassify a project, but the system cannot relabel client work as personal merely to avoid review.

Client `required` is a policy invariant across setters, direct task APIs, curator proposals, revert, and controller collection. Reverting configuration cannot reintroduce a client review-off snapshot. Same-provider review may be supported only by an explicitly chosen independence policy requiring a fresh session; the initial client policy retains `independent_provider` and waits/blocks if unavailable. Never silently substitute a forbidden same-provider route.

### 4.5 Legacy migration and current review debt

- Preserve all existing `review_policy` JSON and historical outcomes.
- Set new type/choice confirmation fields to unresolved, not personal.
- Display “legacy policy retained; classification required before new implementation.”
- Permit diagnostics and historical viewing without classification.
- Before activating the new engine, quiesce/drain active work; do not pause an already-running production attempt mid-write just to ask a new intake question.
- H7–H9 review gaps remain explicit follow-up records. Their historical approval is not inferred from a later personal no-review decision.

## 5. Database contracts and migration design

### 5.1 Migration strategy

Current `Store` construction opens a writable connection, executes schema DDL, ensures columns, and writes schema version 14. Do not use it for historical read-only audits. First add a read-only opening path that never calls `migrate()`.

For write mode:

1. Read existing schema metadata before DDL and before changing persistent pragmas where practical.
2. Reject a schema newer than the supported version, without stamping it down.
3. Apply ordered, versioned migrations in transactions; change the version only after a successful migration.
4. Make fresh-create and upgrade paths converge; defer indexes on new columns until those columns exist on legacy tables.
5. Test partial failure and repeated invocation. A failed migration must not report success.
6. Separate structural migrations from potentially lengthy historical projections/backfills.
7. Require an explicit maintenance action, stopped/drained controller, verified SQLite backup, and restore rehearsal for the live database.

Reserve the next versions after 14 during T02; record their actual allocated numbers here. Do not assume that 15 is still free if other changes land first. No destructive down migration is required; prefer forward-compatible additive changes and forward fixes.

### 5.2 Proposed additive schema

Use existing tables where their semantics fit. Do not create a second event store or duplicate provider transcripts in SQLite. The following contracts specify minimum information; exact DDL must be checked into a migration and verified against a schema-14 fixture.

| Entity | Proposed fields/constraints | Purpose |
| --- | --- | --- |
| `projects` additions | nullable `project_type`, nullable `review_choice`, `governance_decision_id`, `governance_version` | Explicit identity/choice separate from legacy preset |
| `product_briefs` additions | same nullable type/choice, confirmation/provenance reference | Carry decisions before a repository exists |
| **new** `project_policy_decisions` | ID, project/brief subject, expected version, type, choice, resolved policy JSON, actor, source, created_at; require at least one subject | Append-only evidence of human decisions |
| **new** `execution_episodes` | ID, task ID, episode number, authorizing decision, status, repair/recovery limits, consumed counters, started/ended_at; unique task/episode | Bounded explicit retry episodes without resetting lifetime history |
| **new** `stage_runs` | ID, task/episode, stage, ordinal, state, attempt/gate binding, launch key UNIQUE, input fingerprint, revision, environment fingerprint, engine revision, lease/fencing token, timestamps, failure detail | Authoritative continuation and side-effect reconciliation |
| **new** `task_obligations` | ID, task ID, kind, severity, blocking flag, source review/gate/decision, stable source key, state, introduced/resolved revision, evidence refs, clarification ID; unique source key per task | Findings survive quota checkpoints; question/defect distinction |
| `attempts` additions | stage_run ID, parent attempt/session binding, requested/configured/reported model and effort metadata, engine/CLI versions, last_progress_at, usage status | Honest launch provenance and optional child accounting |
| **new** `attempt_usage` | attempt ID + normalizer version primary key, normalized dimensions JSON, source artifact hash/offset, coverage, source semantics, updated_at | Versioned derived usage without rewriting `usage_json` |
| **new** `environment_checks` | ID, task/stage, component/profile, revision, runtime/lockfile fingerprint, outcome, evidence refs, setup action required | Preflight reuse and operational failure evidence |
| **new** `admission_leases` | ID, stage ID UNIQUE, controller/fencing owner, provider/quota domain, project, resource set, status, granted/released times | Unified concurrency accounting, recovery, resource ownership |
| **new** `incidents` | ID, signature + classifier version, category/layer, symptom, hypothesis/confirmed cause, confidence, lifecycle, affected version range, lesson/fix/test refs | Root-cause learning, not raw error duplication |
| **new** `incident_occurrences` | incident ID, unique source event/stage key, task/attempt/revision, evidence refs, observed_at | Deduplicated occurrences across copied checkpoints |
| `context_packets` additions | purpose, full prompt bytes/estimate, estimator version, section sizes, mandatory/optional counts, content fingerprint | Budget reflects actual supplied prompt |
| `routing_decisions` additions | capability registry/config version, requested/effective selection, eligibility evidence, fallback/escalation reason, quota-domain ID | Explain why a route was selected |
| `gate_results` additions | stage/job identity, environment/command/input fingerprint, raw exit/signal/timeout, failure diagnosis | Distinguish ERROR from failing product behavior |
| `optimization_*` additions | experiment protocol version, repeat index, seed if supported, primary metric/tolerances, per-case safeguards, usage coverage, run authorization, source stage/task refs | Controlled comparison, not synthetic counterfactuals |
| Existing `events` | Versioned payloads for decision, progress, admission, projection, budget, incident, and export events | Retain authoritative correlation and audit journal |
| Existing `config_versions` | Snapshot adds governance, routing/budget/scheduling policy versions | Exact activation binding; no invisible mutable defaults |

Do not add an exporter table initially: a bounded local queue and a durable export cursor/checkpoint are sufficient. Optional export is a rebuildable projection. If durable remote delivery is later required, design a separate idempotent outbox rather than claiming exactly-once external delivery.

Requirement ownership must be explicit in task records (a versioned requirement-ID set or join table). Show global requirements as context, but distinguish task-owned acceptance from final integration coverage. Do not silently drop project requirements when narrowing review. Legacy tasks without mapping retain “mapping unknown/legacy broad coverage”; they are not backfilled with invented ownership.

### 5.3 Stage and obligation enums

Proposed stages: `prepare_workspace`, `preflight`, `implement`, `finalize`, `check`, `review`, `repair`, `accept`.

Proposed stage states: `ready`, `reserved`, `launching`, `running`, `succeeded`, `failed`, `waiting`, `cancelled`, `unknown`.

The existing task states remain the coarse UI/API view: QUEUED/READY/RUNNING/CHECKING/REVIEWING/BLOCKED/FAILED/DONE/CANCELLED. Stage state is the recovery authority; do not maintain contradictory parallel state machines. Define and test the mapping in `domain/execution.ts`.

Obligation kinds: `code_defect`, `gate_failure`, `requirement_evidence`, `decision_needed`, `advisory`.

Obligation states: `open`, `addressed_pending_validation`, `resolved`, `superseded`, `withdrawn`. A worker marking a defect addressed is not sufficient to resolve it; bind resolution to check/review evidence or a recorded human decision as applicable.

### 5.4 Record APIs

Introduce narrow APIs instead of expanding arbitrary SQL writes in the controller:

```ts
// Proposed signatures, with exact domain types to be finalized in T02.
readProjectReadiness(subject): Readiness;
recordProjectDecision(input, expectedVersion): Decision;
getContinuation(taskId): Continuation;
reserveStage(input, expectedTaskVersion): Reservation;
recordLaunchStarted(stageId, fencingToken, handle): void;
finishStage(stageId, fencingToken, outcome): void;
recordObligation(input): Obligation;
resolveObligation(input, evidence): Obligation;
recordUsageProjection(input): UsageProjection;
recordIncidentOccurrence(input): Occurrence;
```

Stage transition, task state, counters, and authoritative event must commit together. Do not hold a SQLite transaction open while launching subprocesses, running tests, calling a provider, or exporting telemetry.

### 5.5 Historical projection rules

- Raw `attempts.usage_json`, review findings/verdicts, gate results, checkpoints, and task outcomes remain unchanged.
- Backfill new usage/incident projections with explicit versions and source hashes.
- Use stable unique source keys; interrupted imports resume without duplicate counts.
- Never synthesize reported effort/model, quota remaining, cost, or reviewer approval.
- Do not migrate all final tasks into new active execution episodes.
- Legacy active work must be drained or explicitly reconciled in maintenance; ambiguous state becomes `unknown/waiting`, not re-launched blindly.

## 6. Durable execution and recovery

### 6.1 Continuation contract

Each attempt receives a compact continuation derived from authoritative records, not merely `latestCheckpoint()`:

```ts
interface Continuation {
  taskId: string;
  episodeId: string;
  stageRunId: string;
  nextStage: string;
  baseRevision: string;
  currentRevision: string;
  dependencyRevisions: string[];
  openObligationIds: string[];
  blockingDecisionIds: string[];
  validEvidenceIds: string[];
  lastOperationalFailure: FailureDiagnosis | null;
  remainingBudgets: BudgetState;
  configFingerprint: string;
  environmentFingerprint: string | null;
}
```

Capture dirty-worktree status and retained partial-work evidence separately. A provider session may be resumable, but session resume must never substitute for the authoritative contract.

### 6.2 Main transitions

```text
intake ready
  -> prepare_workspace -> preflight -> implement -> finalize -> check
                                                        |         |
                                                        |         +-- CODE failure -> repair
                                                        |         +-- ENV/CONFIG error -> readiness recovery
                                                        |         +-- pass -> required review? -> review
                                                        |                                  |        |
                                                        |                                  |        +-- defect -> repair
                                                        |                                  |        +-- decision -> wait for user
                                                        |                                  |        +-- approved -> accept
                                                        |                                  +-- no -> accept with no-review-required label
                                                        +-- operational problem -> reconcile/retry finalize, not reimplement
```

At any model stage: quota/auth failure preserves the stage purpose, all open obligations, revision, and budgets. Select an eligible fallback or wait. Never replace them with the last operational error string.

### 6.3 Recovery decisions

| Failure/interruption | Resume behavior | Code-repair budget |
| --- | --- | --- |
| Provider quota during implementation | Reconcile retained changes, continue implementation with eligible provider or wait | No |
| Quota during repair | Continue the same repair obligations; retain earlier consumed repair allocation | No additional charge merely for reroute |
| Reviewer binary missing | Resolve readiness and resume review of the same valid revision | No |
| Missing compiler/check dependency | Environment readiness/setup path, then rerun affected checks | No |
| Genuine assertion/type error from changed product code | Targeted repair with evidence | Yes, once per repair episode step |
| Uncertain nonzero check exit | Diagnose; do not automatically classify as code | Not until classified |
| Controller crashes after worker launch | Reconcile launch marker, process identity, completion envelope, and reservation | No duplicate worker |
| Controller crashes after commit | Verify revision/commit marker and resume checks | No repeated implementation/commit |
| Check/review result arrives after config/revision drift | Mark evidence stale; repeat the affected validation stage | Separate invalidation reason |
| Dependency-only block clears | Re-evaluate readiness and resource admission | No |
| User pause, rejection, cancelled task, approval block | Preserve block until authorized change | No automatic resume |

### 6.4 Idempotent side effects and fencing

SQLite and OS process launch cannot form one atomic transaction. Implement a reconciliation protocol:

1. Commit a reservation/stage with a unique launch key and controller fencing token.
2. Write a launch spec tied to that key; the worker wrapper atomically claims/records launch identity before starting the provider.
3. Persist PID plus process-start identity/session marker, not PID alone, to avoid PID-reuse confusion.
4. Record completion atomically under that launch key.
5. On restart, inspect markers/process/completion evidence before deciding whether any launch is safe.
6. If execution status is ambiguous, mark it unknown and investigate. Do not launch a duplicate to “be safe.”

Use analogous operation keys for finalization, dependency integration, and check jobs. Preserve real Git conflicts as actionable failures; do not skip arbitrary failed cherry-picks because their text resembles an empty patch.

### 6.5 Checks must not monopolize the controller

Move long check execution into durable bounded jobs. The controller should schedule and reconcile them while keeping its lease/progress loop alive. The check runner receives revision, worktree, command/env fingerprint, expected output paths, and a unique job ID.

A code-mutating worker must not edit a workspace under active checks/review. Either retain an exclusive workspace lease or run checks/review on a pinned snapshot. Evidence must verify the inspected revision and any dirty state before acceptance.

Separate model-worker and gate-worker ceilings. Gate concurrency also consumes CPU/memory and must not bypass shared resource limits.

### 6.6 Retry budgets and provider cooldown

Keep lifetime totals plus explicit execution-episode counters. A retry can resume the current episode without resetting repair capacity. Replenishing capacity requires a new recorded authorization/episode; do not reset historical `repairs_used` silently or retry forever.

Store operational-recovery counts separately from code-repair counts. A repeated identical failure with unchanged environment/revision triggers backoff or a decision, not another identical reasoning attempt.

Use provider reset times when supplied in structured/reliably parsed evidence; record timezone/confidence. A generic fallback cooldown is not a measurement of quota reset. Models in the same account may share quota, so switching model families must not be assumed to restore capacity. Distinguish model-specific and account-wide limits when known.

## 7. Environment readiness and failure classification

### 7.1 Preflight the actual worktree

Reuse `src/profiles/` detection for both TypeScript/JavaScript and Python. Do not hardcode npm for every project merely because MABS uses npm.

Check:

- Repository/worktree identity, branch, pinned base, dependency integration evidence, and unexpected dirty state.
- Runtime executable/version and package manager selected by manifest/lockfile.
- Required project-local dependencies (for example `tsc`), not just PATH executables in the main checkout.
- Registered command availability and configured working directories.
- Provider CLI binary runnable without inference (`--version`/help where appropriate).
- Worker capability to invoke permitted checks, or availability of the controller-owned bounded check runner.
- Relevant filesystem access, disk headroom, and output paths.

Readiness output is `ready`, `setup_required`, `unavailable`, or `unknown`, with evidence. Cache it only against a fingerprint including worktree/runtime/lockfile/check configuration and permission/capability policy. Expire it when relevant inputs change.

### 7.2 Setup boundary

Produce explicit setup commands from the detected profile. Package installation can execute lifecycle scripts and access networks; it is not a harmless health check. Run it only under existing authorization and a bounded environment action. Do not alter the lockfile to make a check pass.

Do not “fix” Claude check permissions with unrestricted shell access. Either approve the exact required commands under the existing policy or expose controller-owned registered checks through a narrow job interface. In either case, record who ran the checks and bind evidence to the actual revision.

### 7.3 Failure contract

```ts
interface FailureDiagnosis {
  category: "provider_capacity" | "provider_auth" | "environment" |
    "host_runtime" | "controller" | "worker_contract" |
    "product_code" | "requirement" | "unknown";
  stage: string;
  symptom: string;
  causeStatus: "observed" | "hypothesis" | "confirmed";
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  classifierVersion: string;
  recoveryAction: string;
  consumesCodeRepair: boolean;
  legacyFailureClass: string | null;
}
```

Prefer structured provider/gate signals over prose. Preserve legacy failure labels as historical evidence. An unknown exception is not proof of a worker coding mistake.

A review clarification requires separate fields: whether it blocks an accepted requirement, which requirement, why existing evidence is insufficient, and the exact user decision needed. Do not assign `[major]` to every question automatically.

## 8. Usage accounting, budgets, and context

### 8.1 Normalized usage contract

Retain provider raw data and expose dimensions with provenance:

- Uncached input, cache-read input, cache-write input, total input events where derivable.
- Total output and reasoning output as a subset when provider semantics say so.
- Requested model/effort, configured launch settings, provider-reported model/effort, and unknown effective values.
- Provider/CLI schema version, source event identity, normalizer version.
- `complete`, `partial`, `unknown`, or `not_applicable` coverage.
- Known subtotal and count of measured/missing attempts; do not collapse an entire cohort to unexplained null.

Codex: `input_tokens` includes `cached_input_tokens` for the observed schema. Claude: observed cache-read/cache-creation fields are separate from `input_tokens`. Never assume all future schemas share those semantics.

Treat cumulative snapshots and incremental deltas differently. Deduplicate by stable event sequence/source identity; do not sum repeated cumulative snapshots. A final envelope may replace a prior partial projection, not add another full total. Preserve contradictory totals for diagnosis rather than silently choosing the smallest.

### 8.2 Duration and outcome attribution

Use `ended_at - started_at` for recorded historical attempt duration; validate ordering. Use monotonic elapsed measurement in new processes when possible and persist wall-clock timestamps for correlation.

Report separately:

- Worker process success.
- Product checks passed.
- Review performed and verdict.
- Task accepted under its explicit project policy.
- Contribution to a later completed task.
- Failure/recovery cost.

A failed Opus/Codex route does not become a successful route because another worker later finished the task. Do not sum task acceptance across route groups as if each group independently delivered the same task.

### 8.3 Cost and budget model

Maintain separate ledgers for actual subscription/infrastructure charges (only if supplied), observed resource consumption, and optional API-equivalent estimates. No conversion of cached token totals into a claimed subscription bill or remaining usage window.

Budget scope includes the complete task/episode, not only the currently successful attempt. Dimensions: model attempts, code repairs, operational retries, elapsed active time, tool turns where observable, prompt estimate, reported usage, and optional human-approved experiment limits.

Unknown live usage limits enforcement accuracy. Apply pre-dispatch eligibility/prompt limits, runtime duration/progress limits, and soft usage warnings where reliable. At a supported safe boundary, checkpoint and pause rather than lose work. Do not promise an exact live token cap for a provider that reports usage only after completion.

Budget exhaustion must never convert required review into approved/no-review-needed. It becomes a visible waiting decision.

### 8.4 Complete-prompt accounting

Count the final string passed to the provider after role instructions, selected guidance, worker contract, context, JSON schema, and serialization. Record:

- UTF-8 bytes and estimator version.
- Token estimate and whether a model tokenizer was used.
- Per-section byte/estimate breakdown.
- Mandatory versus optional sections.
- Artifact reference inventory.

The initial implementation may retain a documented UTF-8-bytes/4 estimate; call it an estimate, not exact tokens. Unicode and JSON escaping must be tested. If mandatory information exceeds the configured budget, fail preparation with a useful explanation or request an explicitly approved larger budget; do not silently drop requirements. Prevent recursive “compress again” loops.

Do not silently reinterpret old `contextBudgetTokens` as a stricter full-prompt cap in production. Add a versioned budget mode, report current full-prompt size in shadow mode, then activate a deliberate per-purpose budget after measurement.

### 8.5 Purpose-specific packets

| Purpose | Required content | Usually keep on disk |
| --- | --- | --- |
| Implementation | Task acceptance, relevant requirements, scoped code/interface map, dependency state, checks, constraints | Full history, unrelated source, every omitted-file path |
| Repair | Current revision/delta, open finding IDs, exact reproduction/failing checks, valid prior evidence, next action | Already resolved findings, duplicated original task prose |
| Review | Actual diff, risk/requirement coverage, gate evidence, prior findings, repair delta when valid | Implementer's broad narrative and unrelated prior attempts |
| Research | Question, source/access constraints, citation requirements, bounded retrieval | Raw unrelated source dumps |
| Troubleshooting | Failure signature, environment/version, discriminating evidence, prior verified relevant incidents | Entire logs unless requested by bounded retrieval |

Retrieve relevant spans/symbols rather than only leading file prefixes. Keep the complete omission manifest in the artifact, with at most a compact summary/reference in the prompt. Deduplicate findings and dependency summaries. Pass the actual attempt purpose/kind to guidance selection; repair must not silently receive only initial implementation guidance.

## 9. Model routing and agent roles

### 9.1 Baseline and candidate policy

Observed baseline: installed Claude Code `2.1.280`, Codex CLI `0.151.0`; local defaults `claude-opus-5` with high effort and `gpt-5.6-sol` with high effort. MABS routes many reviews to `claude-sonnet-5`. Codex cached catalog also listed Terra/Luna variants; this does not establish current entitlement or effectiveness.

Use a small portfolio and explicit candidate status. Newer models in public documentation are discovery inputs, not automatic upgrades. Fable/other credit-billed options must not be enabled where included subscription access is unverified. Never activate a hidden model merely because it appears in a cache.

| Work | Candidate starting tier | Escalation evidence |
| --- | --- | --- |
| Monitoring, scheduling, aggregation, check execution | Deterministic, no model | Novel incident needs diagnosis |
| Extraction, narrow summaries | Eligible efficient model | Ambiguity or complex cross-source synthesis |
| Routine research | Sonnet/Sol at model-supported moderate effort | Conflicting evidence or broad architectural reasoning |
| Architectural recommendations | Opus/Sol with justified deeper effort | Important unresolved trade-offs |
| Well-specified coding | Sonnet/Sol moderate effort | Cross-component invariants or difficult defects |
| Complex coding/concurrency | Sol/Opus deeper effort | Evidence of genuine task complexity |
| Review | Independent context/provider according to policy, capability at least sufficient for risk | Complex failure modes, not merely a large diff |
| Test design | Match behavioral difficulty | Concurrency/property/integration edge cases |
| Known operational recovery | Deterministic procedure | Procedure mismatches evidence |
| Novel troubleshooting | Narrow diagnostic worker, then escalate | Multiple viable causes remain after bounded investigation |
| Curator aggregation | Deterministic | A bounded non-obvious recommendation needs synthesis |

These are experiment candidates, not globally proven optimal routes. Do not reduce effort indiscriminately. A smaller model causing extra repairs can cost more over the complete task.

### 9.2 Capability registry

Registry fields: adapter, exact model ID, CLI/version constraints, supported effort values, task/tool capabilities, subscription eligibility status/evidence/expiry, quota domain, observed context limits, child-delegation support, evidence status (`candidate`, `verified`, `disabled`), and registry version.

Validate route overrides against this registry rather than exact membership in a hardcoded provisional default array. Eligibility and quality are distinct: an available model may still be unvalidated for a class of tasks.

Use pinned model IDs for reproducible comparisons. If an alias is used for discovery, record both requested alias and resolved/reported version when available. Unknown resolution remains unknown.

### 9.3 Launch contract

Add `effort` and controlled delegation settings to `AdapterLaunch`, worker process spec, and launch options. Validate before launch and pass the supported provider-specific flags/configuration explicitly.

For the inspected CLIs, verify through tests the intended equivalents of Claude `--effort <level>` and Codex `-c model_reasoning_effort=...`, plus explicit model selection. Use actual installed CLI capability evidence rather than assuming syntax will never change. Do not write `~/.claude/settings.json` or `~/.codex/config.toml` to implement a per-task route.

CLI/environment/managed configuration can cap or override settings. Log requested/configured/reported fields separately; do not call the prompt's `execution.effort` field an effective model setting.

### 9.4 Route decisions and escalation

Order: governance ready -> capability/entitlement -> required tools -> quality tier -> resource/capacity -> budget -> fair admission.

Separate reasons:

- Capacity wait: preferred acceptable route busy; waiting is allowed.
- Provider fallback: eligible alternative under the same task obligations.
- Capability escalation: demonstrated complexity justifies a stronger route.
- Explicit operator override: versioned, validated, visible.

A deadline does not automatically justify high effort, which can increase latency. Compare the expected critical path and approved policy. Same-account quota exhaustion is not bypassed by changing to another model in that account.

### 9.5 Workers versus roles versus native subagents

Use temporary workers from a shared pool, not a standing researcher/coder/tester/reviewer per project. A role contract selects instructions/tools; it does not require a permanently running process.

MABS owns default task-level parallelism. Native subagent delegation is disabled by default where enforceable. If the harness cannot enforce/observe a requested delegation policy, record the limitation and reject routes needing a hard cap. Do not report top-level attempt count as complete model concurrency when child work is unobservable.

An optional later bounded delegation policy requires depth/child limits, parent-child IDs, usage attribution semantics, and admission accounting. Never enable Ultra/automatic task delegation merely by treating it as another reasoning level.

## 10. Parallel tasks and shared worker scheduling

### 10.1 Extend existing machinery

Retain the existing task DAG, worktrees, project scheduling, provider limits, and scope checks. Extract admission/planning into `src/scheduling/` so every path uses the same policy.

No declared dependency is not proof of independence. Task contracts need:

- Declared prerequisites and pinned outputs.
- Repository identity and read/write scope.
- Shared interface/contract version.
- Named resources: ports, databases, shared output paths, package/install caches when mutable.
- Resource mode: shared/read or exclusive/write.
- Project priority and approved concurrency ceiling.

Normalize path separators and canonical repository identity consistently. Two registered projects pointing to the same repository or shared resource must not bypass conflicts merely because project IDs differ.

### 10.2 Admission algorithm

At a bounded scheduling tick:

1. Reconcile completions and release only proven-finished leases.
2. Re-evaluate dependency-only and capacity-only waits under their explicit policies.
3. Build candidate stages, including initial/repair/review/resume and gate jobs.
4. Filter on project decision readiness, dependencies, evidence freshness, capability, and resources.
5. Rank by project fairness/age, task priority, and completion/critical-path value.
6. Scan a bounded number of candidates; a blocked first candidate must not hide compatible work behind it.
7. Atomically reserve capacity/resources and recheck active-project/global/provider ceilings at reservation time.
8. Launch outside the transaction using the idempotent stage protocol.
9. Record selected and rejected/waiting reasons for the UI.

Never let direct repair/review/reroute calls bypass this algorithm. Those transitions enqueue the next stage; they do not spawn immediately outside admission.

### 10.3 Limits and fairness

Separate ceilings for global model workers, per-provider/quota-domain workers, per-project workers, active projects, gate jobs, and optional delegated children. All ceilings are explicit configuration, not inferred from CPU count.

Start with an explainable weighted fair policy with aging and bounded service accounting. Preserve existing dispatch count as history but do not use lifetime count alone. Include elapsed/estimated service and maximum waiting bounds; document estimation uncertainty. Prefer helping a runnable second project before expanding one project unless explicit priority/deadline policy says otherwise.

Use separate cooldown and hysteresis for adaptive desired concurrency. Increase only within approved ceilings after measured healthy operation; reduce admissions on resource pressure/errors. Do not oscillate every tick or kill existing work to meet a smaller desired count.

### 10.4 Safe forms of parallelism

- Independent components after shared contracts are fixed: separate worktrees, disjoint writes, join-stage integration checks.
- Independent projects: separate repo/resource identities, shared provider/host accounting.
- Read-only bounded investigations: separate contexts, pinned evidence, one reconciliation owner.
- Deterministic checks: separate gate capacity and isolated resources; review must wait for evidence it requires.

Do not create multiple agents to solve the same small task or let several agents redesign a shared interface independently. Parallelism can reduce lead time while increasing total tokens; measure both.

### 10.5 Integration and acceptance

A join task integrates exact prerequisite revisions, runs cross-component checks, and reviews the integrated change when policy requires. Individual branch approval is not automatically approval of the combined revision. Stable finding/evidence fingerprints determine what can be reused and what must be revalidated.

Historical UI tasks were sequential with overlapping launcher/CLI scopes. Do not retrospectively call them parallelizable without redesigning ownership. New plans may parallelize adapters after their shared contract is explicit.

## 11. Observability and operator experience

### 11.1 Telemetry contract

Every event includes schema version, event ID, wall-clock time, project/task/episode/stage/attempt correlation, revision/config/engine provenance where applicable, and source. Metric dimensions remain bounded; task IDs belong in events/traces, not unlimited metric labels.

Capture:

- Stage start/finish/wait and transition reason.
- Reservation/admission/rejection/release.
- Provider tool/progress events where exposed.
- Gate start/output/finish and raw exit status.
- Usage partial/final normalization with coverage.
- Project decision required/answered and policy resolution.
- Incident occurrence/projection and proposal/experiment lifecycle.

Do not mistake a wrapper PID check or controller-written heartbeat for worker progress. Store separate liveness, readiness, last output, last tool event, and last meaningful progress signals. Do not infer internal chain-of-thought or hidden provider activity.

### 11.2 Streaming and bounded storage

`exec` already supports output callbacks; adapters must use a compatible stream protocol and incremental parsing. Claude's current single JSON output does not provide full live events; add a tested stream-json adapter path rather than assuming callbacks alone solve it. Preserve final structured result parsing and failure-envelope handling.

Write bounded append-only JSONL/raw evidence while the worker runs, with restrictive existing artifact permissions, rotation/limits, truncation indicators, and final manifest. Handle UTF-8/chunk boundaries and out-of-order/duplicate events. Large raw logs stay in artifacts, not SQLite rows or worker prompts.

Make telemetry sinks asynchronous and bounded. If an optional exporter fails, local execution continues and an export-gap counter is reported. If authoritative task/audit persistence fails, fail closed at safe execution boundaries; do not confuse that with an optional dashboard outage.

### 11.3 Three native views

**Live execution:** stage, role/provider/model, requested/reported effort, last real progress, elapsed time, budget coverage, blocker, next action, and why other tasks are waiting.

**Run scorecard:** all attempts grouped by purpose, known usage subtotals and missing coverage, active/waiting time, code repairs versus environment recovery, operator interventions, checks/review status, and comparison against a compatible cohort.

**Improvement board:** incidents, verified fixes/test links, repeated failures after fix, curator proposals, experiment evidence, approvals, activations, and observed regressions.

Also show governance prominently: unknown project type, personal-review unanswered/off/risk/required, or client mandatory. Never display review-off as review-approved, missing checks as passed, or experiment preparation as execution.

### 11.4 Initial metric catalog

Names below are proposed stable metric families, not existing endpoints.

| Metric/signal | Collection | Interpretation/action |
| --- | --- | --- |
| `mabs_controller_heartbeat_age_seconds` | Read current authoritative heartbeat | Detect missing controller, not worker progress |
| `mabs_controller_tick_duration_seconds` | Histogram per tick | Detect blocking checks/slow DB |
| `mabs_queue_ready`, oldest ready age | Per bounded tick | Backlog and starvation |
| Active reservations by job/provider/project class | Admission events | Explain capacity without unbounded project IDs in exported metrics |
| Last worker progress age | Streaming events | Warning based on task-class baseline; silence is not proof of failure |
| Environment readiness failures | Preflight results | Prevent dispatch until actionable readiness condition resolves |
| Host memory/load/disk and DB/WAL/artifact size | Cheap periodic samples | Apply configured thresholds; no model required |
| Provider quota/auth failures and cooldown | Structured failure events | Avoid repeated unavailable-provider attempts |
| Usage dimensions and coverage | Partial/final provider projections | Keep missing observations visible |
| Prompt bytes/estimate by purpose/section | At context assembly | Detect packet inflation/duplication |
| Recovery success and resumed-stage match | Stage reconciliation | Detect repeated implementation and lost obligations |
| First-pass acceptance and repairs | Per completed cohort | Compare matched task classes/risk, not unlike projects |
| Required review/check coverage | At acceptance and scorecard | Detect actual quality debt |
| Incident recurrence after verified fix | Occurrence projection | Test whether learning changed behavior |
| Telemetry dropped/truncated events | Sink counters | Identify monitoring blind spots |

Alert rules need an owner, evidence link, severity, deduplication key, cooldown, and safe suggested action. Initial thresholds are configuration values calibrated by tests and observed workloads, not arbitrary “99.9%” promises. Suggested cadence: inexpensive host/queue samples every 15–30 seconds while active, event-driven task metrics, and post-run deterministic summaries. Scheduling/export destinations remain opt-in.

### 11.5 Optional integrations

Use a backend-neutral event/metric interface and an optional OpenTelemetry-compatible exporter. The exporter is not an authoritative database. Native diagnostics must work without it.

OpenLIT, SigNoz, Prometheus/Grafana, and Langfuse remain optional later evaluation targets. Do not install them or automatically enable LLM-as-judge features. Terraform/OpenTofu are provisioning tools, not a solution to controller retry correctness; OpenCost is not needed for the current local subscription setup.

## 12. Incident memory and curator

### 12.1 Incident lifecycle

```text
observed occurrence -> grouped symptom -> hypothesis -> confirmed cause
       -> proposed remedy -> verified fix + regression test -> monitoring
       -> resolved or reopened on applicable recurrence
```

Store occurrence separately from root-cause grouping. Use normalized signatures with component/provider/tool version and classifier version. Do not merge unrelated failures merely because they contain “exit 1.”

A lesson includes: applicability, evidence, cause confidence, fix revision, regression test, last validated version, and superseded/withdrawn status. Hypotheses can inform diagnosis but cannot be presented as proven fixes.

### 12.2 Low-cost operation

Run deterministic grouping and scorecard updates after stage/task completion. No recurring model call is needed. For a novel, ambiguous, or repeatedly costly incident, create a bounded diagnostic suggestion, with required evidence and estimated investigation scope. It is not automatically dispatched as a model task.

Use SQL filters and optional SQLite FTS5 for scoped search. Feature-detect FTS5; provide a bounded SQL fallback. Do not add embeddings/vector infrastructure initially. Retrieve only relevant lessons under a small explicit context budget, not the entire history.

### 12.3 Historical import

Dry-run reports the proposed incidents/occurrences and provenance first. An explicit import writes only derived incident/projection records. Re-running with unchanged source IDs is idempotent. Changing classifier versions creates a new interpretation or supersedes a projection without deleting raw evidence.

Copied checkpoint findings are not separate occurrences. Join on source review/finding/stage IDs; use textual normalization only as a fallback with lower confidence.

### 12.4 Curator improvements

Extend signals to include:

- Code defects versus environment/controller failures.
- Repeat diagnosis and lost-continuation events.
- Prompt section overhead and usage completeness.
- Route outcomes for comparable task/risk classes.
- Review defects versus advisory questions.
- Incident recurrence after fixes.

A curator suggestion must state evidence, proposed mechanism, affected policy/component, expected measurable effect, quality safeguard, and evaluation needed. It may decline to suggest anything.

Configuration changes remain proposals with exact-version approval. Engine defects become scoped coding proposals, not silent engine edits. Avoid generic responses such as adding “run tests” to every prompt when the compiler is missing.

Curator must never infer project type, turn off client review, or treat a personal unanswered review question as consent. A candidate configuration failing governance validation cannot reach activation.

## 13. Controlled optimizer experiments

### 13.1 Scope

This is the AI-evaluation portion of the plan, implemented inside the existing optimizer. It is distinct from normal backend regression tests. It is manually triggered and subscription-budgeted, not a permanent model loop or separate platform.

Policy replay remains useful for configuration safety, but cannot manufacture performance/quality measurements for a model that never executed the task.

### 13.2 Experiment protocol

Each experiment declares:

- Hypothesis and exactly one primary changed dimension (model, effort, packet strategy, or concurrency).
- Fixed cases and starting revisions, component/runtime/check environment, project type/review policy.
- Baseline and candidate configurations with exact versions.
- Repeat count and pairing/order; use randomized or counterbalanced order where possible.
- Primary metric, secondary trade-off limits, per-case quality safeguards, and missing-data policy.
- Maximum attempts/elapsed time/usage warning thresholds and explicit authorization.
- Evidence paths and rules for interruption/incomplete trials.

Changing routing and concurrency simultaneously is a later factorial experiment, not an initial comparison. Cache warmth, provider outages, quota windows, and runtime versions are confounders to record, not hide.

### 13.3 Quality and comparison rules

- Every fixed case must have paired baseline/candidate results or the experiment is incomplete.
- Compare quality per case; aggregate acceptance must not hide a regression in one case offset by an unrelated improvement.
- Include required gates, expected requirement coverage, review verdict where required, escaped/reproduced defects, interventions, and repairs.
- Use an independently fixed acceptance oracle/reviewer protocol; do not let each candidate grade itself with different standards.
- Missing usage prevents a claim of demonstrated token savings unless the predeclared metric is explicitly a known-subtotal analysis with an appropriate limitation; that analysis cannot activate a cost-saving policy on its own.
- A token improvement cannot outweigh a disallowed quality regression. A latency improvement cannot automatically justify an unbounded token increase.
- Do not require an invented statistical significance from one sample. Report repetitions, dispersion, coverage, limitations, and whether evidence is sufficient.

Extend `optimization_measurements` uniqueness to include a repeat/trial key. Retain all failed and interrupted trials in the report. Separate case acceptance from eventual project DONE state.

### 13.4 Execution boundary

A dry run produces a manifest and budget, with zero provider calls. Live execution requires explicit authorization and uses normal project governance/admission. Model eligibility is verified first; no experiment may silently use paid access.

An experiment result can support a curator proposal. It cannot approve or activate itself. Shadow scheduling reports what would have been selected but is not labeled measured model performance.

## 14. Ordered implementation work packages

### 14.1 Dependency graph and ownership

```text
T01 -> T02 -> T03 -> +-- T04 --+ -> T06 -> T07 -> T08 -> T09 -> T10
                    +-- T05 --+                                 |
                                                               T11
                                                                |
                                                               T12 -> T13 -> T14 -> T15
```

Only T04/T05 are explicitly unordered parallel implementation packages. Their allowed scopes are disjoint. All other shared controller/schema/adapter/UI changes are ordered. The current runtime ceiling may still execute T04/T05 serially; declaring independence does not authorize raising concurrency.

These are coherent work packages, not a requirement for a fresh model session for every edit. Use approved continuation where valid and avoid repeating full-context reviews for unchanged evidence. If subdividing a package, preserve requirements and create narrow acceptance/scope boundaries; revise the stored plan if dependencies or scope materially change.

### T01 — Historical baseline and migration safety

**Milestone:** M0. **Depends on:** none. **Risk:** high. **Mode:** sequential.

**Files:** existing `src/store/db.ts`; new `src/diagnostics/history.ts`, `scripts/audit-execution-history.ts`, `fixtures/execution-history/`, `test/history-audit.test.ts`, `test/schema-migrations.test.ts`; this guide.

**Steps:**

1. Introduce explicit read-only database access with no schema writes, auto-migrations, directory creation, or live-controller mutation.
2. Create the audit selection/normalizer metadata and report all nine historical tasks with attempt/review/retry linkage.
3. Extract minimal sanitized fixture envelopes for the failure cases in section 2.4; fixture IDs may be synthetic with a provenance manifest mapping to source IDs.
4. Add future-schema rejection and transactional migration failure tests before schema expansion.
5. Add safe SQLite backup/restore rehearsal against temporary files.

**Acceptance:** historical snapshot counts/known usage match; missing usage and artifact gaps remain explicit; audit leaves source rows/schema unchanged; future schema is rejected without mutation; no default command silently selects the live DB.

### T02 — Durable shared contracts and schema

**Milestone:** M1. **Depends on:** T01. **Risk:** high. **Mode:** sequential.

**Files:** `src/store/`, `src/core/ids.ts`, `src/domain/config.ts`, `src/intake/types.ts`, `src/intake/store.ts`; new `src/domain/execution.ts`, `src/domain/project-policy.ts`, `src/usage/types.ts`, `src/incidents/types.ts`, `src/routing/capabilities.ts`, `src/scheduling/types.ts`; store/migration/record tests.

**Steps:**

1. Implement versioned migrations and the minimal entities in section 5, preserving original rows.
2. Add typed parsers/default handling where null means unknown rather than approved/zero.
3. Add transactional APIs for stage reservations, findings, decisions, projections, and incidents.
4. Define configuration fingerprint inclusion for governance, routing, budgets, and scheduling.
5. Add restartable projection cursors/source keys; do not launch any backfill on application startup without an explicit policy.

**Acceptance:** fresh and schema-14 fixtures converge; all new types round-trip; repeated launches/occurrences violate intended uniqueness; failed transaction rolls back stage/task/event together; no migration infers project type or starts execution episodes for DONE tasks.

### T03 — Explicit project type and review decision

**Milestone:** M1. **Depends on:** T02. **Risk:** high. **Mode:** sequential.

**Files:** `src/domain/project-policy.ts`, `src/domain/config.ts`, `src/review/policy.ts`, `src/intake/`, `src/bootstrap/`, `src/store/records.ts`, `src/controller/controller.ts`, `src/cli.ts`, `.pi/extensions/mabs.ts`, `.pi/skills/product-discovery/`; `test/` for new governance tests and explicit decision updates in affected legacy fixtures. This broader test scope is sequential and must not be used to weaken existing assertions.

**Steps:**

1. Implement the decision table and one readiness evaluator.
2. Add explicit type/review fields to intake and project commands/tools; preserve exact user answers.
3. Persist deduplicated material questions and structured CLI `needs_input` responses.
4. Gate all task submission/dispatch paths and configuration activation/revert.
5. Preserve legacy policy/history; mark classification unresolved.
6. Ensure changing governance invalidates stale accepted decisions where applicable.
7. Update skill wording to request type/choice, while keeping actual enforcement in code.
8. Update existing test project builders/cases to supply explicit test decisions appropriate to each scenario. Do not bypass governance for fake adapters, set a production default-personal shortcut, or defer broken fixtures until the final phase. Run the affected existing suites as well as the new governance tests.

**Acceptance:** missing type launches zero workers; personal unanswered is blocked; personal off runs required checks; client off cannot bypass policy; client lack of reviewer waits/blocks; legacy projects remain inspectable. No project is auto-classified as personal, including MABS.

**Pi prerequisite:** before modifying extension APIs, the implementer must read the installed Pi extension documentation and relevant cross-references completely, as required by the repository/harness instructions. Do not infer API behavior from this plan.

### T04 — Provider usage and outcome accounting

**Milestone:** M2. **Depends on:** T03. **Risk:** medium. **Mode:** parallel with T05 only.

**Exclusive files:** `src/usage/`, `src/optimization/routing.ts`, `src/curator/service.ts`, `test/usage-normalization.test.ts`, `test/routing-accounting.test.ts`.

**Steps:** implement source-specific normalization, partial coverage, cumulative/delta deduplication, correct `ended_at` duration, route contribution versus success, and shared curator/report consumers. Keep raw usage immutable.

**Acceptance:** fixtures cover both providers, missing/zero/partial values, duplicate streams, malformed envelopes, multiple model usage and reasoning subsets; UI known subtotal is 56,712,129 input events and 368,642 output tokens with five missing attempts; no claim of actual subscription spend.

### T05 — Failure classification and environment readiness

**Milestone:** M2. **Depends on:** T03. **Risk:** medium. **Mode:** parallel with T04 only.

**Exclusive files:** `src/environment/`, `src/core/failure.ts`, `src/profiles/`, `test/environment-preflight.test.ts`, `test/failure-classification.test.ts`.

**Steps:** implement structured diagnosis and actual-worktree JS/Python checks; distinguish check capabilities from mere executable PATH presence; generate bounded authorized setup plans; provide classifier version/confidence and unknown state.

**Acceptance:** `tsc: not found`, missing provider binary, and permission denial produce operational actions with zero code-repair charge; genuine assertions/types can become code defects; no model launch, network installation, or permission expansion is performed by inspection alone.

### T06 — Stage recovery and asynchronous check jobs

**Milestone:** M2. **Depends on:** T04, T05. **Risk:** high. **Mode:** sequential.

**Files:** `src/controller/`, `src/domain/execution.ts`, `src/store/records.ts`, `src/gates/`, adapter harness/types, workspace Git, `src/core/exec.ts`, CLI; controller/recovery/gate/liveness/workspace tests.

**Steps:**

1. Replace direct launch-on-failure flow with durable next-stage enqueue/reservation/reconciliation.
2. Preserve obligations through quota/reroute and distinguish operational failure from progress checkpoint.
3. Implement asynchronous check workers and controller-owned check requests.
4. Add finalization/dependency-integration idempotency and restart markers.
5. Add dependency-only block reevaluation, explicit retry episodes, separate recovery/code budgets.
6. Keep controller lease renewal independent from lengthy subprocess/check work.

**Acceptance:** every crash boundary has a deterministic fixture; no duplicate provider process or commit; review binary failure resumes review; missing compiler reruns readiness/checks; successful prerequisite unblocks dependent; approval/user/cancellation blockers remain. Retained work is not discarded to simplify recovery.

### T07 — Explicit model/effort and capability-aware routes

**Milestone:** M3. **Depends on:** T06. **Risk:** high. **Mode:** sequential.

**Files:** routing, adapter, launch/env, domain config, controller, CLI; adapter/model-routing/phase2 tests.

**Steps:** propagate exact settings across all launch layers; add versioned capability/eligibility registry; separate capacity fallback and capability escalation; validate tool/effort support; expose effective-setting uncertainty; control native delegation.

**Acceptance:** fake executables capture exact argv/config; global settings remain untouched; unsupported effort and unknown new-model entitlement launch no inference; shared account quota is respected; baseline high settings can be deliberately overridden per attempt. No new model is activated merely by a catalog update.

### T08 — Complete-budget continuation context

**Milestone:** M3. **Depends on:** T07. **Risk:** medium. **Mode:** sequential.

**Files:** context, prompts, domain contract, controller; context-budget/context-continuation/phase5 tests.

**Steps:** full rendered-prompt accounting; per-purpose selection; deduplicated obligation references; relevant spans instead of blind prefixes; move omitted-file inventory to artifacts; select guidance using actual attempt kind; explicit mandatory overflow.

**Acceptance:** exact sent bytes match recorded bytes; estimates carry provenance; quota reroute retains findings even if its latest checkpoint is operational; review revision drift fails closed; Unicode and oversized mandatory records are tested; existing budget semantics change only through versioned activation.

### T09 — Review obligations and quality evidence

**Milestone:** M3. **Depends on:** T08. **Risk:** high. **Mode:** sequential.

**Files:** review, domain contract, controller, store records, context packet, diagnostics; review-obligation/phase3/extension tests.

**Steps:** stable finding IDs and lifecycle; separate advisory question versus blocking requirement decision; evidence-based resolution; explicit requirement ownership and integration coverage; preserve independent-route policy; valid repair-delta review and evidence invalidation.

**Acceptance:** H1 advisory clarification does not automatically become a major code repair; genuine ambiguity waits for a user; missing required evidence remains a blocker; client review cannot silently use a forbidden route; personal off is labeled not-required, never approved. No historical verdict is rewritten.

### T10 — Live bounded telemetry

**Milestone:** M3. **Depends on:** T09. **Risk:** medium. **Mode:** sequential.

**Files:** new telemetry, exec, adapters, launch, controller, progress/logs/liveness/diagnostics; streaming tests.

**Steps:** incremental provider stream parsers; bounded live artifacts; correlated progress/usage updates; independent liveness/readiness/progress fields; final-envelope reconciliation; telemetry loss indicators.

**Acceptance:** logs appear before exit; UTF-8/chunk splits and malformed events do not break collection; usage is not counted twice; bounded buffers cannot hide truncation; an exporter outage cannot stop execution; missing provider internals remain unknown rather than synthesized.

### T11 — Resource-safe parallel scheduler

**Milestone:** M4. **Depends on:** T10. **Risk:** high. **Mode:** sequential.

**Files:** scheduling, controller, plan/config contracts, records, Git integration, CLI; scheduler-admission/parallel-integration/phase2/closeout tests.

**Steps:** common admission for all stage kinds; named-resource and canonical-repository checks; bounded candidate scanning; age/service-aware project fairness; separate gates/model/child caps; safe join integration; opt-in adaptive target with hysteresis.

**Acceptance:** every cap holds during review/reroute/repair/restart, not only initial dispatch; no head-of-line starvation; same-repo projects cannot bypass write locks; independent fake tasks overlap; incompatible interfaces fail integration; current production limit remains one. A two-worker pilot is prepared, not activated.

### T12 — Incidents and curator learning

**Milestone:** M4. **Depends on:** T11. **Risk:** medium. **Mode:** sequential.

**Files:** incidents, curator, history/task diagnostics, retrieval, CLI; incident/curator-learning/phase4 tests.

**Steps:** deterministic grouping/projections; versioned hypothesis/verified/superseded lessons; dry-run historical import; bounded scoped retrieval; recurrence after fix; curator recommendations with mechanisms and evidence.

**Acceptance:** import is idempotent; copied checkpoint prose is not several incidents; infrastructure failures do not suggest generic prompt inflation; no unverified lesson is reported as proven; client governance and exact-version activation remain enforced; no periodic model loop.

### T13 — Bounded optimizer experiments

**Milestone:** M4. **Depends on:** T12. **Risk:** high. **Mode:** sequential.

**Files:** optimization, curator service, CLI, optimizer tests/phase5 tests, `fixtures/optimization/`.

**Steps:** version protocol/measurement repeats; fixed-case pairing; primary metric/tolerances; per-case quality guards; complete/partial evidence handling; dry-run run manifests and explicit execution budgets; normal scheduler integration.

**Acceptance:** incomplete pairs cannot prove improvement; aggregate quality cannot hide a regressed case; lower latency cannot mask disallowed token regression; policy replay is not live evaluation; live runs require authorization and count failed trials; comparison cannot self-activate configuration.

### T14 — Native operator views and optional export

**Milestone:** M5. **Depends on:** T13. **Risk:** medium. **Mode:** sequential.

**Files:** operator/workbench/diagnostics/telemetry/operations, CLI, Pi MABS extensions; operator/workbench/extension/export/CLI tests.

**Steps:** add governance readiness prompts; live timeline and queue explanations; scorecard and quality coverage; incident/improvement board; optional disabled exporter; bounded queries/pagination and evidence links.

**Acceptance:** unknown/missing decisions are actionable and never defaulted; requested/reported model/effort and missing usage are distinct; disabled review is not approved; exporter disabled means no network writes; native UI works without external services; no secret-bearing raw prompt is exported by default. Preserve existing protections without adding a new hardening project.

### T15 — Integrated acceptance and rollout documentation

**Milestone:** M5. **Depends on:** T14. **Risk:** high. **Mode:** sequential.

**Files:** new reliability-acceptance/scheduler-soak tests, migration tests, fixtures, `scripts/validate-execution-upgrade.ts`, docs, README.

**Steps:** run the full fault matrix, deterministic soak, disposable database upgrade/restore rehearsal, backend/UI compatibility, and final evidence report. Update this guide and operator runbooks with actual implemented commands.

**Acceptance:** all required checks have actual evidence or explicit unmet prerequisites; no live database/controller mutation by tests; classification and review decisions are enforced end to end; prepared versus activated features are clearly distinguished; one-worker canary and two-worker pilot gates documented; retrospective reviews remain separate.

## 15. Detailed validation matrix

All tests below are proposed additions/expansions. Use fake adapters and disposable repositories/databases by default. Test IDs provide requirement-to-evidence traceability.

### 15.1 Project governance

| ID | Setup/action | Required assertion |
| --- | --- | --- |
| GOV-01 | Create draft without type | Persist draft and one material question; no inferred type |
| GOV-02 | Submit implementation with unknown type via each entry point | Structured needs-input; zero worker/check mutations for implementation |
| GOV-03 | Personal, review unanswered | Ask before implementation; no default off or risk |
| GOV-04 | Personal explicit off, required failing check | No review launch, task not accepted because gate fails |
| GOV-05 | Personal explicit yes | Resolved required policy shown/stored; independent review required |
| GOV-06 | Personal explicit risk policy | Safe case skips review with reason; risk case requires it |
| GOV-07 | Client with review off through CLI/intake/curator/revert | Reject conflicting configuration; no bypass |
| GOV-08 | Client reviewer unavailable | Pending/blocked, not DONE; no forbidden same-provider fallback |
| GOV-09 | Legacy project has personal/client preset but no type decision | Old rows unchanged; new work gated; ask type |
| GOV-10 | Change type or review choice after proposal acceptance | Invalidate stale acceptance and configuration binding |
| GOV-11 | Two concurrent decision updates | One expected-version update wins; other rereads, no lost decision |
| GOV-12 | Repeated controller ticks with missing decision | One question/incident, not an unbounded stream |
| GOV-13 | Existing project decision and absent brief fields | Reuse explicit compatible decision; do not overwrite with defaults |
| GOV-14 | Client task mislabeled research but edits product code | Observed change still requires appropriate review |

### 15.2 Recovery, environment, and evidence

| ID | Fault injection | Required assertion |
| --- | --- | --- |
| REC-01 | Repair findings F1/F2; Codex quota; fallback Claude | F1/F2 remain open in fallback packet; same repair purpose |
| REC-02 | Reviewer CLI missing | Environment incident; no implementation rerun/code-repair charge |
| REC-03 | `tsc` missing in task worktree but present in main checkout | Actual-worktree preflight fails; no model repair |
| REC-04 | Node/npm denied to worker, controller check runner available | Exact registered check runs through authorized runner; no broad permission bypass |
| REC-05 | Real type error after implementation | CODE diagnosis with evidence; one repair allocation |
| REC-06 | Worker crash before PID record, launch marker exists | Reconcile marker; never duplicate launch on uncertainty |
| REC-07 | Crash after finalization commit, before check scheduling | Resume checks on committed revision; no duplicate commit |
| REC-08 | Crash after gate completion artifact, before DB result | Idempotently collect once |
| REC-09 | Lease expiry/competing controller while check runs | One active owner; stale completion cannot overwrite fenced state |
| REC-10 | Long check exceeds several poll intervals | Controller heartbeat/reconciliation continue |
| REC-11 | Dependency FAILED then explicitly recovered to DONE | Only dependency blocker clears; normal admission follows |
| REC-12 | User pause/cancel/approval block | Never auto-cleared by dependency success |
| REC-13 | Retained worktree and previously integrated dependency | No duplicate cherry-pick; genuine conflict remains visible |
| REC-14 | New untracked nested file in allowed scope | Expanded files checked correctly; actual out-of-scope edits still rejected |
| REC-15 | Retry exhausted episode | No hidden budget reset; explicit new authorization required |
| REC-16 | Provider reset time supplied versus unknown | Use evidenced reset with provenance; fallback cooldown labeled inferred |
| REC-17 | Check/review revision or environment changes | Evidence invalidated; required validation repeated, not silently reused |
| REC-18 | Review advisory plus non-blocking question (H1 fixture) | No automatic major defect or code-repair launch |
| REC-19 | Blocking unanswered requirement decision | Wait for user; no agent guesses acceptance |
| REC-20 | Multiple worker results mention same obligation | One stable obligation; resolution requires actual evidence |

### 15.3 Usage, routing, and context

| ID | Case | Required assertion |
| --- | --- | --- |
| USE-01 | Codex input 1000, cached 800, output 50 | Total input 1000, not 1800; uncached 200 where valid |
| USE-02 | Claude input 10, cache read 800, cache write 200, output 50 | Total input events 1010; dimensions retained |
| USE-03 | Missing envelope vs reported zeros | Unknown distinct from zero |
| USE-04 | Cumulative stream snapshots then final envelope | Count final cumulative total once |
| USE-05 | Incremental events with repeated sequence ID | Deduplicate repeats; do not discard distinct increments |
| USE-06 | Reasoning-output subset included in total | Do not add reasoning twice |
| USE-07 | Failed route then another route succeeds | Failed route remains failed/contributor; no false success credit |
| USE-08 | `ended_at` present, no `finished_at` column | Correct duration, invalid timestamp diagnostics |
| USE-09 | Unknown provider schema/multiple model entries | Preserve raw and unknown dimensions; no guessed totals |
| USE-10 | Full historical cohort | Reproduce section 2.3 with explicit coverage |
| RTE-01 | Task asks medium, user global high | Exact medium setting passed in fake CLI; global file unchanged |
| RTE-02 | Requested effort unsupported/model ineligible | No worker launch, actionable route rejection |
| RTE-03 | Preferred route busy; stronger route free | Wait or explicitly authorized fallback, not silent escalation |
| RTE-04 | Same-account quota exhausted | Model switch does not manufacture provider capacity |
| RTE-05 | Unknown reported model/managed effort cap | Requested/configured/reporting fields distinct; unknown stays unknown |
| RTE-06 | Native delegation disabled/unobservable | Do not claim child count zero unless enforceable/evidenced |
| CTX-01 | Large omission list/duplicate findings | Full inventory on disk; each obligation once in prompt |
| CTX-02 | Unicode, JSON escaping, role/schema overhead | Recorded full bytes match exact sent string |
| CTX-03 | Mandatory records exceed budget | Explicit preparation blocker/approved adjustment; no silent truncation |
| CTX-04 | Repair guidance and current delta | Correct purpose-specific packet, not initial-only guidance |
| CTX-05 | Reviewer packet source revision drift | Fail closed and record drift |

### 15.4 Scheduling, learning, and UI

| ID | Scenario | Required assertion |
| --- | --- | --- |
| PAR-01 | Two independent tasks, two allowed slots | Overlap under fake adapters; disjoint worktrees/resources |
| PAR-02 | No graph dependency but overlapping write scope | Serialize |
| PAR-03 | Disjoint files but same exclusive port/database | Serialize or allocate isolated resource |
| PAR-04 | Two project IDs resolve to same repository | Canonical repo conflict still enforced |
| PAR-05 | Initial + repair + review + reroute admission | All global/provider/project caps hold |
| PAR-06 | More eligible projects than active-project cap in one tick | Recheck cap per reservation, never oversubscribe |
| PAR-07 | First ready task blocked, later compatible task available | Bounded scan finds compatible work; no head-of-line starvation |
| PAR-08 | Long tasks in one project, short tasks in another | Aging/service fairness prevents starvation |
| PAR-09 | Host pressure or quota failure rises | Reduce new admissions; preserve active work |
| PAR-10 | Independent branches individually pass, interface mismatch at join | Integration check catches mismatch; branch approval not inherited blindly |
| PAR-11 | Controller restart with admission leases | No leaked permanent slots or duplicate workers |
| PAR-12 | Optional child agent starts | Parent/child capacity and usage accounted, or launch rejected |
| LRN-01 | Historical import repeated | Same occurrence counts; source rows unchanged |
| LRN-02 | Hypothesis versus verified fix | Retrieval labels confidence; no false verified remedy |
| LRN-03 | Same signature after fix on applicable version | Recurrence/reopened incident recorded |
| LRN-04 | Curator sees missing compiler incidents | Environment remedy, not bigger implementation prompt |
| EVAL-01 | One case quality worsens, another improves | Per-case safeguard fails despite equal aggregate acceptance |
| EVAL-02 | Lower latency but excessive token increase | Outcome follows declared tolerances; no automatic improved label |
| EVAL-03 | Missing usage or unmatched trials | Incomplete/limited evidence, not demonstrated savings |
| EVAL-04 | Dry-run benchmark | Zero provider calls, explicit budget manifest |
| EVAL-05 | Successful candidate experiment | Proposal support only; no self-activation |
| OBS-01 | Long-running worker | Live output visible before exit; liveness distinct from progress |
| OBS-02 | Export endpoint down/buffer full | Local task continues; dropped/export-gap metric visible |
| OBS-03 | Personal off/client required/unknown type | UI correctly distinguishes all three, no fabricated approval |
| OBS-04 | Failed attempts with missing usage | Scorecard includes them and shows coverage |
| OBS-05 | Changed engine/config after startup | Attempt provenance exposes exact engine/config snapshot |

### 15.5 Migration/restore and soak

- Create fresh schema and upgrade a disposable schema-14 fixture; compare table/column/index definitions and typed round trips.
- Inject a migration exception between DDL steps; verify rollback and unchanged schema version.
- Open a future-version fixture with the new engine; verify refusal before schema mutation.
- Open audit mode on a read-only copy; compare rows/schema before and after.
- Run two fake projects for hundreds of deterministic stage transitions with seeded failure injection and a fake clock. Verify no leaked reservations, duplicate obligations, infinite retries, or cap violations.
- Restore a SQLite backup into a different temporary path and read all required evidence references. Missing external artifacts are reported, not invented.
- No test may point `MABS_DB_PATH`, `MABS_STATE_DIR`, or `MABS_WORKTREE_ROOT` at the production locations.

## 16. Commands, fixtures, and evidence production

### 16.1 Existing repository checks

The repository declares these checks in `package.json`:

```bash
npm run typecheck
npm run typecheck:extensions
npm test
```

Run against the implementing revision in an isolated checkout with its declared Node/npm environment. `npm test` currently matches `test/*.test.ts` and `test/operator/*.test.ts`; place new root tests accordingly or explicitly update the script through a scoped plan revision. Do not place tests in an undiscovered nested folder and claim the full suite ran them.

The repository has no declared general lint/build script in the inspected package manifest; do not invent one as an existing check. Missing optional Pi dependencies or environment prerequisites must be reported and resolved under the repository's setup instructions, not relabeled PASS.

`npm run verify` invokes provider-oriented verification. It is **not** part of the default no-model regression loop; inspect and separately authorize any live provider activity before running it.

### 16.2 Isolated test shell

Example environment isolation, to use only in an implementation worktree. Do not run provider commands from this block:

```bash
TEST_ROOT="$(mktemp -d -t mabs-execution-tests.XXXXXX)"
export MABS_STATE_DIR="$TEST_ROOT/state"
export MABS_DB_PATH="$TEST_ROOT/state/mabs.sqlite"
export MABS_WORKTREE_ROOT="$TEST_ROOT/worktrees"
# Run the repository checks above, capturing exit status and evidence.
# Cleanup only TEST_ROOT created by this invocation, after evidence is retained.
```

Keep cleanup explicit and scoped. Prefer test harness cleanup to broad shell deletion. Fake adapter executables should be placed in a temporary PATH and must never invoke installed Claude/Codex accidentally. Assert invocation counters are zero in pure deterministic tests.

### 16.3 Read-only audit example

The following uses the Python standard library for inspection only; it does not replace the proposed TypeScript audit tool. Pass an explicit source path. Do not use the application's default `Store` constructor for this audit.

```bash
python3 - /explicit/path/to/mabs.sqlite <<'PY'
import json, pathlib, sqlite3, sys
path = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA query_only = ON')
connection.execute('BEGIN')
try:
    query = '''
      SELECT t.id, t.title, t.state,
        (SELECT count(*) FROM attempts a WHERE a.task_id=t.id) AS attempts,
        (SELECT count(*) FROM review_results r WHERE r.task_id=t.id) AS reviews,
        (SELECT count(*) FROM events e
          WHERE e.task_id=t.id AND e.kind='task.retry_requested') AS retries
      FROM tasks t ORDER BY t.created_at, t.id
    '''
    print(json.dumps([dict(row) for row in connection.execute(query)], indent=2))
finally:
    connection.rollback()
    connection.close()
PY
```

For a live WAL database, use SQLite's supported backup mechanism or a read transaction. Do not copy only `mabs.sqlite` while ignoring its WAL and claim a consistent backup. Restore rehearsal must target a disposable path, never overwrite the live database.

### 16.4 Proposed interfaces — not existing commands yet

Implement the following capabilities through the CLI/service layer; exact spellings are proposed and must be finalized/documented during their owning task. Do not execute these as if already implemented:

```text
project classify <project> --type personal|client|other --expected-version N
project review-choice <project> --choice off|risk|required --expected-version N
project readiness <project> --json
history audit --db <explicit-path> --read-only --output <new-report-path>
task continuation <task> --json
task scorecard <task> --json
incident import-history --project <id> --dry-run
incident list|show|verify|supersede ...
routing explain <task> --json
routing capabilities --local-only
scheduler explain <task> --json
optimization prepare-run <experiment> --dry-run
optimization run <experiment> --authorization <exact-binding>
telemetry status
```

Existing curator and optimization commands remain compatible where semantics are unchanged. New mutation commands must expose expected-version/approval requirements rather than allowing dashboards to mutate state implicitly.

### 16.5 Fixture and evidence conventions

Proposed fixture layout:

```text
fixtures/execution-history/
  manifest.json                     # provenance, extraction date, source IDs, sanitization
  cohort-summary.json               # expected counts/subtotals, not raw full DB
  codex-usage-cached-subset.json
  claude-usage-separate-cache.json
  repair-quota-reroute.json
  reviewer-binary-missing.json
  missing-tsc-gate.json
  advisory-clarification-review.json
  dependency-recovered.json
  schema14-minimal.sqlite-or-builder # prefer reproducible schema/data builder
fixtures/optimization/
  paired-cases.json
  per-case-quality-regression.json
  incomplete-usage.json
```

Use minimal data needed for regression; do not commit a copy of the live database, complete private transcripts, credentials, or machine-specific destinations. Preserve a local provenance link when raw evidence cannot be committed.

Every implementation package records: task/proposal ID, code revision, config/schema version, changed files, commands and exit codes, relevant test IDs, evidence locations, known limitations, and whether activation occurred. Failed or skipped checks remain visible.

## 17. Rollout and activation gates

### Gate A — Plan and project governance

- User accepts the exact validated proposal/version.
- User supplies MABS's project type and, if personal, review choice before implementation starts.
- Confirm allowed local scope; no approval for push/merge/deployment is inferred.
- Confirm runtime/tool prerequisites for tests.

### Gate B — Deterministic foundations

Complete T01–T06 on isolated state. All historical regression fixtures, migration safety, project-decision tests, and recovery/lease tests pass. No live model experiment is needed to prove missing-compiler classification or findings retention.

### Gate C — Instrumented one-worker validation

Complete routing/context/review/telemetry work and deterministic tests. Prepare a one-worker canary manifest with exact engine/config/model settings and approved project policy. A live canary needs an explicit task/objective and budget. Compare behavior with the baseline without claiming savings from unmeasured runs.

### Gate D — Scheduling and learning

Pass deterministic multi-project/fault/soak tests, per-case optimizer safeguards, native UI acceptance, and database restore rehearsal. Prove every model launch path goes through admission.

### Gate E — Safe engine activation

This is a separate operational action:

1. Stop new admissions and drain/reconcile active worker/check jobs.
2. Verify retained worktrees and no ambiguous running stage.
3. Capture a consistent SQLite backup plus artifact/engine/config manifests.
4. Rehearse upgrade and restore on a copy.
5. Pin the engine revision/runtime used by controller and worker entrypoints. Avoid launching new workers from a mutable source checkout while the controller uses older loaded code.
6. Perform the approved migration and start one controller on the intended DB.
7. Verify lease ownership, governance prompts, historical views, and no unintended dispatch/config changes.
8. Keep one model-worker ceiling until a separately enabled pilot is approved.

### Gate F — Optional two-worker pilot

Prerequisites: two actually independent ready tasks or projects; explicit governance decisions; validated model entitlement; healthy environment; safe provider/host limits; no uncontrolled native subagents; documented stop conditions.

Initial candidate ceiling: two model workers total, one per provider, within project/resource limits. Tests/check workers have their own bounded ceiling. Record quota interruptions, first-pass quality, total consumption, lead time, integration defects, and operator intervention. Do not declare success solely because two processes ran simultaneously.

Higher ceilings or routing changes require evidence and exact configuration activation. External telemetry export and destinations remain off until separately configured.

## 18. Rollback and operational runbooks

### 18.1 Before any rollback

Stop new admissions; preserve running process identity and artifacts; wait for safe completion or explicitly cancel under existing policy. Record the affected engine/config/schema versions and why rollback is needed. Never hide a failed rollout by editing historical task states.

### 18.2 Configuration regression

Use the existing exact-version revert approval flow. Validate the target against current governance: a client project cannot revert to review-off, and unknown project type is not resolved by an old preset. Activate at a safe checkpoint and observe the next explicitly authorized run.

### 18.3 Database/engine regression

Prefer a forward fix when additive schema is sound. Do not run an older binary that can stamp a newer schema down. If restoring a backup is necessary, require a maintenance decision and account for all work/events created after that backup; do not silently discard them. Retain the newer database/artifacts for reconciliation and use an explicitly compatible engine.

Restore procedures must be tested on disposable paths first. A backup without referenced artifacts is incomplete evidence retention; record what is and is not restorable.

### 18.4 Common incidents

| Incident | First action | Do not do |
| --- | --- | --- |
| Missing project type/review choice | Ask and persist exact answer | Guess personal or treat silence as no review |
| Provider quota | Preserve continuation; wait/eligible fallback under budget | Cycle through same quota-domain models indefinitely |
| Missing compiler | Show environment evidence and authorized setup plan | Dispatch another coder to rediscover it |
| Worker appears silent | Compare process liveness, stream health, last real progress | Assume dead solely from absent buffered final log |
| Dependency recovered, task still waiting | Inspect typed blocker and admission explanation | Clear all blockers indiscriminately |
| Repeated review question | Check requirement linkage and blocking classification | Automatically promote every question to major defect |
| Exporter unavailable | Keep local evidence; show export gap | Block required product work on optional dashboard |
| Unexpected concurrency | Audit all admission and child-agent leases | Kill arbitrary processes or raise caps to hide accounting gaps |
| Model setting differs | Inspect requested/configured/reported provenance | Trust prompt metadata as runtime truth |

## 19. Completion checklist and unresolved activation prerequisites

### 19.1 Implementation definition of done

- [ ] All REQ-01 through REQ-15 have linked test/evidence IDs.
- [ ] T01–T15 acceptance criteria satisfied on the integrated revision.
- [ ] Missing type always asks; no default-personal implementation path remains.
- [ ] Personal review choice is explicit and durable; client review cannot be disabled implicitly.
- [ ] History preserved; all historical projections reproducible and versioned.
- [ ] Quota reroute retains findings; retries resume the correct stage.
- [ ] Environment errors do not consume code-repair budget.
- [ ] Full-prompt accounting and normalized usage show unknown/partial coverage honestly.
- [ ] Explicit model/effort settings reach the provider launch contract.
- [ ] Every launch path uses admission; parallel/resource/restart tests pass.
- [ ] Required checks/reviews are revision-bound; advisory questions are not automatic code defects.
- [ ] Native live/scorecard/improvement views work with no external platform.
- [ ] Curator/optimizer remain proposal-and-evidence mechanisms, not self-activation loops.
- [ ] Migration/restore and engine-version rollout rehearsed on isolated state.
- [ ] Documentation states which capabilities are implemented, tested, approved, and activated separately.

### 19.2 Still required before activation or live evaluation

1. Exact implementation-plan acceptance.
2. Explicit type and applicable review choice for each project that will execute new implementation, including MABS.
3. Subscription-tier/entitlement confirmation for candidate models; cached catalog entries are insufficient.
4. Explicit live canary/benchmark cases and budgets.
5. Approval for the particular live database/engine/configuration activation action.
6. Separate decision on the three outstanding final UI review gaps, if the user wants them reviewed.

No implementation or operational checkbox is checked merely because this document exists. At preparation time only source/SQLite/documentation inspection and proposal validation have been performed; no application quality suite, live benchmark, migration, or activation is claimed to have passed.

## 20. References

### Repository starting points

- [Documentation index](../index.md)
- [Curator workflow](../curator.md)
- [Routing policy history](../routing-policy-v1.md)
- [Command reference](../commands.md)
- [Architecture overview](../architecture/system-overview.md)
- [Recovery guide](../architecture/recovery-and-failures.md)
- [Operator documentation](../operator/index.md)
- [Project discovery skill](../../.pi/skills/product-discovery/SKILL.md)
- [Automation design skill](../../.pi/skills/automation-design/SKILL.md)
- [Shared MABS boundaries](../../.pi/skills/_shared/MABS_BOUNDARIES.md)

Primary implementation files: `src/controller/controller.ts`, `src/store/db.ts`, `src/store/records.ts`, `src/store/schema.sql`, `src/review/policy.ts`, `src/intake/service.ts`, `src/intake/types.ts`, `src/domain/config.ts`, `src/domain/plan.ts`, `src/adapters/types.ts`, `src/adapters/harness.ts`, `src/adapters/worker-process.ts`, `src/verify/launch.ts`, `src/context/packet.ts`, `src/context/retrieval.ts`, `src/gates/runner.ts`, `src/optimization/routing.ts`, `src/optimization/experiments.ts`, `src/curator/service.ts`, and `src/diagnostics/task.ts`.

### External references consulted during planning

These documents change over time; pin actual CLI/model capabilities during implementation and do not infer subscription eligibility from marketing descriptions.

- [Claude model and effort configuration](https://code.claude.com/docs/en/model-config)
- [Claude usage/cost guidance](https://code.claude.com/docs/en/costs)
- [OpenAI model guidance](https://learn.chatgpt.com/docs/models)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenTelemetry Collector](https://github.com/open-telemetry/opentelemetry-collector)
- [Prometheus](https://github.com/prometheus/prometheus)
- [OpenLIT](https://github.com/openlit/openlit)
- [SigNoz](https://github.com/SigNoz/signoz)
- [Langfuse](https://github.com/langfuse/langfuse)

External tools are reference options, not selected deployment dependencies. The detailed design deliberately prioritizes recovery correctness, trustworthy accounting, explicit project governance, and native visibility before adding infrastructure.
