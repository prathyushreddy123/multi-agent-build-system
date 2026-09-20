# Visual guide

[Documentation](../index.md) · [Get started](../getting-started.md)

**One question per view.** Start with the overview, then follow the scenario you care about. These diagrams explain behavior; they are not live task status.

| Question | View | Pattern |
| --- | --- | --- |
| What does each part do? | [System overview](system-overview.md) | Responsibility map |
| How does work reach completion? | [Task execution](task-execution.md) | Stage strip and launch sequence |
| What if a check, provider, or controller fails? | [Recovery and failures](recovery-and-failures.md) | Separate scenarios and a decision table |
| How does a configuration change get authorized? | [Approvals and configuration](approvals-and-config.md) | Approval stages |
| Which task transitions are allowed? | [State reference](state-reference.md) | Complete developer table |

## Reading the diagrams

- Read in the direction shown; an arrow describes a handoff or the next step, not a guarantee of success.
- Each diagram has a text explanation. You do not need color or a Mermaid renderer to follow it.
- In GitHub's rendered Markdown view, Mermaid displays as a diagram. In an editor without Mermaid support, use the accompanying explanation or a Markdown preview that supports Mermaid.
- Conditions and exceptions live below the diagram rather than inside oversized boxes.
- Source links point to the implementation behind each view.

**Need actual task progress?** Use the [localhost workbench or `task show`](../getting-started.md#5-inspect-the-result). Recorded attempts, checks, reviews, and evidence—not an illustrative diagram—tell you what happened.
