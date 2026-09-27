import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryConsumesCodeRepair,
  classifyFailure,
  consumesRepairBudget,
  diagnoseFailure,
  failureClassForCategory,
} from "../src/core/failure.ts";

test("missing tools and denied permissions are environment failures with no repair charge", () => {
  const missing = diagnoseFailure({
    stage: "check",
    source: "gate",
    exitCode: 127,
    toolResolved: false,
    text: "sh: 1: tsc: not found",
    evidenceIds: ["gate-tsc-log"],
  });
  assert.equal(missing.category, "environment");
  assert.equal(missing.consumesCodeRepair, false);
  assert.equal(missing.causeStatus, "observed");
  assert.deepEqual(missing.evidenceIds, ["gate-tsc-log"]);

  const providerBinary = diagnoseFailure({
    stage: "review",
    source: "review",
    exitCode: 127,
    toolResolved: false,
    text: "spawn claude ENOENT",
  });
  assert.equal(providerBinary.category, "environment");
  assert.equal(providerBinary.consumesCodeRepair, false);
  const legacyMissing = classifyFailure("spawn claude ENOENT", 127);
  assert.equal(legacyMissing, "CONFIG");
  assert.equal(consumesRepairBudget(legacyMissing), false);

  const permission = diagnoseFailure({
    stage: "check",
    source: "gate",
    exitCode: 126,
    text: "Permission denied",
  });
  assert.equal(permission.category, "environment");
  assert.match(permission.recoveryAction, /Do not widen worker permissions/i);
  assert.equal(permission.consumesCodeRepair, false);
  const legacyPermission = classifyFailure("Permission denied by worker policy", 1);
  assert.equal(legacyPermission, "INFRA");
  assert.equal(consumesRepairBudget(legacyPermission), false);
});

test("positive compiler and assertion evidence can identify a product defect", () => {
  const typeError = diagnoseFailure({
    stage: "check",
    source: "gate",
    exitCode: 2,
    toolResolved: true,
    text: "src/index.ts(4,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    evidenceIds: ["typecheck-log"],
  });
  assert.equal(typeError.category, "product_code");
  assert.equal(typeError.consumesCodeRepair, true);
  assert.equal(typeError.confidence, "high");
  assert.equal(failureClassForCategory(typeError.category), "CODE");

  const assertion = diagnoseFailure({
    stage: "check",
    source: "gate",
    exitCode: 1,
    toolResolved: true,
    text: "AssertionError: expected 2 to equal 3",
  });
  assert.equal(assertion.category, "product_code");
  assert.equal(categoryConsumesCodeRepair(assertion.category), true);
});

test("structured signals distinguish provider, controller, contract, requirement, and unknown causes", () => {
  assert.equal(diagnoseFailure({
    stage: "implement", source: "worker", exitCode: 1, text: "HTTP 429 usage limit reached",
  }).category, "provider_capacity");
  assert.equal(diagnoseFailure({
    stage: "implement", source: "worker", exitCode: 1, text: "please run codex login",
  }).category, "provider_auth");
  assert.equal(diagnoseFailure({
    stage: "preflight", source: "controller", exitCode: 1, text: "lease reconciliation failed",
  }).category, "controller");
  assert.equal(diagnoseFailure({
    stage: "finalize", source: "contract", exitCode: 1, contractViolation: "changed out-of-scope file",
  }).category, "worker_contract");
  assert.equal(diagnoseFailure({
    stage: "accept",
    source: "controller",
    requirementDecision: { requirementId: "REQ-5", question: "Which target is authoritative?" },
  }).category, "requirement");

  const unknown = diagnoseFailure({ stage: "implement", source: "worker", exitCode: 9, text: "unexpected exit" });
  assert.equal(unknown.category, "unknown");
  assert.equal(unknown.causeStatus, "hypothesis");
  assert.equal(unknown.confidence, "low");
  assert.equal(unknown.consumesCodeRepair, false);
  assert.equal(diagnoseFailure({
    stage: "check", source: "gate", exitCode: 9, toolResolved: true, text: "unexpected exit",
  }).category, "unknown", "a resolved gate command is not by itself proof of a code defect");
});

test("actual readiness evidence outranks incidental failure prose", () => {
  const diagnosis = diagnoseFailure({
    stage: "check",
    source: "gate",
    exitCode: 1,
    toolResolved: true,
    text: "AssertionError from a stale log fragment",
    readiness: { state: "setup_required", summary: "node_modules/.bin/tsc is absent in this worktree" },
    evidenceIds: ["preflight-tsc"],
  });
  assert.equal(diagnosis.category, "environment");
  assert.equal(diagnosis.symptom, "node_modules/.bin/tsc is absent in this worktree");
  assert.equal(diagnosis.consumesCodeRepair, false);
});
