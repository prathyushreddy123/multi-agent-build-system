# Operator workspace

[Documentation](../index.md) · [Command reference](../commands.md) · [Getting started](../getting-started.md)

A development workspace around Herdr and Pi: concise agent output, reliable file opening, independent code inspection, live task progress, and accessible execution logs.

The controller stays the scheduler and the only writer of task transitions. Workers stay isolated in their worktrees. The task store stays authoritative. Everything here is presentation and read-only inspection on top of the existing records.

## Surfaces

| Surface | What it is for |
| --- | --- |
| **Agent** | Requests and concise execution summaries; expand for raw details |
| **Code** | Browse all project files and changed files; inspect source and diffs in the selected task worktree |
| **Tasks** | Plan, tasks, recorded steps, dependencies, attempts, and blocked reasons |
| **Logs** | Original tool, worker, check, and review evidence |

## Pages

| Page | Contents |
| --- | --- |
| [Phase 0 capabilities](phase-0-capabilities.md) | What the installed Pi, Herdr, viewer, and editor actually support, and the two integration proofs |
| [Progress note](progress.md) | Phase status, changed files, checks, blockers, and next action |

## Boundaries this work does not cross

- No second scheduler, duplicate task database, or new editor framework.
- No change to model-facing tool results, existing truncation, cancellation, or error semantics.
- No new model calls, API billing, automatic merge, push, or deployment.
- No provider routing or authentication change.
- Disabling the feature leaves the original CLI, Pi integration, and workbench working.

## Verify the environment

```bash
node src/cli.ts operator probe
```

Re-run after upgrading Pi or Herdr and compare with the versions recorded in [Phase 0 capabilities](phase-0-capabilities.md).
