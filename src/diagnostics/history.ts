import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup } from "node:sqlite";

import { SCHEMA_VERSION, Store, type Row } from "../store/db.ts";

export const HISTORY_AUDIT_FORMAT = "mabs.execution-history-audit.v1";
export const HISTORY_USAGE_NORMALIZER = "mabs.historical-usage.v1";

const EVIDENCE_TABLES = [
  "projects",
  "tasks",
  "task_dependencies",
  "attempts",
  "gate_results",
  "review_results",
  "task_checkpoints",
] as const;

type UsageCoverage = "complete" | "partial" | "missing" | "malformed";

export interface NormalizedHistoricalUsage {
  coverage: UsageCoverage;
  sourceSemantics: "codex-input-includes-cache" | "claude-cache-is-separate" | "generic-reported";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  knownInputEvents: number | null;
  outputTokens: number | null;
  limitations: string[];
}

export interface HistoryAuditOptions {
  /** Explicit source path. There is deliberately no live-database default. */
  dbPath: string;
  /** Omit to select every task present in the explicit database. */
  taskIds?: string[];
  observedAt?: string;
}

export interface HistoricalTaskAudit {
  projectId: string;
  projectName: string;
  taskId: string;
  title: string;
  state: string;
  attempts: number;
  reviews: number;
  reviewChangeRequests: number;
  retries: number;
  gates: number;
  checkpoints: number;
}

export interface HistoricalUsageAudit {
  normalizerVersion: string;
  semantics: string;
  knownInputEvents: number;
  knownOutputTokens: number;
  attemptsWithCompleteUsage: number;
  attemptsWithPartialUsage: number;
  missingUsageAttempts: string[];
  malformedUsageAttempts: string[];
  elapsedMilliseconds: number;
  missingDurationAttempts: string[];
  invalidDurationAttempts: string[];
  byProject: Array<{
    projectId: string;
    projectName: string;
    knownInputEvents: number;
    knownOutputTokens: number;
    missingUsageAttempts: number;
    elapsedMilliseconds: number;
  }>;
}

export interface HistoryAuditReport {
  format: string;
  observedAt: string;
  source: { path: string; schemaVersion: string; access: "read-only" };
  selection: { kind: "all" | "task-ids"; taskIds: string[]; missingTaskIds: string[] };
  evidence: { tables: string[]; sha256: string };
  tasks: HistoricalTaskAudit[];
  totals: {
    tasks: number;
    attempts: number;
    reviews: number;
    reviewChangeRequests: number;
    retries: number;
    gates: number;
    gateStatuses: Record<string, number>;
    checkpoints: number;
    appliedRequestChanges: number;
    curatorProposals: number;
    optimizationExperiments: number;
  };
  usage: HistoricalUsageAudit;
  artifactGaps: Array<{
    ownerType: "attempt" | "gate" | "review";
    ownerId: string;
    status: "not-recorded" | "missing";
    path: string | null;
  }>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Normalize only provider fields whose observed semantics are documented. */
export function normalizeHistoricalUsage(adapter: string, raw: unknown): NormalizedHistoricalUsage {
  const limitations: string[] = [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw === "") parsed = null;
    else {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return {
          coverage: "malformed", sourceSemantics: "generic-reported", inputTokens: null,
          cachedInputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null,
          knownInputEvents: null, outputTokens: null, limitations: ["usage_json is not valid JSON"],
        };
      }
    }
  }
  if (parsed === null || parsed === undefined) {
    return {
      coverage: "missing", sourceSemantics: "generic-reported", inputTokens: null,
      cachedInputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null,
      knownInputEvents: null, outputTokens: null, limitations: ["no provider usage was recorded"],
    };
  }
  const envelope = record(parsed);
  if (!envelope) {
    return {
      coverage: "malformed", sourceSemantics: "generic-reported", inputTokens: null,
      cachedInputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null,
      knownInputEvents: null, outputTokens: null, limitations: ["usage_json is not an object"],
    };
  }
  const usage = record(envelope.usage) ?? envelope;
  const inputTokens = token(usage.input_tokens);
  const outputTokens = token(usage.output_tokens);
  const adapterName = adapter.toLowerCase();

  if (adapterName.includes("claude")) {
    const cacheRead = token(usage.cache_read_input_tokens);
    const cacheCreation = token(usage.cache_creation_input_tokens);
    if (inputTokens === null) limitations.push("input_tokens is absent or invalid");
    if (outputTokens === null) limitations.push("output_tokens is absent or invalid");
    if (cacheRead === null) limitations.push("cache_read_input_tokens is absent or invalid");
    if (cacheCreation === null) limitations.push("cache_creation_input_tokens is absent or invalid");
    const coverage = [inputTokens, outputTokens, cacheRead, cacheCreation].every((value) => value === null)
      ? "missing"
      : limitations.length === 0 ? "complete" : "partial";
    return {
      coverage,
      sourceSemantics: "claude-cache-is-separate",
      inputTokens,
      cachedInputTokens: null,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      knownInputEvents: inputTokens === null ? null : inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0),
      outputTokens,
      limitations,
    };
  }

  if (adapterName.includes("codex")) {
    const cached = token(usage.cached_input_tokens);
    if (inputTokens === null) limitations.push("input_tokens is absent or invalid");
    if (outputTokens === null) limitations.push("output_tokens is absent or invalid");
    return {
      coverage: inputTokens === null && outputTokens === null
        ? "missing"
        : limitations.length === 0 ? "complete" : "partial",
      sourceSemantics: "codex-input-includes-cache",
      inputTokens,
      cachedInputTokens: cached,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      // cached_input_tokens is a subset of input_tokens and is intentionally
      // not added again.
      knownInputEvents: inputTokens,
      outputTokens,
      limitations,
    };
  }

  if (inputTokens === null) limitations.push("input_tokens is absent or invalid");
  if (outputTokens === null) limitations.push("output_tokens is absent or invalid");
  return {
    coverage: inputTokens === null && outputTokens === null
      ? "missing"
      : limitations.length === 0 ? "complete" : "partial",
    sourceSemantics: "generic-reported",
    inputTokens,
    cachedInputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    knownInputEvents: inputTokens,
    outputTokens,
    limitations,
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function sortedObject(row: Row): Row {
  return Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)));
}

