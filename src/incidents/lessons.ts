/**
 * Bounded, scoped lesson retrieval for worker context.
 *
 * Only incidents observed in this project, relevant to the attempt's purpose,
 * and carrying a hypothesis or a verified cause are eligible. Every lesson is
 * labeled with its confidence, so a hypothesis is never presented as a proven
 * remedy. Superseded lessons are never retrieved.
 */
import type { Records, Task } from "../store/records.ts";
import type { Incident } from "./types.ts";

export const LESSON_LIMIT = 3;

export interface RetrievedLesson {
  incidentId: string;
  confidence: Incident["confidence"];
  /** "verified" only when a confirmed cause has fix and test references. */
  status: "verified" | "hypothesis";
  text: string;
}

const RELEVANT: Record<"implementation" | "repair" | "review", readonly string[]> = {
  implementation: ["environment", "host_runtime", "worker_contract"],
  repair: ["environment", "host_runtime", "worker_contract"],
  review: ["environment", "worker_contract"],
};

export function lessonsForTask(records: Records, task: Task, purpose: "implementation" | "repair" | "review", limit = LESSON_LIMIT): RetrievedLesson[] {
  const candidates = records.listIncidents({ projectId: task.projectId })
    .filter((incident) => incident.lifecycle !== "superseded" && RELEVANT[purpose].includes(incident.category))
    .filter((incident) => (incident.confidence === "verified" && incident.confirmedCause) || incident.hypothesis)
    .map((incident) => ({ incident, occurrences: records.incidentOccurrences(incident.id).length }))
    .sort((left, right) =>
      Number(right.incident.confidence === "verified") - Number(left.incident.confidence === "verified") ||
      right.occurrences - left.occurrences ||
      left.incident.id.localeCompare(right.incident.id));
  return candidates.slice(0, Math.max(0, limit)).map(({ incident, occurrences }) => {
    const verified = incident.confidence === "verified" && Boolean(incident.confirmedCause);
    return {
      incidentId: incident.id,
      confidence: incident.confidence,
      status: verified ? "verified" : "hypothesis",
      text: verified
        ? `[verified] ${incident.symptom} — cause: ${incident.confirmedCause} (fix: ${incident.fixRefs.join(", ")}; ${occurrences} occurrence(s))`
        : `[hypothesis, ${incident.confidence} confidence, unverified] ${incident.symptom} — ${incident.hypothesis} (${occurrences} occurrence(s))`,
    };
  });
}
