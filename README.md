# MABS

A local multi-agent build system with an LLM-assisted orchestrator and a deterministic, SQLite-backed task controller. It uses existing Claude Pro and ChatGPT subscription sessions and strips API-key paths before launching workers.

## Current status

Phases 0–5 are complete, along with the source plan's pre-routine-use acceptance checklist (stale-heartbeat visibility, many inactive projects alongside active ones, and database/lease-error visibility). No further numbered phases are defined in the plan. The system now includes durable projects/tasks/attempts/events, isolated Git worktrees, portable context packets with deterministic relevant-file retrieval and bounded context budgets, Claude and Codex subscription adapters, deterministic quality gates, bounded implementation/review feedback loops, revision-bound approvals, crash recovery, multi-project scheduling, provider-aware routing with outcome telemetry, persisted execution plans, structured task checkpoints and cross-provider continuity, evidence/context diagnostics, durable user feedback, an approval-gated configuration curator, a measured optimization-experiment registry, and a localhost workbench.

See [`docs/implementation-status.md`](docs/implementation-status.md), the [configuration curator guide](docs/curator.md), the [versioned routing policy](docs/routing-policy-v1.md), and the source plan in [`docs/requirements/source-plan.txt`](docs/requirements/source-plan.txt).

## Architecture

MABS splits the system along one line: a **deterministic controller** owns scheduling, state, quality gates, and evidence, while **non-deterministic workers** only ever run inside an isolated Git worktree behind a strict output contract. SQLite is the authoritative record, large artifacts are files on disk referenced by path, and the controller itself never pushes, merges, releases, or deploys.

### System map

```mermaid
flowchart LR
    subgraph SURF["Operator surfaces — localhost only"]
        direction TB
        CLI["CLI<br/>src/cli.ts"]
        PI["Pi extension<br/>.pi/extensions/mabs.ts"]
        WB["Workbench 127.0.0.1:4317<br/>read-only by default<br/>mutations need a capability token"]
    end

    subgraph CTRL["Controller process — one lease holder at a time"]
        direction TB
        TICK["Tick loop<br/>reconcile · promote · dispatch · health"]
        SCHED["Scheduler<br/>global · active-project · per-project · per-provider limits<br/>starvation-resistant fairness, memory and load backpressure"]
        ROUTER["Router<br/>task class and profile to a verified route<br/>policy version, project override, operator override"]
        CTXB["Context builder<br/>stable requirements · latest checkpoint<br/>rules-first file retrieval inside a token budget"]
        ADP["Adapters<br/>claude · codex<br/>start / status / cancel / collect result"]
        GATES["Gate runner<br/>repository-declared commands, bound to one revision"]
        REVIEW["Independent review<br/>fresh context, prefers the other provider, read-only"]
        CUR["Curator and optimization registry<br/>proposals · policy replay · measured experiments"]
    end

    subgraph STATE["Durable state — outside every repository"]
        direction TB
        DB[("SQLite<br/>projects · requirements · tasks · attempts · events<br/>gates · reviews · approvals · checkpoints · routing<br/>plans · config versions · experiments · health")]
        ART["Artifacts under ~/.local/state/mabs<br/>worker transcripts · completion envelopes<br/>gate logs · review diffs · context packets"]
        BAK["Backups and retention<br/>14 consistent SQLite copies · dry-run-first prune"]
    end

    subgraph EXEC["Execution substrate"]
        direction TB
        REPO["Project repository<br/>base branch is never moved"]
        WT["Isolated worktree<br/>one mabs branch per task"]
        WRK["Detached worker process<br/>paid-API variables stripped, fails closed"]
        CLAUDE["claude CLI<br/>claude.ai subscription"]
        CODEX["codex CLI<br/>ChatGPT subscription"]
    end

    CLI --> DB
    PI --> DB
    WB --> DB
    CLI -->|"controller run"| TICK

    TICK --> SCHED --> ROUTER --> CTXB --> ADP
    TICK --> GATES
    TICK --> REVIEW
    WB -->|"analyze, propose, evaluate, approve"| CUR
    CUR --> DB
    TICK <--> DB

    REPO -->|"git worktree add"| WT
    ADP -->|"spawn detached"| WRK
    WRK --> CLAUDE
    WRK --> CODEX
    CLAUDE -->|"edits confined to the worktree"| WT
    CODEX -->|"edits confined to the worktree"| WT
    GATES -->|"run against the checked revision"| WT
    WRK -->|"completion envelope and result JSON"| ART
    GATES --> ART
    REVIEW --> ART
    DB --> BAK
    ART -.->|"referenced by path"| DB
```

### Task execution flow

This is the path every task takes. Each decision below is enforced in code, not by prompt instruction.

