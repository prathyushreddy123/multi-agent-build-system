# E1 summary — correctness fixes before new features

Completed: 19 September 2026. Branch `mabs-extension`.

Four invariants in the reviewed baseline (`50a33e9`) were wrong in ways that would have been
inherited by every later phase. Each was reproduced against the baseline commit first, then fixed.

## Evidence that each defect was real

A probe was run inside a Git worktree checked out at `50a33e9` (`git worktree add /tmp/mabs-baseline 50a33e9`):

| # | Baseline behaviour observed | Fixed behaviour |
| --- | --- | --- |
| 1 | `absolutePath` pointed at the task worktree while the excerpt was read from the **base clone**; the two checkouts were at different revisions (`58b87b63` vs `37ededa7`). | Retrieval takes an explicit `sourceWorkspace`; packets carry `source_workspace`, `inspected_revision`, and `workspace.head_revision`. |
| 2 | `createProject({ mode: "required", skipTaskClasses: [...] })` stored `{"mode":"required","skipTaskClasses":["mechanical","planning","research"]}`. | Normalized to `{"mode":"required","skipTaskClasses":[]}` at every entry point, with a `project.review_policy_normalized` event. |
| 3 | `runGates` with zero configured checks returned `passed = true`, `results: []`, and no coverage field. | Returns `status: "not_configured"`, `coverage`, `requiredConfigured`, and records a revision-bound `quality-coverage` SKIPPED gate with an evidence file. |
| 4 | `prepareApproval` on a project with **0** configured checks prepared a `deploy` approval with `gates: []` as its evidence. | Refused unless an explicit approved waiver exists for `quality-coverage:<revision>`. |
| 5 | A review whose only finding was `[minor]` produced `request_changes`; the record had no severity fields. | Minor findings are advisory; `blockingFindings`/`advisoryFindings` are stored separately and all findings are retained. |

## Changes

- **`src/review/policy.ts` (new).** Single home for `ReviewPolicy`, normalization, strict validation,
  the finding-severity vocabulary, and `reviewRequiredFor`. `src/store/records.ts` re-exports the type
  and default so existing imports keep working. An unlabelled finding defaults to `major`, never to advice.
- **`src/context/retrieval.ts`.** `retrieveContext` requires an explicit `sourceWorkspace` and returns
  `sourceWorkspace` plus `inspectedRevision` (read with `git rev-parse HEAD`). Every excerpt, size, and
  absolute path now comes from that one checkout.
- **`src/context/packet.ts`.** Passes the task worktree as the source workspace. Review packets **fail
  closed** when the checkout is not on the revision under review. Implementation packets are labelled
  with the revision actually inspected and record a `context.revision_drift` event plus a manifest warning.
- **`src/gates/runner.ts`.** Adds `coverage`, `requiredConfigured`, and `status`
  (`passed` / `failed` / `not_configured`), and writes a `quality-coverage` evidence file when nothing is configured.
- **`src/controller/controller.ts`.** Uses the shared policy for dispatch; records a
  `quality_not_configured` checkpoint instead of claiming checks passed; computes the review verdict from
  blocking findings only; sends advisory findings to a repair worker clearly labelled as optional.
- **`src/store/records.ts`.** Normalizes review policy on create and update; stores blocking/advisory
  findings; adds `qualityCoverage()`; refuses approval preparation without configured checks or a waiver.
- **`src/cli.ts`, `src/domain/config.ts`.** Both entry points route through the shared normalization and validation.

## Migration

Schema version 10 → 11, additive only: `context_packets.source_workspace`, `context_packets.inspected_revision`,
`review_results.blocking_findings`, `review_results.advisory_findings`.

A database written by baseline code was opened with the new code: it migrated to 11, all legacy rows read
back, and a legacy review's findings were treated conservatively as blocking rather than retroactively
downgraded to advice.

## Tests

`test/extension-e1.test.ts` — five regression tests, one per invariant, including a full controller run
proving a minor-only review approves without consuming repair budget.

Two existing tests were updated because the corrected invariant changed their expected outcome:
`test/phase5.test.ts` (a project with no checks now records `quality_not_configured`) and
`test/workbench.test.ts` (approval preparation now needs configured, passing quality evidence).

```
npm run typecheck   # clean
npm test            # 49 pass, 0 fail (44 before this phase)
```
