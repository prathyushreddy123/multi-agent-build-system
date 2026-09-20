# E5 summary — AI engineering study assistant pilot

Completed: 20 September 2026. MABS branch `mabs-extension`.

## Intake, consent, and bootstrap

The real pilot used the generic E3/E4 records and services; no study-planning behavior was added to
the controller.

- Brief: `brf_01M2XJ8W95BXYET7TA3N8HSZFJ`
- Accepted proposal: `prv_01M2XJTWP9MQYTJG4H0XNW2FXZ`, version 2
- Accepted fingerprint: `560805ad74b67dc25282f07935238967364622840a50f0ba6792eb2b9d37ccae`
- Human acceptance: `Prathyush`, recorded separately from proposal creation
- Bootstrap: `bst_01M2XJRK8WNZRK0T2TQ1WDQR9C`
- Project: `prj_01M2XJRKAXXW8BDPR31R0EEPG3`
- Repository: `/home/prat/src/products/ai-engineering-study-assistant`
- Review preset: personal

The learner record uses the supplied assessment: intermediate Python (automation experience and code
comprehension, with more library/application exploration needed), beginner ML fundamentals, and
beginner LLM application development. The curriculum targets clear enterprise-scale AI/LLM
engineering and AI/MLOps concepts plus interview readiness, informed by ten years of DevOps/SRE
experience.

The first accepted proposal contained noncanonical routing labels. Bootstrap stopped before task
creation or worker use. This exposed and fixed a platform validation gap: presentable proposals now
reject unknown task class, complexity, ambiguity, risk, context size, empty tools, and invalid priority.
The brief was versioned, stale consent invalidated, a corrected proposal presented, and the user
accepted its new fingerprint before bootstrap resumed under the same ID.

Bootstrap completed all nine recorded steps, created one local repository, registered unittest and
compile checks, and submitted four sequential tasks. One exact-specification feedback task was later
created through the generic feedback service after acceptance auditing found access-label, author, and
seven-day-schedule omissions.

## MABS execution evidence

All five tasks are `DONE`. Execution used existing subscription authentication only:

- 5 Codex implementation attempts;
- 5 Codex repair attempts;
- 10 independent Claude review attempts;
- 20 total attempts, with no provider/auth/quota failure and no paid fallback.

The first task required two review repairs; each of the next three planned tasks required one; the
acceptance follow-up passed its first independent review. Every accepted revision passed the registered
unittest and compile gates.

A second platform defect surfaced after the first task's review repairs. Downstream setup tried to
cherry-pick only the final repair commit, which omitted its prerequisite implementation commits and
conflicted. The controller was stopped before another worker ran. `integrateDependencyRevisions()` now
replays every dependency commit not reachable from the downstream workspace, oldest first. A
regression test uses an initial commit plus a dependent repair commit. The blocked task was explicitly
retried and all later dependency workspaces materialized the full reviewed history.

Final reviewed pilot deliverable:

- branch: `mabs/tsk_01m2xqkvhw2qhknef17m4kzwfn`
- revision: `ccc7d830d0c5104329fe9e71e48871e754e7334a`
- worktree: `/home/prat/worktrees/prj_01M2XJRKAXXW8BDPR31R0EEPG3/tsk_01M2XQKVHW2QHKNEF17M4KZWFN`
- product tests: 33 pass, 0 fail

At the E5 phase commit, the product's `main` remained at bootstrap revision `f0afffc`; the reviewed
branch was deliberately not merged or pushed because E5 authorization explicitly left merge and remote
publication disabled. During E6, the user separately approved the exact reviewed revision. Approval
`apr_01M2YJPP7N4YHS84KNJ5TWSC5W` was bound to `merge`, target `main`, revision `ccc7d83`, the current
project configuration, passing gates, and approved review. `main` was fast-forwarded locally, its 33
tests and compile check passed, and the approval was consumed. No pilot remote or push was added.

## Pilot behavior

The standard-library-first Python CLI runs without MABS and provides:

- `assess` — stable, idempotent learner assessment;
- `syllabus` — assessment-adapted eight-week outline with seven days per week;
- `packet --day N` — versioned Markdown/HTML daily packet;
- `progress` — idempotent completion, difficulty, exercise result, and bounded backlog records;
- `revise-week` — append-only future-week revision with prior progress/history preserved;
- `status` — current state and complete revision history.

