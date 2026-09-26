-- Schema 15: durable governance, execution continuation, and projections.
-- This migration is deliberately structural only. It does not classify legacy
-- projects, create execution episodes, or rewrite historical evidence.
--
-- This file holds the new objects. The additive columns on pre-existing tables,
-- and the two indexes over them, live in the schema-15 entry of MIGRATIONS in
-- `../db.ts`, because SQLite has no `ADD COLUMN IF NOT EXISTS` and they must be
-- applied through a presence check. Every statement here is likewise written so
-- that re-applying the migration converges instead of failing.

CREATE TABLE IF NOT EXISTS project_policy_decisions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
  brief_id         TEXT REFERENCES product_briefs(id) ON DELETE CASCADE,
  expected_version INTEGER NOT NULL,
  project_type     TEXT NOT NULL CHECK(project_type IN ('personal', 'client', 'other')),
  review_choice    TEXT NOT NULL CHECK(review_choice IN ('off', 'risk', 'required')),
  resolved_policy  TEXT NOT NULL,
  actor            TEXT NOT NULL,
  source           TEXT NOT NULL,
  source_ref       TEXT,
  created_at       TEXT NOT NULL,
  CHECK ((project_id IS NOT NULL AND brief_id IS NULL) OR
         (project_id IS NULL AND brief_id IS NOT NULL)),
  UNIQUE(project_id, expected_version),
  UNIQUE(brief_id, expected_version)
);

CREATE TABLE IF NOT EXISTS execution_episodes (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  episode_number        INTEGER NOT NULL CHECK(episode_number > 0),
  authorizing_decision  TEXT REFERENCES project_policy_decisions(id),
  status                TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed', 'cancelled')),
  repair_limit          INTEGER NOT NULL CHECK(repair_limit >= 0),
  repairs_consumed      INTEGER NOT NULL DEFAULT 0 CHECK(repairs_consumed >= 0),
  recovery_limit        INTEGER NOT NULL CHECK(recovery_limit >= 0),
  recoveries_consumed   INTEGER NOT NULL DEFAULT 0 CHECK(recoveries_consumed >= 0),
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  UNIQUE(task_id, episode_number)
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  episode_id              TEXT NOT NULL REFERENCES execution_episodes(id) ON DELETE CASCADE,
  stage                   TEXT NOT NULL CHECK(stage IN ('prepare_workspace', 'preflight', 'implement', 'finalize', 'check', 'review', 'repair', 'accept')),
  ordinal                 INTEGER NOT NULL CHECK(ordinal > 0),
  state                   TEXT NOT NULL CHECK(state IN ('ready', 'reserved', 'launching', 'running', 'succeeded', 'failed', 'waiting', 'cancelled', 'unknown')),
  attempt_id              TEXT REFERENCES attempts(id) ON DELETE SET NULL,
  gate_id                 TEXT REFERENCES gate_results(id) ON DELETE SET NULL,
  launch_key              TEXT NOT NULL UNIQUE,
  input_fingerprint       TEXT NOT NULL,
  revision                TEXT,
  environment_fingerprint TEXT,
  engine_revision         TEXT NOT NULL,
  fencing_token           TEXT NOT NULL UNIQUE,
  reserved_at             TEXT NOT NULL,
  started_at              TEXT,
  last_progress_at        TEXT,
  finished_at             TEXT,
  failure_class           TEXT,
  failure_detail          TEXT,
  UNIQUE(episode_id, stage, ordinal),
  UNIQUE(attempt_id),
  UNIQUE(gate_id)
);

CREATE INDEX IF NOT EXISTS stage_runs_by_task ON stage_runs(task_id, reserved_at);
CREATE INDEX IF NOT EXISTS stage_runs_active ON stage_runs(state) WHERE state IN ('reserved', 'launching', 'running', 'waiting', 'unknown');

