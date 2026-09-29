# Pocket Ledger

A zero-dependency TypeScript command-line expense ledger.

## Required interface

```text
node src/cli.ts add AMOUNT CATEGORY DESCRIPTION...
node src/cli.ts list [--category=CATEGORY]
node src/cli.ts summary
```

Set `POCKET_LEDGER_FILE` to select the JSON data file. Otherwise the CLI uses
`ledger.json` in the current directory.

All successful commands print JSON to stdout. Errors go to stderr and use a
non-zero exit code.
