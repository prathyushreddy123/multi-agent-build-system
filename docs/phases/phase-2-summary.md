# Phase 2 summary — parallel projects and task routing

Completed: 18 September 2026

## Outcome

Phase 2 adds safe multi-project scheduling and evidence-informed worker routing without introducing paid API fallback. The controller can progress independent repositories concurrently, enforce global/project/provider limits, route by explicit task profile, persist provider cooldowns, and switch subscription providers only at an attempt boundary.

## Delivered

### Scheduling and execution modes

- Durable starvation-resistant project scheduling based on dispatch counts.
- Configurable global worker, active-project, per-project worker, and per-provider limits.
- Optional free-memory and per-CPU load thresholds pause new dispatch and surface an explicit backpressure reason.
- `single`, `sequential`, `parallel`, and `mixed` execution modes with required rationale.
- Parallel tasks in one project run together only when their declared edit scopes are disjoint.
- Downstream task branches materialize completed dependency revisions before execution, allowing explicit join/integration tasks to see prerequisite outputs.
- Mechanical tasks run registered deterministic gates without invoking a model.

### Routing and provider handling

- Versioned provisional routing map for nine task classes.
- Routing inputs include language/domain, complexity, ambiguity, context size, change risk, urgency, required tools, and task class.
- Phase 0 evidence informs the initial implementation/diagnosis/complex routes; unmeasured classes remain explicitly provisional.
- Provider availability, concurrency, error counts, quota cooldowns, and authentication failures persist in SQLite.
- `AUTH` and `QUOTA` can reroute to an eligible installed subscription adapter after the failed attempt ends. Reroutes do not spend code-repair budget.
- No API-key or pay-as-you-go route was added.

### Plan and scope safety

- JSON execution plans are validated before task creation.
- Missing acceptance criteria, unknown dependencies, cycles, invalid modes, and overlapping unordered edit scopes are rejected.
- Valid plans are inserted atomically in topological order using nested SQLite savepoints.
- Context packets carry the full task profile and explicit allowed paths.
- The controller rejects worker changes outside a declared repository-relative scope before committing them.

### Health and visibility

- Controller health now includes oldest READY/claim ages, slot utilization, uptime, and provider status.
- Operational summaries expose controller generations, provider errors, invalid plans, routing overrides, repeated replans, and orchestrator decision state/duration when available.
- Task details expose planning (unknown when no orchestrator decision is involved), queue, worker, check, review, and approval-wait latency with the longest stage and reason.
- CLI and localhost workbench expose provider capacity and operational health.

## Verification

```text
npm test                    27 passing
npm run typecheck           passing
node src/cli.ts verify --quick   3/3 passing
Pi RPC extension load            passing
```

The Phase 2 tests cover:

- execution-plan cycles, acceptance criteria, overlap detection, atomic DAG application, and dependency-revision integration;
- two-project concurrent dispatch under global/provider limits;
- task-class route selection, local-tool eligibility, and explicit route override behavior;
- out-of-scope edit rejection;
- deterministic mechanical execution;
- machine-resource backpressure visibility;
- durable fair scheduling between projects;
- quota cooldown and fallback without repair-budget use;
- provider cooldown expiry and operator reset.

## Real multi-project acceptance

Evidence directory:

`~/.local/state/mabs/acceptance/phase2-2026-09-18T13-12-59Z`

Two independent Git repositories were registered with required npm gates. In one controller cycle, both tasks entered `RUNNING` using two authenticated Codex subscription sessions under these limits:

- global workers: 2;
- active projects: 2;
- per-project workers: 1;
- Codex provider capacity: 2.

Both tasks completed without repair and reached `DONE`:

- task `tsk_01M2TAC69Q3Y03G3ECYHQWHWS9` — revision `3b9ac1433dced2ffa9d047f1ebaa87498e81e4c3`;
- task `tsk_01M2TAC6CJWF1VNV14VS1ANAT4` — revision `279c16581a52bd089aece9d1fa0710df38b75ab8`.

Both final-revision npm gates passed. `report.md`, `acceptance.json`, task records, worker logs, gate logs, completion envelopes, the SQLite database, and controller polling evidence remain outside Git in that directory.

## Boundaries retained

- No push, merge, release, deployment, or external action executor exists yet.
- Independent review and bounded feedback/replanning loops remain Phase 3.
- The orchestrator health surface correctly reports idle because no LLM planning daemon is activated in this phase.
- Routing preferences are provisional where the Phase 0 baseline did not provide representative evidence.
