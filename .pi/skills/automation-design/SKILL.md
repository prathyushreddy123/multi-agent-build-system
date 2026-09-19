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
7. Give each task a narrow repository-relative scope, dependency reason, and evidence-based acceptance criteria.
8. Do not add infrastructure merely because it might be useful later.
