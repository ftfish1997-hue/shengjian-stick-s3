import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  aggregateWeeklyReview,
  decideWeeklyReviewClaim,
  defaultWeekStart,
  isMonday,
  parseWeeklyNarrative,
  weekEndDate,
} from "./weekly_review.ts";

function daily(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    review_date: "2026-07-20",
    status: "generated",
    completed_items: [{
      record_id: "00000000-0000-4000-8000-000000000001",
      title: "完成周报逻辑",
      project: "Voice Inbox",
      duration_minutes: 30,
    }],
    pomodoro_count: 2,
    focus_minutes: 50,
    idea_count: 1,
    inbox_count: 2,
    facts: {
      record_count: 4,
      record_type_counts: { idea: 1, inbox: 2, task: 1 },
      completed_count: 1,
      pending_follow_up_count: 1,
      project_counts: { "Voice Inbox": 3 },
      pomodoro_count: 2,
      focus_seconds: 3000,
    },
    narrative: "完成了周报逻辑。",
    ...overrides,
  };
}

test("resolves the previous complete Monday-to-Sunday week in Shanghai", () => {
  assert.equal(
    defaultWeekStart(new Date("2026-07-23T16:30:00.000Z")),
    "2026-07-13",
  );
  assert.equal(isMonday("2026-07-13"), true);
  assert.equal(isMonday("2026-07-14"), false);
  assert.equal(weekEndDate("2026-07-13"), "2026-07-19");
  assert.equal(addDays("2026-07-31", 1), "2026-08-01");
});

test("aggregates only generated or synced daily reviews deterministically", () => {
  const result = aggregateWeeklyReview([
    daily({
      id: "00000000-0000-4000-8000-000000000012",
      review_date: "2026-07-22",
      status: "synced",
      completed_items: [],
      pomodoro_count: 1,
      focus_minutes: 25,
      idea_count: 0,
      inbox_count: 1,
      facts: {
        record_count: 1,
        record_type_counts: { inbox: 1 },
        completed_count: 0,
        pending_follow_up_count: 2,
        project_counts: { Personal: 1 },
        pomodoro_count: 1,
        focus_seconds: 1500,
      },
    }),
    daily(),
    daily({
      id: "00000000-0000-4000-8000-000000000013",
      review_date: "2026-07-21",
      status: "failed",
    }),
    daily({
      id: "00000000-0000-4000-8000-000000000014",
      review_date: "2026-07-27",
    }),
  ], "2026-07-20");

  assert.deepEqual(result.source_daily_review_ids, [
    "00000000-0000-4000-8000-000000000010",
    "00000000-0000-4000-8000-000000000012",
  ]);
  assert.equal(result.facts.daily_review_count, 2);
  assert.equal(result.facts.days_with_records, 2);
  assert.equal(result.facts.record_count, 5);
  assert.equal(result.facts.completed_count, 1);
  assert.equal(result.facts.pending_follow_up_count, 3);
  assert.equal(result.pomodoro_count, 3);
  assert.equal(result.facts.focus_seconds, 4500);
  assert.equal(result.focus_minutes, 75);
  assert.deepEqual(result.facts.record_type_counts, {
    idea: 1,
    inbox: 3,
    task: 1,
  });
  assert.deepEqual(result.project_investment, {
    Personal: 1,
    "Voice Inbox": 3,
  });
  assert.deepEqual(result.unfinished_items, []);
  assert.deepEqual(result.next_focus, []);
});

test("accepts only an exact bounded weekly narrative object", () => {
  assert.equal(parseWeeklyNarrative({ narrative: " 本周完成了周报逻辑。 " }),
    "本周完成了周报逻辑。");
  assert.equal(parseWeeklyNarrative({ narrative: "", extra: true }), null);
  assert.equal(parseWeeklyNarrative({ narrative: "" }), null);
  assert.equal(parseWeeklyNarrative({ narrative: "x".repeat(3001) }), null);
});

test("weekly claim decisions suppress duplicates and bound retries", () => {
  const now = Date.parse("2026-07-24T00:00:00.000Z");
  const snapshot = {
    status: "generating",
    updated_at: new Date(now - 60_000).toISOString(),
    generation_attempts: 1,
  };
  assert.deepEqual(decideWeeklyReviewClaim(snapshot, false, now), {
    kind: "in_progress",
  });
  assert.deepEqual(decideWeeklyReviewClaim({
    ...snapshot,
    status: "generated",
  }, false, now), { kind: "existing" });
  assert.deepEqual(decideWeeklyReviewClaim({
    ...snapshot,
    status: "failed",
    generation_attempts: 4,
  }, false, now), { kind: "exhausted" });
  assert.deepEqual(decideWeeklyReviewClaim({
    ...snapshot,
    status: "failed",
    generation_attempts: 4,
  }, true, now), { kind: "claim", next_attempt: 1 });
  assert.deepEqual(decideWeeklyReviewClaim({
    ...snapshot,
    status: "synced",
  }, true, now), { kind: "existing" });
});
