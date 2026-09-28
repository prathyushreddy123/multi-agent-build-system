-- Schema 18: bind each live experiment trial to the one task created for it.
-- A binding is written only by the trial launcher, for exactly one slot of an
-- authorized manifest; a task can fill at most one slot, and a slot at most
-- one task. Recording a live trial requires the binding, so an unrelated or
-- reused task can never become experiment evidence.
CREATE TABLE IF NOT EXISTS optimization_trial_bindings (
  experiment_id        TEXT NOT NULL REFERENCES optimization_experiments(id) ON DELETE CASCADE,
  variant              TEXT NOT NULL CHECK(variant IN ('baseline', 'candidate')),
  case_key             TEXT NOT NULL,
  repeat_index         INTEGER NOT NULL,
  task_id              TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  manifest_fingerprint TEXT NOT NULL,
  starting_revision    TEXT NOT NULL,
  applied_config       TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (experiment_id, variant, case_key, repeat_index)
);
