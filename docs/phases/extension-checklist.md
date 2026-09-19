# MABS Extension Implementation Brief — phase checklist

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

- [ ] Context packets carry an explicit source workspace and inspected revision.
- [ ] Review policy normalized and validated at every entry point; required mode cannot inherit skips.
- [ ] Advisory findings separated from blocking findings.
- [ ] Unconfigured quality coverage represented explicitly rather than reported as passed.

## E2 — Configurable review without repeated work

- [ ] Versioned review-policy evaluator shared by dispatch, verdicts, approval preparation, CLI, and workbench.
- [ ] Presets: experiment, personal, client. Explicit migration from required/substantive/none.
- [ ] Risk detection, repair-delta reuse, capacity handling, resolved-policy display.

## E3 — Conversation to an accepted product plan

- [ ] Durable intake records and brief lifecycle.
- [ ] Pi tools: create/update brief, propose/accept plan, bootstrap, submit plan, get product.
- [ ] `/mabs-new` entry point plus product-discovery skill; existing commands preserved.

## E4 — Bootstrap, language profiles, reusable guidance

- [ ] Resumable bootstrap with recorded steps and existing-directory refusal.
- [ ] Python and JS/TS profiles with detection, environment, checks, artifacts, composition.
- [ ] Post-scaffold check rediscovery; versioned skills/prompts.

## E5 — AI engineering study assistant pilot

- [ ] Separate product repository created through the generic MABS services.
- [ ] Assessment, syllabus, daily packet, progress, weekly revision, status.
- [ ] Evidence-verified retrieval with honest access labels and partial packets.

## E6 — Optional operations and release validation

- [ ] CI, deployment, monitoring, scheduling, delivery, and cost interfaces defined and disabled.
- [ ] End-to-end scenario and handoff evidence.
