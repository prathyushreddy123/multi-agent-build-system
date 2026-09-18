import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../core/exec.ts";

/**
 * A throwaway git repository with one deliberately broken function and a
 * failing test. Every access-proof round trip uses the same fixture so the two
 * harnesses are compared on identical work.
 */
export const FIXTURE_TASK =
  "The test suite in this repository fails. Fix the implementation in src/calc.py so that " +
  "`python3 -m unittest discover -s tests` passes. Do not edit the tests.";

const CALC_BROKEN = `"""Small calculator used by the access-proof fixture."""


def add(a, b):
    return a + b


def multiply(a, b):
    # Deliberately wrong: repeated addition is off by one factor.
    return a + b
`;

const TEST_FILE = `import unittest

from src.calc import add, multiply


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_multiply(self):
        self.assertEqual(multiply(3, 4), 12)

    def test_multiply_zero(self):
        self.assertEqual(multiply(0, 9), 0)


if __name__ == "__main__":
    unittest.main()
`;

export interface Fixture {
  path: string;
  baseRevision: string;
  testCommand: string[];
}

export async function createFixture(root: string): Promise<Fixture> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "src", "calc.py"), CALC_BROKEN);
  writeFileSync(join(root, "src", "__init__.py"), "");
  writeFileSync(join(root, "tests", "test_calc.py"), TEST_FILE);
  writeFileSync(join(root, "tests", "__init__.py"), "");
  writeFileSync(
    join(root, "README.md"),
    "# access-proof fixture\n\nThrowaway repository. `multiply` is wrong and its test fails.\n",
  );

  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "fixture@local"], { cwd: root });
  await exec("git", ["config", "user.name", "MABS fixture"], { cwd: root });
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-q", "-m", "fixture: failing multiply"], { cwd: root });
  const rev = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

  return { path: root, baseRevision: rev.stdout.trim(), testCommand: ["python3", "-m", "unittest", "discover", "-s", "tests"] };
}

export async function fixtureTestsPass(fixturePath: string): Promise<{ pass: boolean; output: string }> {
  const result = await exec("python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: fixturePath,
    timeoutMs: 60_000,
  });
  return { pass: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
}

export async function gitStatus(fixturePath: string): Promise<{ changedFiles: string[]; revision: string }> {
  const status = await exec("git", ["status", "--porcelain"], { cwd: fixturePath });
  const rev = await exec("git", ["rev-parse", "HEAD"], { cwd: fixturePath });
  const changedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(" ") + 1).trim());
  return { changedFiles, revision: rev.stdout.trim() };
}
