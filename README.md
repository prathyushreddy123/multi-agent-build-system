# MABS

A local multi-agent build system with an LLM-assisted orchestrator and a deterministic, SQLite-backed task controller. It uses existing Claude Pro and ChatGPT subscription sessions and strips API-key paths before launching workers.

## Current status

Phases 0–4 are complete. The system now includes durable projects/tasks/attempts/events, isolated Git worktrees, portable context packets, Claude and Codex subscription adapters, deterministic quality gates, bounded implementation/review feedback loops, revision-bound approvals, crash recovery, multi-project scheduling, provider-aware routing, persisted execution plans, evidence/context diagnostics, durable user feedback, an approval-gated configuration curator, and a localhost workbench.

See [`docs/implementation-status.md`](docs/implementation-status.md), the [configuration curator guide](docs/curator.md), the [versioned routing policy](docs/routing-policy-v1.md), and the source plan in [`docs/requirements/source-plan.txt`](docs/requirements/source-plan.txt).

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
  --accept="registered checks pass;result is committed locally" \
  --class=small_implementation --scope=src,test \
  --mode=single --mode-reason="One bounded implementation task."

# Run the controller and local workbench.
node src/cli.ts controller run --adapter=codex --ui
```

The default workbench is `http://127.0.0.1:4317`. Runtime state defaults to `~/.local/state/mabs`; worktrees default to `~/worktrees`. Override these with `MABS_STATE_DIR`, `MABS_DB_PATH`, and `MABS_WORKTREE_ROOT`.

When this repository is trusted by Pi, `.pi/extensions/mabs.ts` adds `/mabs-status`, `/mabs-project`, `/mabs-task`, `/mabs-plan`, `/mabs-feedback`, `/mabs-approval`, `/mabs-curate`, `/mabs-provider`, `/mabs-start`, `/mabs-ui`, and `/mabs-backup`, plus read-status and submit-task tools.

## Useful commands

```bash
node src/cli.ts help
node src/cli.ts status
node src/cli.ts task list
node src/cli.ts plan validate plan.json
node src/cli.ts plan apply demo plan.json
node src/cli.ts plan list --project=<id>
node src/cli.ts feedback add task <id> question --body="..." --version=<recordVersion>
node src/cli.ts approval request <task> deploy <target> --reason="..."
node src/cli.ts curator snapshot demo > config.json
node src/cli.ts curator suggest demo --title="Rules-first suggestion"
node src/cli.ts curator propose demo config.json --title="..." --rationale="..."
node src/cli.ts curator evaluate <proposal>
node src/cli.ts curator history demo
node src/cli.ts provider list
node src/cli.ts provider reset codex
node src/cli.ts controller once --workers=2 --codex-limit=1 --claude-limit=1
node src/cli.ts baseline --only=complex --harness=codex
node src/cli.ts maintenance policy
node src/cli.ts maintenance backup
node src/cli.ts maintenance prune          # dry-run
node src/cli.ts maintenance prune --apply  # explicit deletion
```

SQLite records and completed summaries are retained indefinitely. Full artifacts are retained for 30 days after successful tasks and 90 days after failed or cancelled tasks; active and blocked task evidence is not automatically eligible. Pruning is dry-run unless `--apply` is supplied. The newest 14 consistent SQLite backups are retained.

Routing is task-class based and evidence-informed. Supplying `--adapter=codex|claude` is an explicit operator override; omitting it uses the versioned policy. `--workers`, `--active-projects`, `--per-project-workers`, `--codex-limit`, and `--claude-limit` control concurrency. Optional `--min-free-memory-mb` and `--max-load-per-cpu` thresholds pause new dispatch under machine pressure. Quota failures enter a persisted cooldown and may reroute only at an attempt boundary; authentication failures remain unavailable until `provider reset`.

New CLI-onboarded projects default to substantive independent review after revision-bound quality gates. Review uses a fresh context, prefers a provider different from the implementer when eligible, records structured findings, and can return bounded repairs for re-check and re-review.

The Phase 4 curator writes proposed configuration to an isolated local Git branch, runs deterministic policy replay, and requires an exact `activate_config_change` approval before changing active local configuration. Activation and revert history are durable, and equivalent rejected suggestions require new evidence before reconsideration.

Consequential actions such as push, merge, and deploy are not performed by the controller. The workbench and CLI can prepare and decide exact revision/configuration-bound approvals, but no approval is itself an external-action executor. Target, revision, or project-configuration drift invalidates open approvals.
