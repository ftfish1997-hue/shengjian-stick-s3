export const FINISHED_RECORD_STATES = [
  "processed",
  "notion_sync_pending",
  "synced",
  "notion_sync_failed",
] as const;

export interface DailyRecord {
  id: string;
  record_type: string | null;
  title: string | null;
  summary: string | null;
  project: string | null;
  duration_minutes: number | null;
  completed: boolean | null;
  follow_ups: unknown;
  captured_at: string | null;
  received_at: string;
  status: string;
}

export interface DailyPomodoroSession {
  id: string;
  status: string;
  actual_seconds: number | null;
}

export interface CompletedItem {
  record_id: string;
  title: string;
  project: string | null;
  duration_minutes: number | null;
}

export interface DailyFacts {
  review_date: string;
  timezone: "Asia/Shanghai";
  record_count: number;
  record_type_counts: Record<string, number>;
  completed_count: number;
  pending_follow_up_count: number;
  project_counts: Record<string, number>;
  pomodoro_count: number;
  focus_seconds: number;
}

export interface DailyAggregation {
  completed_items: CompletedItem[];
  pomodoro_count: number;
  focus_minutes: number;
  idea_count: number;
  inbox_count: number;
  source_record_ids: string[];
  facts: DailyFacts;
}

export interface DailyReviewClaimSnapshot {
  status: string;
  updated_at: string;
  generation_attempts: number;
}

export type DailyReviewClaimDecision =
  | { kind: "claim"; next_attempt: number }
  | { kind: "existing" }
  | { kind: "in_progress" }
  | { kind: "exhausted" };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const FINISHED_STATES = new Set<string>(FINISHED_RECORD_STATES);

export function isValidReviewDate(value: string): boolean {
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

export function previousDate(value: string): string {
  if (!isValidReviewDate(value)) throw new Error("invalid review date");
  const previous = new Date(`${value}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
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
  if (!isValidReviewDate(value)) throw new Error("could not resolve local date");
  return value;
}

export function defaultReviewDate(
  now: Date,
  timezone = "Asia/Shanghai",
): string {
  return previousDate(localDateAt(now, timezone));
}

export function reviewDateRange(
  reviewDate: string,
  timezone: string,
): { start: string; end: string } {
  if (!isValidReviewDate(reviewDate)) throw new Error("invalid review date");
  if (timezone !== "Asia/Shanghai") {
    throw new Error("only Asia/Shanghai is supported");
  }
  const startMs = Date.parse(`${reviewDate}T00:00:00+08:00`);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function decideDailyReviewClaim(
  existing: DailyReviewClaimSnapshot,
  regenerate: boolean,
  nowMs: number,
  staleMs = 5 * 60 * 1000,
  maxAttempts = 4,
): DailyReviewClaimDecision {
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

function eventTime(record: DailyRecord): number {
  const value = Date.parse(record.captured_at ?? record.received_at);
  return Number.isFinite(value) ? value : 0;
}

function followUpCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedObject(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function aggregateDailyReview(
  records: DailyRecord[],
  sessions: DailyPomodoroSession[],
  reviewDate: string,
  timezone = "Asia/Shanghai",
): DailyAggregation {
  if (!isValidReviewDate(reviewDate)) throw new Error("invalid review date");
  if (timezone !== "Asia/Shanghai") {
    throw new Error("only Asia/Shanghai is supported");
  }

  const eligible = records.filter((record) => FINISHED_STATES.has(record.status))
    .sort((left, right) => eventTime(left) - eventTime(right) ||
      left.id.localeCompare(right.id));
  const typeCounts: Record<string, number> = {};
  const projectCounts: Record<string, number> = {};
  const completedItems: CompletedItem[] = [];
  let pendingFollowUpCount = 0;

  for (const record of eligible) {
    increment(typeCounts, record.record_type ?? "unclassified");
    const project = record.project?.trim();
    if (project) increment(projectCounts, project);
    pendingFollowUpCount += followUpCount(record.follow_ups);
    if (record.completed === true) {
      completedItems.push({
        record_id: record.id,
        title: record.title?.trim() || "已完成事项",
        project: project || null,
        duration_minutes: record.duration_minutes,
      });
    }
  }

  const completedSessions = sessions.filter((session) =>
    session.status === "completed" &&
    typeof session.actual_seconds === "number" &&
    Number.isFinite(session.actual_seconds) &&
    session.actual_seconds >= 0
  );
  const focusSeconds = completedSessions.reduce(
    (total, session) => total + (session.actual_seconds ?? 0),
    0,
  );

  return {
    completed_items: completedItems,
    pomodoro_count: completedSessions.length,
    focus_minutes: Math.floor(focusSeconds / 60),
    idea_count: typeCounts.idea ?? 0,
    inbox_count: typeCounts.inbox ?? 0,
    source_record_ids: eligible.map((record) => record.id),
    facts: {
      review_date: reviewDate,
      timezone: "Asia/Shanghai",
      record_count: eligible.length,
      record_type_counts: sortedObject(typeCounts),
      completed_count: completedItems.length,
      pending_follow_up_count: pendingFollowUpCount,
      project_counts: sortedObject(projectCounts),
      pomodoro_count: completedSessions.length,
      focus_seconds: focusSeconds,
    },
  };
}

export function parseDailyNarrative(value: unknown): string | null {
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
