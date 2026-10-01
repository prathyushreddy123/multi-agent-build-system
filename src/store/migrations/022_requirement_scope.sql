-- Schema 22: requirement scope.
-- requirements.scope (added by the migration's column list) separates global
-- invariants, which every task's context carries, from task-owned
-- requirements, which only their owning task carries. NULL is a legacy,
-- unclassified requirement and keeps broad coverage.
SELECT 1;
