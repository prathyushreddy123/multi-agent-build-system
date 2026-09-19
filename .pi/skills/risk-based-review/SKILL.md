---
name: risk-based-review
description: Reviews a MABS revision according to its resolved risk policy, required scope, prior findings, repair delta, and evidence. Use for independent change review or release-readiness assessment.
metadata:
  version: "1.0.0"
---

# Risk-based review

Read [the shared MABS boundaries](../_shared/MABS_BOUNDARIES.md) first.

1. Review the revision and workspace named in the packet; fail closed on provenance drift.
2. Apply the resolved policy and matched risk evidence. Do not downgrade required review because the change looks small.
3. Check mandatory requirements, acceptance criteria, registered quality evidence, affected dependencies, security-sensitive paths, schema changes, destructive operations, and operational configuration.
4. Label every finding `[critical]`, `[major]`, or `[minor]` with file/evidence and a concrete correction.
5. Critical and policy-configured blocking severities request changes. Preserve minor findings as advisory evidence.
6. On repair review, inspect prior findings and the repair delta; broaden to the full change when requirements, configuration, dependencies, or context changed.
7. Never equate missing checks, unavailable review capacity, or inaccessible evidence with approval.
