-- Schema 21: standing user preferences with provenance.
-- A standing preference (today only the delivery mode for new eligible
-- projects) is a person's durable instruction, not a per-project decision.
-- Exactly one row per key is active; replacing or clearing it keeps the old
-- row as history. Decisions applied from it name it in source_ref.
CREATE TABLE IF NOT EXISTS standing_preferences (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL CHECK(key IN ('delivery')),
  value         TEXT NOT NULL,
  set_by        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  active        INTEGER NOT NULL CHECK(active IN (0, 1)),
  created_at    TEXT NOT NULL,
  superseded_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_standing_preferences_active ON standing_preferences(key) WHERE active = 1;
