import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/parse.js";
import { formatDuration } from "../src/format.js";

const valid = { "1h30m": 5_400_000, "45s": 45_000, "2d4h": 187_200_000, "250ms": 250, "0ms": 0, "1d1h1m1s1ms": 90_061_001, "1m": 60_000, "10s500ms": 10_500 };
for (const [s, v] of Object.entries(valid)) test(`valid ${s}`, () => assert.equal(parseDuration(s), v));
for (const bad of [42, null, undefined, {}, ["1s"]]) test(`type ${String(bad)}`, () => assert.throws(() => parseDuration(bad), TypeError));
for (const bad of ["", "1x", "1m1h", "1s1s", "h", "1h30", "1h 30m", "-1s", "1.5h", "1hx", "ms", "1msx", " 1s"])
  test(`syntax ${JSON.stringify(bad)}`, () => assert.throws(() => parseDuration(bad), SyntaxError));
test("round trip", () => { for (let n = 0; n < 200_000_000; n += 7_777_777) assert.equal(parseDuration(formatDuration(n)), n); for (const n of [0,1,999,1000,59_999,86_400_000]) assert.equal(parseDuration(formatDuration(n)), n); });
