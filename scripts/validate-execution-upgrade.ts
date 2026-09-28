#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateExecutionUpgrade } from "../src/diagnostics/upgrade.ts";

const USAGE = `Usage: node scripts/validate-execution-upgrade.ts --source <explicit.sqlite> --work <new-directory>

Rehearses the schema upgrade and a restore on copies inside a new work directory.
The source is opened read-only and is never migrated. Exit status 0 only when every
pre-existing value survives, the copy reaches the supported schema, and the restore matches.`;

function valueAfter(args: string[], name: string): string | undefined {
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const source = valueAfter(args, "--source");
  const work = valueAfter(args, "--work");
  if (args.includes("--help") || !source || !work) {
    console.error(USAGE);
    process.exitCode = args.includes("--help") ? 0 : 1;
  } else {
    try {
      const report = await validateExecutionUpgrade({ sourcePath: source, workDir: work });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.passed ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
