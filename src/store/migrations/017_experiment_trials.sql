-- Schema 17: repeated, retained experiment trials.
-- The original table's UNIQUE(experiment_id, variant, case_key) forbids repeat
-- measurements, and SQLite cannot alter a table constraint in place, so the
-- table is rebuilt with the repeat index in its key. Every existing row is
-- copied unchanged (repeat 0, source "manual", trial state "completed").
-- Re-applying converges: the copy reads whichever table currently holds the data.
CREATE TABLE IF NOT EXISTS optimization_measurements_v17 (
  id                     TEXT PRIMARY KEY,
  experiment_id          TEXT NOT NULL REFERENCES optimization_experiments(id) ON DELETE CASCADE,
  variant                TEXT NOT NULL,
  case_key               TEXT NOT NULL,
  accepted               INTEGER NOT NULL,
  requirement_violations INTEGER NOT NULL DEFAULT 0,
  repairs                INTEGER NOT NULL DEFAULT 0,
  interventions          INTEGER NOT NULL DEFAULT 0,
  duration_ms            INTEGER,
  reported_input_tokens  INTEGER,
  reported_output_tokens INTEGER,
  relevant_files         INTEGER NOT NULL DEFAULT 0,
  warnings               INTEGER NOT NULL DEFAULT 0,
  evidence_path          TEXT,
  created_at             TEXT NOT NULL,
  repeat_index           INTEGER NOT NULL DEFAULT 0,
  seed                   TEXT,
  usage_coverage         TEXT,
  trial_state            TEXT NOT NULL DEFAULT 'completed' CHECK(trial_state IN ('completed', 'failed', 'interrupted')),
  source                 TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'live_trial', 'policy_replay')),
  task_id                TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  UNIQUE(experiment_id, variant, case_key, repeat_index)
);
INSERT OR IGNORE INTO optimization_measurements_v17(
  id, experiment_id, variant, case_key, accepted, requirement_violations, repairs, interventions, duration_ms,
  reported_input_tokens, reported_output_tokens, relevant_files, warnings, evidence_path, created_at,
  repeat_index, seed, usage_coverage
)
SELECT id, experiment_id, variant, case_key, accepted, requirement_violations, repairs, interventions, duration_ms,
  reported_input_tokens, reported_output_tokens, relevant_files, warnings, evidence_path, created_at,
  repeat_index, seed, usage_coverage
FROM optimization_measurements;
DROP TABLE optimization_measurements;
ALTER TABLE optimization_measurements_v17 RENAME TO optimization_measurements;
