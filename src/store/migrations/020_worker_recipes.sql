-- Schema 20: named worker recipes.
-- projects.worker_recipes (added by the migration's column list) holds the
-- exploratory commands a worker may run besides the registered checks, such
-- as running the program it is building. A recipe fixes the executable; the
-- worker may only append validated arguments. Recipe output is never
-- acceptance evidence. Existing projects start with none.
SELECT 1;
