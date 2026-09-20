# Documentation phase 2 — visual architecture

20 September 2026 · [Documentation](../index.md) · [Visual guide](../architecture/index.md)

Phase 1 was committed and pushed as `df618cf` before this phase began.

## Changes

- Replaced the dense README architecture section with one small map and links to focused guides.
- Added six architecture pages: navigation, responsibilities, task execution, recovery, approvals, and a complete state reference.
- Separated success, mechanical work, repair, provider fallback, and restart recovery into individual scenarios.
- Replaced the all-transitions lifecycle drawing with a developer table. Each remaining diagram has a text explanation.
- Corrected the worker handoff: completion is written to a file and collected by the controller, not written to SQLite by the worker.
- Made missing quality coverage, review-capacity handling, and approval-versus-execution distinctions explicit.
- Removed the README's long command dump and repeated implementation paragraphs. Advanced readers can use CLI help, source links, and existing focused guides; phase 3 adds a curated command reference.

## Validation

- Compared the state table programmatically with `TASK_STATES` and `canTransition`: all 10 states and 100 possible state pairs match.
- Checked behavior against the controller, worker process, gates, review policy, and configuration activation code.
- Local link/anchor checker: 80 links passed across the README, hub, getting-started guide, and six architecture pages.
- All nine Mermaid diagrams rendered successfully with Mermaid CLI 11.17.0 and local Chromium. Inspected contact sheets; shortened the handoff sequence after inspecting its first render, then checked it at a 1024-pixel viewport.
- Initial Chromium launch lacked shared libraries. Reused existing local browser libraries through `LD_LIBRARY_PATH`; no system or repository dependency changes were needed.
- Rendering artifacts and validation helpers stayed under `/tmp`. The checked-in source remains Markdown/Mermaid with text alternatives. GitHub's renderer and themes can differ from the local preview.
- Getting-started shell syntax and `git diff --check`: passed.

No application code or workbench behavior changed. Publication gate: commit and successfully push this phase before starting phase 3.
