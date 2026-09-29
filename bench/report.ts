/**
 * Summarize benchmark rows into docs/benchmarks/efficiency-v4.md.
 *
 *   node bench/report.ts --labels=direct-baseline,v3-baseline,v4-step1 [--out=docs/benchmarks/efficiency-v4.md]
 *
 * Every figure is the median over a group's samples. Claude and Codex input
 * events are kept apart: they follow different provider semantics (Codex
 * input includes its cached subset) and are not one billing unit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AttemptRow, RunRow } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function option(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function median(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 ? known[middle] ?? null : ((known[middle - 1] ?? 0) + (known[middle] ?? 0)) / 2;
}

const sum = (attempts: AttemptRow[], field: keyof AttemptRow, filter: (attempt: AttemptRow) => boolean = () => true): number | null => {
  const values = attempts.filter(filter).map((attempt) => attempt[field]).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
};

interface Summary {
  label: string;
  fixture: string;
  harness: string;
  samples: number;
  states: string;
  wallMs: number | null;
  implMs: number | null;
  implTurns: number | null;
  implDenied: number | null;
  implPromptBytes: number | null;
  implInput: number | null;
  implOutput: number | null;
  claudeInput: number | null;
  codexInput: number | null;
  output: number | null;
  costUsd: number | null;
  attempts: string;
  hidden: string;
  hiddenMin: number | null;
}

/** The first implementation attempt: what a direct run is comparable to. */
const implementation = (row: RunRow): AttemptRow | undefined => row.attempts.find((attempt) => attempt.kind === "initial");

function summarize(label: string, fixture: string, harness: string, rows: RunRow[]): Summary {
  const kinds = (row: RunRow, kind: string) => row.attempts.filter((attempt) => attempt.kind === kind).length;
  const hiddenRates = rows.map((row) => row.hidden && row.hidden.total > 0 ? row.hidden.passed / row.hidden.total : 0);
  return {
    label, fixture, harness, samples: rows.length,
    states: [...new Set(rows.map((row) => row.finalState))].join("/"),
    wallMs: median(rows.map((row) => row.wallMs)),
    implMs: median(rows.map((row) => implementation(row)?.durationMs ?? null)),
    implTurns: median(rows.map((row) => implementation(row)?.turns ?? null)),
    implDenied: median(rows.map((row) => implementation(row)?.denied ?? null)),
    implPromptBytes: median(rows.map((row) => implementation(row)?.promptBytes ?? null)),
    implInput: median(rows.map((row) => implementation(row)?.inputEvents ?? null)),
    implOutput: median(rows.map((row) => implementation(row)?.output ?? null)),
    claudeInput: median(rows.map((row) => sum(row.attempts, "inputEvents", (attempt) => attempt.adapter === "claude"))),
    codexInput: median(rows.map((row) => sum(row.attempts, "inputEvents", (attempt) => attempt.adapter === "codex"))),
    output: median(rows.map((row) => sum(row.attempts, "output"))),
    costUsd: median(rows.map((row) => sum(row.attempts, "costUsd"))),
    attempts: `${median(rows.map((row) => kinds(row, "initial") + kinds(row, "reroute")))}/${median(rows.map((row) => kinds(row, "repair")))}/${median(rows.map((row) => kinds(row, "review")))}`,
    hidden: rows.map((row) => row.hidden ? `${row.hidden.passed}/${row.hidden.total}` : "–").join(", "),
    hiddenMin: rows.length === 0 ? null : Math.min(...hiddenRates),
  };
}

const k = (value: number | null) => value === null ? "–" : value >= 10_000 ? `${Math.round(value / 1000)}K` : String(Math.round(value));
const s = (ms: number | null) => ms === null ? "–" : `${Math.round(ms / 1000)}s`;
const usd = (value: number | null) => value === null ? "–" : `$${value.toFixed(2)}`;
const pct = (after: number | null, before: number | null) =>
  after === null || before === null || before === 0 ? "–" : `${after >= before ? "+" : ""}${Math.round(((after - before) / before) * 100)}%`;
const ratio = (value: number | null, base: number | null) => value === null || base === null || base === 0 ? "–" : `${(value / base).toFixed(1)}×`;

