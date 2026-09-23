/**
 * Phase 1 — compact view construction.
 *
 * This module turns one finished execution into the lines a terminal renderer
 * draws. It is deliberately free of any renderer dependency so the behaviour
 * can be tested without a terminal, and so the Pi extension stays a thin shim
 * that only applies colour.
 *
 * Nothing here reads or writes the result the model sees.
 */
import {
  summarizeExecution,
  type ExecutionFacts,
  type ExecutionSummary,
  type SummaryTone,
} from "./summaries.ts";

export type LineTone = SummaryTone | "dim";

export interface CompactLine {
  text: string;
  tone: LineTone;
}

export interface CompactViewOptions {
  expanded: boolean;
  /** Original, unmodified output. Shown verbatim when expanded. */
  output?: string | null;
  maxExpandedLines?: number;
  /** A path where the untruncated original remains readable. */
  evidencePath?: string | null;
}

const DEFAULT_EXPANDED_LINES = 40;

/**
 * Pi's shell tool reports status by appending a known line to the output and,
 * on failure, throwing it as an error message. These are recognized formats,
 * not prose inference: the exact strings are produced by
 * `dist/core/tools/bash.js` in the installed version.
 */
export function shellFactsFromResult(input: {
  tool: string;
  command?: string | null;
  text: string;
  isError: boolean;
  durationMs?: number | null;
  partial?: boolean;
}): ExecutionFacts {
  const { text } = input;
  const exited = text.match(/\n\nCommand exited with code (\d+)$/);
  const aborted = /\n\nCommand aborted$/.test(text) || /^Command aborted$/.test(text.trim());
  const timedOut = /\n\nCommand timed out after (\d+) seconds$/.test(text) || /^Command timed out after \d+ seconds$/.test(text.trim());
  const noExitCode = /\n\nCommand terminated without an exit code$/.test(text);
  const truncated = /\[Showing (?:lines \d+-\d+ of \d+|last [^\]]*of line \d+)[^\]]*\]/.test(text);

  const facts: ExecutionFacts = {
    tool: input.tool,
    command: input.command ?? null,
    output: text,
    isError: input.isError,
    truncated,
    durationMs: input.durationMs ?? null,
    partial: input.partial === true,
  };
  if (aborted) facts.cancelled = true;
  else if (timedOut) facts.timedOut = true;
  else if (exited?.[1]) facts.exitCode = Number(exited[1]);
  else if (noExitCode) facts.exitCode = null;
  else if (!input.isError) facts.exitCode = 0;
  return facts;
}

/** The path Pi records when it truncates output, so expansion can point at it. */
export function fullOutputPath(text: string | null | undefined): string | null {
  return text?.match(/Full output: ([^\]]+)\]/)?.[1]?.trim() ?? null;
}

/**
 * Terminal control sequences in captured output must not be replayed when the
 * operator renders it. The bytes on disk are left untouched; only the drawn
 * copy is escaped.
 */
export function escapeControlSequences(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b/g, "\\u001b").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Build the lines for one tool row.
 *
 * Collapsed: the headline, plus a detail line when the summary carries one, plus
 * an expansion hint when a failure has more to show.
 * Expanded: the same headline followed by the original output, verbatim except
 * for escaped control sequences.
 */
export function compactView(summary: ExecutionSummary, options: CompactViewOptions): CompactLine[] {
  const lines: CompactLine[] = [{ text: summary.headline, tone: summary.tone }];
  if (summary.detail) lines.push({ text: summary.detail, tone: "dim" });

  if (!options.expanded) {
    // A failure is never hidden behind expansion; the hint only says where the
    // rest of the evidence is.
    if (summary.expandable && summary.tone === "failure") {
      lines[0] = { text: `${summary.headline}    [expand for details]`, tone: summary.tone };
    }
    return lines;
  }

  const output = options.output ?? "";
  if (output.trim().length === 0) {
    lines.push({ text: "No output was produced.", tone: "dim" });
    return lines;
  }

  const limit = options.maxExpandedLines ?? DEFAULT_EXPANDED_LINES;
  const all = output.replace(/\s+$/, "").split("\n");
  for (const line of all.slice(0, limit)) lines.push({ text: escapeControlSequences(line), tone: "dim" });
  if (all.length > limit) {
    lines.push({ text: `… ${all.length - limit} more line${all.length - limit === 1 ? "" : "s"}`, tone: "dim" });
  }

  const evidence = options.evidencePath ?? fullOutputPath(output);
  if (evidence) lines.push({ text: `Original output: ${evidence}`, tone: "dim" });
  return lines;
}

/** Convenience wrapper: summarize and lay out in one step. */
export function renderExecution(facts: ExecutionFacts, options: Omit<CompactViewOptions, "output">): CompactLine[] {
  const summary = summarizeExecution(facts);
  return compactView(summary, {
    ...options,
    output: facts.output ?? null,
    evidencePath: options.evidencePath ?? fullOutputPath(facts.output),
  });
}

/** Plain-text form, used by tests and by non-terminal surfaces. */
export function plainText(lines: CompactLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/**
 * Replace only the drawing functions of a tool definition.
 *
 * Re-registering a built-in tool by name replaces it entirely, so anything the
 * original definition carried and this copy dropped would be a silent change in
 * behaviour: the executor itself, but also the parameter schema, prompt
 * contributions, constrained-sampling request, execution mode, and argument
 * preparation. In the installed Pi version the shell tool is additionally built
 * with the user's configured shell path and command prefix, so re-creating it
 * from defaults would quietly ignore their settings.
 *
 * This keeps every other field, including the identical `execute` reference,
 * and swaps the two render functions.
 */
export function withCompactRenderers<T extends object, R extends object>(definition: T, renderers: R): T & R {
  return { ...definition, ...renderers };
}

/** The keys that must survive re-registration untouched. */
export const PRESERVED_TOOL_KEYS = [
  "name",
  "label",
  "description",
  "parameters",
  "promptSnippet",
  "promptGuidelines",
  "constrainedSampling",
  "executionMode",
  "prepareArguments",
  "execute",
] as const;
