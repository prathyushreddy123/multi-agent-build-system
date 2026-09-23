/**
 * Phase 5 — workspace and pane integration.
 *
 * This creates only the operator surfaces that are missing, reuses the ones it
 * already owns, and leaves everything else alone. Three rules keep it safe to
 * run repeatedly:
 *
 *  - ownership is proved by the pane ID the API returned *and* by that pane
 *    still belonging to this workspace. A label is display only and is never
 *    treated as proof;
 *  - a surface command runs only in a pane this call created. A reused pane is
 *    left alone, so repeated calls cannot start duplicate watchers or viewers;
 *  - focus is preserved. Panes are created with `--no-focus` unless the user
 *    explicitly asked to focus something.
 *
 * Outside Herdr nothing fails: the plan degrades to the equivalent CLI commands.
 */
import { exec } from "../core/exec.ts";
import { readPreferences, setOwnedSurface, updatePreferences, type OwnedSurface } from "./preferences.ts";
import { readViewerState } from "./viewer.ts";

export type SurfaceName = "agent" | "code" | "tasks" | "logs";

export const SURFACES: readonly SurfaceName[] = ["agent", "code", "tasks", "logs"];

export interface HerdrSession {
  available: boolean;
  version: string | null;
  inSession: boolean;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  /** Why the workspace cannot be driven, when it cannot. */
  reason: string | null;
}

export interface PaneInfo {
  paneId: string;
  tabId: string | null;
  workspaceId: string | null;
  cwd: string | null;
  agent: string | null;
}

export class HerdrError extends Error {}

/**
 * Environment a created pane must inherit.
 *
 * A new pane starts a fresh login shell, so it does not see the caller's
 * overrides. Without these a surface would silently read a different MABS
 * store than the operator is looking at.
 */
export const INHERITED_ENV = ["MABS_STATE_DIR", "MABS_DB_PATH", "MABS_WORKTREE_ROOT", "MABS_OPERATOR_CONFIG"] as const;

export function inheritedEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return INHERITED_ENV.flatMap((key) => (env[key] ? ["--env", `${key}=${env[key] as string}`] : []));
}

