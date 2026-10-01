---
name: automation-design
description: Designs small local automation products as explicit components, state, inputs, outputs, failure modes, and deterministic acceptance checks. Use when converting an accepted product brief into implementation tasks.
metadata:
  version: "1.0.0"
---

# Automation design

Read [the shared MABS boundaries](../_shared/MABS_BOUNDARIES.md) before applying this guidance.

1. Define inputs, outputs, durable state, and repeatable behavior before framework choices.
2. Separate a deterministic core from provider, network, scheduler, and delivery adapters.
3. Prefer local, inspectable files or SQLite when the accepted brief does not require a remote service.
4. Make retries idempotent; record checkpoints before side effects.
5. Convert each failure mode into an actionable state, not an implicit success.
6. Keep optional CI, scheduling, monitoring, deployment, and notifications disabled until explicitly configured.
7. Prefer one cohesive task. A small implementation includes the tests and documentation it needs; they are not separate tasks. Split only for an independent deliverable, a step that needs another task's accepted result, real parallel benefit with disjoint scopes, or context too large for one worker, and put that reason in the task's execution reason.
8. Give each task a repository-relative scope that covers its code, tests, and docs, a dependency reason, and evidence-based acceptance criteria. Keep every requirement and acceptance criterion when you merge or split tasks. When tasks name the requirements they own, mark cross-cutting invariants (offline, no paid services, data stays local) as `global` so every task carries them.
9. Do not add infrastructure merely because it might be useful later.
