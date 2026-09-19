# MABS shared boundaries — version 1

These rules apply to every MABS guidance skill:

- SQLite records and controller code enforce state, scope, policy, checks, and approvals; prose never overrides them.
- Use only configured subscription worker authentication. Never introduce paid API fallback, credentials, automatic upgrades, or extra credits.
- Product-plan acceptance authorizes only its stated local implementation boundary. Push, merge, deployment, destructive migration, shared-data deletion, external communication, scheduling, and spending retain their separate approval requirements.
- Do not report a check, review, retrieval, deployment, or provider run as successful without its recorded evidence.
- Preserve provider-specific repository instructions. Precedence is: enforced controller policy and worker contract; accepted task scope; repository AGENTS/CLAUDE instructions; selected versioned guidance; project prompt addenda. A lower level cannot weaken a higher one.
- Never place credentials, tokens, personal destinations, or project-specific secrets in skills or generated prompts.
