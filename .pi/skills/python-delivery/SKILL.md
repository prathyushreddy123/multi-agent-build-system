---
name: python-delivery
description: Delivers and reviews Python application changes using the repository's declared environment, package manager, checks, entry points, and artifact conventions. Use for Python components detected by a MABS application profile.
metadata:
  version: "1.0.0"
---

# Python delivery

Read [the shared MABS boundaries](../_shared/MABS_BOUNDARIES.md) first.

- Follow the detected component root, `pyproject.toml` or other manifest, lockfile, and version file.
- Use the selected isolated environment (`uv`, Poetry, Pipenv, or `.venv`); do not install into shared global Python.
- A `pyproject.toml` alone is not evidence that pytest is configured. Run only checks registered from manifest/configuration evidence.
- Keep import layout and entry points consistent with the repository; do not rewrite a mature project to match a starter.
- Add deterministic tests for changed behavior and run every registered required check from its component root.
- If Python, a selected manager, or a declared check tool is missing, report the exact setup requirement rather than treating the check as passed.
- Record runnable entry points, build outputs, reports, and development commands in handoff evidence.
