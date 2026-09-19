import { randomBytes, randomUUID } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U.

/**
 * Time-sortable identifier: 10 chars of millisecond timestamp followed by 16
 * chars of randomness. IDs from the same millisecond have no causal ordering;
 * SQLite row order or explicit attempt numbers are used where that matters.
 */
export function newId(prefix: string): string {
  let time = Date.now();
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    timeChars.unshift(ALPHABET[time % 32] as string);
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let randomChars = "";
  for (const byte of random) randomChars += ALPHABET[byte % 32] as string;
  return `${prefix}_${timeChars.join("")}${randomChars}`;
}

export const ids = {
  project: () => newId("prj"),
  task: () => newId("tsk"),
  attempt: () => newId("att"),
  event: () => newId("evt"),
  gate: () => newId("gat"),
  approval: () => newId("apr"),
  launch: () => newId("lnc"),
  config: () => newId("cfg"),
  packet: () => newId("pkt"),
  plan: () => newId("pln"),
  review: () => newId("rev"),
  feedback: () => newId("fbk"),
  proposal: () => newId("prp"),
  evaluation: () => newId("evl"),
  activation: () => newId("act"),
  checkpoint: () => newId("chk"),
  experiment: () => newId("exp"),
  measurement: () => newId("mea"),
  brief: () => newId("brf"),
  clarification: () => newId("clr"),
  proposalVersion: () => newId("prv"),
  acceptance: () => newId("acc"),
  bootstrap: () => newId("bst"),
  conversation: () => newId("cnv"),
};

/** RFC 4122 v4 UUID, required by harnesses that accept an explicit session id. */
export function uuid(): string {
  return randomUUID();
}
