# MABS Extension Implementation Brief — phase checklist

[Implementation history](../implementation-status.md) · [Current documentation](../index.md)

> Historical acceptance record. Versions, test counts, and machine-specific observations below describe the extension work when it was verified, not your current installation.

Source specification: `MABS Extension Implementation Brief`, version 1.0, 18 September 2026.
Branch: `mabs-extension`. Reviewed baseline commit: `50a33e9e3e701b1a4d46034f26a0166d03f59e28`.

Each phase records: concrete changes, acceptance tests, evidence, and a local commit. A phase is
complete only when its gate tests pass; source files existing is never sufficient.

## E0 — Baseline

- [x] Working tree inspected; no uncommitted user work existed at `50a33e9`.
- [x] Dedicated branch `mabs-extension` created for this increment.
- [x] Installed capability versions recorded (below).
- [x] Pre-existing test and typecheck state recorded: `npm test` 44/44 pass, `npm run typecheck` clean.
- [x] Test isolation confirmed: every suite sets `MABS_STATE_DIR`/`MABS_WORKTREE_ROOT` into a temp dir;
      no persistent state directory existed on this machine (`~/.local/state/mabs` absent at E0 start).
- [x] Subscription adapters left unchanged. No credential contents are printed anywhere in this increment.

### Installed capabilities at E0 (this machine, WSL2 Linux 6.6.87.2)

| Capability | Version | Path |
| --- | --- | --- |
| Node | v24.20.0 | mise `node/24` |
| TypeScript | 7.0.2 | repository devDependency |
| Pi | 0.85.1 | mise `node/24/bin/pi` |
| Claude Code | 2.1.260 | nvm `node/v20.20.0/bin/claude` |
| Codex CLI | 0.151.0 | nvm `node/v20.20.0/bin/codex` |
| Python | 3.14 | mise `python/3.14` |
| Git | system `/usr/bin/git` | — |

### Baseline commands

```
MABS_STATE_DIR=/tmp/mabs-baseline-state npm run typecheck   # clean
MABS_STATE_DIR=/tmp/mabs-baseline-state npm test            # 44 pass, 0 fail
```

## E1 — Correctness fixes

- [x] Context packets carry an explicit source workspace and inspected revision.
- [x] Review policy normalized and validated at every entry point; required mode cannot inherit skips.
- [x] Advisory findings separated from blocking findings.
- [x] Unconfigured quality coverage represented explicitly rather than reported as passed.

Evidence: `docs/phases/extension-e1-summary.md`. Each defect reproduced against `50a33e9` first.
`npm test` 49 pass / 0 fail; `npm run typecheck` clean. Schema 10 -> 11, additive, migration verified
against a database written by baseline code.

## E2 — Configurable review without repeated work

- [x] Versioned review-policy evaluator shared by dispatch, verdicts, approval preparation, CLI, and workbench.
- [x] Presets: experiment, personal, client. Explicit migration from required/substantive/none.
- [x] Risk detection, repair-delta reuse, capacity handling, resolved-policy display.

Evidence: `docs/phases/extension-e2-summary.md`. `npm test` 57 pass / 0 fail; typecheck clean.
Schema 11 gains policy/evidence fields additively; a stored v1 policy row reads back migrated.

## E3 — Conversation to an accepted product plan

- [x] Durable, versioned intake records and brief lifecycle before a repository exists.
- [x] Pi/CLI intake tools: create/update brief, material clarifications, propose/accept plan, submit plan, get product.
- [x] Exact proposal consent, stale-plan invalidation, preservation of completed work, and idempotent submission.
- [x] `/mabs-new` entry point plus versioned on-demand product-discovery skill; existing commands preserved.
- [x] Schema 11 -> 12 migration and automated E3 scenarios pass (64 total tests; typecheck clean).
- [x] Installed Pi loads the extension commands and product-discovery skill in offline RPC mode without errors.
- [x] Recorded a bounded provider-backed Pi conversation that created, presented, explicitly accepted, and submitted a validated plan without hand-written JSON.

Evidence: `docs/phases/extension-e3-summary.md` and `docs/phases/evidence/e3-live-pi-transcript.md`.
`mabs_bootstrap_project` is completed with
the safe bootstrap service in E4 rather than exposed here as a nonfunctional stub.

## E4 — Bootstrap, language profiles, reusable guidance

- [x] Accepted-path bootstrap records nine resumable steps and refuses unrelated non-empty directories.
- [x] Resume preserves files and reuses project/task linkage without destructive cleanup or duplicates.
- [x] Python and JS/TS profiles cover detection, isolated environment instructions, checks, artifacts, and mixed-component composition.
- [x] Post-scaffold check rediscovery is shared with project onboarding; missing tooling remains an explicit setup requirement.
- [x] Versioned product, automation, Python, JS/TS, and risk-review skills load on demand; shared boundaries are stored once.
- [x] Role prompts/schemas are separate from packet assembly; attempts record prompt and selected guidance versions.
- [x] Schema 12 -> 13 migration, installed Pi load check, and all E4 scenarios pass.

Evidence: `docs/phases/extension-e4-summary.md`. Full gate: 72 tests, typecheck clean.

## E5 — AI engineering study assistant pilot

- [x] Real learner brief, corrected exact proposal consent, resumable bootstrap, and five reviewed tasks used only generic MABS services.
- [x] Separate Python repository provides assessment, 8 x 7-day syllabus, 270-minute packet, progress, weekly revision, and status.
- [x] Fixed-fixture retrieval verifies identity/authors/status/access/provenance, deduplicates reruns, and returns honest partial packets.
- [x] One bounded free-public arXiv smoke retrieved two distinct preprints and labeled inspected evidence `abstract_only`; no key or paid service was used.
- [x] Finished CLI ran independently of MABS; product suite passes 33/33 and simulated progress evidence is explicitly labeled.
- [x] Proposal-value and multi-commit dependency defects found by the pilot have fail-closed regression coverage.

Evidence: `docs/phases/extension-e5-summary.md` and `docs/phases/evidence/e5-*.json`. The reviewed
product is revision `ccc7d83` on its MABS task branch; merge/push remain disabled pending separate approval.

## E6 — Optional operations and release validation

- [x] Versioned CI, deployment, monitoring, scheduling, delivery, and cost contracts default disabled/manual/local-only.
- [x] Incomplete targets fail closed; preparation is dry-run; no production external-operation adapter or execute command is registered.
- [x] Exact deployment approval consumption plus simulated failure/recovery, schema 13 -> 14 migration, CLI/Pi/workbench visibility pass focused tests.
- [x] User-approved E5 local merge was bound to reviewed revision `ccc7d83`, rechecked on pilot `main`, and consumed; no push/release/deploy followed.
- [x] End-to-end evidence matrix separates real provider/pilot/runtime evidence from automated and simulated portions.
- [x] Bounded subscription-backed Pi read-only verification used exactly the two status tools, reported the Git-proof limitation, and performed no mutation.
- [x] Final gates: clean typecheck, 79/79 MABS tests, 33/33 pilot tests from merged `main`, compile pass, Pi extension load, valid evidence JSON, and clean diff check.

Current evidence: `docs/phases/extension-e6-summary.md` and `docs/phases/evidence/e6-*.json`.
