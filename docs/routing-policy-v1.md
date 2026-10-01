# How provider routing works

[Documentation](index.md) · [Provider recovery](troubleshooting.md#provider-recovery)

MABS selects an eligible subscription route for each task. The default policy is **`phase2-routing-v1`**, still marked **provisional** in [`src/routing/router.ts`](../src/routing/router.ts). It is a starting configuration, not a ranking of provider quality. The policy *proposes* routes; the [capability registry](#the-capability-registry-decides-what-may-launch) decides whether each one may launch.

## Default routes

Every route names an **exact model and effort**. A launch never inherits a provider's local default model or reasoning setting, and the launchers refuse to run without both flags. Efforts are limited to `low`, `medium`, and `high`; maximum reasoning levels are excluded.

| Task class | First choice | Fallback |
| --- | --- | --- |
| Mechanical | Registered checks; no model | None |
| Small implementation | Codex `gpt-5.6-sol`, medium | Claude `claude-sonnet-5`, medium |
| Complex coding | Codex `gpt-5.6-sol`, high | Claude `claude-opus-5`, high |
| Diagnosis | Codex `gpt-5.6-sol`, high | Claude `claude-sonnet-5`, high |
| Planning | Claude `claude-opus-5`, high | Codex `gpt-5.6-sol`, high |
| Research | Codex `gpt-5.6-sol`, medium | Claude `claude-sonnet-5`, medium |
| Review | Claude `claude-sonnet-5`, medium | Codex `gpt-5.6-sol`, high |
| Troubleshooting | Codex `gpt-5.6-sol`, high | Claude `claude-opus-5`, high |
| Curation | Claude `claude-opus-5`, high | Codex `gpt-5.6-sol`, high |

## The capability registry decides what may launch

A route in the table can launch only if its exact provider, model, and effort are listed in the versioned **capability registry** (`mabs.capabilities.v3`, in [`src/routing/capabilities.ts`](../src/routing/capabilities.ts)) with **verified** subscription entitlement. A model showing up in a provider's catalog is not evidence of entitlement. Adding a model is a reviewed code change that gets a new registry version.

| Provider | Models | Entitlement out of the box | Quota domain |
| --- | --- | --- | --- |
| Claude | `claude-sonnet-5`, `claude-opus-5` | Verified (Phase 0 probe) | `anthropic:claude-ai-subscription` |
| Codex | `gpt-5.6-sol` | **Unknown**, so ineligible | `openai:chatgpt-subscription` |

**Codex stays ineligible until you prove it.** Phase 0 ran Codex on its locally configured default, which `codex exec` does not report. So the exact pinned ID is unproven. Run:

```bash
node src/cli.ts routing verify-entitlement codex gpt-5.6-sol
```

This makes **one real provider call** on that exact route. Only a clean answer, reported as that same model, records the proof in `capability-entitlements.json` in the state directory. A running controller picks it up on its next tick, with no restart. The proof can flip `unknown` to `verified`; it can never add a model. Until you run it, every Codex-first route falls back to Claude and records why.

Two more launch rules come from the registry:

- **No native child agents.** Claude runs with `--disallowedTools Agent`, and Codex with `features.multi_agent=false`. A route whose delegation cannot be switched off is rejected.
- **Wrong model fails the attempt.** If Claude answers with a different model than the one requested, the attempt fails as `CONFIG` rather than being accepted.

`node src/cli.ts routing capabilities` prints the registry with recorded proofs applied.

## What can change the choice?

- **Eligibility:** the adapter must be installed, required tools available, the route registered and entitled, and the provider not unavailable. A rejected candidate is skipped, and the decision is recorded as a `provider_fallback`.
- **Quota domains:** models in one subscription share its quota. Once a domain is exhausted for a task, every route in it is excluded; switching models within it cannot create capacity.
- **Capacity:** if the preferred provider is only *busy*, `--capacity-fallback=allow` (the default) uses a free fallback and records a `capacity_fallback`. `--capacity-fallback=wait` keeps the task waiting for the preferred route.
- **Task profile:** a small implementation with high complexity, risk, or context size uses the complex-coding route. A recorded deadline less than 24 hours away raises Codex effort to high. Both are recorded as a `capability_escalation`, and neither bypasses safety checks.
- **Operator preference:** `--adapter=codex` or `--adapter=claude` (or `MABS_ADAPTER`) reorders the candidates. It cannot make an ineligible or unavailable route usable, and it does not disable fallback. `--model=` and `--effort=` set explicit per-attempt values, which are rejected before launch if they are not in the registry.
- **Project configuration:** the controller applies an eligible project route override after that selection, so it can supersede the adapter preference. A project route override must be eligible in the registry. Inspect the recorded routing reason when both are set.
- **Review:** the reviewer must be a different provider from the implementer, with fresh context, unless a custom review policy explicitly allows same-provider review. A small change (mechanical or small implementation, not high-risk, not highly complex) is reviewed at **medium** effort if the reviewer's route supports it. An explicit project review route is never overridden. See [review behavior](architecture/task-execution.md#where-review-fits).
- **Provider failure:** `AUTH` or `QUOTA` can trigger fallback between attempts, with fresh context and no code-repair charge. See the [fallback scenario](architecture/recovery-and-failures.md#provider-fallback-during-implementation).

Each selection records its `decision` (`primary`, `provider_fallback`, `capacity_fallback`, `capability_escalation`, `capacity_wait`, `no_route`, or `deterministic`), the fallback and escalation reasons separately, the quota domain, per-candidate eligibility evidence, and the route the policy originally *requested*.

Language and domain are recorded as context, not used here to claim unmeasured provider expertise. No API-key or paid model API route is eligible.

## Inspect the actual decision

`node src/cli.ts routing explain TASK_ID` shows the recorded route decisions, plus a dry selection that launches nothing. `node src/cli.ts task show TASK_ID` includes routing records and reasons, and `task scorecard TASK_ID` keeps the requested, configured, and reported model and effort distinct. `node src/cli.ts provider list` shows current recorded availability. Read these instead of assuming the first-choice column was used.

If a model or tool is unsupported, fix the configuration rather than repeatedly retrying or enabling paid access. For a reviewed configuration change, follow the [curator guide](curator.md).

## Evidence and limitations

The initial choices used a small [Phase 0 sample](phases/phase-0-summary.md). Planning, research, and other sparsely measured routes remain provisional. Provider outages are availability observations, not proof of coding inferiority.

The original evidence directories were `~/.local/state/mabs/baseline/2026-09-18T03-31-48-077Z` and `~/.local/state/mabs/baseline/2026-09-18T03-45-13-035Z` on the verification machine; they are not included in a fresh checkout.

Use recorded outcomes and representative comparisons to justify changes. A curator evaluation tests configuration safety; improvement claims additionally need a completed [optimization experiment](../src/optimization/experiments.ts).