function rowsForDigest(store: Store, table: typeof EVIDENCE_TABLES[number], taskIds: string[]): Row[] {
  const selected = placeholders(taskIds);
  switch (table) {
    case "projects":
      return store.all(
        `SELECT p.* FROM projects p WHERE p.id IN
         (SELECT project_id FROM tasks WHERE id IN (${selected})) ORDER BY p.rowid`, ...taskIds,
      );
    case "tasks":
      return store.all(`SELECT * FROM tasks WHERE id IN (${selected}) ORDER BY rowid`, ...taskIds);
    case "task_dependencies":
      return store.all(
        `SELECT * FROM task_dependencies
         WHERE task_id IN (${selected}) OR depends_on_id IN (${selected}) ORDER BY rowid`, ...taskIds, ...taskIds,
      );
    default:
      return store.all(
        `SELECT * FROM ${table} WHERE task_id IN (${selected}) ORDER BY rowid`, ...taskIds,
      );
  }
}

function evidenceDigest(store: Store, taskIds: string[]): string {
  const hash = createHash("sha256");
  for (const table of EVIDENCE_TABLES) {
    hash.update(table);
    hash.update(JSON.stringify(rowsForDigest(store, table, taskIds).map(sortedObject)));
  }
  return hash.digest("hex");
}

function artifactGap(ownerType: "attempt" | "gate" | "review", ownerId: string, value: unknown) {
  const path = typeof value === "string" && value !== "" ? value : null;
  if (path === null) return { ownerType, ownerId, status: "not-recorded" as const, path };
  if (!existsSync(path)) return { ownerType, ownerId, status: "missing" as const, path };
  return null;
}

function countBy(rows: Row[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key]);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Read a stable evidence snapshot. The source connection is read-only and the
 * entire report is built inside one deferred read transaction.
 */
