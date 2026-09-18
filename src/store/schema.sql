-- MABS schema v1.
--
-- SQLite is authoritative for coordination state. Large logs and transcripts
-- are files on disk; records keep the path, never the payload.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  repo_path       TEXT NOT NULL,
  base_branch     TEXT NOT NULL DEFAULT 'main',
  status          TEXT NOT NULL DEFAULT 'active',      -- active | paused | archived
  routing_profile TEXT NOT NULL DEFAULT 'default',
  approval_policy TEXT NOT NULL DEFAULT '{"overrides":{},"standing":[]}',
  review_policy   TEXT NOT NULL DEFAULT '{"mode":"substantive","skipTaskClasses":["mechanical","planning","research"]}',
  routing_overrides TEXT NOT NULL DEFAULT '{}',
  prompt_profile TEXT NOT NULL DEFAULT '{"implementationAddendum":null,"reviewAddendum":null,"researchAddendum":null}',
  controller_settings TEXT NOT NULL DEFAULT '{"defaultRepairLimit":2}',
  check_commands  TEXT NOT NULL DEFAULT '[]',
  config_version  TEXT NOT NULL,
  goal            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Requirements carry stable IDs so context packets can prove coverage.
CREATE TABLE IF NOT EXISTS requirements (
  id         TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  mandatory  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  objective           TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  role                TEXT NOT NULL DEFAULT 'implementer',
  task_class          TEXT NOT NULL DEFAULT 'small_implementation',
  complexity          TEXT NOT NULL DEFAULT 'medium',
  ambiguity           TEXT NOT NULL DEFAULT 'low',
  change_risk         TEXT NOT NULL DEFAULT 'medium',
  language            TEXT,
  domain              TEXT,
  context_size        TEXT NOT NULL DEFAULT 'medium',
  required_tools      TEXT NOT NULL DEFAULT '[]',
  allowed_scope       TEXT NOT NULL DEFAULT '[]',
  state               TEXT NOT NULL DEFAULT 'QUEUED',
  priority            INTEGER NOT NULL DEFAULT 100,
  execution_mode      TEXT NOT NULL DEFAULT 'single',   -- single | sequential | parallel | mixed
  execution_reason    TEXT,
  in_scope_actions    TEXT NOT NULL DEFAULT '[]',
  repair_limit        INTEGER NOT NULL DEFAULT 2,
  repairs_used        INTEGER NOT NULL DEFAULT 0,
  deadline_at         TEXT,
  branch              TEXT,
  worktree_path       TEXT,
  base_revision       TEXT,
  result_revision     TEXT,
  claimed_by          TEXT,                             -- controller launch id
  claimed_at          TEXT,
  blocked_reason      TEXT,
  failure_class       TEXT,
  result_summary      TEXT,
  review_of_task_id   TEXT REFERENCES tasks(id),
  record_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_by_state   ON tasks(state);
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(project_id, state);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  launch_id       TEXT NOT NULL UNIQUE,
  attempt_number  INTEGER NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'initial',      -- initial | repair | review
  adapter         TEXT NOT NULL,
  model           TEXT,
  effort          TEXT,
  auth_mode       TEXT,
  state           TEXT NOT NULL DEFAULT 'running',      -- running | succeeded | failed | cancelled
  pid             INTEGER,
  session_id      TEXT,
  worktree_path   TEXT,
  base_revision   TEXT,
  result_revision TEXT,
  outcome         TEXT,
  failure_class   TEXT,
  reason          TEXT,
  exit_status     INTEGER,
  usage_json      TEXT,
  output_path     TEXT,
  packet_id       TEXT,
  started_at      TEXT NOT NULL,
  heartbeat_at    TEXT,
  ended_at        TEXT
);

CREATE INDEX IF NOT EXISTS attempts_by_task ON attempts(task_id);
CREATE INDEX IF NOT EXISTS attempts_running ON attempts(state) WHERE state = 'running';

-- Append-only. Every state change writes its event in the same transaction.
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  project_id TEXT,
  task_id    TEXT,
  attempt_id TEXT,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, at);
CREATE INDEX IF NOT EXISTS events_by_kind ON events(kind, at);

CREATE TABLE IF NOT EXISTS gate_results (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id    TEXT,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,                          -- PASS | FAIL | ERROR | SKIPPED
  required      INTEGER NOT NULL DEFAULT 1,
  command       TEXT NOT NULL,
  tool_version  TEXT,
  revision      TEXT NOT NULL,
  evidence_path TEXT,
  duration_ms   INTEGER,
  waiver_id     TEXT REFERENCES approvals(id),
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gates_by_task ON gate_results(task_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  action         TEXT NOT NULL,
  target         TEXT NOT NULL,
  revision       TEXT NOT NULL,
  config_version TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected | invalidated | consumed
  reason         TEXT,
  evidence       TEXT NOT NULL DEFAULT '{}',
  requested_at   TEXT NOT NULL,
  decided_at     TEXT,
  decided_by     TEXT,
  consumed_at    TEXT
);

CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(state, requested_at);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id  TEXT,
  rule        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  eligible    TEXT NOT NULL DEFAULT '[]',
  chosen      TEXT NOT NULL,
  model       TEXT,
  effort      TEXT,
  at          TEXT NOT NULL
);

