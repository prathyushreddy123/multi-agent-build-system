#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { auditExecutionHistory } from "../src/diagnostics/history.ts";

const USAGE = `Usage: node scripts/audit-execution-history.ts --db <explicit.sqlite> --read-only --output <new-report.json> [--tasks <id,id,...>]

The command never selects the live MABS database implicitly and refuses to overwrite an existing report.`;

function valueAfter(args: string[], name: string): string | undefined {
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function runHistoryAuditCli(args: string[]): string {
  if (args.includes("--help") || args.includes("-h")) {
    return USAGE;
  }
  const db = valueAfter(args, "--db");
  const output = valueAfter(args, "--output");
  if (!db || !output || !args.includes("--read-only")) throw new Error(USAGE);
  const sourcePath = resolve(db);
  const outputPath = resolve(output);
  if (sourcePath === outputPath) throw new Error("Audit output must not be the source database.");
  if (existsSync(outputPath)) throw new Error(`Audit output already exists: ${outputPath}`);
  if (!existsSync(dirname(outputPath))) throw new Error(`Audit output directory does not exist: ${dirname(outputPath)}`);
  const taskValue = valueAfter(args, "--tasks");
  const taskIds = taskValue?.split(",").map((value) => value.trim()).filter(Boolean);
  const report = auditExecutionHistory({ dbPath: sourcePath, taskIds });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return outputPath;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(runHistoryAuditCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