```mermaid
flowchart TD
    SUBMIT["Task submitted<br/>class · allowed scope · execution mode<br/>acceptance criteria"] --> PROMOTE{"Project active and<br/>dependencies DONE?"}
    PROMOTE -->|"dependency failed or cancelled"| BLOCK["BLOCKED<br/>worktree and evidence preserved"]
    PROMOTE -->|"project paused or waiting"| QUEUED["QUEUED"]
    PROMOTE -->|"yes"| READY["READY"]
    QUEUED --> PROMOTE

    READY --> SLOT{"Slot available?<br/>global · project · provider limits<br/>disjoint scopes · machine pressure"}
    SLOT -->|"no"| READY
    SLOT -->|"yes"| CLAIM["Atomic claim<br/>prepare branch and worktree<br/>cherry-pick dependency revisions"]

    CLAIM --> KIND{"Task class"}
    KIND -->|"mechanical"| MECH["Run registered gates only<br/>no model inference"]
    MECH --> MECHOK{"Gates pass?"}
    MECHOK -->|"yes"| DONE["DONE"]
    MECHOK -->|"no"| FAILED["FAILED"]

    KIND -->|"model work"| ROUTE["Select route<br/>versioned policy, then project override,<br/>then explicit operator override"]
    ROUTE --> PACKET["Build context packet<br/>mandatory requirements · latest checkpoint<br/>retrieved files, omissions recorded"]
    PACKET --> WORK["RUNNING<br/>detached worker on a subscription CLI"]
    WORK --> OUT{"Attempt outcome"}

    OUT -->|"malformed or missing output"| CONTRACT["BLOCKED · CONTRACT<br/>never recorded as success"]
    OUT -->|"worker reports blocked"| BLOCK
    OUT -->|"AUTH or QUOTA"| REROUTE{"Another eligible<br/>subscription provider?"}
    REROUTE -->|"yes, at the attempt boundary"| PACKET
    REROUTE -->|"eligible but at capacity"| READY
    REROUTE -->|"none — paid fallback is forbidden"| BLOCK
    OUT -->|"CODE failure"| BUDGET{"Repair budget remaining?"}
    OUT -->|"completed"| SCOPE{"Edits within the<br/>declared allowed scope?"}

    SCOPE -->|"no"| CONTRACT
    SCOPE -->|"yes"| COMMIT["Commit on the task branch<br/>bind the result revision<br/>invalidate open approvals"]
    COMMIT --> GATE["CHECKING<br/>registered gates, evidence bound to the revision"]

    GATE -->|"a required gate fails"| BUDGET
    BUDGET -->|"yes"| REPAIR["RUNNING · repair attempt<br/>findings carried forward in a fresh packet"]
    REPAIR --> WORK
    BUDGET -->|"exhausted"| FAILED

    GATE -->|"all required gates pass"| POLICY{"Review policy applies<br/>to this task?"}
    POLICY -->|"no"| DONE
    POLICY -->|"yes"| REVIEW["REVIEWING<br/>fresh context, prefers the other provider,<br/>reads the diff, gate evidence, requirements"]
    REVIEW --> VERDICT{"Verdict"}
    VERDICT -->|"approved"| DONE
    VERDICT -->|"changes requested"| BUDGET
    VERDICT -->|"review blocked"| BLOCK
    VERDICT -->|"reviewer modified the workspace"| CONTRACT
```

### One controller tick and the worker handoff

```mermaid
sequenceDiagram
    autonumber
    participant OPS as Operator surface
    participant CTL as Controller tick
    participant DB as SQLite
    participant WT as Worktree
    participant WRK as Detached worker
    participant HAR as Subscription CLI

    OPS->>DB: register project, requirements, task
    loop every poll interval, default 2s
        CTL->>DB: acquire the controller lease, one generation only
        CTL->>DB: reconcile running attempts
        alt completion envelope exists
            CTL->>WRK: collect result, validate the contract, classify failure
        else process still alive
            CTL->>DB: heartbeat, stale age is reported and never auto-failed
        else process gone and no envelope
            CTL->>DB: block as INFRA, preserve worktree and evidence
        end
        CTL->>DB: promote QUEUED to READY as dependencies complete
        CTL->>DB: claim one READY task atomically
        CTL->>WT: prepare the isolated branch and worktree
        CTL->>DB: persist the context packet and the routing decision
        CTL->>WRK: spawn detached with paid-API variables stripped
        WRK->>HAR: run the harness with the packet prompt
        HAR->>WT: edit files inside the worktree only
        WRK->>DB: write the completion envelope and worker result JSON
        CTL->>DB: record checkpoint, gates, review, and controller health
    end
```

A worker deliberately outlives its controller. Because the completion envelope is a file and the attempt is a durable record, a restarted controller collects the same launch instead of dispatching a duplicate; a `RUNNING` task with no live attempt fails closed to `BLOCKED` rather than being retried silently.

### Task lifecycle

