import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateDailyReview,
  decideDailyReviewClaim,
  defaultReviewDate,
  isValidReviewDate,
  parseDailyNarrative,
  reviewDateRange,
} from "./daily_review.ts";

function record(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    record_type: "activity",
    title: "完成日报逻辑",
    summary: "实现确定性聚合",
    project: "Voice Inbox",
    duration_minutes: 20,
    completed: true,
    follow_ups: [],
    captured_at: "2026-07-23T02:00:00.000Z",
    received_at: "2026-07-23T02:00:01.000Z",
    status: "processed",
    ...overrides,
  };
}

test("validates calendar dates and defaults to the previous Shanghai day", () => {
  assert.equal(isValidReviewDate("2026-02-28"), true);
  assert.equal(isValidReviewDate("2026-02-30"), false);
  assert.equal(
    defaultReviewDate(new Date("2026-07-23T16:30:00.000Z")),
    "2026-07-23",
  );
});

test("converts a Shanghai review date to an exact UTC half-open range", () => {
  assert.deepEqual(reviewDateRange("2026-07-23", "Asia/Shanghai"), {
    start: "2026-07-22T16:00:00.000Z",
    end: "2026-07-23T16:00:00.000Z",
  });
});

test("aggregates only finished records with deterministic ordering", () => {
  const result = aggregateDailyReview(
    [
      record({
        id: "00000000-0000-4000-8000-000000000002",
        record_type: "idea",
        completed: false,
        project: null,
        follow_ups: [{ content: "验证", due_date: null }],
        captured_at: "2026-07-23T03:00:00.000Z",
      }),
      record(),
      record({
        id: "00000000-0000-4000-8000-000000000003",
        status: "classification_failed",
      }),
      record({
        id: "00000000-0000-4000-8000-000000000004",
        record_type: "inbox",
        completed: null,
        project: "Voice Inbox",
        captured_at: "2026-07-23T04:00:00.000Z",
      }),
    ],
    [
      { id: "p1", status: "completed", actual_seconds: 1499 },
      { id: "p2", status: "completed", actual_seconds: 1501 },
      { id: "p3", status: "interrupted", actual_seconds: 500 },
    ],
    "2026-07-23",
  );

  assert.deepEqual(result.source_record_ids, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000004",
  ]);
  assert.equal(result.completed_items.length, 1);
  assert.equal(result.idea_count, 1);
  assert.equal(result.inbox_count, 1);
  assert.equal(result.pomodoro_count, 2);
  assert.equal(result.focus_minutes, 50);
  assert.equal(result.facts.pending_follow_up_count, 1);
  assert.deepEqual(result.facts.record_type_counts, {
    activity: 1,
    idea: 1,
    inbox: 1,
  });
  assert.deepEqual(result.facts.project_counts, { "Voice Inbox": 2 });
});

test("accepts only an exact bounded narrative object", () => {
  assert.equal(parseDailyNarrative({ narrative: " 今天完成了日报逻辑。 " }),
    "今天完成了日报逻辑。");
  assert.equal(parseDailyNarrative({ narrative: "", extra: true }), null);
  assert.equal(parseDailyNarrative({ narrative: "" }), null);
  assert.equal(parseDailyNarrative({ narrative: "x".repeat(3001) }), null);
});

test("claim decisions suppress duplicates and bound automatic retries", () => {
  const now = Date.parse("2026-07-24T00:00:00.000Z");
  const snapshot = {
    status: "generating",
    updated_at: new Date(now - 60_000).toISOString(),
    generation_attempts: 1,
  };
  assert.deepEqual(decideDailyReviewClaim(snapshot, false, now), {
    kind: "in_progress",
  });
  assert.deepEqual(decideDailyReviewClaim({
    ...snapshot,
    status: "generated",
  }, false, now), { kind: "existing" });
  assert.deepEqual(decideDailyReviewClaim({
    ...snapshot,
    status: "failed",
    generation_attempts: 3,
  }, false, now), { kind: "claim", next_attempt: 4 });
  assert.deepEqual(decideDailyReviewClaim({
    ...snapshot,
    status: "failed",
    generation_attempts: 4,
  }, false, now), { kind: "exhausted" });
  assert.deepEqual(decideDailyReviewClaim({
    ...snapshot,
    status: "failed",
    generation_attempts: 4,
  }, true, now), { kind: "claim", next_attempt: 1 });
  assert.deepEqual(decideDailyReviewClaim({
    ...snapshot,
    status: "synced",
  }, true, now), { kind: "existing" });
});
