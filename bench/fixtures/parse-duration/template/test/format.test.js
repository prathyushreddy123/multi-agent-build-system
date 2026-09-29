import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/format.js";

test("formats compound durations", () => {
  assert.equal(formatDuration(5_400_000), "1h30m");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(0), "0ms");
});

test("rejects invalid input", () => {
  assert.throws(() => formatDuration(-1), TypeError);
});
