/**
 * Phase 0 — operator workspace capability proof.
 *
 * The operator workspace (Agent, Code, Tasks, Logs) is built on two external
 * surfaces MABS does not own: the installed Pi extension API and the installed
 * Herdr CLI. Neither is assumed. Every claim below is produced by running the
 * real command or reading the installed type declarations, and the evidence is
 * written to the state directory so a later upgrade can be checked against it.
 *
 * Run: node src/cli.ts operator probe [--json]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { exec } from "../core/exec.ts";
import { stateDir, worktreeRoot } from "../core/paths.ts";

export type ProbeStatus = "PASS" | "FAIL" | "UNKNOWN" | "SKIPPED";

export interface OperatorProbe {
  id: string;
  name: string;
  status: ProbeStatus;
  /** What was observed, in plain language. */
  detail: string;
  /** The exact command or file that produced the observation. */
  evidence: string;
  /** A capability the operator layer must work without, when one was found. */
  limitation?: string;
  data?: Record<string, unknown>;
}

export interface OperatorCapabilities {
  probedAt: string;
  versions: Record<string, string>;
  probes: OperatorProbe[];
  evidenceDir: string;
}

async function versionOf(command: string, args: string[]): Promise<string> {
  const result = await exec(command, args, { timeoutMs: 20_000 });
  if (result.code !== 0) return "unavailable";
  return (result.stdout || result.stderr).trim().split("\n")[0] ?? "unknown";
}

/**
 * Locate the installed Pi package so its shipped type declarations can be read.
 * The repository deliberately does not depend on Pi, so resolution goes through
 * the global install rather than node_modules.
 */