export function auditExecutionHistory(options: HistoryAuditOptions): HistoryAuditReport {
  if (!options.dbPath) throw new Error("History audit requires an explicit dbPath.");
  const sourcePath = resolve(options.dbPath);
  const store = Store.openReadOnly(sourcePath);
  store.db.exec("BEGIN");
  try {
    const schema = store.get("SELECT value FROM schema_meta WHERE key = 'schema_version'");
    if (!schema) throw new Error(`Database ${sourcePath} has no schema_version metadata.`);
    const allTasks = store.all(
      `SELECT t.id, t.project_id, t.title, t.state, t.created_at, p.name project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY t.created_at, t.id`,
    );
    const requested = options.taskIds === undefined ? null : [...new Set(options.taskIds)].sort();
    if (requested?.length === 0) throw new Error("History audit taskIds must be omitted or non-empty.");
    const allTaskIds = new Set(allTasks.map((row) => String(row.id)));
    const missingTaskIds = requested?.filter((id) => !allTaskIds.has(id)) ?? [];
    const taskIds = requested ?? allTasks.map((row) => String(row.id));
    const selectedIds = taskIds.filter((id) => allTaskIds.has(id));
    if (selectedIds.length === 0) throw new Error("History audit selection matched no tasks.");
    const selectedSet = new Set(selectedIds);
    const selectedTasks = allTasks.filter((row) => selectedSet.has(String(row.id)));
    const inTasks = placeholders(selectedIds);
    const attempts = store.all(
      `SELECT a.*, t.project_id, p.name project_name FROM attempts a
       JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
       WHERE a.task_id IN (${inTasks}) ORDER BY a.started_at, a.id`, ...selectedIds,
    );
    const reviews = store.all(
      `SELECT * FROM review_results WHERE task_id IN (${inTasks}) ORDER BY created_at, id`, ...selectedIds,
    );
    const retries = store.all(
      `SELECT * FROM events WHERE task_id IN (${inTasks}) AND kind = 'task.retry_requested' ORDER BY at, id`,
      ...selectedIds,
    );
    const gates = store.all(
      `SELECT * FROM gate_results WHERE task_id IN (${inTasks}) ORDER BY created_at, id`, ...selectedIds,
    );
    const checkpoints = store.all(
      `SELECT * FROM task_checkpoints WHERE task_id IN (${inTasks}) ORDER BY created_at, id`, ...selectedIds,
    );
    const perTask = selectedTasks.map((task): HistoricalTaskAudit => {
      const taskId = String(task.id);
      const taskReviews = reviews.filter((row) => row.task_id === taskId);
      return {
        projectId: String(task.project_id),
        projectName: String(task.project_name),
        taskId,
        title: String(task.title),
        state: String(task.state),
        attempts: attempts.filter((row) => row.task_id === taskId).length,
        reviews: taskReviews.length,
        reviewChangeRequests: taskReviews.filter((row) => row.verdict === "request_changes").length,
        retries: retries.filter((row) => row.task_id === taskId).length,
        gates: gates.filter((row) => row.task_id === taskId).length,
        checkpoints: checkpoints.filter((row) => row.task_id === taskId).length,
      };
    });

    let knownInputEvents = 0;
    let knownOutputTokens = 0;
    let complete = 0;
    let partial = 0;
    let elapsedMilliseconds = 0;
    const missingUsageAttempts: string[] = [];
    const malformedUsageAttempts: string[] = [];
    const missingDurationAttempts: string[] = [];
    const invalidDurationAttempts: string[] = [];
    const byProject = new Map<string, HistoricalUsageAudit["byProject"][number]>();
    for (const attempt of attempts) {
      const attemptId = String(attempt.id);
      const projectId = String(attempt.project_id);
      let project = byProject.get(projectId);
      if (!project) {
        project = {
          projectId, projectName: String(attempt.project_name), knownInputEvents: 0,
          knownOutputTokens: 0, missingUsageAttempts: 0, elapsedMilliseconds: 0,
        };
        byProject.set(projectId, project);
      }
      const usage = normalizeHistoricalUsage(String(attempt.adapter), attempt.usage_json);
      if (usage.coverage === "complete") complete += 1;
      else if (usage.coverage === "partial") partial += 1;
      else if (usage.coverage === "missing") {
        missingUsageAttempts.push(attemptId);
        project.missingUsageAttempts += 1;
      } else malformedUsageAttempts.push(attemptId);
      if (usage.knownInputEvents !== null) {
        knownInputEvents += usage.knownInputEvents;
        project.knownInputEvents += usage.knownInputEvents;
      }
      if (usage.outputTokens !== null) {
        knownOutputTokens += usage.outputTokens;
        project.knownOutputTokens += usage.outputTokens;
      }
      if (attempt.ended_at === null || attempt.ended_at === undefined) missingDurationAttempts.push(attemptId);
      else {
        const start = Date.parse(String(attempt.started_at));
        const end = Date.parse(String(attempt.ended_at));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) invalidDurationAttempts.push(attemptId);
        else {
          const duration = end - start;
          elapsedMilliseconds += duration;
          project.elapsedMilliseconds += duration;
        }
      }
    }

    const gaps = [
      ...attempts.map((row) => artifactGap("attempt", String(row.id), row.output_path)),
      ...gates.map((row) => artifactGap("gate", String(row.id), row.evidence_path)),
      ...reviews.map((row) => artifactGap("review", String(row.id), row.evidence_path)),
    ].filter((gap): gap is NonNullable<typeof gap> => gap !== null);
    const selectedProjects = [...new Set(selectedTasks.map((row) => String(row.project_id)))];
    const projectParams = placeholders(selectedProjects);
    const feedback = store.all(
      `SELECT * FROM feedback WHERE task_id IN (${inTasks}) AND kind = 'request_change' AND state = 'applied'`,
      ...selectedIds,
    );
    const curator = store.all(
      `SELECT id FROM curator_proposals WHERE project_id IN (${projectParams})`, ...selectedProjects,
    );
    const experiments = store.all(
      `SELECT id FROM optimization_experiments WHERE project_id IN (${projectParams})`, ...selectedProjects,
    );

    return {
      format: HISTORY_AUDIT_FORMAT,
      observedAt: options.observedAt ?? new Date().toISOString(),
      source: { path: sourcePath, schemaVersion: String(schema.value), access: "read-only" },
      selection: {
        kind: requested === null ? "all" : "task-ids",
        taskIds: selectedIds,
        missingTaskIds,
      },
      evidence: { tables: [...EVIDENCE_TABLES], sha256: evidenceDigest(store, selectedIds) },
      tasks: perTask,
      totals: {
        tasks: perTask.length,
        attempts: attempts.length,
        reviews: reviews.length,
        reviewChangeRequests: reviews.filter((row) => row.verdict === "request_changes").length,
        retries: retries.length,
        gates: gates.length,
        gateStatuses: countBy(gates, "status"),
        checkpoints: checkpoints.length,
        appliedRequestChanges: feedback.length,
        curatorProposals: curator.length,
        optimizationExperiments: experiments.length,
      },
      usage: {
        normalizerVersion: HISTORY_USAGE_NORMALIZER,
        semantics: "Known provider-reported token events; not unique tokens, cost, or subscription charges.",
        knownInputEvents,
        knownOutputTokens,
        attemptsWithCompleteUsage: complete,
        attemptsWithPartialUsage: partial,
        missingUsageAttempts,
        malformedUsageAttempts,
        elapsedMilliseconds,
        missingDurationAttempts,
        invalidDurationAttempts,
        byProject: [...byProject.values()].sort((left, right) => left.projectId.localeCompare(right.projectId)),
      },
      artifactGaps: gaps,
    };
  } finally {
    try { store.db.exec("ROLLBACK"); } finally { store.close(); }
  }
}

