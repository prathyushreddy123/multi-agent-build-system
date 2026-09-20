# Documentation phase 3 — practical guidance and cleanup

20 September 2026 · [Documentation](../index.md) · [Implementation history](../implementation-status.md)

Phase 2 was committed and pushed as `97f7122` before this phase began.

## Changes

- Added troubleshooting, a curated command reference, FAQ, and contributor guidance.
- Simplified the configuration curator guide into inspect/propose, evaluate, approve, and activate stages. Mutation and publication boundaries remain explicit.
- Updated routing wording to match the controller: an eligible project override is applied after operator-preferred candidate ordering. Removed stale “future Phase 3/4” language from current guidance.
- Replaced the duplicated implementation-status narrative with a compact history index. Original phase summaries, source requirements, ADR reasoning, and acceptance evidence remain available.
- Marked the extension checklist and ADR as historical where their versions or future-tense statements could confuse new readers.
- Linked common questions, troubleshooting, and contributions from the README and hub. Removed repeated explanations rather than deleting useful provenance.

## Validation

- `npm test`: **79 passed, 0 failed**, using isolated default state/worktree paths and no inherited `MABS_DB_PATH`.
- `npm run typecheck`: passed on Node.js 24.20.0.
- CLI smoke in a disposable Git fixture: fixture tests, profile inspection, project registration, requirement/task submission, task/policy/status inspection, and optional CI preparation passed. The submitted task stayed `QUEUED` with zero attempts; no model worker or task worktree was launched.
- Source audit covered CLI flags, retry/version behavior, provider reset, review, route selection, workbench refresh, retention, and configuration activation.
- `bash -n`: passed on all 23 shell blocks in current guides. Syntax checks did not execute the examples.
- Local Markdown link/anchor audit: **174 local links/anchors passed across 36 Markdown files**, covering README, CONTRIBUTING, and all Markdown files under `docs/`.
- Final Mermaid blocks match the nine rendered diagrams checked in phase 2. The state reference was rechecked against all 10 states and all 100 possible state pairs.
- Inspected local rendered previews of README, the documentation hub, system overview, and getting started. Layout checks passed at 1024- and 390-pixel widths without page-level horizontal overflow; code blocks may scroll independently. These used a local Markdown preview, not GitHub's exact renderer.
- `git diff --check`: passed. Changes are documentation only; no runtime code, dependency, lockfile, or Pi-extension changes.

Validation helpers, browser previews, fixture state, and logs stayed under `/tmp`; no private runtime evidence was added to Git. No full provider verification, benchmark run, workbench rewrite, hosted site, or deployment was performed.

Publication gate: commit and normally push this final phase to `origin/mabs-extension`. Phase commit IDs and successful publication are confirmed by Git, not inferred from this note.