function main(): void {
  const labels = (option("labels") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (labels.length === 0) throw new Error("--labels=a,b,c is required (in chronological order)");
  const out = resolve(option("out", join(HERE, "..", "docs", "benchmarks", "efficiency-v4.md")) as string);
  const rows: RunRow[] = [];
  for (const label of labels) {
    const file = join(HERE, "results", `${label}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) rows.push(JSON.parse(line) as RunRow);
  }
  const fixtures = [...new Set(rows.map((row) => row.fixture))].sort();
  const harnesses = ["direct-claude", "direct-codex", "mabs-claude", "mabs-codex"];
  const summaries: Summary[] = [];
  for (const fixture of fixtures) for (const label of labels) for (const harness of harnesses) {
    const group = rows.filter((row) => row.label === label && row.fixture === fixture && row.harness === harness);
    if (group.length > 0) summaries.push(summarize(label, fixture, harness, group));
  }

  const lines: string[] = [
    "# MABS efficiency v4: benchmark results",
    "",
    "Generated by `node bench/report.ts`. Medians over samples. \"Impl\" is the first implementation attempt, comparable to a direct run;",
    "\"total\" covers every attempt (implementation, repairs, reviews). Claude and Codex input events follow different provider",
    "semantics and are never added together. Cost is Claude's list-price equivalent only, not a subscription charge.",
    "Attempts are initial/repair/review. Hidden = behavioural checks the worker never saw, one entry per sample.",
    "",
  ];
  for (const fixture of fixtures) {
    lines.push(`## ${fixture}`, "",
      "| Label | Harness | n | State | Wall | Impl time | Impl turns | Impl denied | Impl prompt | Impl input | Impl output | Claude input (total) | Codex input (total) | Output (total) | Claude cost | Attempts | Hidden |",
      "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
    for (const item of summaries.filter((entry) => entry.fixture === fixture)) {
      lines.push(`| ${item.label} | ${item.harness} | ${item.samples} | ${item.states} | ${s(item.wallMs)} | ${s(item.implMs)} | ${k(item.implTurns)} | ${k(item.implDenied)} | ` +
        `${k(item.implPromptBytes)}B | ${k(item.implInput)} | ${k(item.implOutput)} | ${k(item.claudeInput)} | ${k(item.codexInput)} | ${k(item.output)} | ${usd(item.costUsd)} | ${item.attempts} | ${item.hidden} |`);
    }
    lines.push("");
    const mabsLabels = labels.filter((label) => summaries.some((entry) => entry.fixture === fixture && entry.label === label && entry.harness.startsWith("mabs-")));
    for (const harness of ["mabs-claude", "mabs-codex"]) {
      const direct = summaries.find((entry) => entry.fixture === fixture && entry.harness === (harness === "mabs-claude" ? "direct-claude" : "direct-codex"));
      const series = mabsLabels.map((label) => summaries.find((entry) => entry.fixture === fixture && entry.label === label && entry.harness === harness)).filter((entry): entry is Summary => entry !== undefined);
      if (series.length === 0) continue;
      const baseline = series[0];
      lines.push(`### ${fixture} · ${harness}: change per step`, "",
        "| Label | Wall Δ prev | Wall Δ baseline | Impl input Δ prev | Impl input Δ baseline | Impl time vs direct | Impl input vs direct | Wall vs direct | Hidden (worst) vs direct |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|");
      series.forEach((item, index) => {
        const previous = series[index - 1] ?? item;
        const worse = direct && item.hiddenMin !== null && direct.hiddenMin !== null && item.hiddenMin < direct.hiddenMin;
        lines.push(`| ${item.label} | ${pct(item.wallMs, previous.wallMs)} | ${pct(item.wallMs, baseline?.wallMs ?? null)} | ${pct(item.implInput, previous.implInput)} | ` +
          `${pct(item.implInput, baseline?.implInput ?? null)} | ${ratio(item.implMs, direct?.implMs ?? null)} | ${ratio(item.implInput, direct?.implInput ?? null)} | ` +
          `${ratio(item.wallMs, direct?.wallMs ?? null)} | ${worse ? "**below direct**" : "not below"} |`);
      });
      lines.push("");
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

main();
