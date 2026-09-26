-- Schema 15: durable governance, execution continuation, and projections.
-- This migration is deliberately structural only. It does not classify legacy
-- projects, create execution episodes, or rewrite historical evidence.

ALTER TABLE projects ADD COLUMN project_type TEXT;
ALTER TABLE projects ADD COLUMN review_choice TEXT;
ALTER TABLE projects ADD COLUMN governance_decision_id TEXT;
ALTER TABLE projects ADD COLUMN governance_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE product_briefs ADD COLUMN project_type TEXT;
ALTER TABLE product_briefs ADD COLUMN review_choice TEXT;
ALTER TABLE product_briefs ADD COLUMN governance_decision_id TEXT;
ALTER TABLE product_briefs ADD COLUMN governance_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE project_policy_decisions (
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

CREATE TABLE execution_episodes (
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

CREATE TABLE stage_runs (
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

CREATE INDEX stage_runs_by_task ON stage_runs(task_id, reserved_at);
CREATE INDEX stage_runs_active ON stage_runs(state) WHERE state IN ('reserved', 'launching', 'running', 'waiting', 'unknown');

CREATE TABLE task_obligations (
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

CREATE INDEX task_obligations_open ON task_obligations(task_id, state, blocking);

ALTER TABLE attempts ADD COLUMN stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE SET NULL;
ALTER TABLE attempts ADD COLUMN parent_attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL;
ALTER TABLE attempts ADD COLUMN parent_session_id TEXT;
ALTER TABLE attempts ADD COLUMN requested_model TEXT;
ALTER TABLE attempts ADD COLUMN configured_model TEXT;
ALTER TABLE attempts ADD COLUMN reported_model TEXT;
ALTER TABLE attempts ADD COLUMN requested_effort TEXT;
ALTER TABLE attempts ADD COLUMN configured_effort TEXT;
ALTER TABLE attempts ADD COLUMN reported_effort TEXT;
ALTER TABLE attempts ADD COLUMN engine_version TEXT;
ALTER TABLE attempts ADD COLUMN cli_version TEXT;
ALTER TABLE attempts ADD COLUMN last_progress_at TEXT;
ALTER TABLE attempts ADD COLUMN usage_status TEXT;
CREATE UNIQUE INDEX attempts_by_stage_run ON attempts(stage_run_id) WHERE stage_run_id IS NOT NULL;

CREATE TABLE attempt_usage (
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

CREATE TABLE environment_checks (
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

CREATE TABLE admission_leases (
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

CREATE INDEX admission_leases_active ON admission_leases(status, provider, project_id);

CREATE TABLE incidents (
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

CREATE TABLE incident_occurrences (
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

ALTER TABLE context_packets ADD COLUMN purpose TEXT;
ALTER TABLE context_packets ADD COLUMN prompt_bytes INTEGER;
ALTER TABLE context_packets ADD COLUMN prompt_token_estimate INTEGER;
ALTER TABLE context_packets ADD COLUMN estimator_version TEXT;
ALTER TABLE context_packets ADD COLUMN section_sizes TEXT;
ALTER TABLE context_packets ADD COLUMN mandatory_count INTEGER;
ALTER TABLE context_packets ADD COLUMN optional_count INTEGER;
ALTER TABLE context_packets ADD COLUMN content_fingerprint TEXT;

ALTER TABLE routing_decisions ADD COLUMN capability_registry_version TEXT;
ALTER TABLE routing_decisions ADD COLUMN config_version TEXT;
ALTER TABLE routing_decisions ADD COLUMN requested_selection TEXT;
ALTER TABLE routing_decisions ADD COLUMN effective_selection TEXT;
ALTER TABLE routing_decisions ADD COLUMN eligibility_evidence TEXT;
ALTER TABLE routing_decisions ADD COLUMN fallback_reason TEXT;
ALTER TABLE routing_decisions ADD COLUMN escalation_reason TEXT;
ALTER TABLE routing_decisions ADD COLUMN quota_domain_id TEXT;

ALTER TABLE gate_results ADD COLUMN stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE SET NULL;
ALTER TABLE gate_results ADD COLUMN job_id TEXT;
ALTER TABLE gate_results ADD COLUMN environment_fingerprint TEXT;
ALTER TABLE gate_results ADD COLUMN command_fingerprint TEXT;
ALTER TABLE gate_results ADD COLUMN input_fingerprint TEXT;
ALTER TABLE gate_results ADD COLUMN raw_exit_status INTEGER;
ALTER TABLE gate_results ADD COLUMN raw_signal TEXT;
ALTER TABLE gate_results ADD COLUMN timed_out INTEGER;
ALTER TABLE gate_results ADD COLUMN failure_diagnosis TEXT;
CREATE UNIQUE INDEX gates_by_stage_run ON gate_results(stage_run_id) WHERE stage_run_id IS NOT NULL;

ALTER TABLE optimization_experiments ADD COLUMN protocol_version TEXT;
ALTER TABLE optimization_experiments ADD COLUMN primary_metric TEXT;
ALTER TABLE optimization_experiments ADD COLUMN tolerances TEXT;
ALTER TABLE optimization_experiments ADD COLUMN safeguards TEXT;
ALTER TABLE optimization_experiments ADD COLUMN run_authorization TEXT;
ALTER TABLE optimization_experiments ADD COLUMN source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE optimization_experiments ADD COLUMN source_stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE SET NULL;

ALTER TABLE optimization_measurements ADD COLUMN repeat_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE optimization_measurements ADD COLUMN seed TEXT;
ALTER TABLE optimization_measurements ADD COLUMN usage_coverage TEXT;

CREATE TABLE task_requirement_ownership (
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requirement_id  TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY(task_id, requirement_id, mapping_version)
);

CREATE TABLE projection_cursors (
  projection       TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  cursor           TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY(projection, projection_version, source_key)
);
