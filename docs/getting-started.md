# Run your first task

[Documentation](index.md) · [Repository home](../README.md)

**Goal:** make one small, inspectable change in a trusted Git repository. MABS will keep the result on a local task branch—not merge or publish it.

Run the commands below from the **MABS checkout**, unless stated otherwise. Replace example paths and IDs with your own values.

## 1. Install MABS

You need Node.js 24+, Git, and an authenticated Claude Code or Codex CLI for model work. Install the tools needed by your target repository too.

```bash
git clone https://github.com/prathyushreddy123/multi-agent-build-system.git
cd multi-agent-build-system
npm ci
npm test
npm run typecheck
node src/cli.ts help
```

Already have this checkout? Skip cloning and confirm you are on `main`. Successful tests and typechecking verify the local MABS code; they do not verify your provider login or target project.

Check the provider you plan to use:

```bash
# Codex: expect a ChatGPT login, not an API-key login.
codex login status

# Or Claude Code: expect a first-party claude.ai session.
claude auth status
```

**Codex needs one extra step.** Every route names an exact model, and the Codex route (`gpt-5.6-sol`) stays ineligible until one real probe proves your subscription can use it. Until then, Codex-first routes fall back to Claude and the fallback is recorded. If Codex is your provider, run this once. It makes one small subscription call:

```bash
node src/cli.ts routing verify-entitlement codex gpt-5.6-sol
node src/cli.ts routing capabilities   # entitlement for that route now reads "verified"
```

The Claude routes (`claude-sonnet-5`, `claude-opus-5`) are already verified.

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
  --type=personal --delivery=standard \
  --goal="Learn the workflow with a small documentation task"

node src/cli.ts requirement add demo REQ-1 \
  "Keep application behavior unchanged and preserve existing README content."

node src/cli.ts task add demo "Document the test command" \
  --objective="Add a short Testing section to README.md using the repository's actual declared test command. Do not change application code or invent commands." \
  --accept="README explains how to run the declared tests;existing README content is preserved;registered required checks pass" \
  --class=small_implementation --scope=README.md \
  --mode=single --mode-reason="One small first task."
```

**Both governance flags are required before any task runs.** `--type` is `personal`, `client`, or `other`. `--delivery` sets how careful the project is:

| Delivery | Same as | Meaning |
| --- | --- | --- |
| `fast` | `--review=off` | Checks only |
| `standard` | `--review=risk` | Checks, plus review when a change is risky |
| `verified` | `--review=required` | Checks, plus required independent review; the task blocks if no reviewer can run |

A `client` project with no review choice defaults to `required`. MABS never picks the project type for you. If you leave a flag out, registration prints `"outcome": "needs_input"` with the open questions, and the controller dispatches nothing for that project. Answer later with `project governance demo --type=... --delivery=... --version=N`, and use `project readiness` to list the decisions that are still open.

When governance is complete, the registration output includes the project's `id`, `baseBranch`, `checkCommands`, and `reviewPolicy`. The base branch defaults to the target repository's current branch (`--base=BRANCH` overrides it). Check these before dispatch; missing checks are not equivalent to passing tests.

> `verified` with only one provider: independent review needs a *second* eligible provider. On a fresh install with Codex not yet verified, a `verified` project blocks with `CONFIG` before implementing, and names the ineligible reviewer. It launches nothing. Use `standard` for a first run, or verify the second provider first.

Save the `id` printed by `task add`. Use a different project name if `demo` is already registered; do not repeat registration to inspect an existing project.

## 4. Start the controller

**This starts real worker runs and uses subscription capacity.** It can dispatch other eligible tasks in the same MABS state directory, not just `demo`. Inspect `project list` and `task list` first if you already use MABS.

```bash
node src/cli.ts controller run --adapter=codex --workers=1 --ui
```

Use `--adapter=claude` if that is your authenticated provider. This flag reorders the routing policy's candidates; it cannot make an ineligible route usable. If Codex's entitlement is not verified (step 1), `--adapter=codex` still runs on Claude, and `task show` records the provider fallback. Omit the flag to use the routing policy. You can also set the preference with `MABS_ADAPTER=codex|claude`. To require one provider instead, use `--pin-adapter=codex`: implementation and repair then run only on Codex, and wait or block when it cannot run rather than moving to Claude. Review routing is not pinned, so a required independent reviewer can still run.

A second `controller run` against the same state refuses to start while one is live, and exits 0. (`--force` overrides this; it is meant for recovery, not normal use.) When review is triggered, it runs on a different provider from the implementer. With only one eligible provider, a `standard` project's review waits as `Review pending:` until a second provider becomes eligible.

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
| Verified route entitlements | `~/.local/state/mabs/capability-entitlements.json` | follows `MABS_STATE_DIR` |
| Operator workspace preferences | `~/.local/state/mabs/operator/preferences.json` | `MABS_OPERATOR_CONFIG` |

If `XDG_STATE_HOME` is set, the default state directory is `$XDG_STATE_HOME/mabs`. Keep the same overrides across terminals and restarts. A different state path points to different records.

Less common environment variables:

| Variable | Effect |
| --- | --- |
| `MABS_ADAPTER` | Default for `controller run --adapter` (`claude` or `codex`) |
| `MABS_VIEWER_COMMAND` | Viewer for the Code surface, used instead of nvim/vim/less; called as `COMMAND [LINE] FILE` |
| `MABS_VSCODE_EXECUTABLE` | VS Code CLI for the Herdr popup's Code action ([popup setup](../plugins/herdr/README.md)) |
| `MABS_PI_PACKAGE_DIR` | Location of the installed Pi package, used by `operator probe` |
| `MABS_CLAUDE_MANAGED_SETTINGS_DIR` | An *extra* directory of managed Claude settings to inspect before launch. `/etc/claude-code` is always inspected too; this cannot switch the check off |
| `MABS_CODEX_MANAGED_CONFIG_DIR` | An extra directory of managed Codex configuration to inspect, in addition to `/etc/codex` |

Before every worker launch, MABS inspects system-managed Claude and Codex configuration. If a managed setting can change the provider, credential, endpoint, or model, the launch is refused, so a machine policy cannot silently redirect a subscription worker.

**Next:** [follow a task visually](architecture/task-execution.md), [troubleshoot a blocker](troubleshooting.md), or [browse the documentation](index.md).
