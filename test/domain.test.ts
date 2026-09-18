import assert from "node:assert/strict";
import test from "node:test";

import { classifyFailure, consumesRepairBudget, isProviderUnavailable } from "../src/core/failure.ts";
import { validateWorkerOutput } from "../src/domain/contract.ts";
import { bindingMatches, describeStaleness, evaluate } from "../src/domain/policy.ts";
import { assertTransition, canTransition, holdsSlot, isTerminal } from "../src/domain/states.ts";
import { assertNoPaidFallback, buildWorkerEnv } from "../src/verify/env.ts";

const validOutput = {
  outcome: "completed",
  reason: "implementation complete",
  summary: "Implemented and checked the requested change.",
  evidence: {
    changed_files: ["src/example.ts"],
    result_revision: "abc123",
    tests: ["npm test"],
    artifacts: [],
  },
  follow_up: { unresolved: [], decisions_requested: [], next_step: null },
  usage: { model: null, input_tokens: null, output_tokens: 12 },
  addressed_requirements: ["REQ-1"],
};

test("worker output validation accepts the exact contract", () => {
  const result = validateWorkerOutput(validOutput);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.output?.evidence.result_revision, "abc123");
});

test("worker output validation rejects missing, malformed, and extra fields", () => {
  const result = validateWorkerOutput({
    ...validOutput,
    extra: true,
    evidence: { ...validOutput.evidence, tests: ["ok", 4] },
    follow_up: { unresolved: [], decisions_requested: [] },
    usage: { model: null, input_tokens: -1, output_tokens: 1.5 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.output, null);
  const paths = result.violations.map((violation) => violation.path);
  assert.ok(paths.includes("$.extra"));
  assert.ok(paths.includes("$.evidence.tests[1]"));
  assert.ok(paths.includes("$.follow_up.next_step"));
  assert.ok(paths.includes("$.usage.input_tokens"));
  assert.ok(paths.includes("$.usage.output_tokens"));
});

test("state machine enforces lifecycle boundaries", () => {
  assert.equal(canTransition("QUEUED", "READY"), true);
  assert.equal(canTransition("QUEUED", "DONE"), false);
  assert.throws(() => assertTransition("DONE", "RUNNING"), /Invalid task transition/);
  assert.equal(holdsSlot("RUNNING"), true);
  assert.equal(holdsSlot("REVIEWING"), true);
  assert.equal(isTerminal("CANCELLED"), true);
});

test("approval policy and bindings fail closed on drift", () => {
  assert.equal(evaluate({ action: "edit_worktree" }).requiresApproval, false);
  assert.equal(evaluate({ action: "merge" }).requiresApproval, true);
  assert.equal(evaluate({ action: "add_runtime_dependency", inScope: true }).requiresApproval, false);
  assert.equal(evaluate({ action: "push_branch" }).requiresApproval, true);
  assert.equal(
    evaluate({ action: "push_branch", policy: { overrides: {}, standing: ["push_branch"] } }).requiresApproval,
    false,
  );

  const granted = { action: "merge" as const, target: "main", revision: "a", configVersion: "v1" };
  const current = { ...granted, revision: "b" };
  assert.equal(bindingMatches(granted, current), false);
  assert.deepEqual(describeStaleness(granted, current), ["revision a -> b"]);
});

test("failure classes protect repair budget", () => {
  assert.equal(classifyFailure("HTTP 429 usage limit reached", 1), "QUOTA");
  assert.equal(classifyFailure("please run claude login", 1), "AUTH");
  assert.equal(classifyFailure("unknown model foo", 1), "CONFIG");
  assert.equal(classifyFailure("assertion failed", 1), "CODE");
  assert.equal(consumesRepairBudget("CODE"), true);
  assert.equal(consumesRepairBudget("QUOTA"), false);
  assert.equal(isProviderUnavailable("AUTH"), true);
});

test("worker environment removes paid API access and guard fails closed", () => {
  const parent = { PATH: "/bin", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret" };
  const result = buildWorkerEnv(parent);
  assert.equal(result.env.OPENAI_API_KEY, undefined);
  assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(result.removed.sort(), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  assert.throws(() => assertNoPaidFallback(parent), /Refusing to launch/);
  assert.doesNotThrow(() => assertNoPaidFallback(result.env));
});
