# Code-health audit (report only)

CLEAN-01 baseline, 2026-10-01, commit `19a9b80`. **Nothing was deleted.** Any removal must be its own small commit with evidence, validation and a rollback, and is not required to finish the brief.

## Tools (pinned, run through `npx`, not added to package.json)
| Tool | Version | Notes |
|---|---|---|
| Knip | 6.39.0 | explicit entrypoints: `src/cli.ts`, `src/**/*-process.ts`, `src/worker-tools/*.ts`, `.pi/extensions/*.ts`, `bench/*.ts`, `scripts/*.mjs`, tests. `@earendil-works/*` is ignored because Pi is linked externally on purpose (`scripts/link-pi.mjs`) |
| dependency-cruiser | 18.5.0 with typescript 5.9.3 parser | TS 7 (repo) has no JS compiler API, so the TS 5 parser was used only inside the temporary npx environment |
| local link check | ad-hoc script | lychee is not installed. 289 relative links in 52 Markdown files, 0 broken; external URLs not checked |

Raw output: `evidence/phase0-knip.txt`, `evidence/phase0-depcruise.txt`, `evidence/phase0-doclinks.txt`.

## Findings
| Finding | Count | Classification | Action |
|---|---|---|---|
| Unused source files under `src/`, `.pi/` | 0 | — | none |
| Unused / unlisted npm dependencies | 0 (Pi excluded as external) | — | none |
| Dependency cycles (126 modules, 449 edges) | 0 | — | none |
| `bench/fixtures/pocket-ledger/template/src/cli.ts` reported unused | 1 | benchmark-only: a template copied into a benchmark project | keep |
| `bench/fixtures/parse-duration/hidden.test.js` unresolved imports | 2 | benchmark-only: hidden tests resolve against the worker's output at run time | keep |
| `bench/pi-turn.ts` unlisted binary `pi` | 1 | intentional: Pi is a user-installed external CLI | keep |
| Unused exports | 58 | mostly intentional: version constants (`*_VERSION`), enum tables, and helpers exported but used only inside their own module | candidates for *un-exporting* only; no deletion. Low value, so deferred |
| Unused exported types | 38 | intentional public domain types (e.g. `PlannedTask`, `DeliveryMode`) | keep |

Protected regardless of analyzer output: `src/verify/fixture.ts` (deliberately broken calculator for access proofs), migrations, recovery fixtures, benchmark hidden tests, historical evidence.

## Conclusion
The codebase has no dead modules, unused dependencies or import cycles at this baseline, so no cleanup commit is proposed. Analyzer findings alone never justify deletion (BND-09).
