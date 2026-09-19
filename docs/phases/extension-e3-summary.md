# E3 summary — conversation to an accepted product plan

Completed: 19 September 2026. Branch `mabs-extension`.

## What changed

### Durable intake before a repository

Schema 12 adds `product_briefs`, immutable `brief_revisions`, `conversation_events`,
`clarification_items`, `proposal_versions`, exact `acceptance_bindings`, and `bootstrap_runs`. A brief
can exist with no project or repository. Content updates use expected-version checks and retain the
source, summary, changed fields, full payload, and conversational event.

The brief lifecycle is separate from task execution:

```
DRAFT -> CLARIFYING -> PROPOSED -> ACCEPTED -> BOOTSTRAPPING -> REGISTERED
```

A restart reads the same brief, open questions, proposal versions, consent, and next action from
SQLite. No model writes SQL.

### Deterministic proposal and consent boundaries

`src/intake/service.ts` validates requirement IDs, acceptance criteria, dependency graphs, execution
modes, and parallel edit scopes before storing a presentable proposal. Invalid plans remain audit
events but cannot become proposals.

Acceptance is bound to the proposal ID, proposal version, brief version, and SHA-256 fingerprint.
The caller must echo the fingerprint the user saw and identify the person who accepted; agent/model/
system identities are rejected. Stale and superseded proposals fail closed. Repeating the same
submission reuses its recorded task IDs instead of creating duplicate work.

A content revision after acceptance invalidates the exact consent and cancels only not-started tasks
created from that accepted proposal. Completed task state, revision, summary, and evidence remain
untouched. A fresh proposal and user decision are then required.

### Pi and CLI surfaces

The project-local extension adds:

- `/mabs-new <plain-language idea>` — starts an agent turn for product discovery;
- `/mabs-product <brief>` and `/mabs-brief ...`;
- `mabs_create_brief`, `mabs_update_brief`;
- `mabs_ask_clarifications`, `mabs_answer_clarification`;
- `mabs_propose_plan`, `mabs_accept_plan`, `mabs_submit_plan`, `mabs_get_product`.

The matching CLI commands are `mabs brief create|list|show|update|ask|answer|propose|accept|submit`
and `mabs product show`. Submission consumes the stored accepted plan; the user never authors plan
JSON.

`.pi/skills/product-discovery/SKILL.md` is an on-demand, versioned skill. It distinguishes discussion,
planning, implementation, and external release; asks only material questions; keeps assumptions
visible; and prevents proposal acceptance from being interpreted as deployment or spending consent.

`mabs_bootstrap_project` is intentionally not exposed as a nonfunctional stub. It lands with the
safe, resumable bootstrap service in E4; schema 12 already provides its durable run record. E3 can
submit to an existing registered project, while E4 closes the new-directory path.

## Migration

Schema 11 -> 12 is additive. Opening a schema-11 fixture preserves its existing project and creates
the intake tables. The migration test then creates and reads a brief successfully. Back up first with:

```
node src/cli.ts maintenance backup
```

## Automated evidence

```
npm run typecheck                                      # clean
MABS_STATE_DIR=/tmp/mabs-extension-e3-full npm test    # 64 pass, 0 fail
```

`test/extension-e3.test.ts` covers a new idea, material questions, incomplete answers and explicit
assumptions, exact consent, idempotent submission, invalid cycles and overlapping parallel scopes,
post-acceptance scope revision, preservation of completed work, cancellation of stale planned work,
restart during clarification, optimistic concurrency, schema 11 migration, and the real CLI path used
by Pi tools.

The installed Pi runtime was also started in offline RPC mode with project trust enabled. `get_commands`
reported `/mabs-new`, `/mabs-product`, and `/skill:product-discovery` from their project-local paths,
with no `extension_error`. This verifies loading and format without making a provider call.

## Live conversational evidence

After explicit authorization, one bounded Pi RPC conversation ran through the existing
`openai-codex` subscription OAuth path with `gpt-5.6-sol` at low thinking. `/mabs-new` caused the
model to create and version a brief, record its stack and quality settings, validate and present a
two-task plan, wait for a separate explicit user acceptance turn containing the exact fingerprint,
then record consent and submit two tasks to an isolated pre-registered project. The controller did
not run, and no implementation, push, merge, deployment, release, scheduling, notification, or paid
API occurred.

Verbatim user/assistant text, tool sequence, durable IDs, final state, and reported token usage are in
`docs/phases/evidence/e3-live-pi-transcript.md`. This is live evidence and is not conflated with the
automated fixtures.
