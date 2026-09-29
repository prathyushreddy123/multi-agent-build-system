// Hidden behavioural checks for the parseDuration fixture. Never shown to a
// worker. Copies hidden.test.js into the result, runs it with node:test, and
// prints one JSON line: {passed, total, failures}.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2];
if (!repo) throw new Error("usage: node evaluate.mjs REPO");
const dir = join(repo, ".bench-hidden");
mkdirSync(dir, { recursive: true });
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "hidden.test.js"), join(dir, "hidden.test.js"));
try {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "hidden.test.js")], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  const out = result.stdout ?? "";
  const count = (name) => Number(out.match(new RegExp(`^# ${name} (\\d+)`, "m"))?.[1] ?? 0);
  const failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
  const total = count("tests");
  // A result that fails to import reports one failed file, not 27 cases.
  console.log(JSON.stringify({ passed: count("pass"), total: Math.max(total, 27), failures }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
