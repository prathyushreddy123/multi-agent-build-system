# E6 live Pi read-only verification

Run: 20 September 2026. This is provider-backed evidence, separate from deterministic tests and the
simulated requested-change smoke.

## Boundary and environment

- The user explicitly approved this bounded test in the conversation immediately before the run.
- Pi `0.85.1`, non-interactive JSON mode, ephemeral `--no-session`.
- Successful model: `openai-codex/gpt-5.6-sol`, thinking `low`.
- `pi auth check --provider openai-codex`: `ready`.
- Existing ChatGPT/Codex subscription OAuth only. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` were removed
  from the process environment; no API-key or paid fallback was available.
- Tool allowlist: `mabs_get_product,mabs_get_operations`. Built-in and mutation tools were unavailable.
- Timeout: 300 seconds. Exit: 0. Stderr: empty.
- A first attempt selected `gpt-5.4-mini`; Codex rejected it as unsupported for a ChatGPT account before
  any tool call and reported zero input/output tokens. The supported subscription model was then used.
- Successful run usage reported by Pi across two assistant messages: 5,382 input, 550 output, 80
  reasoning, 5,932 total tokens. Pi's model metadata also emitted nominal API-price estimates; those are
  not evidence of a charge. This run used subscription OAuth, not a paid API credential.

## User prompt

> Read-only E6 acceptance verification. Use mabs_get_product exactly once for brief
> brf_01M2XJ8W95BXYET7TA3N8HSZFJ and mabs_get_operations exactly once for project
> prj_01M2XJRKAXXW8BDPR31R0EEPG3. Do not call mutation tools and do not change files or state. Report:
> accepted proposal and fingerprint if present; work completion and final output revisions; each
> optional-operation status; operation-run count; paid-model-API policy; and any limitation on whether
> these tools alone prove the current local main revision. Do not infer facts that the tool results do
> not establish.

## Tool calls and observed facts

Pi issued one assistant tool-use message containing exactly two calls:

1. `mabs_get_product({"brief":"brf_01M2XJ8W95BXYET7TA3N8HSZFJ"})`
   - accepted proposal `prv_01M2XJTWP9MQYTJG4H0XNW2FXZ`, version 2;
   - fingerprint `560805ad74b67dc25282f07935238967364622840a50f0ba6792eb2b9d37ccae`;
   - acceptance by `Prathyush` remains active;
   - bootstrap is completed;
   - five of five tasks are `DONE`;
   - final follow-up output revision is `ccc7d830d0c5104329fe9e71e48871e754e7334a`;
   - no outstanding intake decision or queued work.
2. `mabs_get_operations({"project":"prj_01M2XJRKAXXW8BDPR31R0EEPG3"})`
   - synthesized safe-default configuration version 0;
   - CI disabled; deployment disabled; monitoring disabled; scheduling manual;
   - delivery ready only as local files under `outputs`;
   - external costs disabled and paid model APIs prohibited;
   - zero operation runs, zero missed schedules, and zero task backlog;
   - each preparation result was `dryRun: true`;
   - the controller health row was returned read-only. Its accumulated `db_errors` value is preserved as
     observed evidence; this run did not reinterpret it as a SQLite failure.

No tool reported an error and no mutation or external-operation tool was available.

## Assistant response

> ## E6 acceptance verification
>
> - **Accepted proposal:** `prv_01M2XJTWP9MQYTJG4H0XNW2FXZ`, version 2, state `accepted`
> - **Proposal fingerprint:** `560805ad74b67dc25282f07935238967364622840a50f0ba6792eb2b9d37ccae`
> - **Work completion:** 5 of 5 work items are `DONE`; none pending or in progress.
> - **Recorded output revisions:**
>   - `cc3a023c0507dc6db41f558eb1846687507d2b34`
>   - `999b9fd76b93cef83b1851fcc91452fa5f97c7da`
>   - `c6a2b8e43c12e56314be831ab049ad843d6aa1f8`
>   - `51e60a196902b778547ca1bc8db713a4b56aaf4a`
>   - `ccc7d830d0c5104329fe9e71e48871e754e7334a`
>
> ### Optional operations
>
> | Operation | Effective status |
> |---|---|
> | CI | Disabled |
> | Deployment | Disabled |
> | Monitoring | Disabled |
> | Scheduling | Manual |
> | Delivery | Ready, local files under `outputs` |
> | Costs/external services | Disabled |
>
> - **Operation-run count:** 0
> - **Paid-model-API policy:** Prohibited.
> - **Limitation:** These records identify the repository path and recorded output revisions, but do not
>   inspect Git or establish which revision is currently checked out on local `main`. Therefore, these
>   tools alone cannot prove the current local `main` revision.

The limitation is correct. The separate local merge evidence establishes `main` at `ccc7d83`; this Pi
read-only tool run alone does not.
