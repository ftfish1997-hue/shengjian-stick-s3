import assert from "node:assert/strict";
import test from "node:test";
import {
  audioDurationSeconds,
  constantTimeEqual,
  parseDashboardQuery,
} from "./dashboard_data.ts";

test("parses a bounded dashboard record limit", () => {
  assert.deepEqual(
    parseDashboardQuery(new URL("https://example.test/dashboard-data")),
    { recordLimit: 20 },
  );
  assert.deepEqual(
    parseDashboardQuery(
      new URL("https://example.test/dashboard-data?record_limit=35"),
    ),
    { recordLimit: 35 },
  );
  assert.throws(
    () =>
      parseDashboardQuery(
        new URL("https://example.test/dashboard-data?record_limit=0"),
      ),
    /positive integer/,
  );
  assert.throws(
    () =>
      parseDashboardQuery(
        new URL("https://example.test/dashboard-data?record_limit=51"),
      ),
    /between 1 and 50/,
  );
  assert.throws(
    () =>
      parseDashboardQuery(
        new URL("https://example.test/dashboard-data?unexpected=true"),
      ),
    /Unknown query parameter/,
  );
});

test("compares dashboard tokens without an early length exit", () => {
  assert.equal(constantTimeEqual("same-token", "same-token"), true);
  assert.equal(constantTimeEqual("same-token", "different-token"), false);
  assert.equal(constantTimeEqual("short", "shorter"), false);
});

test("derives PCM duration from the persisted WAV size", () => {
  assert.equal(audioDurationSeconds(44), 0);
  assert.equal(audioDurationSeconds(960_044), 30);
  assert.equal(audioDurationSeconds(148_844), 4.7);
  assert.equal(audioDurationSeconds(null), null);
  assert.equal(audioDurationSeconds(12), null);
});