```mermaid
stateDiagram-v2
    [*] --> QUEUED
    QUEUED --> READY: dependencies DONE, project active
    QUEUED --> BLOCKED: dependency FAILED or CANCELLED
    READY --> RUNNING: claimed, worktree prepared, worker launched
    RUNNING --> CHECKING: valid result, revision committed
    RUNNING --> READY: provider unavailable, fallback at capacity
    RUNNING --> BLOCKED: AUTH, QUOTA, INFRA, CONFIG, CONTRACT, TIMEOUT
    CHECKING --> RUNNING: required gate failed, repair budget remains
    CHECKING --> REVIEWING: required gates passed, review required
    CHECKING --> DONE: gates passed, review not required
    CHECKING --> FAILED: repair budget exhausted
    REVIEWING --> RUNNING: review requested changes
    REVIEWING --> DONE: review approved
    REVIEWING --> BLOCKED: review blocked or reviewer edited the workspace
    RUNNING --> AWAITING_APPROVAL: consequential action prepared
    AWAITING_APPROVAL --> RUNNING: decision recorded, returns to the requesting state
    BLOCKED --> READY: explicit operator retry
    FAILED --> QUEUED: explicit operator requeue
    RUNNING --> CANCELLED: operator cancellation
    DONE --> [*]
    FAILED --> [*]
    CANCELLED --> [*]
```

Cancellation is available from every non-terminal state and terminates the worker process group; only `RUNNING`, `CHECKING`, and `REVIEWING` hold a worker slot. The authoritative transition matrix is [`src/domain/states.ts`](src/domain/states.ts).

### Failure classification

Repair cycles are a budget for the model's own mistakes, so only `CODE` spends one. This is what keeps a session limit or a bad model name from silently consuming the budget that real code repair needs.

| Class | Repair budget | Controller response |
| --- | --- | --- |
| `CODE` | spent | Repair attempt carrying the findings; `FAILED` once the limit is reached. |
| `QUOTA` | untouched | Persisted provider cooldown, reroute at the attempt boundary, `READY` if the fallback is at capacity, `BLOCKED` if there is none. |
| `AUTH` | untouched | Provider unavailable until `provider reset`; reroute to an eligible subscription provider if one exists. |
| `CONFIG` | untouched | `BLOCKED`. An unroutable model, rejected flag, or missing tool cannot be fixed by retrying. |
| `CONTRACT` | untouched | `BLOCKED`. Malformed output, or edits outside the declared scope, are never success. |
| `INFRA` | untouched | `BLOCKED` with the worktree and evidence preserved for inspection. |
| `TIMEOUT` | untouched | `BLOCKED`. |
| `CANCELLED` | n/a | `CANCELLED`; the worker process group is terminated. |

No failure path ever falls back to a paid API route. Forbidden key/base-URL variables are removed from the worker environment and the launch refuses to start if any survive.

### Approval and configuration boundary

```mermaid
flowchart LR
    EVID["Observed evidence<br/>failures · repairs · review findings<br/>routing overrides · provider events · repeated questions"]
    EVID --> AN["Curator analysis, on demand<br/>rules-first, bounded<br/>equivalent rejected fingerprints suppressed"]
    AN --> PROP["Proposal<br/>config-only commit on an isolated local branch<br/>the registered target branch is never touched"]
    PROP --> EVAL["policy-replay-v1 evaluation<br/>schema safety plus historical comparison"]
    EVAL -->|"unsafe or weakening"| REJ["Rejected<br/>reconsideration requires new evidence"]
    EVAL -->|"safe"| APPR{"Exact activate_config_change approval<br/>binds proposal, revision,<br/>evaluation, and config version"}
    APPR -->|"denied, or any binding drifted"| REJ
    APPR -->|"granted"| ACT["Activate at an inactive-task checkpoint<br/>consumes the approval, records actor and reason,<br/>supersedes competing proposals"]
    ACT --> VER["New configuration version<br/>revert is separately approval-gated<br/>and keeps its source version"]
```

The same shape governs every consequential action. An approval is a durable authorization record bound to an exact action, target, revision, and configuration — not an executor. Push, merge, release, and deployment executors do not exist in this codebase, and any drift in a binding invalidates the open approval rather than widening it.

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
node src/cli.ts optimization create demo experiment.json
node src/cli.ts optimization record <experiment> baseline case-1 measurement.json
node src/cli.ts optimization complete <experiment>
node src/cli.ts optimization routing demo
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

Phase 5 replaces the previously empty context relevant-file manifest with deterministic, rules-first retrieval bounded by a per-project token budget; every included or omitted file is recorded with a reason. Durable checkpoints let a rerouted attempt build a fresh context packet for the new provider instead of relying on another provider's history. Improvement or limitation-resolution claims require a completed optimization experiment comparing a fixed baseline and candidate suite; regressions in accepted work, requirement violations, or interventions are rejected.

Consequential actions such as push, merge, and deploy are not performed by the controller. The workbench and CLI can prepare and decide exact revision/configuration-bound approvals, but no approval is itself an external-action executor. Target, revision, or project-configuration drift invalidates open approvals.
