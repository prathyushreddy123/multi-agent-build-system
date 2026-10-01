# MABS efficiency v5: progress

Resume from here in a new session. The details live in the [ledger](mabs-efficiency-implementation.md).

- **Branch / worktree:** `mabs/efficiency-v5` at `~/worktrees/mabs-v5` (main checkout untouched except `b89e7ce`)
- **Authorized:** Phases 0–3, plus the two Phase 2 live checks. Stop and report before Phase 4.
- **Current phase:** Phases 0–3 merged to main and pushed (`8645482`, fixes `8dd8b3d` and `6fca9f0`); live DB at schema 22; V3 live checks done. **Waiting for decisions on the V3 findings and approval of Phase 4.**
- **Baseline:** typecheck ✔, extension typecheck ✔, `npm test` 414/414 ×3

## Done
- Phase 0: environment recorded, baseline green, the 7 reported failures do not reproduce (environment artifact), BENCH-02 turns split (`19a9b80`), cleanup audit (report only), ledger.

- Phase 1: INT-01 `3211ae1`, INT-02 `91cd69c` (schema 19), INT-03 `2e8a946`, INT-04 `e5fde13`, OUT-01 `a1b46b5` + `9823a88`. Tests 440/440, typechecks clean.

- Phase 2: CTX-01 `cd71616`, ROUTE-01 `791ce08`, PLAN-01 `05c2e78`, EXEC-01 `ee94831` (schema 20). Tests 459/459, typechecks clean. Migration 18→20 rehearsed on a live copy.

- Live checks: V2-ROUTE and V2-EXEC passed (`736934c`).
- Phase 3: GOV-01 `c860a58` (schema 21), UX-01 `bfac07b`, CTX-02 `2e1d72c` (schema 22). Tests 474/474. Migration 18→22 rehearsed on a live copy.

- V3 live checks (2026-10-01): parity completed (MABS 17/18 hidden, direct 18/18; Pi tool errors 9 → 0). Findings: false completion of `mechanical` tasks (open, high), fragmentation warnings ignored, new composite tools not chosen, standing preference applied to an inferred type. Fixed during the run: scope globs (`6fca9f0`) and the feed crash on a stale context (`8dd8b3d`).

## Next (needs approval)
1. V3-PARITY / V3-PLAN / V3-INTAKE live run (budget in [mabs-efficiency-validation.md](mabs-efficiency-validation.md)).
2. Phase 4: REV-01..03 (independent review feature); release-vs-task governance must be decided first.
3. Before merging: `maintenance migrate` on the live database (18 → 22, rehearsed on a copy), then `preferences set-delivery fast` if wanted.
