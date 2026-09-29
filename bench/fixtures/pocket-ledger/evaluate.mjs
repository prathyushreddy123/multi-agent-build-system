// Hidden behavioural checks for the Pocket Ledger fixture. Never shown to a
// worker. Each check is scored independently so one failure does not hide the
// rest; the output is one JSON line: {passed, total, failures}.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.argv[2];
if (!repo) throw new Error("usage: node evaluate.mjs REPO");
const root = mkdtempSync(join(tmpdir(), "pocket-ledger-eval-"));
const file = join(root, "ledger.json");

function run(args, ledger = file) {
  return spawnSync(process.execPath, [join(repo, "src/cli.ts"), ...args], {
    cwd: repo,
    env: { ...process.env, POCKET_LEDGER_FILE: ledger },
    encoding: "utf8",
    timeout: 20_000,
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const state = {};

check("add parses decimal amount into cents", () => {
  state.first = json(run(["add", "12.3", " Food ", "Lunch", "special"]));
  assert.equal(state.first.amountCents, 1230);
});
check("add assigns exp-0001 to the first expense", () => assert.equal(state.first.id, "exp-0001"));
check("category is trimmed and lowercased", () => assert.equal(state.first.category, "food"));
check("description joins the remaining words", () => assert.equal(state.first.description, "Lunch special"));
check("createdAt is an ISO timestamp", () => assert.match(state.first.createdAt, /^\d{4}-\d{2}-\d{2}T/));
check("ids are monotonic", () => assert.equal(json(run(["add", "5.00", "travel", "Bus"])).id, "exp-0002"));
check("integer amounts are accepted", () => assert.equal(json(run(["add", "12", "food", "Groceries"])).amountCents, 1200));
check("list filters by normalized category in insertion order", () =>
  assert.deepEqual(json(run(["list", "--category=FOOD"])).map((item) => item.id), ["exp-0001", "exp-0003"]));
check("summary totals and groups by category", () =>
  assert.deepEqual(json(run(["summary"])), { totalCents: 2930, count: 3, byCategory: { food: 2430, travel: 500 } }));
check("summary category keys are ordered", () => assert.deepEqual(Object.keys(json(run(["summary"])).byCategory), ["food", "travel"]));
for (const amount of ["0", "-1", "+1", "1e2", "1.234", "x"]) {
  check(`amount ${amount} is rejected without output or mutation`, () => {
    const before = readFileSync(file, "utf8");
    const result = run(["add", amount, "food", "bad"]);
    assert.notEqual(result.status, 0, `amount ${amount} should fail`);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(file, "utf8"), before, `amount ${amount} mutated the ledger`);
  });
}
check("empty category is rejected", () => assert.notEqual(run(["add", "1", "  ", "x"]).status, 0));
check("missing description is rejected", () => assert.notEqual(run(["add", "1", "food"]).status, 0));
check("errors go to stderr", () => assert.notEqual(run(["add", "x", "food", "bad"]).stderr.trim(), ""));
check("successful writes leave no temporary sibling", () => assert.deepEqual(readdirSync(root).sort(), ["ledger.json"]));
check("persisted file has schemaVersion 1 and an expenses array", () => {
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.expenses.length, 3);
});
check("a missing data file is an empty ledger", () =>
  assert.deepEqual(json(run(["summary"], join(root, "absent.json"))), { totalCents: 0, count: 0, byCategory: {} }));
check("malformed data is an error and is not overwritten", () => {
  writeFileSync(file, "{broken");
  assert.notEqual(run(["add", "1", "food", "bad"]).status, 0);
  assert.equal(readFileSync(file, "utf8"), "{broken");
});
check("numeric category names are ordered lexicographically in summary output", () => {
  const numeric = join(root, "numeric.json");
  json(run(["add", "1", "2", "two"], numeric));
  json(run(["add", "1", "10", "ten"], numeric));
  const text = run(["summary"], numeric).stdout;
  assert.ok(text.indexOf('"10"') >= 0 && text.indexOf('"10"') < text.indexOf('"2"'), `expected "10" before "2" in ${text.trim()}`);
});

const failures = [];
for (const { name, fn } of checks) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
  }
}
console.log(JSON.stringify({ passed: checks.length - failures.length, total: checks.length, failures }));
