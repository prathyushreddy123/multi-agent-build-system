-- Schema 16: named execution resources for the shared scheduler.
-- The only change is the additive `tasks.resources` column, applied through
-- the presence-checked column list in `../db.ts`. Existing tasks default to no
-- named resources; nothing is inferred for them.
SELECT 1;
