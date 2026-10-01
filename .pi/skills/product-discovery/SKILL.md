---
name: product-discovery
description: Turns a plain-language product idea into a durable MABS brief and an exact, user-accepted execution plan. Use when a user wants to create, automate, build, or substantially revise a product, especially before a repository exists.
metadata:
  version: "1.0.0"
---

# MABS product discovery

Read [the shared MABS boundaries](../_shared/MABS_BOUNDARIES.md) first.

Use MABS intake tools for durable decisions; do not substitute chat history or hand-written plan JSON for the records.

## Recognize the boundary

Classify each request before acting:

- **Discussion:** explore possibilities without recording an agreed plan.
- **Planning:** create or revise a brief and proposal. This does not authorize implementation.
- **Implementation:** bootstrap or submit only the exact proposal the user accepted.
- **External release:** pushing, merging, deploying, purchasing, scheduling, or messaging external recipients needs its own applicable approval. Product-plan acceptance does not grant it.

If the user asks to build a new product, call `mabs_create_brief` immediately with what is known. A repository is not required. Leave unknown facts unknown.

Project type is a durable user decision, not a review-preset inference. Record `personal`, `client`, or `other` only when the user supplies it. Personal and other projects also need an explicit `off`, `risk`, or `required` review choice; client projects resolve to mandatory independent review and cannot choose off. If a MABS tool returns `outcome: "needs_input"`, ask the included question and do not submit, bootstrap, or imply that implementation started.

## Assess before recording, only when asked

Skip this stage unless the user asks whether the idea is worth building, or invokes `/mabs-assess`. Most requests do not need it, and running it uninvited slows down a user who already knows what they want.

When it does run, produce exactly these four sections:

1. **What would have to be true.** The three to five load-bearing assumptions the idea rests on. Mark each *checkable now*, *checkable after building*, or *unfalsifiable*.
2. **Prior art.** Existing tools that already do something similar, named. Label this section as recall from training data that may be stale and is worth verifying, unless you actually retrieved current sources in this session.
3. **Cost of being wrong.** Build effort weighed against what the user learns either way. This frame is decision-useful; "good idea" or "bad idea" is not.
4. **Cheapest disconfirming test.** The smallest thing that could kill the idea. Say plainly when that test would replace the build rather than precede it.

Record the result in the fields the brief already has: assumptions into `assumptions`, unverified claims and open risks into `unknowns`, effort and dependency limits into `constraints`, and the disconfirming test into `acceptanceCriteria`. No new record type is needed.

### State what you cannot know

Do not deliver a go or no-go verdict. Present the evidence and the cheapest test, and leave the decision with the user. A confident verdict is exactly what a model cannot support here, and it arrives when the user is most committed to the idea.

Specifically, never assert market size, pricing, funding, adoption, or competitive traction unless those came from a source retrieved in this session. Cite the source when they did. Absent retrieval, say the figure is unavailable rather than estimating it. This follows the shared boundary against silently inferring budgets, credentials, or destinations.

## Clarify only material unknowns

Assessment output does not substitute for this step: an assumption you recorded is still an unknown until the user confirms it.

A question is material only if its answer can change scope, architecture, acceptance criteria, risk/review policy, target directory, or delivery behavior.

1. Record material questions with `mabs_ask_clarifications`, including why each matters. It returns each question's `id` in `requested`; keep those ids.
2. Ask the user concisely, grouping related questions when practical.
3. Record all of their answers in one `mabs_resolve_intake` call: one resolution per question id, with the user's words as `answer`. When an answer changes brief fields, put your explicit interpretation in `patch` with a one-line `summary` in the same call. For a single answer, `mabs_answer_clarification` remains available.
4. If the user cannot answer and wishes to continue, record an explicitly labeled `assumption` instead of an answer, and tell the user. Never silently infer proficiency, credentials, destinations, schedules, budgets, or release authority.
5. Pass the brief version you last read. On `stale_version`, read current product state and merge deliberately. On `already_resolved`, ask the user before replacing an earlier answer with `revise`.
6. A brief's project type and review choice are brief fields (`patch.projectType`, `patch.reviewChoice`). `mabs_set_project_governance` is only for a registered project.

## Propose a plan

Use `mabs_propose_plan` only when material questions are answered or visibly assumed.

The proposal must contain:

- concise scope and out-of-scope boundaries;
- stable requirement IDs;
- milestones;
- tasks with objective and acceptance criteria;
- valid dependency keys;
- an execution mode and reason for the plan and every task;
- repository-relative, disjoint edit scopes for unordered parallel tasks;
- rationale and disclosed assumptions.

Correct validation failures before presenting the plan. Summarize the proposal in ordinary language and invite the user to accept or change it.

## Bind consent exactly

Call `mabs_accept_plan` only after the user agrees in their own words. Pass the ID and fingerprint of the exact proposal shown, the person's name, and a short note reflecting their decision. Never set yourself, “agent”, “model”, or “system” as the accepter.

Any substantive brief revision after acceptance invalidates stale consent. Present a fresh proposal and ask again; do not erase completed task history.

## Continue within the accepted boundary

After acceptance:

- use `mabs_start_work` once, with the accepted proposal id and fingerprint and the destination the user chose (a new directory, or a registered project). It prepares the directory safely and applies the stored validated plan without asking the user to author JSON;
- if `mabs_start_work` reports `interrupted`, explain the error, and once it is fixed retry with the same `requestId`; recorded steps are not repeated. `mabs_bootstrap_project` and `mabs_submit_plan` remain for diagnosis;
- use `mabs_get_product` to report pending decisions, work, outputs, and next actions;
- resolve any structured governance `needs_input` response with the user and persist it before bootstrap or submission;
- do not repeatedly ask permission for routine actions already inside the accepted local implementation boundary;
- do ask for any separate approval required for external release, deployment, spending, credentials, or destructive replacement.