CREATE TABLE IF NOT EXISTS task_obligations (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK(kind IN ('code_defect', 'gate_failure', 'requirement_evidence', 'decision_needed', 'advisory')),
  severity              TEXT NOT NULL,
  blocking              INTEGER NOT NULL CHECK(blocking IN (0, 1)),
  source_review_id      TEXT REFERENCES review_results(id) ON DELETE SET NULL,
  source_gate_id        TEXT REFERENCES gate_results(id) ON DELETE SET NULL,
  source_decision_id    TEXT REFERENCES project_policy_decisions(id) ON DELETE SET NULL,
  source_key            TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK(state IN ('open', 'addressed_pending_validation', 'resolved', 'superseded', 'withdrawn')),
  summary               TEXT NOT NULL,
  introduced_revision   TEXT,
  resolved_revision     TEXT,
  evidence_refs         TEXT NOT NULL DEFAULT '[]',
  resolution_evidence   TEXT NOT NULL DEFAULT '[]',
  clarification_id      TEXT REFERENCES clarification_items(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(task_id, source_key)
);

CREATE INDEX IF NOT EXISTS task_obligations_open ON task_obligations(task_id, state, blocking);

CREATE TABLE IF NOT EXISTS attempt_usage (
  attempt_id          TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  normalizer_version  TEXT NOT NULL,
  normalized          TEXT NOT NULL,
  source_artifact_hash TEXT NOT NULL,
  source_offset       INTEGER,
  coverage            TEXT NOT NULL CHECK(coverage IN ('complete', 'partial', 'missing', 'malformed')),
  source_semantics    TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY(attempt_id, normalizer_version)
);

CREATE TABLE IF NOT EXISTS environment_checks (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_run_id          TEXT REFERENCES stage_runs(id) ON DELETE SET NULL,
  component             TEXT NOT NULL,
  profile               TEXT NOT NULL,
  revision              TEXT,
  runtime_fingerprint   TEXT,
  lockfile_fingerprint  TEXT,
  outcome               TEXT NOT NULL CHECK(outcome IN ('ready', 'missing', 'mismatch', 'error')),
  evidence_refs         TEXT NOT NULL DEFAULT '[]',
  setup_action_required TEXT,
  checked_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_leases (
  id             TEXT PRIMARY KEY,
  stage_run_id   TEXT NOT NULL UNIQUE REFERENCES stage_runs(id) ON DELETE CASCADE,
  controller_id  TEXT NOT NULL,
  fencing_token  TEXT NOT NULL UNIQUE,
  provider       TEXT,
  quota_domain   TEXT,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resources      TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'released', 'expired', 'cancelled')),
  granted_at     TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT
);

CREATE INDEX IF NOT EXISTS admission_leases_active ON admission_leases(status, provider, project_id);

CREATE TABLE IF NOT EXISTS incidents (
  id                     TEXT PRIMARY KEY,
  signature              TEXT NOT NULL,
  classifier_version     TEXT NOT NULL,
  category               TEXT NOT NULL,
  layer                  TEXT NOT NULL,
  symptom                TEXT NOT NULL,
  hypothesis             TEXT,
  confirmed_cause        TEXT,
  confidence             TEXT NOT NULL CHECK(confidence IN ('unknown', 'low', 'medium', 'high', 'verified')),
  lifecycle              TEXT NOT NULL CHECK(lifecycle IN ('open', 'investigating', 'mitigated', 'resolved', 'superseded')),
  affected_version_start TEXT,
  affected_version_end   TEXT,
  lesson_refs            TEXT NOT NULL DEFAULT '[]',
  fix_refs               TEXT NOT NULL DEFAULT '[]',
  test_refs              TEXT NOT NULL DEFAULT '[]',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE(signature, classifier_version)
);

CREATE TABLE IF NOT EXISTS incident_occurrences (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  source_key   TEXT NOT NULL,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE SET NULL,
  attempt_id   TEXT REFERENCES attempts(id) ON DELETE SET NULL,
  revision     TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  observed_at  TEXT NOT NULL,
  UNIQUE(incident_id, source_key)
);

CREATE TABLE IF NOT EXISTS task_requirement_ownership (
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requirement_id  TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY(task_id, requirement_id, mapping_version)
);

CREATE TABLE IF NOT EXISTS projection_cursors (
  projection       TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  cursor           TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY(projection, projection_version, source_key)
);
