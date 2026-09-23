/**
 * MABS operator workspace — Pi presentation layer.
 *
 * Phase 1: compact Agent output.
 *
 * This extension changes how executions are *drawn*. It never changes what the
 * model receives. Two facts from the Phase 0 probe shape the design:
 *
 *  - `ToolDefinition.renderResult` receives a finished result and cannot alter
 *    it, so it is presentation-only by construction. That is the hook used here.
 *  - Pi's `tool_result` event *can* replace result content, so it is a
 *    model-facing hook and is deliberately not used.
 *
 * Built-in tools have no separate renderer registration, so each is
 * re-registered under its own name. The original definition is reused whole —
 * same `execute` reference, parameter schema, prompt contributions, constrained
 * sampling, execution mode, and the user's configured shell path and command
 * prefix — and only the two render functions are replaced.
 *
 * Re-check these assumptions after an upgrade:
 *   node src/cli.ts operator probe
 * Turn the whole layer off without touching task data:
 *   /mabs-compact off
 */
import {
  SettingsManager,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { readPreferences, updatePreferences } from "../../src/operator/preferences.ts";
import {
  compactView,
  shellFactsFromResult,
  withCompactRenderers,
  type CompactLine,
} from "../../src/operator/rendering.ts";
import { formatDuration, shortCommand, summarizeExecution } from "../../src/operator/summaries.ts";
import type { ExecutionFacts } from "../../src/operator/summaries.ts";

/** Elapsed time is observed from execution events, never estimated. */
const timings = new Map<string, { startedAt: number; endedAt?: number }>();

function elapsedMs(toolCallId: string): number | null {
  const timing = timings.get(toolCallId);
  if (!timing) return null;
  return (timing.endedAt ?? Date.now()) - timing.startedAt;
}

function resultText(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

type Theme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

const TONE_COLOR: Record<CompactLine["tone"], string> = {
  success: "success",
  failure: "error",
  warning: "warning",
  neutral: "muted",
  dim: "dim",
};

function draw(lines: CompactLine[], theme: Theme): InstanceType<typeof Text> {
  return new Text(lines.map((line) => theme.fg(TONE_COLOR[line.tone], line.text)).join("\n"), 0, 0);
}

/** Read the tool options Pi itself passes, so a re-registered tool keeps them. */
function builtinToolOptions(cwd: string): { read: { autoResizeImages: boolean }; bash: { commandPrefix: string | undefined; shellPath: string | undefined } } {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir());
    return {
      read: { autoResizeImages: settings.getImageAutoResize() },
      bash: { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() },
    };
  } catch {
    // Without readable settings the safe choice is to leave built-ins alone,
    // which the caller does by treating this as unavailable.
    return { read: { autoResizeImages: true }, bash: { commandPrefix: undefined, shellPath: undefined } };
  }
}