-- Context packets: exactly what was supplied to a worker, for continuity checks.
CREATE TABLE IF NOT EXISTS context_packets (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id      TEXT,
  requirement_ids TEXT NOT NULL DEFAULT '[]',
  omitted         TEXT NOT NULL DEFAULT '[]',
  files           TEXT NOT NULL DEFAULT '[]',
  artifacts       TEXT NOT NULL DEFAULT '[]',
  base_revision   TEXT,
  token_estimate  INTEGER,
  manifest_path   TEXT,
  warnings        TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_versions (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES config_versions(id),
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'snapshot',
  payload    TEXT NOT NULL,
  revision   TEXT,
  active     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS curator_proposals (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  rationale               TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  evidence_fingerprint    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft',
  base_config_version     TEXT NOT NULL,
  proposed_config_version TEXT NOT NULL REFERENCES config_versions(id),
  branch                  TEXT,
  worktree_path           TEXT,
  base_revision           TEXT,
  result_revision         TEXT,
  diff_path               TEXT,
  proposed_by             TEXT NOT NULL,
  rejection_reason        TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS curator_proposals_by_project ON curator_proposals(project_id, created_at);
CREATE INDEX IF NOT EXISTS curator_proposals_by_fingerprint ON curator_proposals(project_id, fingerprint, evidence_fingerprint);

CREATE TABLE IF NOT EXISTS curator_evaluations (
  id               TEXT PRIMARY KEY,
  proposal_id      TEXT NOT NULL REFERENCES curator_proposals(id) ON DELETE CASCADE,
  suite_version    TEXT NOT NULL,
  status           TEXT NOT NULL,
  baseline_metrics TEXT NOT NULL,
  candidate_metrics TEXT NOT NULL,
  case_results     TEXT NOT NULL DEFAULT '[]',
  errors           TEXT NOT NULL DEFAULT '[]',
  evidence_path    TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS curator_evaluations_by_proposal ON curator_evaluations(proposal_id, ended_at);

CREATE TABLE IF NOT EXISTS config_activations (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposal_id            TEXT REFERENCES curator_proposals(id),
  action                 TEXT NOT NULL, -- activate | revert
  from_config_version    TEXT NOT NULL,
  to_config_version      TEXT NOT NULL,
  source_config_version  TEXT,
  approval_id            TEXT NOT NULL REFERENCES approvals(id),
  activated_by           TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS config_activations_by_project ON config_activations(project_id, created_at);

CREATE TABLE IF NOT EXISTS provider_capacity (
  provider        TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'available', -- available | cooldown | unavailable
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  blocked_until   TEXT,
  reason          TEXT,
  error_count     INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_schedule (
  project_id         TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  dispatch_count     INTEGER NOT NULL DEFAULT 0,
  last_dispatched_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_plans (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective  TEXT NOT NULL,
  mode       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  assumptions TEXT NOT NULL DEFAULT '[]',
  milestones  TEXT NOT NULL DEFAULT '[]',
  version    INTEGER NOT NULL DEFAULT 1,
  state      TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_plan_tasks (
  plan_id  TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  PRIMARY KEY(plan_id, task_id),
  UNIQUE(plan_id, task_key)
);

CREATE TABLE IF NOT EXISTS review_results (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id           TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  revision             TEXT NOT NULL,
  verdict              TEXT NOT NULL, -- approved | request_changes | blocked
  summary              TEXT NOT NULL,
  findings             TEXT NOT NULL DEFAULT '[]',
  requirements_checked TEXT NOT NULL DEFAULT '[]',
  evidence_path        TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reviews_by_task ON review_results(task_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id        TEXT REFERENCES execution_plans(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL, -- comment | question | request_change | priority
  body           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending', -- pending | applied | answered | rejected
  response       TEXT,
  linked_task_id TEXT REFERENCES tasks(id),
  submitted_for_version INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  CHECK ((task_id IS NOT NULL AND plan_id IS NULL) OR (task_id IS NULL AND plan_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS feedback_by_task ON feedback(task_id, created_at);
CREATE INDEX IF NOT EXISTS feedback_by_plan ON feedback(plan_id, created_at);

-- One row per controller process generation; proves liveness without an LLM.
CREATE TABLE IF NOT EXISTS controller_lease (
  singleton     INTEGER PRIMARY KEY CHECK(singleton = 1),
  controller_id TEXT NOT NULL,
  pid           INTEGER NOT NULL,
  acquired_at   TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controller_health (
  id                TEXT PRIMARY KEY,
  pid               INTEGER NOT NULL,
  started_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  loop_delay_ms     INTEGER NOT NULL DEFAULT 0,
  db_errors         INTEGER NOT NULL DEFAULT 0,
  queue_depth       INTEGER NOT NULL DEFAULT 0,
  oldest_ready_age_s INTEGER NOT NULL DEFAULT 0,
  oldest_claim_age_s INTEGER NOT NULL DEFAULT 0,
  active_workers    INTEGER NOT NULL DEFAULT 0,
  worker_limit      INTEGER NOT NULL DEFAULT 2,
  slot_utilization  REAL NOT NULL DEFAULT 0,
  uptime_s          INTEGER NOT NULL DEFAULT 0,
  provider_status   TEXT NOT NULL DEFAULT '[]',
  backpressure_reason TEXT,
  state             TEXT NOT NULL DEFAULT 'running'      -- running | stopped | degraded
);
