/**
 * Phase 1 — factual execution summaries.
 *
 * A compact summary is a different view of one execution, never a new claim
 * about it. Every headline here is derived from execution metadata (exit
 * status, duration, cancellation) or from a reporter format that was actually
 * recognized in the output. Nothing is inferred from model prose, and no model
 * call is made to summarize a tool.
 *
 * The rules that matter:
 * - An unknown command gets a neutral exit-status summary.
 * - Interrupted, cancelled, or timed-out work is never reported as success.
 * - A failure stays visible in the compact view; it is not hidden behind
 *   "expand for details".
 */

export type SummaryTone = "success" | "failure" | "warning" | "neutral";

/**
 * Where a headline's claim came from. `exit-status` is the honest default;
 * the reporter bases are only used when their format was matched.
 */
export type SummaryBasis =
  | "exit-status"
  | "test-report"
  | "typecheck-report"
  | "lint-report"
  | "diff-stat"
  | "file-content"
  | "search-report"
  | "record-count"
  | "cancelled"
  | "timeout"
  | "running"
  | "unavailable";

export interface ExecutionFacts {
  /** Tool name as the harness reported it, for example "bash" or "mabs_status". */
  tool: string;
  /** The command actually executed, when the tool knows one. */
  command?: string | null;
  /** Process exit code, when the tool reports one. */
  exitCode?: number | null;
  durationMs?: number | null;
  /** The harness marked this result as an error. */
  isError?: boolean;
  /** Original, unmodified result text. Never rewritten by this module. */
  output?: string | null;
  /** The harness truncated the output before this point. */
  truncated?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  /** Execution has started but not finished. */
  partial?: boolean;
  /** The tool is waiting for the user. */
  awaitingInput?: boolean;
}

