/**
 * Standing delivery preference: a person's durable instruction for how
 * careful new projects should be, applied with provenance.
 *
 * It fills only a missing review choice, only for a project type the person
 * named as eligible, and only once that type is explicitly known. Client
 * projects always require review and are never eligible; an existing decision
 * always wins; nothing is inferred from names. The decision it records is an
 * ordinary governance decision whose source names this preference, so the
 * proposal fingerprint covers it exactly like a typed-in choice.
 */
import { ids } from "../core/ids.ts";
import {
  DELIVERY_MODE_REVIEW, DELIVERY_MODES, PROJECT_TYPES,
  type DeliveryMode, type ProjectPolicyDecision, type ProjectType,
} from "../domain/project-policy.ts";
import { nowIso } from "../store/db.ts";
import type { Records } from "../store/records.ts";

export interface DeliveryPreference {
  id: string;
  mode: DeliveryMode;
  projectTypes: ProjectType[];
  setBy: string;
  reason: string;
  createdAt: string;
}

export const STANDING_PREFERENCE_SOURCE = "standing-preference";
const NON_PEOPLE = new Set(["agent", "assistant", "model", "system", "pi", "pi-conversation", "curator", "optimizer", "controller", "local-cli"]);

function toPreference(row: Record<string, unknown>): DeliveryPreference {
  const value = JSON.parse(String(row.value)) as { mode: DeliveryMode; projectTypes: ProjectType[] };
  return {
    id: String(row.id), mode: value.mode, projectTypes: value.projectTypes,
    setBy: String(row.set_by), reason: String(row.reason), createdAt: String(row.created_at),
  };
}

export function deliveryPreference(records: Records): DeliveryPreference | null {
  const row = records.store.get("SELECT * FROM standing_preferences WHERE key = 'delivery' AND active = 1");
  return row ? toPreference(row) : null;
}

export function deliveryPreferenceHistory(records: Records): (DeliveryPreference & { active: boolean; supersededAt: string | null })[] {
  return records.store.all("SELECT * FROM standing_preferences WHERE key = 'delivery' ORDER BY created_at")
    .map((row) => ({ ...toPreference(row), active: Number(row.active) === 1, supersededAt: (row.superseded_at as string) ?? null }));
}

/** Only a named person may set or clear the standing preference. */
function requirePerson(setBy: string): string {
  const person = setBy?.trim();
  if (!person || NON_PEOPLE.has(person.toLowerCase())) {
    throw new Error("A standing preference must be set by the person it speaks for; an agent cannot set it.");
  }
  return person;
}

export function setDeliveryPreference(records: Records, input: {
  mode: string;
  projectTypes?: string[];
  setBy: string;
  reason: string;
}): DeliveryPreference {
  const setBy = requirePerson(input.setBy);
  if (!(DELIVERY_MODES as readonly string[]).includes(input.mode)) throw new Error(`Unknown delivery mode ${input.mode} (fast, standard, or verified).`);
  const projectTypes = [...new Set(input.projectTypes ?? ["personal"])];
  if (projectTypes.length === 0) throw new Error("Name at least one eligible project type.");
  for (const type of projectTypes) {
    if (!(PROJECT_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown project type ${type}.`);
    if (type === "client") throw new Error("Client projects always require independent review; they cannot take a standing delivery preference.");
  }
  if (!input.reason?.trim()) throw new Error("Say why, so the preference's provenance is clear later.");
  const id = ids.standingPreference();
  const at = nowIso();
  records.store.tx(() => {
    records.store.run("UPDATE standing_preferences SET active = 0, superseded_at = ? WHERE key = 'delivery' AND active = 1", at);
    records.store.run(
      "INSERT INTO standing_preferences(id, key, value, set_by, reason, active, created_at) VALUES(?, 'delivery', ?, ?, ?, 1, ?)",
      id, JSON.stringify({ mode: input.mode, projectTypes }), setBy, input.reason.trim(), at,
    );
    records.recordEvent({ kind: "preference.delivery_set", data: { id, mode: input.mode, projectTypes, setBy } });
  });
  return deliveryPreference(records) as DeliveryPreference;
}

export function clearDeliveryPreference(records: Records, setBy: string): void {
  const person = requirePerson(setBy);
  records.store.tx(() => {
    records.store.run("UPDATE standing_preferences SET active = 0, superseded_at = ? WHERE key = 'delivery' AND active = 1", nowIso());
    records.recordEvent({ kind: "preference.delivery_cleared", data: { clearedBy: person } });
  });
}

/**
 * Fill a missing review choice from the standing preference, when it applies.
 * Returns the recorded decision, or null when the subject is not eligible.
 */
export function applyDeliveryPreference(records: Records, subject: { briefId: string } | { projectId: string }): ProjectPolicyDecision | null {
  const preference = deliveryPreference(records);
  if (!preference) return null;
  const table = "briefId" in subject ? "product_briefs" : "projects";
  const id = "briefId" in subject ? subject.briefId : subject.projectId;
  const row = records.store.get(`SELECT project_type, review_choice, governance_version FROM ${table} WHERE id = ?`, id);
  if (!row) return null;
  const projectType = (row.project_type as ProjectType | null) ?? null;
  if (projectType === null || projectType === "client" || row.review_choice !== null) return null;
  if (!preference.projectTypes.includes(projectType)) return null;
  return records.recordProjectDecision({
    ...("briefId" in subject ? { briefId: subject.briefId } : { projectId: subject.projectId }),
    projectType,
    reviewChoice: DELIVERY_MODE_REVIEW[preference.mode],
    actor: preference.setBy,
    source: STANDING_PREFERENCE_SOURCE,
    sourceRef: preference.id,
  }, Number(row.governance_version ?? 0));
}

export interface DeliverySummary {
  mode: DeliveryMode | null;
  reviewChoice: string | null;
  /** Where the current choice came from, e.g. brief-creation or standing-preference. */
  source: string | null;
  /** Set when the choice came from a standing preference. */
  preferenceSetBy: string | null;
  /** A one-line offer to raise rigor, shown at the plan boundary without an extra turn. */
  offer: string | null;
}

/** How careful this brief's work will be, and why, for the plan the user is about to accept. */
export function deliverySummary(records: Records, brief: { projectType: string | null; reviewChoice: string | null; governanceDecisionId: string | null }): DeliverySummary {
  const decision = brief.governanceDecisionId
    ? records.store.get("SELECT source, source_ref FROM project_policy_decisions WHERE id = ?", brief.governanceDecisionId)
    : undefined;
  const source = (decision?.source as string | undefined) ?? null;
  const preference = source === STANDING_PREFERENCE_SOURCE && decision?.source_ref
    ? records.store.get("SELECT set_by FROM standing_preferences WHERE id = ?", decision.source_ref)
    : undefined;
  const mode = (Object.entries(DELIVERY_MODE_REVIEW).find(([, choice]) => choice === brief.reviewChoice)?.[0] as DeliveryMode | undefined) ?? null;
  const offer = mode === "fast" && brief.projectType !== "client"
    ? `Delivery is FAST${preference ? ` from ${String(preference.set_by)}'s standing preference` : ""}: registered checks run, no AI review. ` +
      "Say \"verified\" to add required independent review for this project; it re-fingerprints the plan."
    : null;
  return { mode, reviewChoice: brief.reviewChoice, source, preferenceSetBy: preference ? String(preference.set_by) : null, offer };
}
