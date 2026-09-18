/**
 * Phase 0 — task-class baseline.
 *
 * The plan's success measure is accepted product work per unit of subscription
 * usage and attention. That comparison needs numbers captured before any
 * automation exists, on tasks that do not change between runs.
 *
 * Every acceptance check here is run by the harness against the repository, not
 * read from the worker's own summary.
 *
 * Run: node src/verify/baseline.ts [--only=bugfix,feature] [--harness=claude]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../core/exec.ts";
import { classifyFailure, classifyFromEnvelope, type FailureClass } from "../core/failure.ts";
import { stateDir } from "../core/paths.ts";
import { validateWorkerOutput, WORKER_OUTPUT_SCHEMA, CONTRACT_VERSION } from "../domain/contract.ts";
import { launchClaude, launchCodex } from "./launch.ts";
import { createFixture, fixtureTestsPass, gitStatus } from "./fixture.ts";

const RESULT_FILE = ".mabs/result.json";

export interface TaskClass {
  id: string;
  label: string;
  prompt: string;
  /** Independent acceptance check run against the repository afterwards. */
  accept: (fixturePath: string, finalMessage: string) => Promise<{ accepted: boolean; note: string }>;
  readOnly?: boolean;
}

/** Run a python expression inside the fixture and return its stdout. */
async function py(fixturePath: string, code: string): Promise<{ ok: boolean; out: string }> {
  const result = await exec("python3", ["-c", code], { cwd: fixturePath, timeoutMs: 60_000 });
  return { ok: result.code === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

export const TASK_CLASSES: TaskClass[] = [
  {
    id: "bugfix",
    label: "Bug fix (single function, failing test)",
    prompt:
      "The test suite fails. Fix the implementation in src/calc.py so that " +
      "`python3 -m unittest discover -s tests` passes. Do not edit the tests.",
    accept: async (path) => {
      const tests = await fixtureTestsPass(path);
      const check = await py(path, "from src.calc import multiply; print(multiply(3,4) == 12 and multiply(0,9) == 0)");
      const accepted = tests.pass && check.out.trim() === "True";
      return { accepted, note: `tests ${tests.pass ? "pass" : "fail"}; multiply correct: ${check.out.trim() || "n/a"}` };
    },
  },
  {
    id: "feature",
    label: "Small feature (new function plus tests)",
    prompt:
      "Add a `power(base, exponent)` function to src/calc.py that returns base raised to exponent, " +
      "with unit tests in tests/. Also fix the existing failing test. " +
      "`python3 -m unittest discover -s tests` must pass.",
    accept: async (path) => {
      const tests = await fixtureTestsPass(path);
      const check = await py(path, "from src.calc import power; print(power(2,3) == 8 and power(5,0) == 1)");
      const accepted = tests.pass && check.out.trim() === "True";
      return { accepted, note: `tests ${tests.pass ? "pass" : "fail"}; power correct: ${check.out.trim() || "n/a"}` };
    },
  },
  {
    id: "diagnosis",
    label: "Diagnosis (explain, change nothing)",
    prompt:
      "Do not modify any file in this repository. Explain precisely why `test_multiply` fails: " +
      "name the function, the incorrect expression, and the correct one.",
    readOnly: true,
    accept: async (path, finalMessage) => {
      const status = await gitStatus(path);
      const sourceUntouched = !status.changedFiles.some((file) => file.includes("src/calc.py") || file.includes("tests/"));
      const text = finalMessage.toLowerCase();
      const namesFunction = text.includes("multiply");
      const namesBug = text.includes("a + b") || text.includes("addition") || text.includes("adds");
      const namesFix = text.includes("a * b") || text.includes("multiplication") || text.includes("multiplies");
      const accepted = sourceUntouched && namesFunction && namesBug && namesFix;
      return {
        accepted,
        note: `source untouched: ${sourceUntouched}; named function: ${namesFunction}; named bug: ${namesBug}; named fix: ${namesFix} (keyword heuristic)`,
      };
    },
  },
  {
    id: "complex",
    label: "Complex change (refactor, keep behaviour)",
    prompt:
      "Refactor src/calc.py so the arithmetic lives on a `Calculator` class with `add` and `multiply` methods, " +
      "while keeping the existing module-level `add` and `multiply` functions working as thin wrappers. " +
      "Fix the failing test. `python3 -m unittest discover -s tests` must pass and the public function API must not change.",
    accept: async (path) => {
      const tests = await fixtureTestsPass(path);
      const check = await py(
        path,
        "from src.calc import Calculator, add, multiply; c=Calculator(); print(c.add(2,3)==5 and c.multiply(3,4)==12 and add(2,3)==5 and multiply(3,4)==12)",
      );
      const accepted = tests.pass && check.out.trim() === "True";
      return { accepted, note: `tests ${tests.pass ? "pass" : "fail"}; class + wrappers correct: ${check.out.trim() || "n/a"}` };
    },
  },
];

function contractPrompt(taskText: string): string {
  return [
    taskText,
    "",
    `When finished, write your structured result to ${RESULT_FILE} (create the directory).`,
    "It must be one JSON object with these keys:",
    JSON.stringify(WORKER_OUTPUT_SCHEMA.properties),
    `Contract version ${CONTRACT_VERSION}. Leave anything you cannot measure as null; do not invent token counts.`,
    "Then reply with the same JSON object as your final message and nothing else.",
  ].join("\n");
}

export interface BaselineRow {
  taskClass: string;
  harness: string;
  accepted: boolean;
  note: string;
  firstAttempt: boolean;
  durationS: number;
  exitCode: number | null;
  failureClass: FailureClass | null;
  contractValid: boolean;
  resultFileWritten: boolean;
  reportedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  apiEquivalentEstimateUsd: number | null;
  changedFiles: number;
}

function tokensOf(usage: Record<string, unknown> | null): { input: number | null; output: number | null } {
  if (!usage) return { input: null, output: null };
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  return {
    input: typeof input === "number" ? input : null,
    output: typeof output === "number" ? output : null,
  };
}

export async function runBaseline(options: { only?: string[]; harnesses?: string[] } = {}): Promise<BaselineRow[]> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(stateDir(), "baseline", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const harnesses = options.harnesses ?? ["claude", "codex"];
  const classes = TASK_CLASSES.filter((task) => !options.only || options.only.includes(task.id));
  const rows: BaselineRow[] = [];

  for (const task of classes) {
    for (const harness of harnesses) {
      const fixturePath = join(runDir, `${task.id}-${harness}`);
      const fixture = await createFixture(fixturePath);
      const evidence = join(runDir, `${task.id}-${harness}.log`);
      const launch = harness === "claude" ? launchClaude : launchCodex;

      const result = await launch({
        cwd: fixture.path,
        prompt: contractPrompt(task.prompt),
        timeoutMs: 12 * 60_000,
        evidencePath: evidence,
      });

      const acceptance = await task.accept(fixture.path, result.finalMessage);
      const status = await gitStatus(fixture.path);
      const resultFile = join(fixture.path, RESULT_FILE);
      const written = existsSync(resultFile);
      let parsed: unknown = null;
      if (written) {
        try {
          parsed = JSON.parse(readFileSync(resultFile, "utf8")) as unknown;
        } catch {
          parsed = null;
        }
      }
      const validation = validateWorkerOutput(parsed);
      const tokens = tokensOf(result.usage);

      let failureClass: FailureClass | null = null;
      if (result.timedOut) failureClass = "TIMEOUT";
      else if (result.exitCode !== 0) {
        if (harness === "claude") {
          let envelope: Record<string, unknown> = {};
          try { envelope = JSON.parse(result.raw) as Record<string, unknown>; } catch { /* raw evidence is retained */ }
          failureClass = classifyFromEnvelope(envelope, `${result.raw}\n${result.stderr}`, result.exitCode);
        } else {
          failureClass = classifyFailure(`${result.raw}\n${result.stderr}`, result.exitCode);
        }
      }

      const row: BaselineRow = {
        taskClass: task.id,
        harness,
        accepted: acceptance.accepted,
        failureClass,
        note: acceptance.note,
        firstAttempt: true,
        durationS: Math.round(result.durationMs / 1000),
        exitCode: result.exitCode,
        contractValid: validation.ok,
        resultFileWritten: written,
        reportedModel: result.reportedModel,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        apiEquivalentEstimateUsd: result.apiEquivalentEstimateUsd,
        changedFiles: status.changedFiles.length,
      };
      rows.push(row);
      console.log(
        `${acceptance.accepted ? "✓" : "✗"} ${task.id.padEnd(10)} ${harness.padEnd(7)} ` +
          `${String(row.durationS).padStart(4)}s  contract=${row.contractValid}  ${acceptance.note}`,
      );
      writeFileSync(join(runDir, `${task.id}-${harness}.result.json`), JSON.stringify({ row, parsed, validation }, null, 2));
    }
  }

  writeFileSync(join(runDir, "baseline.json"), JSON.stringify(rows, null, 2));
  writeFileSync(join(runDir, "baseline.md"), renderBaseline(rows, runDir));
  console.log(`\nEvidence: ${runDir}`);
  return rows;
}

function renderBaseline(rows: BaselineRow[], runDir: string): string {
  const lines: string[] = [];
  lines.push("# Phase 0 — task-class baseline");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Evidence: \`${runDir}\``);
  lines.push("");
  lines.push("Single attempt per cell, no repair cycles, no review. Acceptance is checked against the repository.");
  lines.push("");
  lines.push("| Task class | Harness | Accepted | Failure | Elapsed | Contract | Model reported | In tok | Out tok | Check |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| ${row.taskClass} | ${row.harness} | ${row.accepted ? "yes" : "no"} | ${row.failureClass ?? "—"} | ${row.durationS}s | ` +
        `${row.contractValid ? "valid" : "invalid"} | ${row.reportedModel ?? "not reported"} | ` +
        `${row.inputTokens ?? "—"} | ${row.outputTokens ?? "—"} | ${row.note} |`,
    );
  }
  lines.push("");
  lines.push("Token counts are the harness's own reported values. Blank means the harness did not report one;");
  lines.push("no estimate is substituted. Any cost figure a harness prints is list-price API equivalence, not");
  lines.push("subscription spend.");
  return lines.join("\n");
}

if (import.meta.filename === process.argv[1]) {
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const harnessArg = process.argv.find((arg) => arg.startsWith("--harness="));
  await runBaseline({
    only: onlyArg ? (onlyArg.split("=")[1] ?? "").split(",").filter(Boolean) : undefined,
    harnesses: harnessArg ? (harnessArg.split("=")[1] ?? "").split(",").filter(Boolean) : undefined,
  });
}
