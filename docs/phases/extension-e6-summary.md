# E6 summary — optional operations and release validation

Status: complete. Implementation, migration, local validation, and the separately authorized bounded
provider-backed Pi read-only verification passed.

## Versioned operations contract

`src/operations/` adds `operations-v1`, separately versioned from project routing/review configuration.
The synthesized version-0 default writes no row and keeps every consequential capability off:

- CI: `off`;
- deployment: `off`;
- monitoring: `off`;
- scheduling: `manual` with mandatory overlap lock;
- delivery: repository-relative local `outputs` files only;
- external costs: `off`;
- paid model APIs: always `prohibited`.

A configuration update requires optimistic version, actor, reason, a stable SHA-256 fingerprint, and
strict completeness checks. `ops configure --dry-run` validates a candidate and returns its exact
fingerprint without persisting it. A candidate that selects external cost also returns the required
`external_cost` approval target; `--request-approval` records the proposal and cap as a pending exact
binding. Configuration refuses to enable it without that approved fingerprint/project-configuration
binding and consumes the approval with the write. Enabled-but-
incomplete CI provider/path, deployment target/adapter, VPS cost proposal, application monitor adapter,
timezone/cadence, external destination, or cost cap is rejected. Timezones are validated by the installed runtime; retries are bounded 0–5; missed-run policy
is `skip` or one `run_once`; overlap locking cannot be disabled. Destinations are references, not stored
credentials.

Surfaces:

- `mabs ops status <project>`;
- `mabs ops configure <project> --version=N --payload=... --reason=...` with dry-run, exact cost-approval request, and approved-binding modes;
- `mabs ops prepare <project> <ci|deployment|monitoring|scheduling|delivery|costs>`;
- `mabs ops runs <project>`;
- `/mabs-ops`, `mabs_get_operations`, and dry-run-only `mabs_prepare_operation` in Pi;
- read-only optional-operation status in the local workbench overview.

No Pi or CLI external-execution tool is registered.

## Preparation and adapter boundaries

All preparation results carry `dryRun: true` and explicit disabled/manual/ready/incomplete/approval
status. Preparation never writes a workflow or contacts a provider.

When a user selects GitHub Actions, dry-run CI generation composes the application's detected profile
setup commands and the exact registered quality checks into a `workflow_dispatch` draft. It does not
install, commit, publish, or enable the workflow and never embeds subscription credentials. Other CI
providers require a separately registered generator.

Deployment exposes prepare/execute/status/recover adapter methods but ships no production adapter and
no execution command. The tested service requires a durable approved binding matching project,
`deploy`, exact target, operations fingerprint, and current project configuration. Approval is consumed
before adapter execution so an uncertain result cannot be replayed. Exceptions are recorded as
`unknown` with recovery required. Recovery needs a separate exact approval for
`recovery:<original-target>`.

The simulated adapter acceptance path records one failed status and one bounded successful recovery.
It performs no external action. Local monitoring status includes last operation success, failed/unknown
runs, missed schedules, task backlog, and the latest controller health. Remote application monitoring
explicitly requires an adapter that can run independently of WSL.

## Persistence and migration

Schema 13 -> 14 is additive:

- `operation_configs` stores versioned configuration, fingerprint, actor, and reason;
- `operation_runs` stores exact capability/action/target/fingerprint, dry-run flag, approval, state,
  detail, and timestamps.

Persistent state was backed up before migration:

`~/.local/state/mabs/backups/mabs-pre-e6-2026-09-20T04-45-03.260+00-00.sqlite`

The schema-13 fixture removes both E6 tables, reopens the database, verifies schema 14 and safe
version-0 defaults, and preserves the existing project.

The real pilot currently has no operations configuration row and no operation run. Its effective status
is recorded in `docs/phases/evidence/e6-disabled-operations.json`.

## E5 merge decision

