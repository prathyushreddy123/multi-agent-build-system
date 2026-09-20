# MABS documentation

[Repository home](../README.md)

**Start with a small task. Learn the internals when you need them.**

## Choose your path

| I want to… | Read |
| --- | --- |
| Decide whether MABS fits my workflow | [What MABS does](../README.md#why-use-it) |
| Install it and run a first task | [Getting started](getting-started.md) |
| See the system without a wall of arrows | [Visual guide](architecture/index.md) |
| Understand the controller and workers | [System overview](architecture/system-overview.md) |
| Follow a task or a failure scenario | [Task execution](architecture/task-execution.md) and [recovery](architecture/recovery-and-failures.md) |
| Change project configuration safely | [Configuration curator](curator.md) |
| Understand provider selection | [Routing policy](routing-policy-v1.md) |

## Five terms worth knowing

| Term | Meaning |
| --- | --- |
| **Project** | A Git repository registered with MABS, including its checks and policies. |
| **Task** | A scoped goal with acceptance criteria. |
| **Attempt** | One worker run: implementation, repair, review, or provider fallback. |
| **Worktree** | A separate Git checkout where a task runs without moving the project's base branch. |
| **Gate** | A recorded check, such as a test command, tied to a particular Git revision. |

## History and design decisions

You do not need these to get started. They preserve the reasons behind the design and evidence from earlier verification runs; versions and test counts are historical.

- [Original implementation phases](implementation-status.md)
- [Extension checklist](phases/extension-checklist.md)
- [Why Pi is the interface, not the task worker](adr/0001-pi-and-worker-execution.md)
- [Original requirements and roadmap](requirements/source-plan.txt)

Need a command that is not in a guide? Run `node src/cli.ts help` from the MABS checkout.
