# Change project configuration safely

[Documentation](index.md) · [Approval diagram](architecture/approvals-and-config.md) · [Command reference](commands.md)

The **curator** helps propose and evaluate local configuration changes. It cannot approve its own proposal. Activation and revert need an explicit decision covering the exact version.

Run commands from the MABS checkout. Replace uppercase placeholders with real project names/IDs, proposal IDs, and the approving person's name. These are staged actions—not a script to run without inspection.

## 1. Inspect and propose

```bash
node src/cli.ts curator analyze PROJECT
node src/cli.ts curator snapshot PROJECT > candidate-config.json
```

Analysis inspects recorded failures, repairs, review findings, and other signals. It runs on demand, not as a permanent model loop. The snapshot command writes a local file; choose a new filename rather than overwriting a file you need.

Edit the snapshot only after identifying a concrete need. It contains routing, approval/review policy, checks, prompt addenda, repair limits, and the context budget. Proposals are **complete snapshots**, not partial patches.

```bash
# Mutation: creates a config-only commit in an isolated local worktree.
node src/cli.ts curator propose PROJECT candidate-config.json \
  --title="Describe the bounded change" \
  --rationale="Explain the observed problem and expected effect"
```

The target branch stays unchanged. Unknown fields, unsupported routes, unsafe commands, and changes that bypass enforced boundaries are rejected.

Alternatively, `curator suggest PROJECT --title="Describe the suggestion"` derives a candidate when existing evidence matches a supported rule. It may decline to propose anything; that is better than inventing an improvement.

## 2. Evaluate and inspect

```bash
node src/cli.ts curator evaluate PROPOSAL_ID
node src/cli.ts curator show PROPOSAL_ID
```

Inspect the proposed diff and evaluation evidence before proceeding. `policy-replay-v1` checks configuration safety and compares historical observations. It does **not** prove better product code, lower subscription spend, or remaining quota.

To reject the proposal instead:

```bash
node src/cli.ts curator reject PROPOSAL_ID --reason="Explain why it should not activate"
```

An equivalent rejected or already-open proposal is suppressed while the supporting evidence is unchanged. New evidence can justify reconsideration without erasing the earlier decision.

## 3. Approve the exact version

Only after a passing evaluation and your review:

```bash
node src/cli.ts curator request-activation PROPOSAL_ID \
  --reason="Why this evaluated version should activate"
```

Inspect the returned approval binding. If you accept it, record that decision using its approval ID:

```bash
node src/cli.ts approval approve APPROVAL_ID --by=PERSON
```

Approval alone has not activated the configuration.

## 4. Activate at a safe checkpoint

```bash
node src/cli.ts curator activate PROPOSAL_ID APPROVAL_ID \
  --reason="Activation note" --by=PERSON
```

Activation requires a current proposal, passing evaluation, and matching approval. The project must have no tasks in `RUNNING`, `CHECKING`, or `REVIEWING`. If those conditions changed, stop and resolve the mismatch rather than reusing stale approval.

Successful activation consumes the approval and records a new active configuration with actor, reason, and history. See the [approval guide](architecture/approvals-and-config.md) for the full boundary.

## Revert deliberately

Inspect `curator history PROJECT` and select the historical version you want. Then request a **separate** revert approval:

```bash
node src/cli.ts curator request-revert PROJECT CONFIG_VERSION --reason="Recovery reason"
```

Review and approve that decision before running:

```bash
node src/cli.ts curator revert PROJECT CONFIG_VERSION APPROVAL_ID \
  --reason="Restore the reviewed configuration" --by=PERSON
```

Revert creates a new version containing the selected historical configuration. It does not delete history or undo already completed task work.
