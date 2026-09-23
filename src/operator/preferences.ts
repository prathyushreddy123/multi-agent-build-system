/**
 * Operator workspace preferences.
 *
 * These are presentation and workspace-identity settings, deliberately kept out
 * of the SQLite task store: nothing here may influence scheduling, task state,
 * review policy, or approvals. Deleting this file loses a display preference
 * and nothing else.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "../core/paths.ts";

export const PREFERENCES_VERSION = 1;

export type ViewerChoice = "auto" | "nvim" | "vim" | "less";
export type ExternalEditor = "none" | "code" | "cursor";

export interface OwnedSurface {
  /** Herdr pane ID, as returned by the socket API. */
  paneId: string;
  tabId: string | null;
  /** Display label only. Never used as proof of ownership. */
  label: string;
  createdAt: string;
}

export interface WorkspacePreferences {
  /** Herdr workspace ID that owns these surfaces. */
  workspaceId: string | null;
  /** Repository the surfaces were opened for. */
  repoPath: string | null;
  layout: "tabs" | "split";
  surfaces: Partial<Record<"agent" | "code" | "tasks" | "logs", OwnedSurface>>;
}

export interface OperatorPreferences {
  version: number;
  /** Show full tool output instead of compact summaries. */
  verbose: boolean;
  viewer: ViewerChoice;
  externalEditor: ExternalEditor;
  /** Operator surfaces are disabled until explicitly enabled per feature. */
  enabled: boolean;
  workspace: WorkspacePreferences;
  updatedAt: string | null;
}

export const DEFAULT_PREFERENCES: OperatorPreferences = {
  version: PREFERENCES_VERSION,
  verbose: false,
  viewer: "auto",
  externalEditor: "none",
  enabled: true,
  workspace: { workspaceId: null, repoPath: null, layout: "tabs", surfaces: {} },
  updatedAt: null,
};

export function preferencesPath(): string {
  return process.env.MABS_OPERATOR_CONFIG ?? join(stateDir(), "operator", "preferences.json");
}

function coerce(raw: unknown): OperatorPreferences {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_PREFERENCES };
  const value = raw as Partial<OperatorPreferences>;
  const workspace = (typeof value.workspace === "object" && value.workspace !== null ? value.workspace : {}) as Partial<WorkspacePreferences>;
  const surfaces: WorkspacePreferences["surfaces"] = {};
  for (const key of ["agent", "code", "tasks", "logs"] as const) {
    const surface = workspace.surfaces?.[key];
    if (surface && typeof surface.paneId === "string" && surface.paneId.length > 0) {
      surfaces[key] = {
        paneId: surface.paneId,
        tabId: typeof surface.tabId === "string" ? surface.tabId : null,
        label: typeof surface.label === "string" ? surface.label : key,
        createdAt: typeof surface.createdAt === "string" ? surface.createdAt : new Date(0).toISOString(),
      };
    }
  }
  return {
    version: PREFERENCES_VERSION,
    verbose: value.verbose === true,
    viewer: (["auto", "nvim", "vim", "less"] as ViewerChoice[]).includes(value.viewer as ViewerChoice) ? (value.viewer as ViewerChoice) : "auto",
    externalEditor: (["none", "code", "cursor"] as ExternalEditor[]).includes(value.externalEditor as ExternalEditor) ? (value.externalEditor as ExternalEditor) : "none",
    enabled: value.enabled !== false,
    workspace: {
      workspaceId: typeof workspace.workspaceId === "string" ? workspace.workspaceId : null,
      repoPath: typeof workspace.repoPath === "string" ? workspace.repoPath : null,
      layout: workspace.layout === "split" ? "split" : "tabs",
      surfaces,
    },
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

/** Read preferences. A missing or unreadable file yields defaults, never an error. */
export function readPreferences(): OperatorPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) return { ...DEFAULT_PREFERENCES };
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Apply a patch and persist it atomically. Returns the stored result. */
export function updatePreferences(patch: Partial<OperatorPreferences>): OperatorPreferences {
  const current = readPreferences();
  const next = coerce({
    ...current,
    ...patch,
    workspace: { ...current.workspace, ...(patch.workspace ?? {}) },
    updatedAt: new Date().toISOString(),
  });
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return next;
}

/** Record or forget one owned surface without disturbing the others. */
export function setOwnedSurface(
  key: "agent" | "code" | "tasks" | "logs",
  surface: OwnedSurface | null,
): OperatorPreferences {
  const current = readPreferences();
  const surfaces = { ...current.workspace.surfaces };
  if (surface) surfaces[key] = surface;
  else delete surfaces[key];
  return updatePreferences({ workspace: { ...current.workspace, surfaces } });
}
