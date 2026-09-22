# Operator workspace — Logs and evidence

[Documentation](../index.md) · [Operator workspace](index.md) · [Tasks surface](tasks-surface.md)

Open the original evidence the controller wrote: worker transcripts and results, check output, review detail, and context manifests. The Logs surface creates no new log store and copies nothing.

```bash
node src/cli.ts logs TASK_ID                                  # list evidence
node src/cli.ts logs TASK_ID --attempt=ATTEMPT_ID             # narrow to one attempt
node src/cli.ts logs TASK_ID --evidence=EVIDENCE_ID           # last 200 lines
node src/cli.ts logs TASK_ID --evidence=EVIDENCE_ID --tail=50
node src/cli.ts logs TASK_ID --evidence=EVIDENCE_ID --from=0  # from a byte offset
node src/cli.ts logs TASK_ID --evidence=EVIDENCE_ID --follow
```

From Pi: `/mabs-logs <task> [--attempt=…] [--evidence=…]`.

## Selecting evidence

Every evidence record has a stable ID that also appears on the matching step in the [Tasks surface](tasks-surface.md), so a compact summary is never a dead end:

| Evidence ID | What it opens |
| --- | --- |
| `result:<attemptId>` | the worker's structured result |
| `transcript:<attemptId>` | the provider's raw transcript |
| `completion:<attemptId>` | the completion envelope |
| `check:<gateId>` | one check's recorded output |
| `review:<reviewId>` | one review's detail |
| `manifest:<packetId>` | the context packet manifest |

A retry adds evidence; it never replaces it. Attempt 1's failing check output stays readable next to attempt 2's passing one, and narrowing with `--attempt` says how many earlier attempts are hidden but still available.

## Structured records and raw transcripts

Where the provider recorded a structured result, navigation is per record. Where only a raw transcript exists, the transcript is kept exactly as written and the limit is stated rather than papered over:

```
This is the provider's raw transcript. MABS records no per-command boundaries
inside it, so navigation is by position in the file, not by individual tool call.
```

MABS does not re-segment a transcript into commands that were never recorded as separate events. Adding per-command navigation would mean correlating at the integration boundary, which is only worth doing if it can be done without altering provider execution.

## Following

`--follow` reads bounded chunks and yields only new bytes. It never re-loads the whole file.

| Situation | Behaviour |
| --- | --- |
| Append | Only the new bytes are shown |
| A line still being written | Held back until its newline arrives, so it is never displayed twice |
| End of file without a newline | Still held back while the run is live — a file mid-write is indistinguishable from one with no final newline — and flushed once the attempt is no longer running |
| File replaced (rotation) | Detected by device and inode; following restarts at the new file's beginning and says so |
| Truncated in place | Detected by size against the saved offset; same restart |
| File missing | Reported with the retention reason; the database record remains |
| Run finished | One more poll captures the final flush, then following ends |

`Ctrl+C` stops following. It does not signal the worker, does not touch the file, and does not change any record. Verified live: after interrupting a follow, the task was still `RUNNING`.

## Safety

- Only paths inside the MABS artifacts directory can be opened. `/etc/passwd`, a path outside the state directory, and a traversal through `artifacts/..` are all refused. The Logs surface is not a general file reader.
- Terminal control sequences in captured output are escaped before being drawn, so a log cannot repaint the terminal or spoof surrounding output. **The file on disk is left byte-for-byte intact**, because it is the evidence.
- Retention is the existing policy, unchanged: attempt artifacts become eligible for pruning after 30 days for completed tasks and 90 for failed ones, and database records are kept indefinitely. A pruned file is reported as unavailable with that reason.
- Redaction is also the existing behaviour, unchanged: MABS excludes known credential and secret *paths* from context packets, but it does not redact the contents of evidence files. Treat a transcript as containing whatever the worker printed.
