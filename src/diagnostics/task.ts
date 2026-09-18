import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { stateDir } from "../core/paths.ts";
import { validateWorkerOutput } from "../domain/contract.ts";
import type { Records } from "../store/records.ts";

export interface EvidenceReference {
  kind: "worker" | "gate" | "context" | "review";
  label: string;
  path: string;
  exists: boolean;
  size: number | null;
}

function fileInfo(kind: EvidenceReference["kind"], label: string, path: string | null): EvidenceReference | null {
  if (!path) return null;
  let size: number | null = null;
  try { size = statSync(path).size; } catch { /* represented by exists=false */ }
  return { kind, label, path, exists: existsSync(path), size };
}

export function taskDiagnostics(records: Records, taskId: string) {
  const task = records.getTask(taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  const mandatory = records.listRequirements(task.projectId).filter((requirement) => requirement.mandatory).map((requirement) => requirement.id);
  const packets = records.packetsForTask(taskId);
  const context = packets.map((packet) => {
    const supplied = packet.requirement_ids as string[];
    const missingMandatory = mandatory.filter((id) => !supplied.includes(id));
    const manifestPath = (packet.manifest_path as string | null) ?? null;
    return {
      id: packet.id,
      attemptId: packet.attempt_id,
      baseRevision: packet.base_revision,
      currentBaseRevision: task.baseRevision,
      staleRevision: Boolean(
        task.baseRevision && packet.base_revision !== task.baseRevision && packet.base_revision !== task.resultRevision,
      ),
      mandatoryRequirements: mandatory,
      suppliedRequirements: supplied,
      missingMandatory,
      configVersion: packet.config_version,
      currentConfigVersion: records.getProject(task.projectId)?.configVersion ?? null,
      staleConfig: Boolean(packet.config_version && packet.config_version !== records.getProject(task.projectId)?.configVersion),
      provider: packet.provider,
      checkpointId: packet.checkpoint_id,
      tokenEstimate: packet.token_estimate,
      budgetTokens: packet.budget_tokens,
      relevantFiles: packet.file_details,
      omitted: packet.omitted,
      warnings: packet.warnings,
      manifestPath,
      manifestAvailable: Boolean(manifestPath && existsSync(manifestPath)),
    };
  });

  const attempts = records.listAttempts(taskId);
  const addressed = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.outputPath || !existsSync(attempt.outputPath)) continue;
    try {
      const validation = validateWorkerOutput(JSON.parse(readFileSync(attempt.outputPath, "utf8")) as unknown);
      for (const requirement of validation.output?.addressed_requirements ?? []) addressed.add(requirement);
    } catch { /* malformed output remains visible through attempt failure and raw evidence */ }
  }

  const checkpoints = records.checkpointsForTask(taskId);
  const findingCounts = new Map<string, number>();
  for (const checkpoint of checkpoints) for (const finding of checkpoint.findings) {
    const normalized = finding.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized) findingCounts.set(normalized, (findingCounts.get(normalized) ?? 0) + 1);
  }
  const repeatedFindings = [...findingCounts.entries()].filter(([, count]) => count > 1).map(([finding, count]) => ({ finding, count }));
  const questionCounts = new Map<string, number>();
  for (const feedback of records.listFeedback({ projectId: task.projectId })) {
    if (feedback.kind !== "question") continue;
    const normalized = feedback.body.toLowerCase().replace(/\s+/g, " ").trim();
    questionCounts.set(normalized, (questionCounts.get(normalized) ?? 0) + 1);
  }
  const repeatedQuestions = [...questionCounts.entries()].filter(([, count]) => count > 1).map(([question, count]) => ({ question, count }));
  const contextEvents = records.listEvents(taskId).filter((event) => event.kind === "context.compressed" || event.kind === "context.refetched");

  const evidence = [
    ...attempts.flatMap((attempt) => [
      fileInfo("worker", `${attempt.id} result`, attempt.outputPath),
      fileInfo("worker", `${attempt.id} transcript`, join(stateDir(), "artifacts", taskId, attempt.id, "worker.log")),
      fileInfo("worker", `${attempt.id} completion envelope`, join(stateDir(), "artifacts", taskId, attempt.id, "completion.json")),
    ]),
    ...records.gatesForTask(taskId).map((gate) => fileInfo("gate", `${gate.name} (${gate.status})`, gate.evidencePath)),
    ...packets.map((packet) => fileInfo("context", `${String(packet.id)} manifest`, (packet.manifest_path as string | null) ?? null)),
    ...records.reviewsForTask(taskId).map((review) => fileInfo("review", `${review.id} (${review.verdict})`, review.evidencePath)),
  ].filter((item): item is EvidenceReference => item !== null);

  const warnings = [
    ...context.flatMap((packet) => packet.missingMandatory.map((id) => `Context packet ${String(packet.id)} omitted mandatory requirement ${id}.`)),
    ...context.filter((packet) => packet.staleRevision).map((packet) => `Context packet ${String(packet.id)} references stale base revision ${String(packet.baseRevision)}.`),
    ...context.filter((packet) => packet.staleConfig).map((packet) => `Context packet ${String(packet.id)} references stale configuration ${String(packet.configVersion)}.`),
    ...context.filter((packet) => Number(packet.tokenEstimate) > Number(packet.budgetTokens) && packet.budgetTokens !== null)
      .map((packet) => `Context packet ${String(packet.id)} exceeds its configured context budget because mandatory records were retained.`),
    ...repeatedFindings.map((item) => `A rejected or unresolved finding recurred ${item.count} times: ${item.finding}`),
    ...repeatedQuestions.map((item) => `A project question recurred ${item.count} times: ${item.question}`),
    ...context.filter((packet) => !packet.manifestAvailable).map((packet) => `Context manifest is unavailable for packet ${String(packet.id)}.`),
    ...mandatory.filter((id) => !addressed.has(id)).map((id) => `No retained worker result reports addressing mandatory requirement ${id}.`),
    ...evidence.filter((item) => !item.exists).map((item) => `Evidence file is unavailable: ${item.path}`),
  ];

  return {
    taskId,
    revision: task.resultRevision,
    context,
    requirementCoverage: {
      mandatory,
      addressed: [...addressed].sort(),
      missing: mandatory.filter((id) => !addressed.has(id)),
    },
    checkpoints,
    continuity: {
      compressionAndRefetchEvents: contextEvents,
      repeatedFindings,
      repeatedQuestions,
    },
    evidence,
    warnings: [...new Set(warnings)],
  };
}

export function readArtifact(path: string, maxBytes = 256_000): { path: string; text: string; truncated: boolean } {
  const root = realpathSync(resolve(join(stateDir(), "artifacts")));
  const candidate = realpathSync(resolve(path));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("Artifact path is outside the MABS evidence directory");
  const metadata = statSync(candidate);
  if (!metadata.isFile()) throw new Error("Artifact path is not a regular file");
  const bytes = readFileSync(candidate);
  const truncated = bytes.byteLength > maxBytes;
  return { path: candidate, text: bytes.subarray(0, maxBytes).toString("utf8"), truncated };
}
