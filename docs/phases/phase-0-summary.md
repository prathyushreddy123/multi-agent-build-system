# Phase 0 completion summary — access proof

Completed: 18 September 2026

## Implemented

- Repeatable Claude Code and Codex subscription-authentication probes.
- Fail-closed removal of known paid Anthropic, OpenAI, Azure, Bedrock, Vertex, and custom-base-URL environment routes.
- Identical throwaway repository fixture for provider comparisons.
- Structured worker result schema and validation.
- Edit/test/result and cancellation probes for both harnesses.
- Installed-version capture, Claude model-alias resolution, and failure-shape classification.
- Representative bug-fix, feature, diagnosis, and complex-task baseline.
- Pi execution decision: Pi is the interaction surface; verified subscription CLIs are Phase 1 worker adapters.

## Evidence

- Access proof: `~/.local/state/mabs/phase0/2026-09-18T03-27-48-134Z` — 9/9 probes passed.
- Original baseline: `~/.local/state/mabs/baseline/2026-09-18T03-31-48-077Z`.
- Resumed complex Codex baseline: `~/.local/state/mabs/baseline/2026-09-18T03-45-13-035Z` — accepted in 77 seconds with a valid contract.

Claude's diagnosis and complex baseline cells encountered a real subscription session limit. They are provider-availability observations and are not scored as coding failures.

## Decisions

- Never fall back to paid API credentials.
- Unknown usage remains null.
- Claude's displayed cost is retained only as an API-equivalent estimate, not subscription spend.
- Real provider outages block or explicitly reroute and do not consume code-repair budget.