The default daily total is exactly 270 minutes: concepts/documentation 45, papers 60,
implementation 90, interview practice 45, and recall/backlog 30. The syllabus has 56 days at 4.5
hours each and records the initial 60/40 theory/practice allocation. Backlog displaces new exercise
material rather than extending the daily budget.

The initial vertical slice includes generated eight-week, seven-day sample-week, and complete daily
packet artifacts. A complete packet requires two distinct paper identities with verified authors and
inspected evidence. The readable report includes identity, URL, identifier when available,
publication status, `full_text` / `abstract_only` / `metadata_only` evidence access, commercial
availability, retrieval provenance, evidence snippets, relevance, prerequisites, outcome, priority,
estimate, checks, interview questions, and next action. Untrusted fetched text is escaped in Markdown
and HTML.

## Retrieval and runtime boundaries

Source adapters are replaceable and have explicit timeout, cache, and rate controls. They normalize
DOIs and URLs, relate repository/preprint/published identities, rank primary learning/evidence value
ahead of recency/popularity, and persist source observations. Broken links, timeouts, insufficient
evidence, unknown access, or fewer than two suitable papers produce a visible partial result.

Fixed fixtures cover two distinct papers, identity deduplication, related publication records, honest
status/access, unknown access, broken links, timeout recovery, untrusted content, and rerun behavior.
The optional synthesis boundary is disabled by default. Missing subscription, auth, quota, timeout,
and I/O states preserve a pending request and fetched data; no API-key fallback exists.

A separately authorized live command made one bounded request to the free public arXiv Atom endpoint:

- maximum results: 2;
- timeout: 5 seconds;
- response cap: 1 MB;
- API key: not used;
- paid service: disabled.

It returned two distinct arXiv records with inspected titles/authors/identities and correctly labeled
both as `preprint` plus `abstract_only`; PDF links were not misreported as inspected full text. Raw
evidence is in `docs/phases/evidence/e5-live-retrieval-smoke.json`.

The independent local runtime smoke persisted the real assessment levels and generated 8 weeks, 56
days, a complete 270-minute fixture packet, one progress record, backlog carry-forward, and an
append-only week revision. The progress, difficulty, and revision values are explicitly **SIMULATED
TEST DATA**, not claims about learner activity. See
`docs/phases/evidence/e5-independent-runtime-smoke.json`.

## Commands

From the final reviewed worktree:

```sh
python3 -m unittest discover -s tests       # 33 pass, 0 fail
python3 -m compileall -q src                # clean
PYTHONPATH=src python3 -m ai_engineering_study_assistant.cli --help
```

Example local operation:

```sh
PYTHONPATH=src python3 -m ai_engineering_study_assistant.cli --db study.sqlite3 assess \
  --python intermediate --ml beginner --llm beginner
PYTHONPATH=src python3 -m ai_engineering_study_assistant.cli --db study.sqlite3 syllabus
PYTHONPATH=src python3 -m ai_engineering_study_assistant.cli --db study.sqlite3 packet --day 1 \
  --fixture fixtures/retrieval_ok.json
```

## MABS phase gate and state safety

Persistent MABS state was backed up before intake at
`~/.local/state/mabs/backups/mabs-2026-09-19T19-28-42-655Z.sqlite`. E5 adds no MABS schema change;
the pilot owns its separate application schema, currently version 6 with tested additive/backfill
migration behavior.

```
npm run typecheck                         # clean
MABS_STATE_DIR=/tmp/mabs-e5-final npm test # 72 pass, 0 fail
git diff --check                          # clean
```

An operator-started `controller run --adapter=codex --ui` process entered while the bounded E5
controller held the singleton lease. It remained excluded, then acquired the lease after the E5
controller stopped and completed later work without duplicate tasks. Current work is 5 `DONE`, 0
queued/running/blocked, and 0 pending approvals. Controller health retains a high cumulative
`db_errors` counter because lease contention is currently classified through the generic tick-error
path even though this was not a SQLite outage. E6 should make standby/lease contention distinct from
database failure rather than erasing that evidence. The operator process was not terminated.

## Disabled operations and limitations

No schedule, timezone, notification destination, CI, deployment, monitoring service, remote, push,
merge, paid API, extra credit, or automatic upgrade was configured. The optional local
subscription-synthesis adapter remains a real runtime dependency when explicitly supplied; it is not
background or unlimited intelligence. The live adapter currently covers arXiv Atom only. Publisher
and DOI metadata remain replaceable future adapters. The local pilot `main` now contains the reviewed
revision following the separately recorded E6 merge decision; remote publication remains unconfigured.