export default function mabsUxExtension(pi: ExtensionAPI) {
  let preferences = readPreferences();
  if (!preferences.enabled) return;

  let verbose = preferences.verbose;
  const cwd = process.cwd();

  // Observation only. These handlers return nothing, so they cannot change
  // execution, results, or ordering.
  pi.on("tool_execution_start", (event) => {
    timings.set(event.toolCallId, { startedAt: Date.now() });
  });
  pi.on("tool_execution_end", (event) => {
    const timing = timings.get(event.toolCallId);
    if (timing) timing.endedAt = Date.now();
    if (timings.size > 500) {
      const oldest = [...timings.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt).slice(0, 200);
      for (const [id] of oldest) timings.delete(id);
    }
  });

  // ----------------------------------------------------------------------
  // built-in tools: original definition, compact drawing only
  // ----------------------------------------------------------------------

  const options = builtinToolOptions(cwd);

  const shellRenderers = {
    renderCall(args: { command?: string; timeout?: number }, theme: Theme) {
      const command = shortCommand(args.command, 76) ?? "bash";
      let text = theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", command);
      if (args.timeout) text += theme.fg("dim", ` (timeout ${args.timeout}s)`);
      return new Text(text, 0, 0);
    },
    renderResult(
      result: { content?: { type: string; text?: string }[] },
      renderOptions: ToolRenderResultOptions,
      theme: Theme,
      context: { toolCallId: string; args?: { command?: string }; isError?: boolean },
    ) {
      const text = resultText(result);
      const facts = shellFactsFromResult({
        tool: "bash",
        command: context.args?.command ?? null,
        text,
        isError: renderOptions.isPartial ? false : context.isError === true,
        durationMs: elapsedMs(context.toolCallId),
        partial: renderOptions.isPartial,
      });
      const summary = summarizeExecution(facts);
      return draw(compactView(summary, { expanded: verbose || renderOptions.expanded, output: text }), theme);
    },
  };

  pi.registerTool(withCompactRenderers(createBashToolDefinition(cwd, options.bash), shellRenderers) as never);

  /**
   * Register one file tool with compact drawing. The definition keeps its own
   * type, so replacing only the renderers cannot silently change its schema.
   */
  const registerFileTool = (definition: { name: string }, noun: string): void => {
    const name = definition.name;
    pi.registerTool(withCompactRenderers(definition, {
      renderCall(args: Record<string, unknown>, theme: Theme) {
        const target = typeof args.path === "string" ? args.path
          : typeof args.pattern === "string" ? `"${args.pattern}"`
          : "";
        return new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", target), 0, 0);
      },
      renderResult(
        result: { content?: { type: string; text?: string }[] },
        renderOptions: ToolRenderResultOptions,
        theme: Theme,
        context: { toolCallId: string; isError?: boolean },
      ) {
        const text = resultText(result);
        const isError = renderOptions.isPartial ? false : context.isError === true;
        const facts: ExecutionFacts = {
          tool: name,
          command: name,
          output: text,
          isError,
          exitCode: isError ? 1 : 0,
          durationMs: elapsedMs(context.toolCallId),
          partial: renderOptions.isPartial,
        };
        const summary = summarizeExecution(facts);
        // Replace the neutral exit-status headline with what the tool itself
        // reports, when it reports a countable fact.
        if (!isError && !renderOptions.isPartial && summary.basis === "exit-status") {
          const count = text.trim() === "" ? 0 : text.split("\n").length;
          const elapsed = formatDuration(facts.durationMs);
          summary.headline = `${name}: ${count} ${noun}${count === 1 ? "" : "s"}${elapsed ? ` in ${elapsed}` : ""}`;
        }
        return draw(compactView(summary, { expanded: verbose || renderOptions.expanded, output: text }), theme);
      },
    }) as never);
    // Pi's tool definitions are generic in their parameter schema, so TypeScript
    // cannot relate six different instantiations to one helper signature. The
    // object is unchanged apart from its two render functions; that is asserted
    // structurally in test/operator/extension-load.test.ts.
  };

  registerFileTool(createReadToolDefinition(cwd, options.read), "line");
  registerFileTool(createWriteToolDefinition(cwd), "line");
  registerFileTool(createEditToolDefinition(cwd), "line");
  registerFileTool(createGrepToolDefinition(cwd), "match");
  registerFileTool(createFindToolDefinition(cwd), "result");
  registerFileTool(createLsToolDefinition(cwd), "entry");

  // ----------------------------------------------------------------------
  // preferences and status
  // ----------------------------------------------------------------------

  // One command for one concern. Verbosity and the presentation layer were two
  // separate toggles over the same question: how much of a tool run to show.
  pi.registerCommand("mabs-display", {
    description: "Control MABS output rendering: /mabs-display [verbose|compact|off|on|status]",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase() || "status";
      const usage = "Usage: /mabs-display verbose|compact|off|on|status";

      if (value === "status") {
        ctx.ui.notify(
          `MABS presentation layer is ${preferences.enabled ? "on" : "off"}; output is ${verbose ? "verbose" : "compact"}. ` +
          "Both are persisted in operator preferences.",
          "info",
        );
        return;
      }

      if (value === "verbose" || value === "compact") {
        verbose = value === "verbose";
        preferences = updatePreferences({ verbose });
        // Keep Pi's own expansion state in step so ctrl+e and this command agree.
        ctx.ui.setToolsExpanded(verbose);
        ctx.ui.notify(
          verbose
            ? "MABS output is verbose. Executions show their original output."
            : "MABS output is compact. Expand a row for the original output.",
          "info",
        );
        return;
      }

      if (value === "on" || value === "off") {
        preferences = updatePreferences({ enabled: value === "on" });
        ctx.ui.notify(
          value === "on"
            ? "MABS operator presentation enabled. Run /reload to apply it."
            : "MABS operator presentation disabled. Run /reload to restore Pi's own tool rendering. Task data is untouched.",
          "info",
        );
        return;
      }

      throw new Error(usage);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Restore the persisted preference without overriding a user who has
    // already toggled expansion by hand in this session.
    if (verbose && !ctx.ui.getToolsExpanded()) ctx.ui.setToolsExpanded(true);
    ctx.ui.setStatus("mabs-ux", ctx.ui.theme.fg("dim", `MABS ${verbose ? "verbose" : "compact"}`));
  });
}

/**
 * Register MABS tools through the same compact renderer as Pi's built-ins.
 *
 * `mabs.ts` registers the MABS tools, which are how worker output, check
 * results, and controller state reach the transcript. This returns a drop-in
 * replacement for `pi.registerTool` with the identical generic signature, so
 * call sites keep their parameter type inference. Only the drawing is added;
 * the tool's own executor and schema are passed through.
 */
export function compactToolRegistrar(pi: ExtensionAPI): ExtensionAPI["registerTool"] {
  return (tool) => {
    const name = tool.name;
    const label = tool.label ?? name;
    pi.registerTool(withCompactRenderers(tool, {
      renderCall(args: Record<string, unknown>, theme: Theme) {
        const target = Object.values(args)
          .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length < 60)
          .slice(0, 2)
          .join(" ");
        return new Text(theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg("accent", target), 0, 0);
      },
      renderResult(
        result: { content?: { type: string; text?: string }[] },
        renderOptions: ToolRenderResultOptions,
        theme: Theme,
        context: { toolCallId: string; isError?: boolean },
      ) {
        const text = resultText(result);
        const isError = renderOptions.isPartial ? false : context.isError === true;
        const facts: ExecutionFacts = {
          tool: name,
          command: name,
          output: text,
          isError,
          exitCode: isError ? 1 : 0,
          durationMs: elapsedMs(context.toolCallId),
          partial: renderOptions.isPartial,
        };
        const summary = summarizeExecution(facts);
        if (!isError && !renderOptions.isPartial && summary.basis === "exit-status") {
          const lines = text.trim() === "" ? 0 : text.split("\n").length;
          const elapsed = formatDuration(facts.durationMs);
          summary.headline = `${name}: ${lines} line${lines === 1 ? "" : "s"}${elapsed ? ` in ${elapsed}` : ""}`;
        }
        return draw(compactView(summary, { expanded: readPreferences().verbose || renderOptions.expanded, output: text }), theme);
      },
    }) as typeof tool);
  };
}
