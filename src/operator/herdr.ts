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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { exec } from "../core/exec.ts";
import { stateDir } from "../core/paths.ts";
import { readPreferences, setOwnedSurface, updatePreferences, type OwnedSurface } from "./preferences.ts";
import { readViewerState } from "./viewer.ts";
import { requestToolView, type ToolViewSelection } from "./workspace/tool-view.ts";

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

export type ScopedToolSurface = "tasks" | "logs";

interface ScopedToolOwner {
  paneId: string;
  tabId: string;
  workspaceId: string;
  scopeKey: string;
  command: string;
}

interface ScopedToolOwnership {
  version: 2;
  workspaces: Record<string, {
    surfaces: Partial<Record<ScopedToolSurface, ScopedToolOwner>>;
  }>;
}

function scopedToolOwnershipPath(): string {
  return join(stateDir(), "operator", "launcher-tabs.json");
}

function readScopedToolOwnership(): ScopedToolOwnership {
  const path = scopedToolOwnershipPath();
  if (!existsSync(path)) return { version: 2, workspaces: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value && typeof value === "object" && (value as Partial<ScopedToolOwnership>).version === 2) {
      const rawWorkspaces = (value as Partial<ScopedToolOwnership>).workspaces;
      const normalized: ScopedToolOwnership = { version: 2, workspaces: {} };
      if (rawWorkspaces && typeof rawWorkspaces === "object" && !Array.isArray(rawWorkspaces)) {
        for (const [workspaceId, rawWorkspace] of Object.entries(rawWorkspaces)) {
          if (!rawWorkspace || typeof rawWorkspace !== "object") continue;
          const rawSurfaces = (rawWorkspace as { surfaces?: unknown }).surfaces;
          if (!rawSurfaces || typeof rawSurfaces !== "object" || Array.isArray(rawSurfaces)) continue;
          const surfaces: Partial<Record<ScopedToolSurface, ScopedToolOwner>> = {};
          for (const surface of ["tasks", "logs"] as const) {
            const owner = (rawSurfaces as Partial<Record<ScopedToolSurface, Partial<ScopedToolOwner>>>)[surface];
            if (!owner || owner.workspaceId !== workspaceId || typeof owner.paneId !== "string"
              || typeof owner.tabId !== "string" || typeof owner.scopeKey !== "string" || typeof owner.command !== "string") continue;
            surfaces[surface] = owner as ScopedToolOwner;
          }
          normalized.workspaces[workspaceId] = { surfaces };
        }
      }
      return normalized;
    }
    // Version 1 stored one global owner per surface. Migrate only entries that
    // carry both exact IDs; anything ambiguous is safer to forget than adopt.
    const legacy = value as { version?: number; surfaces?: Partial<Record<ScopedToolSurface, Partial<ScopedToolOwner>>> };
    const migrated: ScopedToolOwnership = { version: 2, workspaces: {} };
    if (legacy.version === 1 && legacy.surfaces) {
      for (const surface of ["tasks", "logs"] as const) {
        const owner = legacy.surfaces[surface];
        if (!owner || typeof owner.workspaceId !== "string" || typeof owner.paneId !== "string"
          || typeof owner.tabId !== "string" || typeof owner.scopeKey !== "string" || typeof owner.command !== "string") continue;
        const workspace = migrated.workspaces[owner.workspaceId] ?? { surfaces: {} };
        workspace.surfaces[surface] = owner as ScopedToolOwner;
        migrated.workspaces[owner.workspaceId] = workspace;
      }
    }
    return migrated;
  } catch {
    return { version: 2, workspaces: {} };
  }
}

function writeScopedToolOwnership(value: ScopedToolOwnership): void {
  const path = scopedToolOwnershipPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

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

export interface OpenScopedToolTabOptions {
  surface: ScopedToolSurface;
  /** Stable IDs only (for example `project:prj_…` or `task:tsk_…`). */
  scopeKey: string;
  repoPath: string;
  /** Fixed command that serves this tab. It must not contain project/task scope. */
  command: string;
  selection: ToolViewSelection;
  cliAlternative: string;
  session?: HerdrSession;
}

export interface ScopedToolTabResult {
  surface: ScopedToolSurface;
  action: "created" | "reused" | "degraded";
  paneId: string | null;
  tabId: string | null;
  reason: string;
  cliAlternative: string;
}

function supportsScopedToolTabs(session: HerdrSession): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(session.version ?? "");
  if (!match) return false;
  const version = match.slice(1).map(Number) as [number, number, number];
  const minimum: [number, number, number] = [0, 9, 1];
  return version[0] > minimum[0]
    || (version[0] === minimum[0] && version[1] > minimum[1])
    || (version[0] === minimum[0] && version[1] === minimum[1] && version[2] >= minimum[2]);
}

function degradedScopedToolResult(options: OpenScopedToolTabOptions, reason: string): ScopedToolTabResult {
  return {
    surface: options.surface,
    action: "degraded",
    paneId: null,
    tabId: null,
    reason: `${reason} Run ${options.cliAlternative}`,
    cliAlternative: options.cliAlternative,
  };
}

