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

    // One command covers rendering; verbosity and the presentation layer were
    // two toggles over the same question.
    assert.deepEqual(recorded.commands.sort(), ["mabs-display"]);
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
      // Efficiency v5 intake operations.
      "mabs_resolve_intake", "mabs_start_work",
    ]) {
      assert.ok(names.includes(expected), `${expected} is no longer registered`);
    }
    for (const tool of recorded.tools) {
      assert.equal(typeof tool.execute, "function", `${tool.name} lost its executor`);
      assert.equal(typeof tool.renderResult, "function", `${tool.name} is not compacted`);
    }
    assert.ok(recorded.commands.includes("mabs-status"));
    // The Code surface is reachable from Pi through the same resolver as the CLI.
    for (const command of [
      "mabs-changes", "mabs-files", "mabs-open", "mabs-diff",
      "mabs-progress", "mabs-steps", "mabs-logs", "mabs-workspace",
    ]) {
      assert.ok(recorded.commands.includes(command), `${command} is not registered`);
    }
    // Viewer ownership is a workspace property, reachable as a subcommand
    // rather than a command of its own.
    assert.ok(!recorded.commands.includes("mabs-viewer"), "mabs-viewer should be folded into mabs-workspace");
    // Assessment is opt-in and must stay separately invocable from intake.
    assert.ok(recorded.commands.includes("mabs-assess"), "mabs-assess is not registered");
    assert.ok(recorded.commands.includes("mabs-new"), "mabs-new is not registered");
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

test("UX-01: the MABS extension updates status and notices from the feed and never wakes the model", { skip: SKIP }, async () => {
  await withState(async () => {
    const factory = await loadExtension("mabs.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    const frames = [
      { version: "mabs.feed.v1", at: "t1", controller: { state: "running", reason: "" }, counts: { active: 1, waiting: 0, attention: 0, done: 0 },
        tasks: [{ id: "tsk_a", title: "Greeter", project: "p", state: "RUNNING", reason: null }] },
      { version: "mabs.feed.v1", at: "t2", controller: { state: "running", reason: "" }, counts: { active: 0, waiting: 0, attention: 0, done: 1 },
        tasks: [{ id: "tsk_a", title: "Greeter", project: "p", state: "DONE", reason: null }] },
    ];
    const calls: string[][] = [];
    let modelMessages = 0;
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(event, handler); return () => undefined; },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      exec: async (_bin: string, args: string[]) => {
        calls.push(args.slice(1));
        const frame = frames[Math.min(calls.filter((call) => call[0] === "progress").length - 1, frames.length - 1)];
        return { code: 0, stdout: JSON.stringify(frame), stderr: "" };
      },
      sendUserMessage: () => { modelMessages += 1; },
    };
    const previous = process.env.MABS_FEED_INTERVAL_MS;
    process.env.MABS_FEED_INTERVAL_MS = "0";
    try {
      factory(pi);
    } finally {
      if (previous === undefined) delete process.env.MABS_FEED_INTERVAL_MS; else process.env.MABS_FEED_INTERVAL_MS = previous;
    }
    const statuses: string[] = [];
    const notices: string[] = [];
    const ctx = { ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: (text: string) => notices.push(text), theme: { fg: (_c: string, text: string) => text } } };
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_start")?.({}, ctx);
    assert.ok(calls.every((call) => call[0] === "progress" && call[1] === "feed"), "the feed is the only call");
    assert.deepEqual(statuses, ["MABS 1 active · 0 attention", "MABS 0 active · 0 attention"]);
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /^Done: Greeter \(tsk_a\)/);
    assert.equal(modelMessages, 0, "the feed never sends the model a message");
    await handlers.get("session_shutdown")?.({}, ctx);
  });
});

test("UX-01: a stale Pi context stops the feed instead of failing the process", { skip: SKIP }, async () => {
  await withState(async () => {
    const factory = await loadExtension("mabs.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    let calls = 0;
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(event, handler); return () => undefined; },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      exec: async () => { calls += 1; return { code: 0, stdout: JSON.stringify({ version: "mabs.feed.v1", at: "t", controller: { state: "running", reason: "" }, counts: { active: 0, waiting: 0, attention: 0, done: 0 }, tasks: [] }), stderr: "" }; },
      sendUserMessage: () => undefined,
    };
    const previous = process.env.MABS_FEED_INTERVAL_MS;
    process.env.MABS_FEED_INTERVAL_MS = "5000";
    try { factory(pi); } finally {
      if (previous === undefined) delete process.env.MABS_FEED_INTERVAL_MS; else process.env.MABS_FEED_INTERVAL_MS = previous;
    }
    const stale = { get ui(): never { throw new Error("This extension ctx is stale after session replacement"); } };
    await assert.doesNotReject(handlers.get("session_start")?.({}, stale) as Promise<void>);
    // The failed first poll stopped the feed for the stale context; a fresh session starts a new one.
    const statuses: string[] = [];
    const fresh = { ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: () => undefined, theme: { fg: (_c: string, text: string) => text } } };
    await handlers.get("session_start")?.({}, fresh);
    assert.deepEqual(statuses, ["MABS 0 active · 0 attention"]);
    assert.ok(calls >= 2);
    await handlers.get("session_shutdown")?.({}, fresh);
  });
});
