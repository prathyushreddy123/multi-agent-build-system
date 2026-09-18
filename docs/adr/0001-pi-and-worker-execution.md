# ADR 0001: Pi is the interaction surface; subscription CLIs are worker adapters

- Status: accepted for Phase 1
- Date: 18 September 2026

## Context

The source plan requires existing Claude Pro and ChatGPT Plus subscription allowance only. It also requires proving the execution path instead of assuming that a third-party provider login receives subscription allowance.

Installed Pi 0.85.1 supports OAuth subscription logins for Anthropic and OpenAI Codex. The active environment reports provider `openai-codex`, and Pi's local auth record identifies both `anthropic` and `openai-codex` as OAuth credentials. Separately, repeatable probes proved the installed `claude` CLI is authenticated through first-party `claude.ai` and the installed `codex` CLI through ChatGPT, with API-key routes removed from every worker environment.

## Decision

1. Phase 1 workers execute through direct Claude Code and Codex CLI adapters whose subscription authentication and output behavior were tested.
2. Pi remains the desired interactive interface. The future thin Pi extension will submit commands to the deterministic controller and open the workbench; it will not make hidden worker model calls.
3. MABS does not pass API keys to Pi or either worker harness. The adapter environment strips known Anthropic, OpenAI, Azure, Bedrock, Vertex, and custom-base-URL billing routes, then checks the result before launch.
4. A Pi worker adapter is deferred. It may be added only after an equally repeatable proof covers subscription authentication, structured output, cancellation, and no paid fallback.

## Consequences

- The current worker path satisfies the no-extra-spend constraint with observable authentication evidence.
- Pi extension work can proceed independently of worker execution and cannot bypass controller approvals.
- Provider session limits block or explicitly reroute; they never trigger API-key fallback.
- Direct adapters duplicate a small amount of harness handling, but preserve clear failure and usage evidence.
