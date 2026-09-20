# Documentation phase 1 — orientation and onboarding

20 September 2026 · [Documentation](../index.md)

## Changes

- Reframed the README around purpose, fit, benefits, and limits instead of an implementation inventory.
- Added a documentation hub and a five-term glossary.
- Added a first-task walkthrough covering installation, login, scope, dispatch, result inspection, and stopping safely.
- Folded the existing architecture reference out of the introductory reading path. Its replacement belongs to phase 2.
- Removed the duplicated README setup walkthrough; the getting-started guide is now the detailed version.

## Validation

- Checked CLI examples against `src/cli.ts`, including scope/acceptance flags and UI/controller behavior.
- Checked provider verification against `src/verify/phase0.ts`: quick verification tests both providers; full verification launches model probes.
- Checked state paths against `src/core/paths.ts` and gate discovery against `src/gates/discover.ts`.
- `node src/cli.ts help`: passed.
- Temporary local link/anchor checker: passed for README, hub, and getting-started guide (23 local links).
- `bash -n`: passed for all getting-started shell blocks. Examples were not dispatched as real model tasks.
- `git diff --check`: passed.

No runtime code, dependencies, or provider settings changed. Existing Mermaid diagrams were retained, not visually revalidated in this phase. The full repository test suite is scheduled for phase 3.

Publication gate: commit and push this phase to `origin/mabs-extension` before starting phase 2. Stop if the push fails; publication is confirmed by Git, not by this note.
