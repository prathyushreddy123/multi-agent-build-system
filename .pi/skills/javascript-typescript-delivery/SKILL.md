---
name: javascript-typescript-delivery
description: Delivers and reviews JavaScript or TypeScript changes using the detected package manager, lockfile, scripts, component root, and runtime. Use for Node.js, JavaScript, or TypeScript components detected by MABS.
metadata:
  version: "1.0.0"
---

# JavaScript and TypeScript delivery

Read [the shared MABS boundaries](../_shared/MABS_BOUNDARIES.md) first.

- Select npm, pnpm, Yarn, or Bun from the lockfile and `packageManager` evidence; never assume npm when stronger evidence exists.
- Use repository scripts for format, lint, typecheck, test, and build. Do not invent an equivalent command with different semantics.
- Respect component roots in monorepos and keep unordered parallel edits in disjoint paths.
- Do not silently generate or replace lockfiles. Package installation is an explicit environment setup step, not bootstrap proof.
- Run every registered required check for the changed component and preserve its output as evidence.
- If Node, the selected manager, or a script dependency is missing, report the setup requirement rather than claiming green quality.
- Record entry points, build outputs, reports, and development commands in handoff evidence.
