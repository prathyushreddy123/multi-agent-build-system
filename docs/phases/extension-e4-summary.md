# E4 summary — safe bootstrap, application profiles, and reusable guidance

Completed: 19 September 2026. Branch `mabs-extension`.

## Resumable bootstrap

`src/bootstrap/service.ts` accepts only a brief with active exact-plan consent and records nine steps
under one bootstrap ID:

1. directory creation and ownership marker;
2. local Git initialization on `main` (no remote);
3. skeleton generation;
4. isolated environment instructions;
5. post-scaffold profile resolution;
6. local initial commit;
7. project registration;
8. post-scaffold check registration;
9. accepted-plan linkage.

Every step moves through pending/running/done/failed with timestamped detail in SQLite. A retry skips
done steps, uses the same ownership marker and project ID, and uses E3's idempotent plan submission.
An interruption after scaffold was resumed in the test suite without deleting a user-created proof file,
duplicating the project, or duplicating tasks.

Bootstrap refuses `/`, the user's home directory, and any non-empty directory without the matching
bootstrap marker. It never cleans an unrelated path. A failed run and its error remain queryable and
resumable. Package installation and global runtime modification are deliberately not bootstrap steps:
setup commands and missing prerequisites are recorded for the user instead.

Surfaces:

- Pi tool `mabs_bootstrap_project` and `/mabs-bootstrap`;
- CLI `mabs brief bootstrap <brief> <target> ...`;
- CLI `mabs bootstrap resume <id>`;
- CLI `mabs profile inspect <repo>`.

## Python and JavaScript/TypeScript profiles

`src/profiles/` defines the versioned `application-profiles-v1` contract: detection, environment,
checks, artifacts, and component composition.

### Python (`python-profile-v1`)

- Detects component roots from Python manifests and reads `.python-version` / `requires-python`.
- Selects uv, Poetry, Pipenv, or isolated stdlib/venv Python from lock/config evidence or explicit
  selection.
- Does **not** infer pytest from `pyproject.toml` alone. Pytest, Ruff, mypy, and build checks require
  their own configuration evidence. A stdlib unittest suite and syntax compilation remain available
  to the generated dependency-free starter.
- Records exact setup commands, missing tools, runnable entry-point files, build/report paths, and
  development instructions.

### JavaScript/TypeScript (`javascript-typescript-profile-v1`)

- Selects npm, pnpm, Yarn, or Bun from lockfile evidence first, then `packageManager`; npm is only the
  fallback when no stronger evidence exists.
- Registers only declared `format`, `lint`, `typecheck`, `test`, and `build` scripts, using the selected
  manager and component root.
- Detects TypeScript from `tsconfig.json` or dependency evidence and records runtime/version files,
  setup commands, entry points, outputs, and reports.

The resolver composes multiple roots. The mixed fixture produces independently scoped `backend:*`
Python and `frontend:*` JS/TS checks. Unknown stacks remain visible as unsupported/custom-gate
requirements rather than being claimed as tested profiles.

## Check discovery and quality honesty

`discoverChecks()` now delegates to the same profile resolver used by bootstrap. Check discovery runs
after scaffold, so a directory that started empty no longer remains permanently unconfigured.
Python and JavaScript generated checks were actually executed in tests. If a selected package manager
or runtime is absent, the profile records that prerequisite; it does not report passing coverage.

## Reusable guidance and prompt provenance

Versioned on-demand Pi skills now cover:

- product discovery;
- automation design;
- Python delivery;
- JavaScript/TypeScript delivery;
- risk-based review.

Shared boundaries live once in `.pi/skills/_shared/MABS_BOUNDARIES.md`; no skill contains credentials
or project-specific secrets. The documented precedence is enforced controller/contract rules, accepted
task scope, repository provider instructions, selected guidance, then project addenda. Lower levels
cannot weaken higher ones.

Role instructions and output-schema assembly moved from packet construction to
`src/prompts/roles.ts`. New attempts record `worker-packet-v2+worker-roles-v1` and only the relevant
guidance versions (for example `mabs-boundaries-v1`, `automation-design-v1`,
`python-delivery-v1`). This is provenance, not a prose policy bypass.

## Migration

Schema 12 -> 13 is additive:

- `bootstrap_runs.profile_resolution`, `environment_plan`, and `artifacts`;
- `attempts.prompt_version` and `skill_versions`.

The migration fixture removes those fields from a schema-12 database, opens it with current code, and
verifies all fields are restored and the schema version advances. Before upgrading persistent state:

```
node src/cli.ts maintenance backup
```

## Evidence

```
npm run typecheck                                  # clean
MABS_STATE_DIR=/tmp/mabs-e4-full npm test          # 72 pass, 0 fail
```

`test/extension-e4.test.ts` covers empty Python and JavaScript directories, executable generated
checks, package-manager evidence, unrelated-directory refusal, interruption/resume, the real CLI path
used by Pi, mixed components, schema migration, and attempt prompt/skill provenance.

The installed Pi runtime was started in offline RPC mode. It loaded `/mabs-bootstrap`, `/mabs-new`,
and all five versioned skills with no `extension_error`. This proves installed format/discovery without
making another provider call.