export async function findPiPackageDir(): Promise<string | null> {
  const explicit = process.env.MABS_PI_PACKAGE_DIR;
  if (explicit && existsSync(join(explicit, "package.json"))) return resolve(explicit);
  const root = await exec("npm", ["root", "-g"], { timeoutMs: 30_000 });
  if (root.code === 0) {
    const candidate = join(root.stdout.trim(), "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

// --------------------------------------------------------------------------
// probes
// --------------------------------------------------------------------------

async function probeRepository(repoPath: string): Promise<OperatorProbe> {
  const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, timeoutMs: 20_000 });
  if (inside.code !== 0) {
    return {
      id: "OP0-01", name: "Repository checkout", status: "FAIL",
      detail: `${repoPath} is not a git work tree`, evidence: `git rev-parse --is-inside-work-tree (cwd ${repoPath})`,
    };
  }
  const branch = await exec("git", ["branch", "--show-current"], { cwd: repoPath, timeoutMs: 20_000 });
  const dirty = await exec("git", ["status", "--porcelain"], { cwd: repoPath, timeoutMs: 20_000 });
  const modified = dirty.stdout.split("\n").filter(Boolean).length;
  return {
    id: "OP0-01",
    name: "Repository checkout",
    status: "PASS",
    detail: `branch ${branch.stdout.trim() || "detached"} with ${modified} uncommitted path(s); unrelated changes must be preserved`,
    evidence: `git branch --show-current; git status --porcelain (cwd ${repoPath})`,
    data: { repoPath, branch: branch.stdout.trim(), uncommittedPaths: modified },
  };
}

async function probePiExtensionApi(): Promise<OperatorProbe[]> {
  const piVersion = await versionOf("pi", ["--version"]);
  const packageDir = await findPiPackageDir();
  const cli: OperatorProbe = {
    id: "OP0-02",
    name: "Pi CLI and extension package",
    status: packageDir ? "PASS" : "UNKNOWN",
    detail: packageDir
      ? `pi ${piVersion} installed at ${packageDir}`
      : `pi ${piVersion} responded but its package directory was not found; type declarations could not be inspected`,
    evidence: "pi --version; npm root -g",
    data: { piVersion, packageDir },
  };
  if (!packageDir) {
    cli.limitation = "Extension API capabilities are unverified; do not select renderer APIs without inspecting them.";
    return [cli, {
      id: "OP0-03", name: "Presentation-only tool rendering", status: "UNKNOWN",
      detail: "Pi type declarations were not readable, so the rendering route is unproven.",
      evidence: "npm root -g",
      limitation: "Compact output must not be implemented until the installed renderer API is inspected.",
    }];
  }

  const typesPath = join(packageDir, "dist", "core", "extensions", "types.d.ts");
  const indexPath = join(packageDir, "dist", "index.d.ts");
  const types = existsSync(typesPath) ? readFileSync(typesPath, "utf8") : "";
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";

  const has = (haystack: string, needle: string) => haystack.includes(needle);
  const renderResult = has(types, "renderResult?:");
  const renderOptions = has(types, "interface ToolRenderResultOptions");
  const toolsExpanded = has(types, "getToolsExpanded(): boolean") && has(types, "setToolsExpanded(");
  // Re-registering a built-in name replaces it, so the original executor has to
  // be obtainable to keep execution, streaming, timeout, and cancellation intact.
  const originalExecutors = ["createBashTool", "createReadTool", "createEditTool", "createWriteTool", "createGrepTool", "createFindTool", "createLsTool"]
    .filter((name) => has(index, name));
  const toolResultMutatesModelInput = has(types, "interface ToolResultEventResult") && has(types, "content?: (TextContent | ImageContent)[]");

  const render: OperatorProbe = {
    id: "OP0-03",
    name: "Presentation-only tool rendering",
    status: renderResult && renderOptions ? "PASS" : "FAIL",
    detail: renderResult && renderOptions
      ? `ToolDefinition.renderResult(result, { expanded, isPartial }) is presentation-only: it receives the finished result and cannot change it. ` +
        `ui.getToolsExpanded/setToolsExpanded ${toolsExpanded ? "are" : "are not"} available for a shared verbose preference. ` +
        `Original executors exported for delegation: ${originalExecutors.join(", ") || "none"}.`
      : "The installed Pi version exposes no presentation-only tool renderer.",
    evidence: `${typesPath}; ${indexPath}`,
    data: { renderResult, renderOptions, toolsExpanded, originalExecutors },
  };
  if (toolResultMutatesModelInput) {
    render.limitation =
      "The tool_result event can replace result content, so it is a model-facing hook and must not be used for presentation. " +
      "Built-in tools are re-registered by name with execution delegated to the exported original executor instead.";
  }
  return [cli, render];
}

async function probeHerdr(): Promise<OperatorProbe[]> {
  const version = await versionOf("herdr", ["--version"]);
  const inSession = process.env.HERDR_ENV === "1";
  const paneId = process.env.HERDR_PANE_ID ?? null;
  const workspaceId = process.env.HERDR_WORKSPACE_ID ?? null;
  const tabId = process.env.HERDR_TAB_ID ?? null;

  const cli: OperatorProbe = {
    id: "OP0-04",
    name: "Herdr CLI and live session",
    status: version === "unavailable" ? "FAIL" : inSession ? "PASS" : "SKIPPED",
    detail: version === "unavailable"
      ? "herdr is not on PATH; the operator workspace must degrade to plain CLI surfaces"
      : inSession
        ? `${version} with caller context workspace ${workspaceId ?? "unknown"}, tab ${tabId ?? "unknown"}, pane ${paneId ?? "unknown"}`
        : `${version} is installed but HERDR_ENV is not 1; workspace automation must not control another client's panes`,
    evidence: "herdr --version; $HERDR_ENV/$HERDR_WORKSPACE_ID/$HERDR_TAB_ID/$HERDR_PANE_ID",
    data: { version, inSession, workspaceId, tabId, paneId },
  };

  const probes = [cli];
  if (version !== "unavailable" && inSession) {
    const list = await exec("herdr", ["workspace", "list"], { timeoutMs: 20_000 });
    let workspaces = 0;
    try {
      const parsed = JSON.parse(list.stdout) as { result?: { workspaces?: unknown[] } };
      workspaces = parsed.result?.workspaces?.length ?? 0;
    } catch {
      workspaces = -1;
    }
    probes.push({
      id: "OP0-05",
      name: "Herdr workspace, tab, and pane API",
      status: list.code === 0 && workspaces >= 0 ? "PASS" : "FAIL",
      detail: list.code === 0 && workspaces >= 0
        ? `socket API returned JSON for ${workspaces} workspace(s); creation responses carry the IDs to own`
        : `herdr workspace list failed (${list.code}): ${(list.stderr || list.stdout).trim().slice(0, 200)}`,
      evidence: "herdr workspace list",
      data: { workspaces },
    });
  } else {
    probes.push({
      id: "OP0-05", name: "Herdr workspace, tab, and pane API", status: "SKIPPED",
      detail: "Not probed outside a live Herdr session.", evidence: "herdr workspace list",
    });
  }

  // OSC-8 escape sequences are emitted by the agent, but something has to
  // receive the activation. Herdr 0.9.x exposes no link-handler registration,
  // so clicking a hyperlink cannot be routed back into MABS.
  const config = await exec("herdr", ["--default-config"], { timeoutMs: 20_000 });
  const configText = config.stdout;
  const linkHandler = /osc[-_ ]?8|hyperlink|link_handler|url_handler/i.test(configText);
  probes.push({
    id: "OP0-06",
    name: "Herdr link dispatch",
    status: linkHandler ? "PASS" : "FAIL",
    detail: linkHandler
      ? "A link or hyperlink handler key exists in the default configuration and can be registered."
      : `${version} exposes no link, hyperlink, or URL handler registration. OSC-8 formatting alone cannot open a file.`,
    evidence: "herdr --default-config (searched for osc8/hyperlink/link_handler/url_handler)",
    ...(linkHandler ? {} : {
      limitation: "File opening must be driven by the picker, the slash command, and the CLI. " +
        "OSC-8 sequences may still be emitted for terminals that handle them, but are never the only route.",
    }),
  });
  return probes;
}

async function probeViewers(): Promise<OperatorProbe[]> {
  const candidates = [
    { command: "nvim", args: ["--version"], readOnly: ["-R"] },
    { command: "vim", args: ["--version"], readOnly: ["-R"] },
    { command: "less", args: ["--version"], readOnly: [] },
  ];
  const found: { command: string; version: string }[] = [];
  for (const candidate of candidates) {
    const version = await versionOf(candidate.command, candidate.args);
    if (version !== "unavailable") found.push({ command: candidate.command, version });
  }
  const primary = found[0];
  const internal: OperatorProbe = {
    id: "OP0-07",
    name: "Internal viewer",
    status: primary ? "PASS" : "FAIL",
    detail: primary
      ? `${primary.command} (${primary.version}) is the preferred read-only viewer; available: ${found.map((f) => f.command).join(", ")}`
      : "No nvim, vim, or less on PATH; Code browsing has no internal viewer",
    evidence: "nvim --version; vim --version; less --version",
    data: { available: found, preferred: primary?.command ?? null },
  };
  if (primary && primary.command !== "nvim") {
    internal.limitation = "Neovim is not installed. The plan prefers it; vim -R provides browsing, search, syntax highlighting, " +
      "and diff, and less is only a degraded fallback.";
  }

  // Reusing one viewer process needs a control channel. Without clientserver or
  // an nvim socket, the operator layer must own the viewer loop itself.
  let remoteControl = false;
  let remoteEvidence = "vim --version (searched for +clientserver)";
  if (found.some((f) => f.command === "nvim")) {
    remoteControl = true;
    remoteEvidence = "nvim --version (nvim --server/--remote is always available)";
  } else if (found.some((f) => f.command === "vim")) {
    const details = await exec("vim", ["--version"], { timeoutMs: 20_000 });
    remoteControl = details.stdout.includes("+clientserver");
  }
  return [internal, {
    id: "OP0-08",
    name: "Viewer remote control",
    status: remoteControl ? "PASS" : "FAIL",
    detail: remoteControl
      ? "The viewer supports remote control, so a running instance can be told to open the next selection."
      : "No viewer remote-control channel. A MABS-owned viewer loop must read selections from its own control channel " +
        "instead of typing commands into a pane that may be running an editor.",
    evidence: remoteEvidence,
    ...(remoteControl ? {} : { limitation: "Viewer reuse is implemented by an owned request channel, not by editor remote control." }),
  }];
}

async function probeExternalEditor(): Promise<OperatorProbe> {
  const distro = process.env.WSL_DISTRO_NAME ?? null;
  const candidates = ["code", "cursor"];
  const available: { command: string; path: string; windowsHosted: boolean }[] = [];
  for (const command of candidates) {
    const which = await exec("bash", ["-lc", `command -v ${command}`], { timeoutMs: 20_000 });
    if (which.code !== 0) continue;
    const path = which.stdout.trim();
    available.push({ command, path, windowsHosted: path.startsWith("/mnt/") });
  }
  if (available.length === 0) {
    return {
      id: "OP0-09", name: "External editor backend", status: "SKIPPED",
      detail: "No code or cursor on PATH. The optional external backend stays unconfigured.",
      evidence: "command -v code; command -v cursor",
    };
  }
  const windowsHosted = available.filter((entry) => entry.windowsHosted).map((entry) => entry.command);
  return {
    id: "OP0-09",
    name: "External editor backend",
    status: "PASS",
    detail: `${available.map((entry) => entry.command).join(", ")} available` +
      (windowsHosted.length > 0
        ? `; ${windowsHosted.join(", ")} is a Windows binary reached through /mnt, so it needs --remote wsl+${distro ?? "<distro>"} to address this filesystem`
        : ""),
    evidence: "command -v code; command -v cursor; $WSL_DISTRO_NAME",
    limitation: "An external editor opens its own GUI window. It is never described as embedded in a Herdr terminal tab.",
    data: { available, wslDistro: distro },
  };
}

/**
 * Proof 1 — one compact result whose original output stays recoverable.
 *
 * Phase 1 generalizes this; Phase 0 only has to show that the facts a factual
 * summary needs (exit status, duration, original bytes) are available, that the
 * compact form is derived from them, and that a failure is never compacted into
 * a success.
 */
async function proveCompactRoundTrip(evidenceDir: string): Promise<OperatorProbe> {
  const succeeded = await exec("node", ["-e", "for (let i = 0; i < 200; i += 1) console.log('line ' + i)"], { timeoutMs: 30_000 });
  const failed = await exec("node", ["-e", "console.error('boom'); process.exit(3)"], { timeoutMs: 30_000 });

  const summarize = (result: Awaited<ReturnType<typeof exec>>) =>
    result.code === 0
      ? `Completed: command exited 0 in ${(result.durationMs / 1000).toFixed(1)}s`
      : `Failed: command exited ${result.code ?? "on signal"} in ${(result.durationMs / 1000).toFixed(1)}s`;

  const original = join(evidenceDir, "compact-round-trip.txt");
  writeFileSync(original, `--- succeeded ---\n${succeeded.stdout}\n--- failed ---\n${failed.stderr}\n`);

  const compact = summarize(succeeded);
  const compactFailure = summarize(failed);
  const shorter = compact.length < succeeded.stdout.length;
  const failureVisible = compactFailure.startsWith("Failed:") && compactFailure.includes("3");
  const recoverable = readFileSync(original, "utf8").includes(succeeded.stdout.trim());

  const ok = shorter && failureVisible && recoverable;
  return {
    id: "OP0-10",
    name: "Proof: compact result with expandable original output",
    status: ok ? "PASS" : "FAIL",
    detail: ok
      ? `"${compact}" replaces ${succeeded.stdout.split("\n").length} lines of output that remain byte-for-byte recoverable; ` +
        `a non-zero exit renders as "${compactFailure}"`
      : "A compact summary could not be derived from execution facts without losing the original output or the failure.",
    evidence: original,
    data: { compact, compactFailure, originalLines: succeeded.stdout.split("\n").length },
  };
}

/**
 * Proof 2 — opening a relative path resolves inside the intended task worktree.
 *
 * Two worktrees hold different content at the same relative path. The proof
 * fails unless each selection returns its own worktree's bytes and a traversal
 * attempt is rejected.
 */
async function proveWorktreeFileOpen(evidenceDir: string): Promise<OperatorProbe> {
  const root = mkdtempSync(join(tmpdir(), "mabs-op0-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], cwd = repo) => exec("git", args, { cwd, timeoutMs: 30_000 });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "mabs@local"]);
    await git(["config", "user.name", "MABS Probe"]);
    writeFileSync(join(repo, "shared.ts"), "export const source = 'base';\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "base"]);

    const worktrees: { task: string; path: string }[] = [];
    for (const task of ["task-a", "task-b"]) {
      const path = join(root, "worktrees", task);
      const added = await git(["worktree", "add", "-q", "-b", `mabs/${task}`, path, "HEAD"]);
      if (added.code !== 0) throw new Error(`git worktree add failed: ${(added.stderr || added.stdout).trim()}`);
      writeFileSync(join(path, "shared.ts"), `export const source = '${task}';\n`);
      worktrees.push({ task, path });
    }

    // The resolver contract proved here: a relative path is joined to the
    // selected worktree root, canonicalized, and required to stay inside it.
    const resolveInWorktree = (worktreePath: string, relative: string): string => {
      const absolute = resolve(worktreePath, relative);
      const prefix = resolve(worktreePath) + "/";
      if (absolute !== resolve(worktreePath) && !absolute.startsWith(prefix)) {
        throw new Error(`${relative} resolves outside the selected worktree`);
      }
      return absolute;
    };

    const contents = worktrees.map((entry) => ({
      task: entry.task,
      text: readFileSync(resolveInWorktree(entry.path, "shared.ts"), "utf8").trim(),
    }));
    const distinct = new Set(contents.map((entry) => entry.text)).size === worktrees.length;
    const matchesTask = contents.every((entry) => entry.text.includes(entry.task));

    let traversalRejected = false;
    try {
      resolveInWorktree(worktrees[0]?.path as string, "../../repo/shared.ts");
    } catch {
      traversalRejected = true;
    }

    const evidence = join(evidenceDir, "worktree-file-open.json");
    writeFileSync(evidence, JSON.stringify({ worktrees, contents, distinct, matchesTask, traversalRejected }, null, 2));
    const ok = distinct && matchesTask && traversalRejected;
    return {
      id: "OP0-11",
      name: "Proof: file open into the correct task worktree",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? "The same relative path in two concurrent task worktrees returned each task's own content, and a traversal attempt was rejected."
        : `Resolution was not task-correct (distinct=${distinct}, matchesTask=${matchesTask}, traversalRejected=${traversalRejected}).`,
      evidence,
      data: { contents, traversalRejected },
    };
  } catch (error) {
    return {
      id: "OP0-11", name: "Proof: file open into the correct task worktree", status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
      evidence: "git worktree add in a temporary repository",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function probeStateSources(): OperatorProbe {
  const state = stateDir();
  const worktrees = worktreeRoot();
  return {
    id: "OP0-12",
    name: "Task, step, and evidence sources",
    status: "PASS",
    detail:
      "Authoritative task state is SQLite `tasks`; recorded implementation steps are `task_checkpoints`; " +
      "attempt identity and transcripts are `attempts.output_path`; check output is `gate_results.evidence_path`; " +
      "review detail is `review_results.evidence_path`; worktrees live under the worktree root.",
    evidence: `${state}; ${worktrees}; src/store/records.ts`,
    data: {
      stateDir: state,
      worktreeRoot: worktrees,
      taskState: "tasks.state",
      steps: "task_checkpoints",
      attemptEvidence: "attempts.output_path",
      gateEvidence: "gate_results.evidence_path",
      reviewEvidence: "review_results.evidence_path",
    },
  };
}

// --------------------------------------------------------------------------
// runner
// --------------------------------------------------------------------------

export async function probeOperatorCapabilities(options: { repoPath?: string } = {}): Promise<OperatorCapabilities> {
  const probedAt = new Date().toISOString();
  const evidenceDir = join(stateDir(), "operator", "phase0", probedAt.replace(/[:.]/g, "-"));
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const repoPath = resolve(options.repoPath ?? process.cwd());

  const probes: OperatorProbe[] = [];
  probes.push(await probeRepository(repoPath));
  probes.push(...(await probePiExtensionApi()));
  probes.push(...(await probeHerdr()));
  probes.push(...(await probeViewers()));
  probes.push(await probeExternalEditor());
  probes.push(await proveCompactRoundTrip(evidenceDir));
  probes.push(await proveWorktreeFileOpen(evidenceDir));
  probes.push(probeStateSources());

  const versions = {
    node: process.version,
    npm: await versionOf("npm", ["--version"]),
    git: await versionOf("git", ["--version"]),
    pi: await versionOf("pi", ["--version"]),
    herdr: await versionOf("herdr", ["--version"]),
  };

  const capabilities: OperatorCapabilities = { probedAt, versions, probes, evidenceDir };
  writeFileSync(join(evidenceDir, "capabilities.json"), JSON.stringify(capabilities, null, 2));
  return capabilities;
}

export function renderCapabilityReport(capabilities: OperatorCapabilities): string {
  const lines: string[] = [];
  lines.push("MABS operator workspace — capability probe");
  lines.push(Object.entries(capabilities.versions).map(([key, value]) => `${key} ${value}`).join("  ·  "));
  lines.push("");
  for (const probe of capabilities.probes) {
    const mark = probe.status === "PASS" ? "✓" : probe.status === "FAIL" ? "✗" : "·";
    lines.push(`${mark} ${probe.id} ${probe.name}`);
    lines.push(`    ${probe.detail}`);
    lines.push(`    evidence: ${probe.evidence}`);
    if (probe.limitation) lines.push(`    limitation: ${probe.limitation}`);
  }
  lines.push("");
  lines.push(`Evidence: ${capabilities.evidenceDir}`);
  return lines.join("\n");
}
