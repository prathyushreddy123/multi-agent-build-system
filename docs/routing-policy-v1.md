# Routing policy v1

Policy ID: `phase2-routing-v1`  
Status: **provisional**  
Implemented in: `src/routing/router.ts`

The controller applies this map only after filtering for installed subscription adapters, required local tools, persisted provider availability, provider concurrency, and an attempt-boundary exclusion. An explicit `--adapter` is an operator override. No API-key or paid fallback is eligible.

| Task class | Primary | Fallback | Evidence / status |
| --- | --- | --- | --- |
| Mechanical | Deterministic gates | None | Model inference is unnecessary. |
| Small implementation | Codex, default model, medium effort | Claude Sonnet 5 | Both providers passed Phase 0 bug-fix and feature cells; Codex is the initial default pending more project evidence. |
| Complex coding | Codex, default model, high effort | Claude Opus 5 | Codex passed the resumed complex cell in 77s. Claude's observed complex run was not accepted and later subscription runs hit capacity limits. |
| Diagnosis | Codex, default model, high effort | Claude Sonnet 5 | Codex passed the Phase 0 diagnosis cell. Claude's sampled diagnosis was not accepted. |
| Planning | Claude Opus 5 | Codex, high effort | Provisional; no representative Phase 0 planning cell. |
| Research | Codex, medium effort | Claude Sonnet 5 | Provisional; no representative Phase 0 research cell. |
| Review | Claude Sonnet 5 | Codex, high effort | Provisional and intended for separate-context review in Phase 3. |
| Troubleshooting | Codex, high effort | Claude Opus 5 | Provisional extension of diagnosis evidence. |
| Curation | Claude Opus 5 | Codex, high effort | Provisional; activation remains approval-gated for Phase 4. |

## Profile adjustments

- A small implementation is promoted to the complex-coding route when complexity, change risk, or context size is `high`.
- A deadline under 24 hours raises Codex effort to `high`; it does not bypass capacity, gates, or approval policy.
- Language and domain are retained in the durable task and routing explanation. This version does not claim a language/domain preference without representative evidence.
- Required tools must resolve locally before an AI route is eligible.
- Quota and authentication failures exclude the failed provider at the current attempt boundary. A fallback starts with a fresh context packet and does not consume code-repair budget.

## Phase 0 evidence

Primary evidence remains outside Git:

- `~/.local/state/mabs/baseline/2026-09-18T03-31-48-077Z`
- `~/.local/state/mabs/baseline/2026-09-18T03-45-13-035Z`

Observed accepted cells:

- bug fix: Claude 21s, Codex 69s;
- feature: Claude 33s, Codex 78s;
- diagnosis: Codex 71s;
- complex: Codex 77s in the resumed run.

These samples are too small to establish broad provider superiority. Future map changes require versioning, representative evaluation, and—once the curator exists—approval before activation.
