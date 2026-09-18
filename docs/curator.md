# Configuration curator

The Phase 4 curator proposes and evaluates local project configuration. It cannot activate its own proposal and it has no push, merge, release, or deployment capability.

## Configuration snapshot

Export the current complete project configuration:

```bash
node src/cli.ts curator snapshot <project> > config.json
```

A snapshot contains:

- `routingProfile` and verified `routingOverrides`;
- `approvalPolicy`;
- `reviewPolicy`;
- explicit `checkCommands`;
- bounded implementation, review, and research prompt addenda;
- `controllerSettings.defaultRepairLimit` (0–2).

Proposals are complete snapshots, not patches. Unknown properties, unsupported routes/models, unsafe commands, prompt text that weakens approval or paid-access boundaries, and weakened consequential-action rules are rejected before a proposal workspace is created.

## Workflow

```bash
node src/cli.ts curator analyze <project>
# When recurring evidence matches a bounded rule, create the candidate automatically:
node src/cli.ts curator suggest <project> --title="Rules-first suggestion"
# Or supply an explicitly reviewed complete snapshot:
node src/cli.ts curator propose <project> config.json \
  --title="Bounded improvement" --rationale="Observed evidence and expected effect"
node src/cli.ts curator evaluate <proposal>
node src/cli.ts curator request-activation <proposal> --reason="Why this evaluated version should activate"
node src/cli.ts approval approve <approval> --by=<owner>
node src/cli.ts curator activate <proposal> <approval> --reason="Activation note" --by=<owner>
```

`propose` creates a local branch and isolated worktree containing `.mabs/proposals/<proposal>.json`, commits it locally, and retains a diff outside Git. It never changes the configured target branch.

The `policy-replay-v1` evaluation performs deterministic safety cases and compares observable historical task, repair, review, gate, routing, prompt-size, and reported-usage metrics. It does **not** claim candidate product-task quality, subscription spend, or remaining quota. Unknown usage remains null.

Activation requires all of the following:

1. the proposal is bound to the current project configuration;
2. its Git revision and diff evidence exist;
3. its latest evaluation passed;
4. an approved `activate_config_change` decision exactly matches proposal ID, revision, and current config version.

The approval is consumed atomically with activation. Concurrent config drift invalidates the approval and makes the proposal stale.

## Rejection and duplicate suppression

```bash
node src/cli.ts curator reject <proposal> --reason="No measurable benefit"
```

The curator fingerprints both the complete candidate and the evidence that motivated it. An equivalent rejected or already-open proposal cannot be repeated against the same evidence. Changed observed evidence permits reconsideration while preserving the earlier outcome.

## Revert

A revert is another approval-gated activation and creates a new config version containing the selected historical payload:

```bash
node src/cli.ts curator history <project>
node src/cli.ts curator request-revert <project> <configVersion> --reason="Recovery reason"
node src/cli.ts approval approve <approval> --by=<owner>
node src/cli.ts curator revert <project> <configVersion> <approval> \
  --reason="Restore known configuration" --by=<owner>
```

History retains the source historical version, previous active version, new revert version, approval, actor, reason, and timestamp.
