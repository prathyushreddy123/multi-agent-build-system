/**
 * Loads the real Pi extension against the installed Pi package.
 *
 * MABS does not depend on Pi, so `@earendil-works/*` only resolves here after
 * `npm run link-pi`. Without the link these tests skip with a reason rather
 * than passing vacuously.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_LINKED = existsSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
const SKIP = PI_LINKED ? undefined : "Pi is not linked into node_modules; run `npm run link-pi`";

interface RegisteredTool {
  name: string;
  execute: unknown;
  renderCall?: (...args: never[]) => unknown;
  renderResult?: (...args: never[]) => unknown;
  parameters?: unknown;
  description?: string;
}

interface Recorded {
  tools: RegisteredTool[];
  commands: string[];
  events: string[];
}

/** A stub with exactly the surface the extensions use. */
function stubPi(): { pi: Record<string, unknown>; recorded: Recorded } {
  const recorded: Recorded = { tools: [], commands: [], events: [] };
  const pi = {
    on: (event: string) => { recorded.events.push(event); return () => undefined; },
    registerTool: (tool: RegisteredTool) => { recorded.tools.push(tool); },
    registerCommand: (name: string) => { recorded.commands.push(name); },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: () => undefined,
  };
  return { pi, recorded };
}

async function loadExtension(file: string): Promise<(pi: unknown) => void> {
  const specifier = `file://${join(ROOT, ".pi", "extensions", file)}`;
  const module = (await import(specifier)) as { default: (pi: unknown) => void };
  return module.default;
}

function withState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mabs-ext-"));
  const previous = process.env.MABS_STATE_DIR;
  process.env.MABS_STATE_DIR = dir;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.MABS_STATE_DIR;
    else process.env.MABS_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("the presentation extension re-registers built-in tools with renderers only", { skip: SKIP }, async () => {
  await withState(async () => {
    const factory = await loadExtension("mabs-ux.ts");
    const { pi, recorded } = stubPi();
    factory(pi);

    const names = recorded.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["bash", "edit", "find", "grep", "ls", "read", "write"]);

    for (const tool of recorded.tools) {
      // The original executor and schema survive re-registration.
      assert.equal(typeof tool.execute, "function", `${tool.name} lost its executor`);
      assert.ok(tool.parameters, `${tool.name} lost its parameter schema`);
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} lost its description`);
      // Only the drawing is ours.
      assert.equal(typeof tool.renderCall, "function", `${tool.name} has no compact call renderer`);
      assert.equal(typeof tool.renderResult, "function", `${tool.name} has no compact result renderer`);
    }

    assert.deepEqual(recorded.commands.sort(), ["mabs-compact", "mabs-verbose"]);
    // Only observational hooks are used; tool_result would be model-facing.
    assert.ok(recorded.events.includes("tool_execution_start"));
    assert.ok(recorded.events.includes("tool_execution_end"));
    assert.ok(!recorded.events.includes("tool_result"));
    assert.ok(!recorded.events.includes("tool_call"));
  });
});

test("the presentation extension draws a compact line from a real result", { skip: SKIP }, async () => {
  await withState(async () => {
    const factory = await loadExtension("mabs-ux.ts");
    const { pi, recorded } = stubPi();
    factory(pi);

    const bash = recorded.tools.find((tool) => tool.name === "bash");
    assert.ok(bash?.renderResult);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = bash.renderResult(
      { content: [{ type: "text", text: "hello\nworld" }] } as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      { toolCallId: "call-1", args: { command: "echo hello" }, isError: false } as never,
    ) as { text?: string };

    const drawn = String((component as { text?: string }).text ?? component);
    assert.match(drawn, /Completed: echo hello exited 0/);
    // Collapsed output does not carry the body.
    assert.ok(!drawn.includes("world"));

    const expandedComponent = bash.renderResult(
      { content: [{ type: "text", text: "hello\nworld" }] } as never,
      { expanded: true, isPartial: false } as never,
      theme as never,
      { toolCallId: "call-1", args: { command: "echo hello" }, isError: false } as never,
    ) as { text?: string };
    assert.match(String(expandedComponent.text ?? ""), /world/);
  });
});

test("the MABS tool extension keeps its tools and routes them through the compact renderer", { skip: SKIP }, async () => {
  await withState(async () => {
    const factory = await loadExtension("mabs.ts");
    const { pi, recorded } = stubPi();
    factory(pi);

    const names = recorded.tools.map((tool) => tool.name);
    // Every tool the product already published stays registered.
    for (const expected of [
      "mabs_status", "mabs_create_brief", "mabs_update_brief", "mabs_ask_clarifications",
      "mabs_answer_clarification", "mabs_propose_plan", "mabs_accept_plan", "mabs_get_operations",
      "mabs_prepare_operation", "mabs_bootstrap_project", "mabs_submit_plan", "mabs_get_product",
      "mabs_submit_task",
    ]) {
      assert.ok(names.includes(expected), `${expected} is no longer registered`);
    }
    for (const tool of recorded.tools) {
      assert.equal(typeof tool.execute, "function", `${tool.name} lost its executor`);
      assert.equal(typeof tool.renderResult, "function", `${tool.name} is not compacted`);
    }
    assert.ok(recorded.commands.includes("mabs-status"));
    // The Code surface is reachable from Pi through the same resolver as the CLI.
    for (const command of ["mabs-changes", "mabs-files", "mabs-open", "mabs-diff", "mabs-viewer"]) {
      assert.ok(recorded.commands.includes(command), `${command} is not registered`);
    }
  });
});

test("the presentation layer can be disabled without touching the MABS tools", { skip: SKIP }, async () => {
  await withState(async () => {
    const { updatePreferences } = await import("../../src/operator/preferences.ts");
    updatePreferences({ enabled: false });

    const factory = await loadExtension("mabs-ux.ts");
    const { pi, recorded } = stubPi();
    factory(pi);
    assert.deepEqual(recorded.tools, []);
    assert.deepEqual(recorded.commands, []);

    // The product's own tools are unaffected by the presentation switch.
    const mabs = await loadExtension("mabs.ts");
    const second = stubPi();
    mabs(second.pi);
    assert.ok(second.recorded.tools.length >= 13);
  });
});
