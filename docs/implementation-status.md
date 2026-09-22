# Implementation history

[Documentation](index.md) · [Repository home](../README.md)

**This is a history index, not a live status dashboard.** The original phases and extension phases have recorded completion summaries. Their test counts, versions, machine-local paths, and future-work statements describe the time of each run. Use the current [getting-started guide](getting-started.md) for setup and `node src/cli.ts status` for your local controller.

This index replaces the duplicated phase-by-phase narrative. Detailed evidence remains in the original summaries linked below; earlier versions of this page remain in Git history.

## Original implementation — 18 September 2026

| Phase | What it established | Evidence |
| --- | --- | --- |
| 0 | Subscription access, result format, provider baseline | [Access proof](phases/phase-0-summary.md) |
| 1 | Reliable local task, worktrees, state, restart recovery | [Local task](phases/phase-1-summary.md) |
| 2 | Multiple projects, bounded concurrency, routing | [Scheduling and routing](phases/phase-2-summary.md) |
| 3 | Independent review, feedback, workbench evidence | [Review and feedback](phases/phase-3-summary.md) |
| 4 | Approval-gated configuration proposals and revert | [Configuration curator](phases/phase-4-summary.md) |
| 5 | Bounded file context, checkpoints, measured experiments | [Context and optimization](phases/phase-5-summary.md) |
| Closeout | Stale heartbeat handling, paused projects, lease-error visibility | [Acceptance closeout](phases/closeout-summary.md) |

The [original source plan](requirements/source-plan.txt) defines phases 0–5. Closeout completed its remaining acceptance checks; it was not an extra numbered implementation phase. Its historical verification reported 44 passing tests; that is not the current suite count.

## Extensions — September 2026

Use the [extension checklist](phases/extension-checklist.md) for the full acceptance matrix and E0 baseline.

| Phase | Focus | Evidence |
| --- | --- | --- |
| E1 | Context, review, and missing-quality correctness fixes | [Summary](phases/extension-e1-summary.md) |
| E2 | Configurable risk-based review | [Summary](phases/extension-e2-summary.md) |
| E3 | Conversation to exact accepted plan | [Summary](phases/extension-e3-summary.md) |
| E4 | Safe bootstrap and Python/JS/TS profiles | [Summary](phases/extension-e4-summary.md) |
| E5 | Separate study-assistant pilot | [Summary](phases/extension-e5-summary.md) |
| E6 | Disabled-by-default optional operations and validation | [Summary](phases/extension-e6-summary.md) |

E6 distinguishes real provider runs, local runtime checks, and simulated operation outcomes. In particular, its deployment-adapter tests are not evidence of a production deployment.

## Documentation refresh — 20 September 2026

| Phase | Focus | Evidence |
| --- | --- | --- |
| 1 | Orientation and first-task onboarding | [Summary](phases/documentation-phase-1-summary.md) |
| 2 | Layered visual architecture | [Summary](phases/documentation-phase-2-summary.md) |
| 3 | Practical guides, cleanup, and consistency audit | [Summary](phases/documentation-phase-3-summary.md) |

## Operator workspace — 22 September 2026

A Herdr and Pi workspace with Agent, Code, Tasks, and Logs surfaces, built on the existing controller, task store, and evidence. It is presentation and read-only inspection only: no second scheduler, no duplicate task store, and no change to model-facing tool results.

| Phase | Focus | Evidence |
| --- | --- | --- |
| 0 | Capability proof against the installed Pi and Herdr | [Capabilities](operator/phase-0-capabilities.md) |
| 1 | Compact agent output derived from execution facts | [Compact output](operator/compact-output.md) |
| 2 | Code browsing through one shared task/worktree resolver | [Code surface](operator/code-surface.md) |
| 3 | Read-only task and recorded-step view | [Tasks surface](operator/tasks-surface.md) |
| 4 | Evidence lookup and safe following | [Logs surface](operator/logs-surface.md) |
| 5 | Idempotent workspace automation | [Workspace](operator/workspace.md) |

The [release acceptance record](operator/release-acceptance.md) separates automated results, live results on the verification machine, and checks that remain unverified. The [progress note](operator/progress.md) is the resumable implementation record.

## Reading evidence correctly

- Paths under `~/.local/state/mabs` refer to the original verification machine. A fresh clone does not contain those private runtime artifacts.
- Checked-in [extension evidence](phases/evidence/) includes explicitly labeled transcripts and JSON observations. Do not assume a simulated result was a real external operation.
- Historical successful checks do not replace rerunning checks for a new revision.
- The original phase work was committed and normally pushed at the owner's direction. That publication history does not grant general merge, release, deployment, or force-push permission.
