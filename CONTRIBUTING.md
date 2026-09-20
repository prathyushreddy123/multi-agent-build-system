# Contributing to MABS

[Repository home](README.md) · [Documentation](docs/index.md) · [System overview](docs/architecture/system-overview.md)

**Small, reviewable changes are welcome.** Explain the problem, keep the scope focused, and show how you checked the result. Documentation fixes, clearer errors, and regression tests are useful contributions—not just new features.

## Set up

Use Node.js 24+ and the repository's npm lockfile:

```bash
npm ci
npm test
npm run typecheck
git diff --check
```

There is no declared build or lint script. Do not invent a replacement command or add a new toolchain for a small documentation change.

The automated suite uses local fixtures and test adapters; a real provider run is a separate check. Full `verify` and `baseline` commands use subscription capacity. Do not launch them or alter your live projects just to validate prose.

## Before changing behavior

1. Read the nearest implementation and tests, plus the relevant [visual guide](docs/architecture/index.md).
2. For a bug, add a small reproduction or regression test. State what fails before the fix and passes after it.
3. Keep controller decisions, worker output, and evidence consistent. A model statement alone is not proof of success.
4. Explain any state/schema/policy change and update affected documentation.

### Source map

| Area | Start here |
| --- | --- |
| Task execution and recovery | [`src/controller/controller.ts`](src/controller/controller.ts), [`test/controller.test.ts`](test/controller.test.ts) |
| State rules and durable records | [`src/domain/states.ts`](src/domain/states.ts), [`src/store/records.ts`](src/store/records.ts) |
| Worker launch and contracts | [`src/adapters/`](src/adapters/), [`src/domain/contract.ts`](src/domain/contract.ts) |
| Checks and review | [`src/gates/`](src/gates/), [`src/review/policy.ts`](src/review/policy.ts) |
| Product intake and bootstrap | [`src/intake/`](src/intake/), [`src/bootstrap/`](src/bootstrap/) |
| Operator interfaces | [`src/cli.ts`](src/cli.ts), [`src/workbench/server.ts`](src/workbench/server.ts), [Pi extension](.pi/extensions/mabs.ts) |

## Writing documentation

- **README:** purpose, fit, small overview, and links. Put detailed commands and internals in focused guides.
- **One question per diagram:** use short labels and roughly 5–9 nodes for introductory views. Put exceptions in another scenario or a table.
- **Explain diagrams in text:** readers without Mermaid support must still understand the page. Never rely only on color.
- **Preview the result:** inspect Mermaid in rendered Markdown or a local renderer. Check readability at ordinary laptop width, not just syntax.
- **Check examples against source/help:** label placeholders, working directories, and commands that mutate records or launch workers. Do not execute dangerous examples as a test.
- **Keep links usable:** verify relative paths and heading anchors, including the hub and links back from new pages.
- **Avoid duplicated truth:** link to the detailed source of an explanation instead of copying it into several guides. Compare the [state reference](docs/architecture/state-reference.md) with `TASK_STATES` and `canTransition` when state rules change.
- **Preserve provenance:** historical phase reports stay dated. Do not rewrite old test results as if they were current verification.

## Boundaries every change must preserve

- No paid model API fallback or credentials committed to the repository.
- No silent skipping of required checks/review; missing evidence stays visible.
- No duplicate dispatch after restart, broadened edit scope, or stale approval reuse.
- No claim of deployment, monitoring, delivery, or improvement without corresponding evidence.
- No external action merely because a plan or approval exists; execution authority is separate.

## Share the change

Include a short summary, affected paths, test commands and outcomes, and any known limits. Include before/after screenshots for visual changes when useful. Keep private transcripts, databases, tokens, and machine-specific evidence out of commits.

A contribution does not authorize a merge, release, or deployment. Follow the repository owner's publication instructions; do not force-push shared history.
