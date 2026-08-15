export interface WeeklyReviewClaimSnapshot {
  status: string;
  updated_at: string;
  generation_attempts: number;
}

export type WeeklyReviewClaimDecision =
  | { kind: "claim"; next_attempt: number }
  | { kind: "existing" }
  | { kind: "in_progress" }
  | { kind: "exhausted" };

export interface WeeklyCompletedItem {
  record_id: string;
  title: string;
  project: string | null;
  duration_minutes: number | null;
}

export interface SourceDailyFacts {
  record_count: number;
  record_type_counts: Record<string, number>;
  completed_count: number;
  pending_follow_up_count: number;
  project_counts: Record<string, number>;
  pomodoro_count: number;
  focus_seconds: number;
}

export interface SourceDailyReview {
  id: string;
  review_date: string;
  status: string;
  completed_items: WeeklyCompletedItem[];
  pomodoro_count: number;
  focus_minutes: number;
  idea_count: number;
  inbox_count: number;
  facts: SourceDailyFacts;
  narrative: string | null;
}

export interface WeeklyFacts {
  week_start: string;
  week_end: string;
  timezone: "Asia/Shanghai";
  daily_review_count: number;
  days_with_records: number;
  record_count: number;
  record_type_counts: Record<string, number>;
  completed_count: number;
  pending_follow_up_count: number;
  project_counts: Record<string, number>;
  pomodoro_count: number;
  focus_seconds: number;
  focus_minutes: number;
  idea_count: number;
  inbox_count: number;
  outcomes_truncated: boolean;
}

export interface WeeklyAggregation {
  major_outcomes: WeeklyCompletedItem[];
  project_investment: Record<string, number>;
  unfinished_items: [];
  next_focus: [];
  pomodoro_count: number;
  focus_minutes: number;
  source_daily_review_ids: string[];
  facts: WeeklyFacts;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SOURCE_STATES = new Set(["generated", "synced"]);
const MAX_MAJOR_OUTCOMES = 500;

export function isValidDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function addDays(value: string, days: number): string {
  if (!isValidDate(value) || !Number.isInteger(days)) {
    throw new Error("invalid date arithmetic");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isMonday(value: string): boolean {
  if (!isValidDate(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1;
}

export function weekEndDate(weekStart: string): string {
  if (!isMonday(weekStart)) throw new Error("week_start must be Monday");
  return addDays(weekStart, 6);
}

export function localDateAt(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const value = `${values.year}-${values.month}-${values.day}`;
  if (!isValidDate(value)) throw new Error("could not resolve local date");
  return value;
}

export function defaultWeekStart(
  now: Date,
  timezone = "Asia/Shanghai",
): string {
  const localDate = localDateAt(now, timezone);
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return addDays(localDate, -daysSinceMonday - 7);
}

export function decideWeeklyReviewClaim(
  existing: WeeklyReviewClaimSnapshot,
  regenerate: boolean,
  nowMs: number,
  staleMs = 5 * 60 * 1000,
  maxAttempts = 4,
): WeeklyReviewClaimDecision {
  if (existing.status === "synced" ||
    (existing.status === "generated" && !regenerate)) {
    return { kind: "existing" };
  }
  const updatedAt = Date.parse(existing.updated_at);
  if (existing.status === "generating" &&
    Number.isFinite(updatedAt) && nowMs - updatedAt < staleMs) {
    return { kind: "in_progress" };
  }
  if (existing.generation_attempts >= maxAttempts && !regenerate) {
    return { kind: "exhausted" };
  }
  return {
    kind: "claim",
    next_attempt: regenerate && existing.generation_attempts >= maxAttempts
      ? 1
      : existing.generation_attempts + 1,
  };
}

function increment(
  target: Record<string, number>,
  key: string,
  amount: number,
): void {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedObject(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function aggregateWeeklyReview(
  reviews: SourceDailyReview[],
  weekStart: string,
  timezone = "Asia/Shanghai",
): WeeklyAggregation {
  if (!isMonday(weekStart)) throw new Error("week_start must be Monday");
  if (timezone !== "Asia/Shanghai") {
    throw new Error("only Asia/Shanghai is supported");
  }
  const weekEnd = weekEndDate(weekStart);
  const eligible = reviews.filter((review) =>
    SOURCE_STATES.has(review.status) &&
    review.review_date >= weekStart &&
    review.review_date <= weekEnd
  ).sort((left, right) =>
    left.review_date.localeCompare(right.review_date) ||
    left.id.localeCompare(right.id)
  );

  const typeCounts: Record<string, number> = {};
  const projectCounts: Record<string, number> = {};
  const completedItems: WeeklyCompletedItem[] = [];
  let daysWithRecords = 0;
  let recordCount = 0;
  let completedCount = 0;
  let pendingFollowUpCount = 0;
  let pomodoroCount = 0;
  let focusSeconds = 0;

  for (const review of eligible) {
    const facts = review.facts;
    recordCount += facts.record_count;
    completedCount += facts.completed_count;
    pendingFollowUpCount += facts.pending_follow_up_count;
    pomodoroCount += facts.pomodoro_count;
    focusSeconds += facts.focus_seconds;
    if (facts.record_count > 0 || facts.pomodoro_count > 0) {
      daysWithRecords += 1;
    }
    for (const [type, count] of Object.entries(facts.record_type_counts)) {
      increment(typeCounts, type, count);
    }
    for (const [project, count] of Object.entries(facts.project_counts)) {
      increment(projectCounts, project, count);
    }
    completedItems.push(...review.completed_items);
  }

  const focusMinutes = Math.floor(focusSeconds / 60);
  return {
    major_outcomes: completedItems.slice(0, MAX_MAJOR_OUTCOMES),
    project_investment: sortedObject(projectCounts),
    unfinished_items: [],
    next_focus: [],
    pomodoro_count: pomodoroCount,
    focus_minutes: focusMinutes,
    source_daily_review_ids: eligible.map((review) => review.id),
    facts: {
      week_start: weekStart,
      week_end: weekEnd,
      timezone: "Asia/Shanghai",
      daily_review_count: eligible.length,
      days_with_records: daysWithRecords,
      record_count: recordCount,
      record_type_counts: sortedObject(typeCounts),
      completed_count: completedCount,
      pending_follow_up_count: pendingFollowUpCount,
      project_counts: sortedObject(projectCounts),
      pomodoro_count: pomodoroCount,
      focus_seconds: focusSeconds,
      focus_minutes: focusMinutes,
      idea_count: typeCounts.idea ?? 0,
      inbox_count: typeCounts.inbox ?? 0,
      outcomes_truncated: completedItems.length > MAX_MAJOR_OUTCOMES,
    },
  };
}

export function parseWeeklyNarrative(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0][0] !== "narrative") return null;
  const narrative = entries[0][1];
  if (typeof narrative !== "string") return null;
  const trimmed = narrative.trim();
  const length = Array.from(trimmed).length;
  return length >= 1 && length <= 3000 ? trimmed : null;
}
