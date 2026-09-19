# E2 summary — configurable review without repeated work

Completed: 19 September 2026. Branch `mabs-extension`.

## What changed

`src/review/policy.ts` is now a versioned evaluator (`review-policy-v2`) read by dispatch, review
verdict handling, approval preparation, the CLI, and the workbench. No component interprets the
policy for itself.

### Separate axes

| Field | Values | Meaning |
| --- | --- | --- |
| `trigger` | off, manual, risk, required | Whether a review runs at all |
| `scope` | change, affected_components, release | How much of the change a reviewer receives |
| `cadence` | task, milestone, release | When acceptance is expected |
| `blockingSeverities` | critical / major / minor | Which findings force another repair cycle (`critical` is mandatory) |
| `riskRules` | named rules | What counts as elevated risk, with the matching evidence recorded |
| `reviewerRoute` | independent_provider, same_provider_fresh_context | Preferred reviewer separation |
| `capacityAction` | pending, blocked | What happens when required coverage cannot run now |
| `qualityExpectation` | advisory, configured_checks, acceptance_and_gates | Readiness bar for approval preparation |

### Presets

| Preset | Review | Quality expectation |
| --- | --- | --- |
| experiment | `trigger=off`; manual review available at any time | `advisory` — may proceed with no configured checks, but every acceptance records a `quality.coverage_disclosed` event that says so |
| personal | `trigger=risk` with the default rule set | `configured_checks` — configured checks or a recorded waiver |
| client | `trigger=required`, `scope=affected_components`, `cadence=release`, no skips | `acceptance_and_gates` — also requires recorded mandatory requirements |

### Risk detection

Risk comes from the controller's own view of the revision — `finalized.changedFiles` and the actual
diff — never from the worker's self-description. Default rules cover declared high risk, complex
coding, authentication/credential paths and content, schema and migration changes, destructive
operations (`rm -rf`, `rmSync`, `shutil.rmtree`, `DELETE FROM`, force push), and deployment/CI
configuration. Every matched rule is stored with its evidence (`changed path src/auth/session.ts`,
`change content matched "rmSync("`), and a `review.decision` event records the outcome either way.

### Compatibility and migration

Stored v1 policies are migrated on read, so old rows and old callers keep working; `mode` remains on
the policy object and is derived from `trigger`. The mapping is explicit:

- `substantive` → `trigger=risk` **plus** an explicit `legacy-substantive-change` rule that matches
  every non-skipped class. The same set of tasks is reviewed as before; the reason is now visible.
- `required` → `trigger=required`, skips dropped, `qualityExpectation=acceptance_and_gates`.
- `none` → `trigger=off`, but `qualityExpectation=configured_checks`. A migrated project is **not**
  relaxed to advisory readiness; only an explicit move to the experiment preset does that.

`setProjectReviewPolicy` refuses any change that weakens review (weaker trigger, new skips, dropped
blocking severities, lower quality expectation) unless the caller acknowledges the weakening and
gives a reason, and the weakening is recorded in the event log.

### Reuse and repair deltas

`reviewContextFingerprint` hashes the configuration version, policy, check commands, requirements,
acceptance criteria, and dependency result revisions. It is stored on every review. Approval
preparation refuses to reuse an accepted review whose fingerprint no longer matches. A re-review
after a repair receives the prior findings plus a `review-delta.patch` covering only the repair,
while the full `review-diff.patch` stays available; after meaningful drift the delta is withheld and
a `review.scope_broadened` event is recorded instead.

### Capacity

When required review cannot be routed, `capacityAction=pending` records a `review_pending`
checkpoint, a `review.pending` event, and a `Review pending:` block reason; the controller's
`resumePendingReviews` retries it when a provider frees up, without re-running the implementation.
`capacityAction=blocked` stops instead. Neither path can be mistaken for acceptance: approval
preparation still refuses the revision.

## Measured comparison on fixed tasks

Measured by `test/extension-e2.test.ts`, same worker behaviour, same fixed tasks:

| Fixed task | Migrated v1 `substantive` | `personal` preset |
| --- | --- | --- |
| Credential change (`src/auth/session.ts`) | reviewed | reviewed — rule `authentication-or-credentials` |
| Documentation change (`docs/usage.md`) | reviewed | **not** reviewed — no risk rule matched |

Two fixed tasks, three review calls under the v1 policy versus two under `personal`: one avoided
review call on this pair, with detection unchanged on the risky change. Repair cycles were unchanged
(0 for both accepted tasks; 1 in the delta test, where the injected defect was detected on the first
review and confirmed fixed on the second). Reported usage is null for the fixture adapters, so no
token or cost figure is claimed here.

## Migration

Schema 11 gains `review_results.policy_version` and `review_results.context_fingerprint` (additive).
A stored v1 policy row was written directly into `projects.review_policy` and read back correctly as
a migrated v2 policy (`test/extension-e2.test.ts`). `src/domain/states.ts` adds one lifecycle edge,
`BLOCKED → REVIEWING`, so a deferred review can resume without repeating the implementation.

## Surfaces

- `mabs project review <project>` with no mode prints the resolved policy; with a mode it sets it.
- `mabs project preset <project> <experiment|personal|client> [--reason=...] [--acknowledge-weakening]`.
- `mabs review decide <task>` explains the decision; `mabs review request <task>` records a manual
  review request that the controller honours at the next decision point.
- The workbench shows the resolved policy per project, and per task the decision, the matched rules
  with their evidence, the quality-coverage status, and blocking versus advisory findings.

## Tests

```
npm run typecheck   # clean
npm test            # 57 pass, 0 fail (49 after E1)
```

`test/extension-e2.test.ts` covers all presets, manual override, required-mode validation, minor
versus major findings, repair-delta review, revision/configuration invalidation, missing checks,
capacity deferral and resumption, legacy stored records, and strict validation of authored policies.
