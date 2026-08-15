import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROCESSING_ATTEMPTS,
  isRetryDue,
  isRetryableErrorCode,
  retryDueAt,
  selectRetryCandidates,
} from "./retry_policy.ts";

const NOW = Date.parse("2026-07-23T04:00:00.000Z");

function candidate(overrides = {}) {
  return {
    id: "9a0a942f-d7e6-47b0-ae74-4611cf23c2ca",
    status: "transcription_failed",
    processing_attempts: 1,
    error_code: "ASR_SUBMIT_NETWORK",
    updated_at: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

test("uploaded records receive a one-minute trigger grace period", () => {
  assert.equal(isRetryDue(candidate({
    status: "uploaded",
    processing_attempts: 0,
    error_code: null,
    updated_at: new Date(NOW - 59_999).toISOString(),
  }), NOW), false);
  assert.equal(isRetryDue(candidate({
    status: "uploaded",
    processing_attempts: 0,
    error_code: null,
  }), NOW), true);
});

test("failed processing uses one, five, and thirty minute retry delays", () => {
  const oneMinute = candidate({ processing_attempts: 1 });
  const fiveMinutes = candidate({
    processing_attempts: 2,
    updated_at: new Date(NOW - 5 * 60_000).toISOString(),
  });
  const thirtyMinutes = candidate({
    processing_attempts: 3,
    updated_at: new Date(NOW - 30 * 60_000).toISOString(),
  });

  assert.equal(retryDueAt(oneMinute), NOW);
  assert.equal(retryDueAt(fiveMinutes), NOW);
  assert.equal(retryDueAt(thirtyMinutes), NOW);
});

test("active claims become eligible only after three minutes", () => {
  assert.equal(isRetryDue(candidate({
    status: "transcribing",
    updated_at: new Date(NOW - 179_999).toISOString(),
  }), NOW), false);
  assert.equal(isRetryDue(candidate({
    status: "classifying",
    updated_at: new Date(NOW - 180_000).toISOString(),
  }), NOW), true);
});

test("permanent input and authorization failures are not retried automatically", () => {
  assert.equal(isRetryableErrorCode("ASR_NO_TEXT"), false);
  assert.equal(isRetryableErrorCode("RAW_TEXT_MISSING"), false);
  assert.equal(isRetryableErrorCode("ASR_SUBMIT_HTTP_400"), false);
  assert.equal(isRetryableErrorCode("QWEN_HTTP_401"), false);
  assert.equal(isRetryableErrorCode("ASR_SUBMIT_NETWORK"), true);
  assert.equal(isRetryableErrorCode(null), true);
});

test("attempt ceiling and invalid candidates are excluded", () => {
  assert.equal(isRetryDue(candidate({
    processing_attempts: MAX_PROCESSING_ATTEMPTS,
  }), NOW), false);
  assert.equal(isRetryDue(candidate({ status: "processed" }), NOW), false);
  assert.equal(isRetryDue(candidate({ updated_at: "invalid" }), NOW), false);
  assert.equal(isRetryDue(candidate({ processing_attempts: -1 }), NOW), false);
});

test("selection preserves oldest-first scan order and enforces the batch limit", () => {
  const candidates = Array.from({ length: 25 }, (_, index) => candidate({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  const selected = selectRetryCandidates(candidates, NOW, 20);
  assert.equal(selected.length, 20);
  assert.deepEqual(selected, candidates.slice(0, 20));
});
