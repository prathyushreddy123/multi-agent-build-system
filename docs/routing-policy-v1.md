# How provider routing works

[Documentation](index.md) · [Provider recovery](troubleshooting.md#provider-recovery)

MABS selects an eligible subscription route for each task. The default policy is **`phase2-routing-v1`**, still marked **provisional** in [`src/routing/router.ts`](../src/routing/router.ts). It is a starting configuration, not a ranking of provider quality.

## Default routes

“Default model” means Codex chooses its configured default; MABS does not invent an exact model identity. Claude entries are the model IDs recorded by the existing policy, not a promise that your installed CLI or subscription currently supports them.

| Task class | First choice | Fallback |
| --- | --- | --- |
| Mechanical | Registered checks; no model | None |
| Small implementation | Codex default, medium effort | Claude Sonnet 5 |
| Complex coding | Codex default, high effort | Claude Opus 5 |
| Diagnosis | Codex default, high effort | Claude Sonnet 5 |
| Planning | Claude Opus 5 | Codex default, high effort |
| Research | Codex default, medium effort | Claude Sonnet 5 |
| Review | Claude Sonnet 5 | Codex default, high effort |
| Troubleshooting | Codex default, high effort | Claude Opus 5 |
| Curation | Claude Opus 5 | Codex default, high effort |

## What can change the choice?

- **Eligibility:** an adapter must be installed, required tools must be available, and the provider must not be unavailable or at capacity.
- **Task profile:** a small implementation with high complexity, risk, or context size uses the complex-coding route. A recorded deadline less than 24 hours away raises Codex effort to high; it does not bypass safety checks.
- **Operator preference:** `--adapter=codex` or `--adapter=claude` reorders the policy candidates. It does not make an unavailable route usable or disable all fallback.
- **Project configuration:** the current controller applies an eligible project route override after that selection, so it can supersede the adapter preference. Inspect the recorded routing reason when both are set.
- **Review:** the controller can prefer a different provider from the implementer, using fresh context. See [review behavior](architecture/task-execution.md#where-review-fits).
- **Provider failure:** `AUTH` or `QUOTA` can trigger fallback between attempts, with fresh context and no code-repair charge. See the [fallback scenario](architecture/recovery-and-failures.md#provider-fallback-during-implementation).

Language and domain are recorded as context, not used here to claim unmeasured provider expertise. No API-key or paid model API route is eligible.

## Inspect the actual decision

`node src/cli.ts task show TASK_ID` includes routing records and reasons. `node src/cli.ts provider list` shows current recorded availability. Read these instead of assuming the first-choice column was used.

If a model or tool is unsupported, fix the configuration rather than repeatedly retrying or enabling paid access. For a reviewed configuration change, follow the [curator guide](curator.md).

## Evidence and limitations

The initial choices used a small [Phase 0 sample](phases/phase-0-summary.md). Planning, research, and other sparsely measured routes remain provisional. Provider outages are availability observations, not proof of coding inferiority.

The original evidence directories were `~/.local/state/mabs/baseline/2026-09-18T03-31-48-077Z` and `~/.local/state/mabs/baseline/2026-09-18T03-45-13-035Z` on the verification machine; they are not included in a fresh checkout.

Use recorded outcomes and representative comparisons to justify changes. A curator evaluation tests configuration safety; improvement claims additionally need a completed [optimization experiment](../src/optimization/experiments.ts).
