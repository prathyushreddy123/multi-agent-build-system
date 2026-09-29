// Hidden product checks for the habit-tracker idea. Never shown to any model.
// Every check uses its own data file so one failure cannot cascade into the
// next. Dates are always passed explicitly, so "today" and time zones never
// matter. Prints one JSON line: {passed, total, failures}.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.argv[2];
if (!repo) throw new Error("usage: node evaluate.mjs REPO");
const root = mkdtempSync(join(tmpdir(), "habit-eval-"));
let counter = 0;
const freshFile = () => join(root, `h${counter++}.json`);

// A terminal that forces color would turn console.log(0) into an escape
// sequence; the program under test gets a plain, non-TTY environment.
const env = { ...process.env, NO_COLOR: "1" };
delete env.FORCE_COLOR;
function cli(file, ...args) {
  return spawnSync(process.execPath, [join(repo, "src/cli.js"), ...args], {
    cwd: repo, env: { ...env, HABIT_FILE: file }, encoding: "utf8", timeout: 20_000,
  });
}
function ok(result) {
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr.trim().slice(0, 200)}`);
  return result.stdout.trim();
}
function fails(result) {
  // A missing or crashing program is not a correct refusal.
  assert.doesNotMatch(result.stderr, /Cannot find module|SyntaxError|ReferenceError|TypeError/, "the CLI crashed instead of refusing");
  assert.notEqual(result.status, 0, "expected a non-zero exit");
  assert.notEqual(result.stderr.trim(), "", "expected an error on stderr");
  return result;
}
const streak = (file, name) => Number(ok(cli(file, "streak", name)));
function withDays(name, days) {
  const file = freshFile();
  ok(cli(file, "add", name));
  for (const day of days) ok(cli(file, "done", name, `--date=${day}`));
  return file;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("add then list includes the habit", () => {
  const file = freshFile();
  ok(cli(file, "add", "read"));
  const list = JSON.parse(ok(cli(file, "list")));
  assert.ok(Array.isArray(list) && list.some((item) => item.name === "read"));
});
check("adding a duplicate habit is an error", () => {
  const file = freshFile();
  ok(cli(file, "add", "read"));
  fails(cli(file, "add", "read"));
});
check("marking an unknown habit is an error", () => fails(cli(freshFile(), "done", "ghost", "--date=2026-03-01")));
check("streak of an unknown habit is an error", () => fails(cli(freshFile(), "streak", "ghost")));
check("a habit never done has streak 0", () => {
  const file = freshFile();
  ok(cli(file, "add", "read"));
  assert.equal(streak(file, "read"), 0);
});
check("three consecutive days give streak 3", () => assert.equal(streak(withDays("read", ["2026-03-01", "2026-03-02", "2026-03-03"]), "read"), 3));
check("a gap resets to the most recent run", () => assert.equal(streak(withDays("read", ["2026-03-01", "2026-03-02", "2026-03-04"]), "read"), 1));
check("days recorded out of order still count", () => assert.equal(streak(withDays("read", ["2026-03-05", "2026-03-03", "2026-03-04"]), "read"), 3));
check("marking the same day twice does not double count", () => assert.equal(streak(withDays("read", ["2026-03-01", "2026-03-02", "2026-03-02"]), "read"), 2));
check("a run across a month boundary counts", () => assert.equal(streak(withDays("read", ["2026-01-31", "2026-02-01"]), "read"), 2));
check("a leap day is a real day", () => assert.equal(streak(withDays("read", ["2028-02-28", "2028-02-29", "2028-03-01"]), "read"), 3));
check("an impossible date is an error", () => {
  const file = withDays("read", []);
  fails(cli(file, "done", "read", "--date=2026-02-30"));
});
check("a malformed date is an error", () => {
  const file = withDays("read", []);
  fails(cli(file, "done", "read", "--date=yesterday"));
});
check("an error prints nothing to stdout", () => assert.equal(fails(cli(freshFile(), "streak", "ghost")).stdout.trim(), ""));
check("list is a JSON array of {name, streak} with current streaks", () => {
  const file = withDays("read", ["2026-03-01", "2026-03-02"]);
  ok(cli(file, "add", "run"));
  const list = JSON.parse(ok(cli(file, "list")));
  const byName = Object.fromEntries(list.map((item) => [item.name, item.streak]));
  assert.deepEqual(byName, { read: 2, run: 0 });
});
check("data is stored at HABIT_FILE", () => {
  const file = freshFile();
  ok(cli(file, "add", "read"));
  assert.ok(existsSync(file), "no file at HABIT_FILE");
  JSON.parse(readFileSync(file, "utf8"));
});
check("a missing data file is an empty list", () => assert.deepEqual(JSON.parse(ok(cli(join(root, "absent", "none.json"), "list"))), []));
check("a corrupt data file is an error and is not overwritten", () => {
  const file = freshFile();
  writeFileSync(file, "{not json");
  fails(cli(file, "add", "read"));
  assert.equal(readFileSync(file, "utf8"), "{not json");
});

const failures = [];
for (const { name, fn } of checks) {
  try { fn(); } catch (error) { failures.push(`${name}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`); }
}
console.log(JSON.stringify({ passed: checks.length - failures.length, total: checks.length, failures }));
