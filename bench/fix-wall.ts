/**
 * Correct MABS rows recorded before wall time ended at the task's final
 * update. Those rows stopped the clock at the last task.state event, but
 * acceptance is recorded as task.accepted, so the review stage and anything
 * after the last state change were left out of wallMs.
 *
 *   node bench/fix-wall.ts            (idempotent; rewrites bench/results/*.jsonl)
 *
 * The controller start is recovered exactly as (last task.state event - old
 * wallMs); the corrected wall is (task.updatedAt - that start). Each row is
 * matched to its evidence directory by fixture, harness, and task creation
 * time, and keeps its original value as wallMsLastStateEvent.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunRow } from "./run.ts";

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "results");

interface Show { task: { id: string; createdAt: string; updatedAt: string }; events: { kind: string; at: string }[] }

const candidates = readdirSync(tmpdir()).filter((name) => name.startsWith("mabs-bench-")).map((name) => join(tmpdir(), name))
  .filter((dir) => existsSync(join(dir, "task-show.json")));

function evidenceFor(row: RunRow, taken: Set<string>): { dir: string; show: Show } | null {
  let best: { dir: string; show: Show; gap: number } | null = null;
  for (const dir of candidates) {
    if (taken.has(dir) || !dir.includes(`mabs-bench-${row.fixture}-${row.harness}-`)) continue;
    const show = JSON.parse(readFileSync(join(dir, "task-show.json"), "utf8")) as Show;
    const gap = Date.parse(show.task.createdAt) - Date.parse(row.startedAt);
    if (gap < 0 || gap > 180_000) continue;
    if (!best || gap < best.gap) best = { dir, show, gap };
  }
  return best;
}

let fixed = 0;
let unmatched = 0;
for (const file of readdirSync(RESULTS).filter((name) => name.endsWith(".jsonl"))) {
  const path = join(RESULTS, file);
  const taken = new Set<string>();
  const rows = readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as RunRow & { wallMsLastStateEvent?: number });
  for (const row of rows) {
    if (!row.harness.startsWith("mabs-")) continue;
    if (row.evidence) taken.add(row.evidence);
  }
  for (const row of rows) {
    if (!row.harness.startsWith("mabs-") || row.wallBasis) continue;
    const match = evidenceFor(row, taken);
    if (!match) { unmatched += 1; console.warn(`no evidence for ${file} ${row.fixture} ${row.harness} #${row.sample} (${row.startedAt})`); continue; }
    taken.add(match.dir);
    const states = match.show.events.filter((event) => event.kind === "task.state").map((event) => Date.parse(event.at));
    const controllerStart = Math.max(...states) - row.wallMs;
    row.wallMsLastStateEvent = row.wallMs;
    row.wallMs = Date.parse(match.show.task.updatedAt) - controllerStart;
    row.wallBasis = "task.updatedAt";
    row.taskId = match.show.task.id;
    row.evidence = match.dir;
    fixed += 1;
  }
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
console.log(`corrected ${fixed} row(s); ${unmatched} without evidence`);
