# MABS

A local multi-agent build system with an LLM-assisted orchestrator and a deterministic, SQLite-backed task controller. It uses existing Claude Pro and ChatGPT subscription sessions and strips API-key paths before launching workers.

## Current status

Phase 0 access verification is complete. The Phase 1 foundation includes durable projects/tasks/attempts/events, isolated Git worktrees, portable context packets, Claude and Codex process adapters, deterministic quality gates, bounded repair handling, revision-bound approvals, controller recovery, and a localhost workbench.

See [`docs/implementation-status.md`](docs/implementation-status.md) and the source plan in [`docs/requirements/source-plan.txt`](docs/requirements/source-plan.txt).

## Requirements

- Node.js 24+
- Git
- At least one authenticated subscription CLI:
  - `claude auth status` using `claude.ai`
  - `codex login status` using ChatGPT

No API key is required or permitted for worker launches.

## Setup

```bash
npm install
npm test
npm run typecheck
node src/cli.ts verify --quick
```

## Basic workflow

```bash
# Register a repository. Existing npm/pytest checks are proposed automatically.
node src/cli.ts project add demo /path/to/repo --goal="Deliver the next milestone"

# Add stable project requirements and a task.
node src/cli.ts requirement add demo REQ-1 "All existing tests must continue to pass"
node src/cli.ts task add demo "Implement feature" \
  --objective="Implement the accepted feature scope" \
  --accept="registered checks pass;result is committed locally"

# Run the controller and local workbench.
node src/cli.ts controller run --adapter=codex --ui
```

The default workbench is `http://127.0.0.1:4317`. Runtime state defaults to `~/.local/state/mabs`; worktrees default to `~/worktrees`. Override these with `MABS_STATE_DIR`, `MABS_DB_PATH`, and `MABS_WORKTREE_ROOT`.

When this repository is trusted by Pi, `.pi/extensions/mabs.ts` adds `/mabs-status`, `/mabs-project`, `/mabs-task`, `/mabs-start`, `/mabs-ui`, and `/mabs-backup`, plus read-status and submit-task tools.

## Useful commands

```bash
node src/cli.ts help
node src/cli.ts status
node src/cli.ts task list
node src/cli.ts controller once --adapter=codex
node src/cli.ts baseline --only=complex --harness=codex
node src/cli.ts maintenance policy
node src/cli.ts maintenance backup
node src/cli.ts maintenance prune          # dry-run
node src/cli.ts maintenance prune --apply  # explicit deletion
```

SQLite records and completed summaries are retained indefinitely. Full artifacts are retained for 30 days after successful tasks and 90 days after failed or cancelled tasks; active and blocked task evidence is not automatically eligible. Pruning is dry-run unless `--apply` is supplied. The newest 14 consistent SQLite backups are retained.

Consequential actions such as push, merge, and deploy are not performed by the Phase 1 controller. Approval records exist, but action executors remain deliberately absent until their safety and idempotency checks are implemented.