export interface BackupRestoreRehearsal {
  sourcePath: string;
  restoredPath: string;
  schemaVersion: string;
  sourceDigest: string;
  restoredDigest: string;
  consistent: boolean;
}

/** Create a SQLite-consistent backup and verify it from a separate path. */
export async function rehearseBackupRestore(sourcePath: string, restoredPath: string): Promise<BackupRestoreRehearsal> {
  const source = resolve(sourcePath);
  const restored = resolve(restoredPath);
  if (source === restored) throw new Error("Restore rehearsal must use a different destination path.");
  if (!existsSync(source)) throw new Error(`Backup source does not exist: ${source}`);
  if (existsSync(restored)) throw new Error(`Restore rehearsal refuses to overwrite: ${restored}`);
  if (!existsSync(dirname(restored))) throw new Error(`Restore rehearsal destination directory does not exist: ${dirname(restored)}`);

  const readOnly = Store.openReadOnly(source);
  try {
    await backup(readOnly.db, restored);
  } finally {
    readOnly.close();
  }
  const sourceReport = auditExecutionHistory({ dbPath: source });
  const restoredReport = auditExecutionHistory({ dbPath: restored });
  return {
    sourcePath: source,
    restoredPath: restored,
    schemaVersion: restoredReport.source.schemaVersion,
    sourceDigest: sourceReport.evidence.sha256,
    restoredDigest: restoredReport.evidence.sha256,
    consistent: sourceReport.source.schemaVersion === restoredReport.source.schemaVersion
      && sourceReport.evidence.sha256 === restoredReport.evidence.sha256,
  };
}

export function supportedHistorySchemaVersion(): string {
  return SCHEMA_VERSION;
}
