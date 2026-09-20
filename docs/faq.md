# Frequently asked questions

[Documentation](index.md) · [Get started](getting-started.md) · [Troubleshooting](troubleshooting.md)

## Why not just run Claude Code or Codex directly?

You can, and that is simpler for one informal task. MABS adds a durable queue, task branches, dependency handling, recorded checks, bounded repairs, review policies, and a workbench. Use it when coordinating and inspecting repeated work matters more than minimizing setup.

## Do I need both subscriptions?

One authenticated supported subscription CLI can run model tasks. A second eligible provider makes cross-provider fallback and review possible. A review can use fresh context on the same provider when no second provider is eligible. Both providers are tested by `verify --quick`, so that combined check can fail on a one-provider installation.

## Is it free to run?

MABS uses your existing eligible subscription sessions rather than paid model API fallback. It does not remove subscription fees, session limits, local compute costs, or provider terms. Reported token counts and API-equivalent estimates are not actual subscription spending or remaining quota.

## Which projects can I use?

MABS registers local Git repositories. Built-in Python and JavaScript/TypeScript profiles discover supported components, setup needs, and declared checks. That is not a guarantee that every framework or repository layout works automatically. Run `profile inspect` and confirm the checks before dispatch.

The MABS runtime itself requires Node.js 24+, even when workers edit a Python project.

## Can I start from an idea instead of an existing repository?

Yes. The optional Pi extension supports a conversation that records a brief, asks material questions, proposes a plan, and waits for your acceptance. Bootstrap then prepares an accepted product in a directory you explicitly select; it refuses an unrelated non-empty directory.

In Pi, after trusting this checkout and loading its project extension:

```text
/mabs-new a local tool that summarizes my project notes
```

Describe the real goal and constraints, review the proposed plan, and choose the target directory. Creating a brief is not the same as accepting a plan, bootstrapping files, or starting workers. The CLI also exposes `brief` and `product` commands; see `node src/cli.ts help`.

## Is Pi required?

No. The CLI and localhost workbench work without Pi. Pi is the optional conversational interface; Claude Code and Codex are the task-worker adapters. See the [design decision](adr/0001-pi-and-worker-execution.md).

## Does `DONE` mean I can deploy?

No. It means the task's completion path finished under its policy. Inspect the exact diff, required checks, quality coverage, and review evidence. Missing checks remain `not_configured`, not passing tests. MABS does not automatically merge or publish the result.

## Does it isolate untrusted code safely?

No. Git worktrees isolate checkouts and branches, not system permissions. Workers and repository checks execute local commands. Use trusted repositories and protect credentials and private data as you would when running another local coding tool.

## What survives a restart?

SQLite retains task and attempt records; files retain completion output and evidence. Detached workers may continue after the controller stops. Restart with the same state paths so the controller can reconcile them. Do not resubmit tasks merely because the UI closed. See [recovery](architecture/recovery-and-failures.md#controller-restart).

## Does MABS push, merge, or deploy for me?

The controller has no push, merge, or release executors. Deployment currently has an internal adapter boundary tested with simulated outcomes, not a registered production adapter or CLI/Pi execution command. Optional-operation settings start disabled/manual; an approved or prepared action is not evidence that execution happened.

## Why are the older phase reports still here?

They preserve historical acceptance evidence and design decisions. Their test counts, installed versions, and “next phase” statements describe that time, not today's setup. Start with the [current guides](index.md); use the [history index](implementation-status.md) when you need provenance.

## Is there a live workflow diagram or hosted documentation site?

Not in this documentation refresh. The [visual guide](architecture/index.md) contains small static Mermaid diagrams with text alternatives. The existing localhost workbench shows recorded task information, including tables and a JSON event timeline; it is not a new animated workflow viewer.