export interface ExecutionSummary {
  /** One compact line. */
  headline: string;
  tone: SummaryTone;
  basis: SummaryBasis;
  /** A second compact line when the basis carries an extra fact worth keeping. */
  detail?: string;
  /** True when output exists that expansion would reveal. */
  expandable: boolean;
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

export function formatDuration(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function withDuration(text: string, durationMs: number | null | undefined): string {
  const elapsed = formatDuration(durationMs);
  return elapsed ? `${text} in ${elapsed}` : text;
}

/** A short, single-line form of a command for the compact view. */
export function shortCommand(command: string | null | undefined, max = 60): string | null {
  if (!command) return null;
  const oneLine = command.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// --------------------------------------------------------------------------
// reporter recognition
// --------------------------------------------------------------------------

export interface RecognizedReport {
  basis: SummaryBasis;
  headline: string;
  tone: SummaryTone;
  detail?: string;
}

/**
 * Recognize reporter formats that state their own counts. Anything not matched
 * here falls back to exit status, which is always true of the execution.
 */
export function recognizeReport(output: string | null | undefined): RecognizedReport | null {
  if (!output) return null;
  const text = output;

  // node:test — "ℹ pass 81" / "ℹ fail 0"
  const nodePass = text.match(/^[\s\u2139#]*pass (\d+)$/m);
  const nodeFail = text.match(/^[\s\u2139#]*fail (\d+)$/m);
  if (nodePass && nodeFail) {
    const passed = Number(nodePass[1]);
    const failed = Number(nodeFail[1]);
    return failed > 0
      ? { basis: "test-report", headline: `Tests: ${failed} failed, ${passed} passed`, tone: "failure" }
      : { basis: "test-report", headline: `Tests: ${passed} passed`, tone: "success" };
  }

  // Jest / Vitest — "Tests:  3 failed, 44 passed, 47 total"
  const jest = text.match(/^\s*Tests?:\s+(.+?)$/m);
  if (jest?.[1]) {
    const line = jest[1];
    const passed = line.match(/(\d+) passed/)?.[1];
    const failed = line.match(/(\d+) failed/)?.[1];
    if (passed || failed) {
      const failedCount = Number(failed ?? 0);
      return failedCount > 0
        ? { basis: "test-report", headline: `Tests: ${failedCount} failed, ${passed ?? 0} passed`, tone: "failure" }
        : { basis: "test-report", headline: `Tests: ${passed} passed`, tone: "success" };
    }
  }

  // pytest — "44 passed, 3 failed in 1.20s"
  const pytest = text.match(/^=+ ([^=]*\b\d+ (?:passed|failed|error)[^=]*?) =+$/m);
  if (pytest?.[1]) {
    const line = pytest[1];
    const passed = line.match(/(\d+) passed/)?.[1];
    const failed = line.match(/(\d+) (?:failed|error)/)?.[1];
    if (failed && Number(failed) > 0) {
      return { basis: "test-report", headline: `Tests: ${failed} failed, ${passed ?? 0} passed`, tone: "failure" };
    }
    if (passed) return { basis: "test-report", headline: `Tests: ${passed} passed`, tone: "success" };
  }

  // TypeScript — "src/a.ts(3,4): error TS2345: ..."
  const tscErrors = text.match(/error TS\d+:/g);
  if (tscErrors && tscErrors.length > 0) {
    const files = new Set(text.match(/^(\S+?)\(\d+,\d+\): error TS/gm)?.map((line) => line.split("(")[0]) ?? []);
    return {
      basis: "typecheck-report",
      headline: `Failed: typecheck returned ${tscErrors.length} error${tscErrors.length === 1 ? "" : "s"}`,
      tone: "failure",
      ...(files.size > 0 ? { detail: `${files.size} file${files.size === 1 ? "" : "s"} affected` } : {}),
    };
  }

  // ESLint — "✖ 7 problems (5 errors, 2 warnings)"
  const eslint = text.match(/[✖x]\s+(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  if (eslint) {
    const errors = Number(eslint[2]);
    const warnings = Number(eslint[3]);
    return errors > 0
      ? { basis: "lint-report", headline: `Failed: lint reported ${errors} error${errors === 1 ? "" : "s"}`, tone: "failure", detail: `${warnings} warning${warnings === 1 ? "" : "s"}` }
      : { basis: "lint-report", headline: `Lint: ${warnings} warning${warnings === 1 ? "" : "s"}`, tone: "warning" };
  }

  // git diff --stat — "7 files changed, 120 insertions(+), 14 deletions(-)"
  const diffStat = text.match(/^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/m);
  if (diffStat) {
    const files = Number(diffStat[1]);
    const added = Number(diffStat[2] ?? 0);
    const removed = Number(diffStat[3] ?? 0);
    return {
      basis: "diff-stat",
      headline: `Changed: ${files} file${files === 1 ? "" : "s"} (+${added} / -${removed})`,
      tone: "neutral",
    };
  }

  return null;
}

// --------------------------------------------------------------------------
// summary
// --------------------------------------------------------------------------

/**
 * Build the compact view of one execution.
 *
 * `facts.output` is read but never modified; the caller keeps the original for
 * expansion. This function makes no network or model call.
 */
export function summarizeExecution(facts: ExecutionFacts): ExecutionSummary {
  const output = facts.output ?? "";
  const expandable = output.trim().length > 0;
  const label = shortCommand(facts.command) ?? facts.tool;

  // Order matters. Interruption outranks any reporter output the run may have
  // produced before it stopped, so partial success can never read as success.
  if (facts.cancelled) {
    return {
      headline: withDuration(`Interrupted: ${label} was cancelled`, facts.durationMs),
      tone: "failure", basis: "cancelled", expandable,
      detail: "Partial output is retained; the execution did not complete.",
    };
  }
  if (facts.timedOut) {
    return {
      headline: withDuration(`Timed out: ${label}`, facts.durationMs),
      tone: "failure", basis: "timeout", expandable,
      detail: "Partial output is retained; the execution did not complete.",
    };
  }
  if (facts.awaitingInput) {
    return { headline: `Waiting for input: ${label}`, tone: "warning", basis: "running", expandable };
  }
  if (facts.partial) {
    return { headline: withDuration(`Running: ${label}`, facts.durationMs), tone: "neutral", basis: "running", expandable };
  }

  const report = recognizeReport(output);
  const failed = facts.isError === true || (facts.exitCode !== null && facts.exitCode !== undefined && facts.exitCode !== 0);

  if (report) {
    // A recognized reporter never overrides a failing exit status into success.
    if (failed && report.tone === "success") {
      return {
        headline: withDuration(`Failed: ${label} exited ${facts.exitCode ?? "with an error"}`, facts.durationMs),
        tone: "failure", basis: "exit-status", expandable,
        detail: `${report.headline}, but the command still failed.`,
      };
    }
    return {
      headline: withDuration(report.headline, facts.durationMs),
      tone: report.tone, basis: report.basis, expandable,
      ...(report.detail ? { detail: report.detail } : {}),
    };
  }

  if (failed) {
    const status = facts.exitCode === null || facts.exitCode === undefined ? "with an error" : `${facts.exitCode}`;
    return {
      headline: withDuration(`Failed: ${label} exited ${status}`, facts.durationMs),
      tone: "failure", basis: "exit-status", expandable,
      ...(facts.truncated ? { detail: "Output was truncated by the harness before this summary." } : {}),
    };
  }

  return {
    headline: withDuration(`Completed: ${label} exited ${facts.exitCode ?? 0}`, facts.durationMs),
    tone: "success", basis: "exit-status", expandable,
    ...(facts.truncated ? { detail: "Output was truncated by the harness before this summary." } : {}),
  };
}

/**
 * Summarize a MABS CLI result. Its commands print JSON, so a record count is a
 * fact about the response rather than a reading of prose.
 */
export function summarizeRecords(facts: ExecutionFacts & { noun?: string }): ExecutionSummary {
  const base = summarizeExecution(facts);
  if (base.tone === "failure" || base.basis === "running") return base;
  const text = (facts.output ?? "").trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return base;
  try {
    const parsed = JSON.parse(text) as unknown;
    const noun = facts.noun ?? "record";
    if (Array.isArray(parsed)) {
      return {
        ...base,
        basis: "record-count",
        headline: `${facts.tool}: ${parsed.length} ${noun}${parsed.length === 1 ? "" : "s"}`,
      };
    }
    const keys = Object.keys(parsed as Record<string, unknown>);
    return { ...base, basis: "record-count", headline: `${facts.tool}: ${keys.length} field${keys.length === 1 ? "" : "s"}` };
  } catch {
    // Not JSON after all: the exit-status summary is still true.
    return base;
  }
}