During E6, the user explicitly authorized the previously excluded local merge. MABS prepared approval
`apr_01M2YJPP7N4YHS84KNJ5TWSC5W`, bound to action `merge`, target `main`, reviewed revision
`ccc7d830d0c5104329fe9e71e48871e754e7334a`, project configuration
`cfg_01M2XJRKB9XN6442WDJ18WY0N5`, two passing required gates, and an approved independent review.
After the human decision was recorded, the pilot `main` fast-forwarded from `f0afffc` to `ccc7d83`.
The 33 product tests and compile check passed from `main`; the approval was then consumed. No remote,
push, release, or deployment exists.

## End-to-end evidence matrix

| Scenario step | Evidence | Classification |
| --- | --- | --- |
| Ordinary conversation persists unknowns and exact consent | E3 live Pi transcript, then real E5 brief/assessment and corrected fingerprint acceptance; E6 Pi read confirms accepted fingerprint and completed work | Provider-backed E3/E6 plus real E5 records |
| Personal preset, safe empty-directory bootstrap, meaningful checks | E5 brief/project/bootstrap IDs; nine completed steps; unittest and compile checks | Real pilot |
| Dependency plan executes and produces outline/week/packet | Five `DONE` tasks, final reviewed revision, generated examples | Real subscription-backed pilot |
| More retrieval-evaluation practice revises future work without history loss | Week 7 revision 2 changes focus/query while both revision IDs and prior progress/backlog remain | Explicitly simulated data: `e6-simulated-change-smoke.json` |
| Interrupt/restart avoids duplicates | E4 interruption test; actual failed bootstrap resumed by ID; controller lease handoff left five unique tasks | Automated plus real recovery evidence |
| Provider boundary and no paid fallback | Codex implementations -> independent Claude reviews; quota reroute and stripped paid-API environment tests | Real provider boundary plus automated failure case |
| Finished product runs without MABS | Pilot `main` at `ccc7d83`; 33 tests; independent CLI assessment/syllabus/packet/progress/revision/status smoke | Real local runtime; progress values labeled simulated |
| Optional operations remain off | version-0 status, no operation runs, no production adapters/execution surfaces | Real persistent status plus automated simulated failure |

The simulated requested-change artifact is
`docs/phases/evidence/e6-simulated-change-smoke.json`. It is not represented as real learner progress.

## Local acceptance

Focused E6 tests cover safe defaults, incomplete configuration, exact external-cost approval,
profile-based CI dry-run, exact deployment approval consumption, simulated deployment failure and
recovery, schema migration, the real CLI path, and workbench visibility. Installed Pi offline RPC loads `/mabs-ops` and the existing commands/skills with
no extension error.

Final acceptance results:

- MABS typecheck: clean;
- MABS tests: 79/79 pass;
- pilot tests from local `main`: 33/33 pass;
- pilot `python3 -m compileall -q src`: pass;
- installed Pi offline load: `/mabs-ops`, bootstrap, and all five versioned skills present, with no
  `extension_error`;
- live Pi read-only run: exactly one `mabs_get_product` and one `mabs_get_operations` call, no mutation
  tools available, no tool errors, operation-run count zero;
- JSON evidence validation and `git diff --check`: pass.

The live transcript is `docs/phases/evidence/e6-live-pi-readonly-transcript.md`. It correctly notes that
status tools alone do not prove the current Git checkout; separate exact merge evidence establishes
pilot `main` at `ccc7d83`.

## Known limitations

- No production CI, deployment, monitoring, scheduler, or external-delivery adapter is registered.
- CI supports only a reviewed GitHub Actions draft; it is not written or published automatically.
- Schedules and destinations are configuration contracts only; nothing wakes WSL or sends a message.
- VPS and hosted services still need a cost proposal, explicit approval, credentials, and project-specific
  recovery evidence.
- A remote application cannot assume access to developer-machine subscription credentials.
- Controller lease contention is currently counted through the generic tick-error/`db_errors` metric;
  the durable rows retain this evidence, but a future health revision should expose a distinct standby
  state instead of implying SQLite failure.
