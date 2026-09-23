/**
 * Phase 2 — link encoding and dispatch.
 *
 * Phase 0 found that the installed Herdr exposes no link-handler registration,
 * so a clicked hyperlink cannot be routed back into MABS. OSC-8 sequences are
 * still emitted for terminals that do handle them, but they are never the only
 * route: the picker, the slash command, and the CLI are the deterministic ones.
 *
 * A link therefore has to survive being copied into any of those, which is why
 * it encodes the whole selection rather than a bare path.
 */

export const LINK_SCHEME = "mabs";

export interface OpenTarget {
  projectId: string;
  taskId: string;
  attemptId: string | null;
  /** Repository-relative path inside the task worktree. */
  path: string;
  line: number | null;
  revision: string | null;
  /** What the link opens. */
  action: "open" | "diff";
}

export class LinkError extends Error {}

function requireField(value: string | null | undefined, name: string): string {
  if (!value || value.trim() === "") throw new LinkError(`A ${name} is required`);
  return value.trim();
}

/** Build `mabs://open/<project>/<task>?...`. Every component is percent-encoded. */
export function encodeOpenTarget(target: OpenTarget): string {
  const project = encodeURIComponent(requireField(target.projectId, "project"));
  const task = encodeURIComponent(requireField(target.taskId, "task"));
  const query = new URLSearchParams();
  query.set("path", requireField(target.path, "path"));
  if (target.attemptId) query.set("attempt", target.attemptId);
  if (target.line !== null && target.line !== undefined) query.set("line", String(target.line));
  if (target.revision) query.set("revision", target.revision);
  return `${LINK_SCHEME}://${target.action}/${project}/${task}?${query.toString()}`;
}

/**
 * Parse a MABS link.
 *
 * Any other scheme is rejected rather than coerced: an operator surface must
 * not be persuadable into opening an http, file, or ssh target.
 */
export function parseOpenTarget(value: string): OpenTarget {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkError(`${value} is not a MABS link`);
  }
  if (url.protocol !== `${LINK_SCHEME}:`) {
    throw new LinkError(`Refusing ${url.protocol}//: only ${LINK_SCHEME}:// links are dispatched`);
  }
  const action = url.hostname;
  if (action !== "open" && action !== "diff") {
    throw new LinkError(`Unknown MABS link action ${action || "(none)"}`);
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "").map((segment) => decodeURIComponent(segment));
  const projectId = requireField(segments[0], "project");
  const taskId = requireField(segments[1], "task");
  const path = requireField(url.searchParams.get("path"), "path");
  if (path.includes("\0")) throw new LinkError("A link path may not contain a null byte");

  const rawLine = url.searchParams.get("line");
  let line: number | null = null;
  if (rawLine !== null) {
    line = Number(rawLine);
    if (!Number.isSafeInteger(line) || line < 1) throw new LinkError(`${rawLine} is not a valid line number`);
  }

  return {
    action,
    projectId,
    taskId,
    attemptId: url.searchParams.get("attempt"),
    path,
    line,
    revision: url.searchParams.get("revision"),
  };
}

/**
 * Wrap text in an OSC-8 hyperlink.
 *
 * Terminals that do not support OSC-8 print the label unchanged, and Herdr
 * 0.9.1 does not dispatch the activation at all, so callers must always offer
 * the same target through a command as well.
 */
export function osc8(label: string, target: string): string {
  // Control characters in the label would break the sequence and could be used
  // to spoof surrounding output.
  const safeLabel = label.replace(/[\u0000-\u001f\u007f]/g, " ");
  return `\u001b]8;;${target}\u001b\\${safeLabel}\u001b]8;;\u001b\\`;
}

/** The equivalent deterministic command for a link, shown next to it. */
export function commandFor(target: OpenTarget): string {
  const parts = [
    target.action === "diff" ? "diff" : "open",
    target.taskId,
    target.path,
  ];
  if (target.attemptId) parts.push(`--attempt=${target.attemptId}`);
  if (target.line !== null) parts.push(`--line=${String(target.line)}`);
  if (target.revision) parts.push(`--revision=${target.revision}`);
  return `node src/cli.ts ${parts.join(" ")}`;
}
