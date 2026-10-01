-- Schema 19: idempotent intake requests.
-- A conversational intake operation (a batch of answers, or starting accepted
-- work) carries a caller-chosen request id. The row binds that id to a hash of
-- the exact request: an identical retry returns the recorded result instead of
-- repeating side effects, and a different request under the same id is a
-- conflict. `progress` holds durable checkpoints for operations that also
-- touch the filesystem and Git, which a database transaction cannot undo.
CREATE TABLE IF NOT EXISTS intake_requests (
  request_id   TEXT PRIMARY KEY,
  brief_id     TEXT NOT NULL REFERENCES product_briefs(id) ON DELETE CASCADE,
  operation    TEXT NOT NULL CHECK(operation IN ('resolve', 'start')),
  payload_hash TEXT NOT NULL,
  state        TEXT NOT NULL CHECK(state IN ('in_progress', 'completed', 'failed')),
  progress     TEXT NOT NULL DEFAULT '{}',
  result       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intake_requests_brief ON intake_requests(brief_id, created_at);
