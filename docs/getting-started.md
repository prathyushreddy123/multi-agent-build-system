# Run your first task

[Documentation](index.md) · [Repository home](../README.md)

**Goal:** make one small, inspectable change in a trusted Git repository. MABS will keep the result on a local task branch—not merge or publish it.

Run the commands below from the **MABS checkout**, unless stated otherwise. Replace example paths and IDs with your own values.

## 1. Install MABS

You need Node.js 24+, Git, and an authenticated Claude Code or Codex CLI for model work. Install the tools needed by your target repository too.

```bash
git clone https://github.com/prathyushreddy123/multi-agent-build-system.git
cd multi-agent-build-system
git switch mabs-extension
npm ci
npm test
npm run typecheck
node src/cli.ts help
```

Already have this checkout? Skip cloning and confirm you are on the intended branch. Successful tests and typechecking verify the local MABS code; they do not verify your provider login or target project.

Check the provider you plan to use:

```bash
# Codex: expect a ChatGPT login, not an API-key login.
codex login status

# Or Claude Code: expect a first-party claude.ai session.
claude auth status
```

Do not add API keys to make a failed login work. MABS removes paid-API environment settings before worker launches and does not fall back to a paid model API.

`node src/cli.ts verify --quick` checks **both** provider logins and environment scrubbing. A missing second provider can fail that combined check even if your chosen provider works. The full `verify` command also launches real model probes and uses subscription capacity; it is not required for this walkthrough.

## 2. Choose a safe practice repository

Use a trusted repository with a committed starting point, a `README.md`, and declared checks that already pass. A disposable clone is a good first choice. The example task below only edits `README.md`.

```bash
# Replace this absolute path. Keep running commands from the MABS checkout.
PROJECT=/absolute/path/to/your/repository

git -C "$PROJECT" status --short
git -C "$PROJECT" log -1 --oneline
node src/cli.ts profile inspect "$PROJECT"
```

Check the profile output for discovered checks and missing prerequisites. MABS does not install missing project dependencies when you register a repository. New task worktrees may also need their own dependency setup; an ignored `node_modules` or virtual environment in the original checkout is not copied by Git.

> **Trust boundary:** worktrees separate Git changes, not operating-system permissions. Workers and repository checks execute local commands. Do not use an untrusted repository or treat a worktree as a security sandbox.

## 3. Register the project and task

These commands write local MABS records. If a controller is already running, it may pick up the task as soon as it becomes eligible. For a controlled first run, stop other controller loops before submission.

```bash
node src/cli.ts project add demo "$PROJECT" \
  --goal="Learn the workflow with a small documentation task"

node src/cli.ts requirement add demo REQ-1 \
  "Keep application behavior unchanged and preserve existing README content."

node src/cli.ts task add demo "Document the test command" \
  --objective="Add a short Testing section to README.md using the repository's actual declared test command. Do not change application code or invent commands." \
  --accept="README explains how to run the declared tests;existing README content is preserved;registered required checks pass" \
  --class=small_implementation --scope=README.md \
  --mode=single --mode-reason="One small first task."
```

The registration output includes the project's `id`, `baseBranch`, `checkCommands`, and `reviewPolicy`. The base branch defaults to the target repository's current branch. Check these before dispatch; missing checks are not equivalent to passing tests.

Save the `id` printed by `task add`. Use a different project name if `demo` is already registered; do not repeat registration to inspect an existing project.

## 4. Start the controller

**This starts real worker runs and uses subscription capacity.** It can dispatch other eligible tasks in the same MABS state directory, not just `demo`. Inspect `project list` and `task list` first if you already use MABS.

```bash
node src/cli.ts controller run --adapter=codex --workers=1 --ui
```

Use `--adapter=claude` if that is your authenticated provider. This flag is an explicit route override; omit it to use the routing policy. A review may use another eligible provider or a fresh review context on the same provider, depending on policy and availability.

Open **[http://127.0.0.1:4317](http://127.0.0.1:4317)**. The workbench shows projects, tasks, attempts, checks, reviews, and evidence. The normal path is:

```text
QUEUED → READY → RUNNING → CHECKING → REVIEWING* → DONE

* Review runs when required by the project's policy.
```

Waiting or blocking is possible—for example, because of subscription limits or missing tools. Do not assume that a submitted task will complete without intervention.

## 5. Inspect the result

In another terminal, from the MABS checkout:

```bash
TASK_ID=replace-with-the-task-id
node src/cli.ts task show "$TASK_ID"
```

Look for:

- `task.state`: `DONE`, or an explicit reason it has not finished.
- `gates` and `reviews`: what was checked, against which revision.
- `task.resultSummary`, `task.resultRevision`, and `task.branch`: the local result.
- `diagnostics`: context warnings and evidence paths.

To inspect the committed change, substitute `task.baseRevision` and `task.resultRevision` from that output:

```bash
BASE_REVISION=replace-with-base-revision
RESULT_REVISION=replace-with-result-revision
git -C "$PROJECT" diff "$BASE_REVISION" "$RESULT_REVISION" -- README.md
```

**`DONE` is not “merged” or “published.”** You decide separately how to integrate the result after inspecting it.

## Stop and resume safely

Press `Ctrl+C` in the controller terminal to stop the loop and its attached workbench. **Detached workers may continue running.** To stop a particular task, use explicit task cancellation rather than assuming the controller's exit cancelled it.

Restart the same controller command with the same state paths to reconcile existing attempts. Do not delete state or worktrees to force a retry.

To open the workbench without starting dispatch:

```bash
node src/cli.ts ui
```

This opens the existing workbench, not a static documentation site. Its mutation controls can change records; inspection alone does not start a controller.

## Where things live

| Item | Default | Override |
| --- | --- | --- |
| Task records and artifacts | `~/.local/state/mabs` | `MABS_STATE_DIR` |
| SQLite database | `~/.local/state/mabs/mabs.sqlite` | `MABS_DB_PATH` |
| Task worktrees | `~/worktrees` | `MABS_WORKTREE_ROOT` |

If `XDG_STATE_HOME` is set, the default state directory is `$XDG_STATE_HOME/mabs`. Keep the same overrides across terminals and restarts. A different state path points to different records.

**Next:** [follow a task visually](architecture/task-execution.md), [troubleshoot a blocker](troubleshooting.md), or [browse the documentation](index.md).
