# MABS efficiency v4: token, time, and quality benchmark

[Documentation](../index.md) · Per-step data tables: [efficiency-v4-data.md](efficiency-v4-data.md)

**What this is:** measured comparisons of direct Claude Code, direct Codex, and MABS (v3 and v4) building the same software, plus an idea-to-product comparison through Pi. It records where MABS spends extra tokens and time, the issues found while measuring, candidate solutions, and the parts of the system that look over-engineered. Every figure comes from rows in [`bench/results/`](../../bench/results/) and can be re-derived with the commands in [How to explore](#how-to-explore-the-data).

Collected 2026-09-29. MABS v3 is `0dc380e`; v4 is branch `mabs/efficiency-v4` (steps 0–7).

## Contents

1. [Setup and how to read the numbers](#1-setup-and-how-to-read-the-numbers)
2. [Single well-specified task](#2-single-well-specified-task)
3. [Per-step results (v4 steps 1–6)](#3-per-step-results)
4. [Idea to product: direct vs Pi + MABS](#4-idea-to-product-direct-vs-pi--mabs)
5. [Issues found](#5-issues-found)
6. [Candidate solutions](#6-candidate-solutions)
7. [Over-engineering review](#7-over-engineering-review)
8. [What was not measured](#8-what-was-not-measured)
9. [How to explore the data](#9-how-to-explore-the-data)

## 1. Setup and how to read the numbers

| Item | Setting |
|---|---|
| Claude model | `claude-sonnet-5`, effort `medium`, subscription login |
| Codex model | `gpt-5.6-sol`, effort `medium`, ChatGPT login |
| Pi (planner) | `claude-bridge/claude-sonnet-5`, thinking `medium`, MABS tools only |
| Isolation | Every run uses its own temporary repository, MABS state directory, database, and worktree root. Direct runs use the same isolation flags as MABS workers (no user settings, hooks, MCP servers, or sub-agents). |
| MABS mode (single-task runs) | VERIFIED: independent cross-provider review required. Claude implementers are reviewed by Codex (effort `high` in v3 and v4 steps 1–4); Codex implementers by Claude (`medium`). |
| MABS mode (idea-to-product) | FAST: checks only, no review. |
| Quality | Hidden behavioural checks written before any run and never shown to a model. |

**Fixtures** (in [`bench/fixtures/`](../../bench/fixtures/)):

| Fixture | Starting point | Instruction | Hidden checks |
|---|---|---|---|
| `parse-duration` | Small JS repo with `formatDuration` | Detailed objective: add its inverse `parseDuration` with tests | 27 |
| `pocket-ledger` | Stub TypeScript CLI | 12-point contract for an expense-ledger CLI | 24 (incl. numeric-category ordering) |
| `habit-tracker` | Empty repository | A plain-English idea naming only the commands | 18 |

**Definitions**

- **Input tokens** are provider-reported input events. They include cache reads, which are much cheaper than fresh input: 75–95% of every figure here was cached. Claude and Codex figures follow different provider semantics (Codex's input includes its cached subset) and are **never added together**.
- **Impl** means the first implementation attempt only, which is what a direct run is comparable to. **Total** covers every attempt: implementation, repairs, and reviews.
- **Wall** runs from controller start to the task's final state. Rows recorded before the runner fix were corrected from their evidence (see issue 5.9); each corrected wall matches the task's summed attempt durations to within a second.
- **Samples are small.** There are 1–3 runs per baseline cell and 1 per v4 step. Treat differences under about 20–30% as noise; the large effects (for example 3–5× fewer implementation tokens) are well outside it.
- Runs that hit a provider subscription limit were moved to `bench/results/discarded/` and are excluded.

## 2. Single well-specified task

Medians. Tokens are in thousands (K). "v4" for Claude covers steps 1–2 (the only Claude-worker steps measured); for Codex it covers steps 1–6 plus one final sample.

**parse-duration (27 hidden checks)**

| Harness | Runs | Wall | Impl time | Impl input | Impl turns | Impl denied | Claude input (total) | Codex input (total) | Output (total) | Attempts | Hidden |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Direct Claude | 2 | 22 s | 22 s | 184K | 8 | 0 | 184K | – | 2K | 1 | 27, 27 |
| Direct Codex | 3 | 53 s | 53 s | 61K | 3 | – | – | 61K | 2K | 1 | 27 ×3 |
| MABS v3 + Claude | 2 | 508 s | 143 s | 941K | 26 | 13 | 1,738K | 474K | 32K | 4 | 27, 27 |
| **MABS v4 + Claude** | 2 | **231 s** | **34 s** | **262K** | **9** | **0** | 411K | 313K | 13K | 3 | 27, 27 |
| MABS v3 + Codex | 1 | 163 s | 85 s | 151K | 7 | – | 324K | 151K | 11K | 2 | 27 |
| **MABS v4 + Codex** | 7 | **120 s** | 70 s | 124K | 6 | – | 287K | 124K | 7K | 2 | 27 ×7 |

**pocket-ledger (24 hidden checks)**

| Harness | Runs | Wall | Impl time | Impl input | Impl turns | Impl denied | Claude input (total) | Codex input (total) | Output (total) | Attempts | Final state | Hidden |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| Direct Claude | 2 | 98 s | 98 s | 664K | 27 | 4 | 664K | – | 12K | 1 | DONE | 23, 23 |
| Direct Codex | 3 | 363 s | 363 s | 496K | 17 | – | – | 496K | 17K | 1 | DONE | 23 ×3 |
| MABS v3 + Claude | 1 | 343 s | 343 s | 1,712K | 43 | 25 | 1,712K | – | 28K | 1 | **BLOCKED** | 23 |
| **MABS v4 + Claude** | 1 | 1,322 s | **94 s** | **476K** | **13** | **1** | 2,664K | 2,164K | 79K | 6 | **FAILED** (review loop) | **24** |
| MABS v3 + Codex | 1 | 464 s | 396 s | 635K | 18 | – | 424K | 635K | 25K | 2 | DONE | 23 |
| **MABS v4 + Codex** | 6 | 445 s | 315 s | 717K | 19 | – | 655K | 725K | 24K | 2 | DONE | 23, 23, 23, 24, 23, 24 |

**Reading it**

- **Implementation is now close to direct cost.** MABS v4 + Claude implements in 0.9–1.5× direct Claude's time and 0.7–1.4× its input tokens, down from 3.5–6.4× and 2.6–5.1× in v3. Denied commands fell from 13–25 to 0–1. The v3 Pocket Ledger run ended **BLOCKED**: the worker reported itself blocked because it could not run `npm test`.
- **MABS + Codex was already near direct Codex** (Codex workers can run commands in their sandbox); v4 changes it little.
- **The review stage is now the main cost.** On Pocket Ledger, the high-effort Codex review requested changes three times, raising new out-of-scope findings each round. The run spent 22 minutes and 2.7M Claude + 2.2M Codex input tokens, then failed on its repair limit, even though its code scored 24/24.
- **Quality is never below direct.** Direct Claude and direct Codex both get Pocket Ledger's numeric-category ordering wrong (23/24); several MABS runs get it right (24/24).

## 3. Per-step results

Full generated tables: [efficiency-v4-data.md](efficiency-v4-data.md). What each step changed:

| Step | Commit | Change | Measured effect |
|---|---|---|---|
| 0 | `d605253` | Safety: N1 optimizer authorization epoch, N2/N3 managed-config checks, flaky soak | No efficiency change (tests only) |
| 1 | `80b6b75` | Workers run registered checks through an exact-name MCP tool (`run_checks`) | **Largest win.** Claude implementation −70 to −72% input, 3–4× faster, denials 13–25 → 0–1 |
| 2 | `913dfa3` | Lean briefs: compact JSON, relative paths, no duplicate file list, relevant guidance only | Prompt 9.5 KB → 7.4 KB; token effect within noise at this task size |
| 3 | `0558047` | Repairs resume the implementer's session (Claude `--resume --fork-session`, Codex `exec resume`) | Verified live; too few repairs in the sample to size |
| 4 | `116aacd` | Retry after a blocked review resumes at review; reviewer preflight; entitlement hot reload | Failure-path fixes (tests); no happy-path change expected |
| 5 | `6b2e319` | Delivery modes; medium review effort for small changes; delta-only re-review | Only measured with Codex workers, whose reviewer was already medium; **unmeasured for Claude workers** |
| 6 | `5269771` | Repeat-failure guard; zero-token worker health; full usage scorecard | No happy-path change expected |
| 7 | `d8becbb` | Subscription-window limit messages classified as QUOTA | Fixes a failure mode found during the benchmark |

Codex-worker wall time across steps 1–6 stayed within 101–140 s (parse-duration) and 361–545 s (Pocket Ledger), which is noise for one sample per step.

## 4. Idea to product: direct vs Pi + MABS

One plain-English idea ([`habit-tracker/idea.txt`](../../bench/fixtures/habit-tracker/idea.txt)), an empty repository, 18 hidden product checks, fast delivery with no review.

- **Direct runs** received the idea plus "Build it from scratch in this empty repository. Run your tests before finishing."
- **Pi + MABS** ran Pi through the product-intake conversation with fixed scripted replies ([`pi-turn1-4.txt`](../../bench/fixtures/habit-tracker/)). The replies answered only operational questions (personal project, fast delivery, target folder) and told Pi to record its own assumptions for behaviour, so Pi got no hints about the hidden checks.
- The session was forked after plan acceptance, so Claude workers and Codex workers built the **same 2-task plan**.

| | Direct Claude | Direct Codex | Pi + MABS (Claude workers) | Pi + MABS (Codex workers) |
|---|---|---|---|---|
| Planning (Pi, Claude) | – | – | 405K in · 8.3K out · 16 calls · 89 s | 405K in · 8.3K out · 16 calls · 90 s |
| Building | 632K in · 10.1K out · 19 turns | 333K in · 8.3K out · 13 turns | Claude 779K in · 14.2K out (2 tasks) | Codex 418K in · 12.1K out (2 tasks) |
| **Total Claude tokens** | 632K / 10.1K | – | **1,185K / 22.4K** | 405K / 8.3K |
| **Total Codex tokens** | – | 333K / 8.3K | – | **418K / 12.1K** |
| **Time** | 130 s | 179 s | 227 s | 351 s |
| Hidden checks | 17/18 | 18/18 | 18/18 | 18/18 |
| Denied commands | 3 | – | 4 + 0 | – |

Direct Claude's miss: it crashes with a stack trace on a corrupt data file instead of refusing cleanly.

**Pi's four turns** (identical up to the fork):

| Turn | Scripted user message | Model calls | Input (incl. cache) | Output | Time | Failed tool calls |
|---|---|---:|---:|---:|---:|---:|
| 1 | The `/mabs-new` intake text with the idea | 3 | 38K | 1.6K | 21 s | 0 |
| 2 | Operational answers; "record assumptions, propose the plan" | 8 | 176K | 5.6K | 50 s | **9** |
| 3 | "Yes, I accept this plan as proposed." | 2 | 68K | 0.4K | 7 s | 0 |
| 4 | "Bootstrap into `<folder>` and submit the plan." | 3 | 122K | 0.6–0.7K | 10 s | 0 |

**Reading it:** across the whole lifecycle, Pi + MABS used about **1.9× the Claude input and 2.2× the output of direct Claude, taking 1.7× the time**. With Codex workers it used 1.26× direct Codex's Codex tokens, plus 405K Claude tokens for Pi, taking 2× the time. The extra comes from two places:

1. **Pi's conversation:** 405K tokens, a third of the Claude-worker total. Almost half of that is one turn with 9 failed tool calls.
2. **Splitting into two sequential tasks:** each starts cold and re-reads the repository. The two Claude workers together (779K) used more than direct Claude's single session (632K).

## 5. Issues found

Each entry: symptom, evidence, status.

| # | Issue | Evidence | Status |
|---|---|---|---|
| 5.1 | **Claude workers could not run the checks they were told to pass.** 13–25 denied `npm`/`node` commands per attempt; one v3 run reported itself blocked. Allowlisting `Bash(npm *)` is unreliable: Claude Code's permission check still denied `npm test` in about 1 of 5 identical probes. | v3 rows: `denied` 13–25 | Fixed in step 1 (`run_checks` MCP tool) |
| 5.2 | **Review never converges on a small task.** A high-effort reviewer raises new out-of-scope findings every round (prototype-key categories, cross-process locking, 400-digit IDs); each repair adds new surface to attack. | v4-step1 `mabs-claude` Pocket Ledger: 3 reviews, 2 repairs, FAILED, 24/24 hidden | Partly addressed in step 5 (medium effort, delta re-review); **unmeasured for Claude workers** |
| 5.3 | **Silent route fallback.** `controller run --adapter=codex` quietly ran Claude workers when Codex's entitlement was unverified in a fresh state. | Discarded lifecycle row in `bench/results/discarded/lifecycle.jsonl` | **Open** |
| 5.4 | **Pi tool friction.** Pi guessed clarification IDs and tried to set governance on a brief that is not yet a project: 9 failed calls, about 176K tokens (43% of Pi's total). | Lifecycle turn 2 | **Open** |
| 5.5 | **Cold start per task.** Dependent tasks re-read the repository from scratch. | Lifecycle: 2 tasks used 779K vs direct's 632K | **Open** |
| 5.6 | **Workers are denied running their own program** (for example `node src/cli.js`), since `run_checks` only runs registered checks. | Lifecycle task 1: 4–5 denials | **Open** |
| 5.7 | **Subscription-window limit misclassified.** "You've hit your session limit · resets …" was classified INFRA, so the task blocked instead of cooling down. | Smoke run during the benchmark | Fixed in step 7 |
| 5.8 | **Fresh-state review deadlock.** Implementation is spent, then review blocks because the only independent reviewer is unentitled; a retry re-implements. | Early v3 run | Fixed in step 4 |
| 5.9 | **Benchmark runner stopped the clock early.** Wall time ended at the last `task.state` event, but acceptance is `task.accepted`, so review time was omitted. | Corrected by `bench/fix-wall.ts` | Fixed (runner commit `a45e931`) |
| 5.10 | **A reviewer hung silently** after a mid-stream provider limit: 21 minutes without a provider event. | Claude step-3 run (discarded) | Visible now as `stalled` (step 6); no automatic recovery |
| 5.11 | **Retry after a failed attempt is blocked by preflight** when the failed worker left edits in the worktree ("unexpected changes"). | `test/loop-guards.test.ts` setup | **Open** (by design, but costs operator time) |
| 5.12 | **Legacy classifier labelled a missing native binary as CODE.** | Carried over from `main` | Fixed (commit on this branch) |
| 5.13 | **Flaky soak test** (seed 20260928): a shared RNG made the quota-reroute path timing-dependent. | 1 failure in 387 in an isolated rerun | Fixed in step 0 (24/24 under 8× load) |

## 6. Candidate solutions

Ordered by expected return. The savings are estimates for the habit-tracker lifecycle and need to be re-measured.

| Priority | Change | Targets | Expected effect |
|---|---|---|---|
| 1 | Refuse, or loudly warn on, an explicit `--adapter` that cannot be honoured; auto-probe entitlement once | 5.3 | Correctness; stops invalid runs |
| 1 | Pi tools: set governance on a brief; return real clarification IDs; batch answers; idempotent calls; cap tool output (status can be 12 KB) | 5.4 | About −40% of Pi tokens |
| 1 | Planner rule: one task unless parts can run in parallel or the work is large; tests always travel with the code | 5.5 | Building ≈ direct (−20–25% worker tokens here) |
| 2 | Coarse conversation tools, `plan(idea)` / `start(plan)` / `status()` / `answer(...)`, with progress pushed as notifications instead of polled | Conversation cost | Pi 16 → ~5 calls (−50–60% of planning) |
| 2 | On-demand `mabs review run <task\|branch>`, so `fast` + review-when-needed replaces automatic review (FirstMate "no-mistakes" style) | 5.2 | Review only when asked |
| 2 | Re-review verifies open findings only; new findings outside the delta become advisory | 5.2 | Ends review ping-pong |
| 3 | Warm handoff: a dependent task on the same route resumes the previous task's session (extends step 3) | 5.5 | Avoids repo re-reads |
| 3 | Worktree-scoped run tool, or allow `node`/`npm` scripts inside the worktree | 5.6 | −10–15% worker tokens |
| 3 | Conversation-builds-small-projects mode: when the plan is one task, the chat session builds it in a MABS worktree; MABS adds checks, commits, and evidence at zero token cost | Claude/Codex-like experience | Lifecycle ≈ direct + deterministic checks |
| 3 | Auto-cancel and re-route a `stalled` worker after a bounded wait | 5.10 | Removes silent hangs |
| 4 | Size the planner model (Sonnet/medium for intake, not Opus/high) | Conversation cost | Cheaper per Pi call |

Combined estimate for the habit tracker: Pi + MABS with Claude workers from about 1.18M to 0.75–0.85M input tokens, roughly 1.2–1.35× direct instead of 1.9×.

## 7. Over-engineering review

The question for each subsystem: does it save tokens, protect correctness, or get used? Freezing means feature-flagged off and removed from the default path and docs, not deleted.

| Subsystem | Size (src lines) | Evidence | Suggestion |
|---|---:|---|---|
| Optimizer experiments | ~1,200 | Zero experiments ever run; carried the critical N1 defect; `bench/` now does comparisons more simply | Freeze |
| Curator + incident memory | ~900 | Zero curator proposals ever made | Keep failure recording; freeze proposals |
| Optional operations (CI, deploy, monitoring, delivery) | ~500 | All disabled by default; no production adapter | Freeze |
| Operator workspace (Herdr, VS Code, viewer, launcher) | ~5,600 (largest) | Four UIs (CLI, workbench, operator workspace, Pi) for one user | Choose one primary UI |
| Two-worker pilot, admission leases, fencing | Spread across `store/` and `controller/` | Default is one worker; review findings N4–N11 and the flaky soak all live here | Keep crash recovery; freeze parallelism |
| Governance surface (type × choice × preset × trigger/scope/cadence/capacity/risk rules) | – | Delivery modes cover the normal cases | Hide the rest behind "advanced" |
| Capability / entitlement gating | ~500 | Caused the review deadlock (5.8) and the silent fallback (5.3) | Keep, but self-healing and loud |
| Pi extension (26 commands, 14 tools) | ~1,100 | Tool granularity drives Pi's cost (5.4) | Fewer, coarser tools; keep Pi optional |

Keep: SQLite records, deterministic checks, revision-bound evidence, worktrees, crash recovery, quota handling, usage accounting.

## 8. What was not measured

- **Claude-worker steps 3–6 and the final round.** These are the steps where medium-effort, delta-only review applies to Claude implementers (Codex reviewer). The runs were stopped to save subscription usage.
- **More than one sample per step**, and three-sample finals for both providers.
- **Pi on its default model** (Opus 5, thinking high).
- **Larger products**, where MABS's small per-task contexts may beat one growing direct session.
- **Review-on-demand**, which does not exist yet.

## 9. How to explore the data

All rows live in `bench/results/*.jsonl`: one JSON object per run, including every attempt's usage, turns, denials, duration, and hidden-check failures. Evidence directories (`/tmp/mabs-bench-*`) were temporary and are not kept; the rows hold every measured value.

```bash
# Regenerate the per-step tables
node bench/report.ts --labels=direct-baseline,v3-baseline,v4-step1,v4-step2,v4-step3,v4-step4,v4-step5,v4-step6,v4-final \
  --out=docs/benchmarks/efficiency-v4-data.md

# Every attempt of every MABS run: kind, provider, effort, turns, denials, input, output
jq -r '[.label,.harness,.fixture,(.attempts[]|"\(.kind)/\(.adapter)/\(.effort) t=\(.turns) d=\(.denied) in=\(.inputEvents) out=\(.output)")] | @tsv' \
  bench/results/v*.jsonl

# Hidden-check failures per run
jq -r 'select(.hidden.failures|length>0) | "\(.label) \(.harness) \(.fixture): \(.hidden.failures|join("; "))"' bench/results/*.jsonl

# Idea-to-product: Pi turns and workers
jq '.pi.turns, [.attempts[]|{task,adapter,turns,denied,inputEvents,output,durationMs}]' bench/results/lifecycle.jsonl
```

To run new measurements (each uses real subscription capacity):

```bash
node bench/run.ts --fixture=parse-duration --harness=mabs-claude --mabs=/path/to/mabs --label=my-label --sample=1
node bench/run.ts --fixture=habit-tracker --harness=direct-claude --label=lifecycle --sample=2
node bench/pi-turn.ts --checkout=/path/to/mabs --state=/tmp/lc --session=s1 --out=/tmp/lc/t1.jsonl "$(cat bench/fixtures/habit-tracker/pi-turn1.txt)"
node bench/lifecycle-exec.ts --checkout=/path/to/mabs --state=/tmp/lc --adapter=claude
```

For `lifecycle-exec.ts --adapter=codex`, verify Codex's entitlement in that state first (`routing verify-entitlement codex gpt-5.6-sol`); see issue 5.3.