async function focusScopedToolTab(tabId: string, options: OpenScopedToolTabOptions): Promise<void> {
  try {
    // A scoped tool owns the whole tab, so focusing its stable tab ID is exact.
    // `pane focus` is directional and cannot select a pane by ID.
    await herdrRun(["tab", "focus", tabId]);
  } catch (error) {
    throw new HerdrError(
      `Could not focus the MABS ${options.surface} tab ${tabId}: ` +
      `${error instanceof Error ? error.message : String(error)}. Run ${options.cliAlternative}`,
    );
  }
}

async function discardCreatedPane(paneId: string): Promise<string> {
  try {
    await herdrRun(["pane", "close", paneId]);
    return `The incomplete pane ${paneId} was closed.`;
  } catch (error) {
    return `The incomplete pane ${paneId} could not be closed: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

/**
 * Open one explicitly scoped Tasks or Logs tab.
 *
 * Ownership is proved by exact workspace, tab, and pane IDs. Its selection may
 * change only through the scoped control channel; other tabs are never adopted
 * or overwritten, even when their labels happen to match.
 */
export async function openScopedToolTab(options: OpenScopedToolTabOptions): Promise<ScopedToolTabResult> {
  const session = options.session ?? await herdrSession();
  if (!session.available || !session.inSession || !session.workspaceId) {
    return degradedScopedToolResult(options, session.reason ?? "Herdr session context is unavailable.");
  }
  if (!supportsScopedToolTabs(session)) {
    return degradedScopedToolResult(
      options,
      `Herdr ${session.version ?? "with an unknown version"} is not supported by the popup adapter; Herdr 0.9.1 or newer is required.`,
    );
  }

  const ownership = readScopedToolOwnership();
  const workspaceOwners = ownership.workspaces[session.workspaceId] ?? { surfaces: {} };
  const saved = workspaceOwners.surfaces[options.surface];
  if (saved && saved.workspaceId === session.workspaceId && saved.command === options.command) {
    const pane = await getPane(saved.paneId);
    // Both IDs must still match. A moved pane can remain in the same workspace
    // under a different tab; it is no longer this owned full-tab surface.
    if (pane?.workspaceId === session.workspaceId && pane.tabId === saved.tabId) {
      try {
        requestToolView(session.workspaceId, options.surface, options.selection);
        saved.scopeKey = options.scopeKey;
        workspaceOwners.surfaces[options.surface] = saved;
        ownership.workspaces[session.workspaceId] = workspaceOwners;
        writeScopedToolOwnership(ownership);
      } catch (error) {
        return degradedScopedToolResult(
          options,
          `Could not update the workspace-scoped ${options.surface} view: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      await focusScopedToolTab(saved.tabId, options);
      return {
        surface: options.surface,
        action: "reused",
        paneId: pane.paneId,
        tabId: saved.tabId,
        reason: `Focused the verified MABS ${options.surface} tab for ${options.scopeKey}; its command was not restarted.`,
        cliAlternative: options.cliAlternative,
      };
    }
  }

  // A missing, moved, or otherwise stale owner is never adopted or closed.
  // This explicit open action creates a replacement and overwrites only our
  // ownership record after the replacement is fully running.
  try {
    requestToolView(session.workspaceId, options.surface, options.selection);
  } catch (error) {
    return degradedScopedToolResult(
      options,
      `Could not initialize the workspace-scoped ${options.surface} view: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  let created: { paneId: string; tabId: string | null };
  try {
    created = await createTab(session, options.repoPath, options.surface);
  } catch (error) {
    return degradedScopedToolResult(
      options,
      `Herdr could not create the ${options.surface} tab: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!created.tabId) {
    const cleanup = await discardCreatedPane(created.paneId);
    return degradedScopedToolResult(
      options,
      `Herdr created pane ${created.paneId} without returning a tab ID, so MABS cannot safely refocus it. ${cleanup}`,
    );
  }
  try {
    await herdrRun(["pane", "run", created.paneId, options.command]);
  } catch (error) {
    const cleanup = await discardCreatedPane(created.paneId);
    return degradedScopedToolResult(
      options,
      `Created ${options.surface} pane ${created.paneId}, but could not start it: ` +
      `${error instanceof Error ? error.message : String(error)}. ${cleanup}`,
    );
  }
  workspaceOwners.surfaces[options.surface] = {
    paneId: created.paneId,
    tabId: created.tabId,
    workspaceId: session.workspaceId,
    scopeKey: options.scopeKey,
    command: options.command,
  };
  ownership.workspaces[session.workspaceId] = workspaceOwners;
  try {
    writeScopedToolOwnership(ownership);
  } catch (error) {
    const cleanup = await discardCreatedPane(created.paneId);
    return degradedScopedToolResult(
      options,
      `Could not record ownership for ${options.surface} pane ${created.paneId}: ` +
      `${error instanceof Error ? error.message : String(error)}. ${cleanup}`,
    );
  }
  await focusScopedToolTab(created.tabId, options);
  return {
    surface: options.surface,
    action: "created",
    paneId: created.paneId,
    tabId: created.tabId,
    reason: `Created and focused a MABS ${options.surface} tab for ${options.scopeKey}.`,
    cliAlternative: options.cliAlternative,
  };
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