/** Run a herdr command and return its raw stdout. Some commands print nothing. */
async function herdrRun(args: string[]): Promise<string> {
  const result = await exec("herdr", args, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new HerdrError(`herdr ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return result.stdout;
}

/** Run a herdr command that returns a JSON payload. */
async function herdr<T>(args: string[]): Promise<T> {
  const stdout = await herdrRun(args);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new HerdrError(`herdr ${args.join(" ")} did not return JSON`);
  }
}

export async function herdrSession(): Promise<HerdrSession> {
  const version = await exec("herdr", ["--version"], { timeoutMs: 15_000 });
  if (version.code !== 0) {
    return {
      available: false, version: null, inSession: false, workspaceId: null, tabId: null, paneId: null,
      reason: "herdr is not on PATH. The operator surfaces are available as ordinary CLI commands.",
    };
  }
  const inSession = process.env.HERDR_ENV === "1";
  return {
    available: true,
    version: version.stdout.trim().split("\n")[0] ?? null,
    inSession,
    workspaceId: process.env.HERDR_WORKSPACE_ID ?? null,
    tabId: process.env.HERDR_TAB_ID ?? null,
    paneId: process.env.HERDR_PANE_ID ?? null,
    // Driving a session we are not inside would control another client's panes.
    reason: inSession ? null : "Not running inside a Herdr pane (HERDR_ENV is not 1), so no pane is created or controlled.",
  };
}

/** Look up a pane, returning null when it no longer exists. */
export async function getPane(paneId: string): Promise<PaneInfo | null> {
  try {
    const response = await herdr<{ result?: { pane?: Record<string, unknown> } }>(["pane", "get", paneId]);
    const pane = response.result?.pane;
    if (!pane) return null;
    return {
      paneId: String(pane.pane_id ?? paneId),
      tabId: (pane.tab_id as string | undefined) ?? null,
      workspaceId: (pane.workspace_id as string | undefined) ?? null,
      cwd: (pane.cwd as string | undefined) ?? null,
      agent: (pane.agent as string | undefined) ?? null,
    };
  } catch {
    // A closed pane's ID is never reused, so a lookup failure means "gone".
    return null;
  }
}

/**
 * A saved surface is only reusable when its pane still exists and still belongs
 * to this workspace. Anything else is treated as not owned.
 */
export async function verifyOwnedSurface(
  surface: OwnedSurface | undefined,
  workspaceId: string | null,
): Promise<{ owned: boolean; pane: PaneInfo | null; reason: string | null }> {
  if (!surface) return { owned: false, pane: null, reason: "no surface recorded" };
  const pane = await getPane(surface.paneId);
  if (!pane) return { owned: false, pane: null, reason: `pane ${surface.paneId} no longer exists` };
  if (workspaceId && pane.workspaceId !== workspaceId) {
    return { owned: false, pane, reason: `pane ${surface.paneId} now belongs to workspace ${pane.workspaceId ?? "unknown"}` };
  }
  return { owned: true, pane, reason: null };
}

export type SurfaceAction = "reused" | "created" | "skipped" | "degraded";

export interface SurfaceResult {
  surface: SurfaceName;
  action: SurfaceAction;
  paneId: string | null;
  tabId: string | null;
  /** What runs there, or what to run by hand when degraded. */
  command: string | null;
  reason: string;
}

export interface WorkspaceResult {
  session: HerdrSession;
  layout: "tabs" | "split";
  workspaceId: string | null;
  repoPath: string;
  surfaces: SurfaceResult[];
  /** True when nothing was created because Herdr is unavailable. */
  degraded: boolean;
  notes: string[];
}

export interface OpenWorkspaceOptions {
  repoPath: string;
  projectId?: string | null;
  layout?: "tabs" | "split";
  /** Move focus to a surface. Off by default, so background work never steals focus. */
  focus?: SurfaceName | null;
  cliCommand?: string;
  /** Injected in tests. */
  session?: HerdrSession;
}

function surfaceCommand(surface: SurfaceName, options: OpenWorkspaceOptions): string | null {
  const cli = options.cliCommand ?? "node src/cli.ts";
  switch (surface) {
    case "agent": return null;
    case "code": return `${cli} viewer serve --surface=code`;
    case "tasks": return options.projectId ? `${cli} task watch --project=${options.projectId}` : `${cli} task watch`;
    // Logs needs a task selection, so the pane starts as a shell with the exact
    // command to run rather than following something nobody asked for.
    case "logs": return `echo 'MABS Logs surface. List evidence: ${cli} logs <task>   Follow one: ${cli} logs <task> --evidence=<id> --follow'`;
  }
}

function degradedHint(surface: SurfaceName, options: OpenWorkspaceOptions): string {
  const cli = options.cliCommand ?? "node src/cli.ts";
  switch (surface) {
    case "agent": return "Run pi in this terminal as usual.";
    case "code": return `Run \`${cli} open <task> <path>\` for one file, or \`${cli} viewer serve\` in a second terminal.`;
    case "tasks": return `Run \`${cli} task watch\` in a second terminal, or \`${cli} task watch --once\` for a single frame.`;
    case "logs": return `Run \`${cli} logs <task> --evidence=<id>\` in a second terminal.`;
  }
}

/**
 * Create or recover the operator surfaces.
 *
 * Safe to call repeatedly: existing owned surfaces are reused untouched, and
 * only missing ones are created.
 */
export async function openWorkspace(options: OpenWorkspaceOptions): Promise<WorkspaceResult> {
  const session = options.session ?? await herdrSession();
  const layout = options.layout ?? readPreferences().workspace.layout;
  const notes: string[] = [];

  if (!session.available || !session.inSession) {
    return {
      session, layout, workspaceId: null, repoPath: options.repoPath, degraded: true,
      surfaces: SURFACES.map((surface) => ({
        surface, action: "degraded", paneId: null, tabId: null,
        command: null, reason: degradedHint(surface, options),
      })),
      notes: [session.reason ?? "Herdr is unavailable.", "Every surface is still reachable as an ordinary CLI command."],
    };
  }

  const preferences = readPreferences();
  const workspaceId = session.workspaceId;
  // Surfaces recorded for a different workspace are someone else's panes.
  const savedWorkspace = preferences.workspace.workspaceId;
  if (savedWorkspace && workspaceId && savedWorkspace !== workspaceId) {
    notes.push(`Previously recorded surfaces belonged to workspace ${savedWorkspace}; they are not reused here.`);
  }
  const reusable = savedWorkspace === workspaceId ? preferences.workspace.surfaces : {};

  const results: SurfaceResult[] = [];

  for (const surface of SURFACES) {
    // The Agent surface is the caller's own pane. A live session is reused; a
    // new agent is never started.
    if (surface === "agent") {
      results.push({
        surface, action: "reused", paneId: session.paneId, tabId: session.tabId,
        command: null, reason: "This pane is the Agent surface; the live session is reused.",
      });
      if (session.paneId) {
        setOwnedSurface("agent", {
          paneId: session.paneId, tabId: session.tabId, label: "Agent", createdAt: new Date().toISOString(),
        });
      }
      continue;
    }

    const verified = await verifyOwnedSurface(reusable[surface], workspaceId);
    if (verified.owned && verified.pane) {
      // A reused pane is left alone. Re-running its command here is exactly how
      // duplicate watchers and viewer processes appear.
      const running = surface === "code" ? readViewerState("code") : null;
      results.push({
        surface, action: "reused", paneId: verified.pane.paneId, tabId: verified.pane.tabId,
        command: null,
        reason: running
          ? `Reusing pane ${verified.pane.paneId}; a viewer is already serving it (pid ${running.pid}).`
          : `Reusing pane ${verified.pane.paneId} without sending anything to it.`,
      });
      continue;
    }
    if (verified.reason && reusable[surface]) notes.push(`${surface}: ${verified.reason}`);

    let created: { paneId: string; tabId: string | null };
    try {
      created = layout === "split" && surface === "code"
        ? await splitPane(session, options.repoPath)
        : await createTab(session, options.repoPath, surface);
    } catch (error) {
      // Partial startup is reported, not hidden; already-created surfaces stay.
      results.push({
        surface, action: "skipped", paneId: null, tabId: null, command: null,
        reason: `Could not create the ${surface} surface: ${error instanceof Error ? error.message : String(error)}. ` +
          degradedHint(surface, options),
      });
      continue;
    }

    const command = surfaceCommand(surface, options);
    if (command) {
      try {
        // `pane run` succeeds with no payload, so only the exit status is read.
        await herdrRun(["pane", "run", created.paneId, command]);
      } catch (error) {
        notes.push(`${surface}: pane ${created.paneId} was created but its command did not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setOwnedSurface(surface, {
      paneId: created.paneId, tabId: created.tabId,
      label: surface.charAt(0).toUpperCase() + surface.slice(1),
      createdAt: new Date().toISOString(),
    });
    results.push({
      surface, action: "created", paneId: created.paneId, tabId: created.tabId,
      command,
      reason: command ? `Created pane ${created.paneId} running \`${command}\`.` : `Created pane ${created.paneId}.`,
    });
  }

  updatePreferences({
    workspace: {
      ...readPreferences().workspace,
      workspaceId,
      repoPath: options.repoPath,
      layout,
    },
  });

  // Focus moves only when asked for, so background work never steals it.
  if (options.focus) {
    const target = results.find((result) => result.surface === options.focus);
    if (target?.paneId) {
      try {
        await herdrRun(["pane", "focus", "--pane", target.paneId]);
        notes.push(`Focus moved to the ${options.focus} surface because it was requested.`);
      } catch {
        notes.push(`Could not focus the ${options.focus} surface; focus was left where it was.`);
      }
    }
  } else {
    notes.push("Focus was left where it was. Surfaces are created in the background.");
  }

  return { session, layout, workspaceId, repoPath: options.repoPath, surfaces: results, degraded: false, notes };
}

async function createTab(session: HerdrSession, cwd: string, surface: SurfaceName): Promise<{ paneId: string; tabId: string | null }> {
  const label = `MABS ${surface}`;
  const response = await herdr<{ result?: { tab?: Record<string, unknown>; root_pane?: Record<string, unknown> } }>([
    "tab", "create",
    ...(session.workspaceId ? ["--workspace", session.workspaceId] : []),
    "--cwd", cwd,
    "--label", label,
    ...inheritedEnvArgs(),
    "--no-focus",
  ]);
  const paneId = response.result?.root_pane?.pane_id;
  if (typeof paneId !== "string") throw new HerdrError("tab create did not return a root pane ID");
  return { paneId, tabId: (response.result?.tab?.tab_id as string | undefined) ?? null };
}

async function splitPane(session: HerdrSession, cwd: string): Promise<{ paneId: string; tabId: string | null }> {
  const response = await herdr<{ result?: { pane?: Record<string, unknown> } }>([
    "pane", "split",
    ...(session.paneId ? ["--pane", session.paneId] : ["--current"]),
    "--direction", "right",
    "--cwd", cwd,
    ...inheritedEnvArgs(),
    "--no-focus",
  ]);
  const paneId = response.result?.pane?.pane_id;
  if (typeof paneId !== "string") throw new HerdrError("pane split did not return a pane ID");
  return { paneId, tabId: (response.result?.pane?.tab_id as string | undefined) ?? null };
}

export interface WorkspaceStatus {
  session: HerdrSession;
  workspaceId: string | null;
  repoPath: string | null;
  layout: "tabs" | "split";
  surfaces: { surface: SurfaceName; paneId: string | null; owned: boolean; reason: string | null }[];
}

export async function workspaceStatus(): Promise<WorkspaceStatus> {
  const session = await herdrSession();
  const preferences = readPreferences();
  const surfaces: WorkspaceStatus["surfaces"] = [];
  for (const surface of SURFACES) {
    const saved = preferences.workspace.surfaces[surface];
    if (!session.available || !session.inSession) {
      surfaces.push({ surface, paneId: saved?.paneId ?? null, owned: false, reason: session.reason });
      continue;
    }
    const verified = await verifyOwnedSurface(saved, session.workspaceId);
    surfaces.push({ surface, paneId: saved?.paneId ?? null, owned: verified.owned, reason: verified.reason });
  }
  return {
    session,
    workspaceId: preferences.workspace.workspaceId,
    repoPath: preferences.workspace.repoPath,
    layout: preferences.workspace.layout,
    surfaces,
  };
}

export interface CloseResult {
  closed: SurfaceName[];
  kept: { surface: SurfaceName; reason: string }[];
  notes: string[];
}

/**
 * Close only the surfaces this feature created and still owns.
 *
 * The Agent pane is never closed: it is the user's session, not a resource this
 * feature created. Closing a dashboard or viewer pane ends a view; it does not
 * cancel a worker or change any task record.
 */
export async function closeWorkspace(options: { session?: HerdrSession } = {}): Promise<CloseResult> {
  const session = options.session ?? await herdrSession();
  const preferences = readPreferences();
  const closed: SurfaceName[] = [];
  const kept: { surface: SurfaceName; reason: string }[] = [];

  for (const surface of SURFACES) {
    if (surface === "agent") {
      kept.push({ surface, reason: "The Agent pane is your session; this feature did not create it and does not close it." });
      continue;
    }
    const saved = preferences.workspace.surfaces[surface];
    if (!saved) { kept.push({ surface, reason: "not owned" }); continue; }
    if (!session.available || !session.inSession) {
      kept.push({ surface, reason: session.reason ?? "Herdr is unavailable" });
      continue;
    }
    const verified = await verifyOwnedSurface(saved, session.workspaceId);
    if (!verified.owned) {
      // Forget a pane we no longer own rather than closing someone else's.
      setOwnedSurface(surface, null);
      kept.push({ surface, reason: verified.reason ?? "no longer owned" });
      continue;
    }
    try {
      await herdrRun(["pane", "close", saved.paneId]);
      setOwnedSurface(surface, null);
      closed.push(surface);
    } catch (error) {
      kept.push({ surface, reason: `close failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return {
    closed,
    kept,
    notes: [
      "Only operator-owned panes were closed. Workers, tasks, evidence, and worktrees are untouched.",
    ],
  };
}
