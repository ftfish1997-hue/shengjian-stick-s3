import { createClient } from "npm:@supabase/supabase-js@2";
import {
  aggregateWeeklyReview,
  decideWeeklyReviewClaim,
  defaultWeekStart,
  isMonday,
  isValidDate,
  localDateAt,
  parseWeeklyNarrative,
  weekEndDate,
} from "../_shared/weekly_review.ts";
import type {
  SourceDailyFacts,
  SourceDailyReview,
  WeeklyAggregation,
  WeeklyCompletedItem,
} from "../_shared/weekly_review.ts";
import { jsonResponse } from "../_shared/http.ts";

const USER_TIMEZONE = "Asia/Shanghai";
const PROMPT_VERSION = "qwen-turbo-weekly-review-v1";
const EMPTY_PROMPT_VERSION = "deterministic-empty-weekly-review-v1";
const CLAIM_STALE_MS = 5 * 60 * 1000;
const MAX_GENERATION_ATTEMPTS = 4;
const MAX_SOURCE_ROWS = 7;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupabaseClient = ReturnType<typeof createClient>;

interface WeeklyReviewRow {
  id: string;
  week_start: string;
  week_end: string;
  status: string;
  updated_at: string;
  generation_attempts: number;
  narrative: string | null;
  prompt_version: string | null;
}

type ClaimResult =
  | { kind: "claimed"; row: WeeklyReviewRow }
  | { kind: "existing"; row: WeeklyReviewRow }
  | { kind: "in_progress"; row: WeeklyReviewRow }
  | { kind: "exhausted"; row: WeeklyReviewRow };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

class NarrativeError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCountObject(value: unknown): value is Record<string, number> {
  return isObject(value) &&
    Object.entries(value).every(([key, count]) =>
      key.length > 0 && key.length <= 120 && isNonNegativeInteger(count)
    );
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(500, "SERVER_MISCONFIGURED", `${name} is not configured`);
  }
  return value;
}

function requiredUrlEnvironment(name: string): string {
  return requiredEnvironment(name).replace(/\/$/, "");
}

function serviceRoleKey(): string {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacyKey) return legacyKey;
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, unknown>;
      if (typeof parsed.default === "string" && parsed.default.length > 0) {
        return parsed.default;
      }
    } catch {
      throw new HttpError(
        500,
        "SERVER_MISCONFIGURED",
        "SUPABASE_SECRET_KEYS is not valid JSON",
      );
    }
  }
  throw new HttpError(500, "SERVER_MISCONFIGURED", "Supabase server key is not configured");
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; ++index) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authorize(request: Request): void {
  const expected = requiredEnvironment("WEEKLY_REVIEW_TOKEN");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{32,256})$/.exec(authorization);
  if (!match || !constantTimeEqual(match[1], expected)) {
    throw new HttpError(401, "WEEKLY_REVIEW_UNAUTHORIZED", "Invalid weekly review token");
  }
}

function parseRequestBody(
  body: unknown,
  now: Date,
): { weekStart: string; weekEnd: string; regenerate: boolean } {
  if (body !== null &&
    (!isObject(body) ||
      Object.keys(body).some((key) => key !== "week_start" && key !== "regenerate"))) {
    throw new HttpError(400, "INVALID_REQUEST", "Request contains unknown fields");
  }
  const value = body as Record<string, unknown> | null;
  const requestedStart = value?.week_start;
  if (requestedStart !== undefined &&
    (typeof requestedStart !== "string" ||
      !isValidDate(requestedStart) ||
      !isMonday(requestedStart))) {
    throw new HttpError(400, "INVALID_REQUEST", "week_start must be a Monday in YYYY-MM-DD");
  }
  const regenerate = value?.regenerate;
  if (regenerate !== undefined && typeof regenerate !== "boolean") {
    throw new HttpError(400, "INVALID_REQUEST", "regenerate must be boolean");
  }
  const weekStart = typeof requestedStart === "string"
    ? requestedStart
    : defaultWeekStart(now, USER_TIMEZONE);
  const weekEnd = weekEndDate(weekStart);
  if (weekEnd >= localDateAt(now, USER_TIMEZONE)) {
    throw new HttpError(400, "INVALID_REQUEST", "week_start must identify a completed week");
  }
  return { weekStart, weekEnd, regenerate: regenerate === true };
}

function isReviewRow(value: unknown): value is WeeklyReviewRow {
  return isObject(value) &&
    typeof value.id === "string" && UUID_PATTERN.test(value.id) &&
    typeof value.week_start === "string" &&
    typeof value.week_end === "string" &&
    typeof value.status === "string" &&
    typeof value.updated_at === "string" &&
    isNonNegativeInteger(value.generation_attempts) &&
    (value.narrative === null || typeof value.narrative === "string") &&
    (value.prompt_version === null || typeof value.prompt_version === "string");
}

async function loadReview(
  supabase: SupabaseClient,
  weekStart: string,
): Promise<WeeklyReviewRow | null> {
  const { data, error } = await supabase.from("weekly_reviews")
    .select(
      "id,week_start,week_end,status,updated_at,generation_attempts,narrative,prompt_version",
    )
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw new HttpError(503, "DATABASE_READ_FAILED", "Weekly review lookup failed");
  if (data === null) return null;
  if (!isReviewRow(data)) {
    throw new HttpError(503, "DATABASE_INVALID_ROW", "Weekly review row is invalid");
  }
  return data;
}

async function claimReview(
  supabase: SupabaseClient,
  weekStart: string,
  weekEnd: string,
  regenerate: boolean,
  now: Date,
): Promise<ClaimResult> {
  const existing = await loadReview(supabase, weekStart);
  if (!existing) {
    const { data, error } = await supabase.from("weekly_reviews").insert({
      week_start: weekStart,
      week_end: weekEnd,
      timezone: USER_TIMEZONE,
      status: "generating",
      generation_attempts: 1,
      last_generation_started_at: now.toISOString(),
      error_code: null,
    }).select(
      "id,week_start,week_end,status,updated_at,generation_attempts,narrative,prompt_version",
    ).single();
    if (!error && isReviewRow(data)) return { kind: "claimed", row: data };
    if (error?.code === "23505") {
      const raced = await loadReview(supabase, weekStart);
      if (raced) return { kind: "in_progress", row: raced };
    }
    throw new HttpError(503, "DATABASE_CLAIM_FAILED", "Weekly review claim failed");
  }

  const decision = decideWeeklyReviewClaim(
    existing,
    regenerate,
    now.getTime(),
    CLAIM_STALE_MS,
    MAX_GENERATION_ATTEMPTS,
  );
  if (decision.kind === "existing") return { kind: "existing", row: existing };
  if (decision.kind === "in_progress") return { kind: "in_progress", row: existing };
  if (decision.kind === "exhausted") return { kind: "exhausted", row: existing };

  const { data, error } = await supabase.from("weekly_reviews").update({
    week_end: weekEnd,
    status: "generating",
    generation_attempts: decision.next_attempt,
    last_generation_started_at: now.toISOString(),
    error_code: null,
    narrative: null,
    prompt_version: null,
  }).eq("id", existing.id)
    .eq("status", existing.status)
    .eq("updated_at", existing.updated_at)
    .select(
      "id,week_start,week_end,status,updated_at,generation_attempts,narrative,prompt_version",
    )
    .maybeSingle();
  if (error) throw new HttpError(503, "DATABASE_CLAIM_FAILED", "Weekly review claim failed");
  if (!data) return { kind: "in_progress", row: existing };
  if (!isReviewRow(data)) {
    throw new HttpError(503, "DATABASE_INVALID_ROW", "Claimed weekly review is invalid");
  }
  return { kind: "claimed", row: data };
}

function isCompletedItem(value: unknown): value is WeeklyCompletedItem {
  return isObject(value) &&
    typeof value.record_id === "string" && UUID_PATTERN.test(value.record_id) &&
    typeof value.title === "string" &&
    (value.project === null || typeof value.project === "string") &&
    (value.duration_minutes === null || isNonNegativeInteger(value.duration_minutes));
}

function isDailyFacts(value: unknown): value is SourceDailyFacts {
  return isObject(value) &&
    isNonNegativeInteger(value.record_count) &&
    isCountObject(value.record_type_counts) &&
    isNonNegativeInteger(value.completed_count) &&
    isNonNegativeInteger(value.pending_follow_up_count) &&
    isCountObject(value.project_counts) &&
    isNonNegativeInteger(value.pomodoro_count) &&
    isNonNegativeInteger(value.focus_seconds);
}

function isSourceDailyReview(value: unknown): value is SourceDailyReview {
  return isObject(value) &&
    typeof value.id === "string" && UUID_PATTERN.test(value.id) &&
    typeof value.review_date === "string" && isValidDate(value.review_date) &&
    typeof value.status === "string" &&
    Array.isArray(value.completed_items) &&
    value.completed_items.every(isCompletedItem) &&
    isNonNegativeInteger(value.pomodoro_count) &&
    isNonNegativeInteger(value.focus_minutes) &&
    isNonNegativeInteger(value.idea_count) &&
    isNonNegativeInteger(value.inbox_count) &&
    isDailyFacts(value.facts) &&
    (value.narrative === null || typeof value.narrative === "string");
}

async function loadSources(
  supabase: SupabaseClient,
  weekStart: string,
  weekEnd: string,
): Promise<SourceDailyReview[]> {
  const { data, error, count } = await supabase.from("daily_reviews").select(
    "id,review_date,status,completed_items,pomodoro_count,focus_minutes," +
      "idea_count,inbox_count,facts,narrative",
    { count: "exact" },
  ).in("status", ["generated", "synced"])
    .gte("review_date", weekStart)
    .lte("review_date", weekEnd)
    .order("review_date", { ascending: true })
    .limit(MAX_SOURCE_ROWS);
  if (error) {
    throw new HttpError(503, "DATABASE_READ_FAILED", "Daily review scan failed");
  }
  if ((count ?? 0) > MAX_SOURCE_ROWS) {
    throw new HttpError(409, "SOURCE_LIMIT_EXCEEDED", "Weekly daily-review count exceeds limit");
  }
  const reviews = (data ?? []).filter(isSourceDailyReview);
  if (reviews.length !== (data ?? []).length) {
    throw new HttpError(503, "DATABASE_INVALID_ROW", "Daily review source row is invalid");
  }
  return reviews;
}

async function persistFacts(
  supabase: SupabaseClient,
  reviewId: string,
  aggregation: WeeklyAggregation,
): Promise<void> {
  const { data, error } = await supabase.from("weekly_reviews").update({
    major_outcomes: aggregation.major_outcomes,
    project_investment: aggregation.project_investment,
    unfinished_items: aggregation.unfinished_items,
    next_focus: aggregation.next_focus,
    pomodoro_count: aggregation.pomodoro_count,
    focus_minutes: aggregation.focus_minutes,
    source_daily_review_ids: aggregation.source_daily_review_ids,
    facts: aggregation.facts,
  }).eq("id", reviewId).eq("status", "generating")
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new HttpError(503, "DATABASE_WRITE_FAILED", "Weekly facts save failed");
  }
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function narrativeInput(
  aggregation: WeeklyAggregation,
  reviews: SourceDailyReview[],
): Record<string, unknown> {
  return {
    facts: aggregation.facts,
    major_outcomes: aggregation.major_outcomes,
    daily_reviews: reviews.map((review) => ({
      review_date: review.review_date,
      narrative: review.narrative ? truncate(review.narrative, 1000) : null,
    })),
  };
}

function narrativePrompt(): string {
  return [
    "你是个人周报助手，只输出一个 JSON 对象，不要 Markdown。",
    "只能根据输入 facts、major_outcomes 和 daily_reviews 叙述，严禁补造事项、项目、时长、数量、完成状态或下周计划。",
    "数字必须与 facts 完全一致；没有来源内容时不得虚构活动。",
    "输出必须且只能包含 narrative，内容使用简洁中文，概括本周完成、投入分布与仍待关注的数量事实，最多 3000 字。",
  ].join("\n");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function generateNarrative(
  aggregation: WeeklyAggregation,
  reviews: SourceDailyReview[],
): Promise<{ narrative: string; promptVersion: string }> {
  if (aggregation.facts.record_count === 0 &&
    aggregation.facts.pomodoro_count === 0) {
    return {
      narrative: "这一周没有已生成且包含记录或专注数据的日报。",
      promptVersion: EMPTY_PROMPT_VERSION,
    };
  }

  const apiHost = requiredUrlEnvironment("DASHSCOPE_API_HOST");
  const apiKey = requiredEnvironment("DASHSCOPE_API_KEY");
  const model = Deno.env.get("DASHSCOPE_WEEKLY_REVIEW_MODEL")?.trim() ||
    Deno.env.get("DASHSCOPE_DAILY_REVIEW_MODEL")?.trim() ||
    Deno.env.get("DASHSCOPE_CLASSIFICATION_MODEL")?.trim() ||
    "qwen-turbo";
  let response: Response;
  try {
    response = await fetch(
      `${apiHost}/services/aigc/text-generation/generation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: {
            messages: [
              { role: "system", content: narrativePrompt() },
              {
                role: "user",
                content: JSON.stringify(narrativeInput(aggregation, reviews)),
              },
            ],
          },
          parameters: {
            result_format: "message",
            response_format: { type: "json_object" },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new NarrativeError("QWEN_NETWORK", "Weekly narrative request failed");
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new NarrativeError(
      `QWEN_HTTP_${response.status}`,
      "Weekly narrative request failed",
    );
  }
  const output = isObject(body) && isObject(body.output) ? body.output : null;
  const choice = output && Array.isArray(output.choices) && isObject(output.choices[0])
    ? output.choices[0]
    : null;
  const message = choice && isObject(choice.message) ? choice.message : null;
  const content = message?.content;
  if (typeof content !== "string") {
    throw new NarrativeError("QWEN_RESPONSE_INVALID", "Qwen response has no content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new NarrativeError("QWEN_JSON_INVALID", "Qwen response is not JSON");
  }
  const narrative = parseWeeklyNarrative(parsed);
  if (!narrative) {
    throw new NarrativeError("QWEN_SCHEMA_INVALID", "Qwen narrative is invalid");
  }
  return { narrative, promptVersion: PROMPT_VERSION };
}

async function markFailed(
  supabase: SupabaseClient,
  reviewId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await supabase.from("weekly_reviews").update({
    status: "failed",
    error_code: errorCode.slice(0, 200),
  }).eq("id", reviewId).eq("status", "generating");
  if (error) console.error("failed to persist weekly review error", reviewId);
}

async function markGenerated(
  supabase: SupabaseClient,
  reviewId: string,
  narrative: string,
  promptVersion: string,
): Promise<void> {
  const { data, error } = await supabase.from("weekly_reviews").update({
    narrative,
    prompt_version: promptVersion,
    status: "generated",
    error_code: null,
  }).eq("id", reviewId).eq("status", "generating")
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new HttpError(503, "DATABASE_WRITE_FAILED", "Weekly narrative save failed");
  }
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is supported");
    }
    authorize(request);
    const text = await request.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
      }
    }
    const now = new Date();
    const { weekStart, weekEnd, regenerate } = parseRequestBody(body, now);
    const configuredTimezone = Deno.env.get("USER_TIMEZONE")?.trim() || USER_TIMEZONE;
    if (configuredTimezone !== USER_TIMEZONE) {
      throw new HttpError(
        500,
        "SERVER_MISCONFIGURED",
        "weekly-review currently requires Asia/Shanghai",
      );
    }

    const supabase = createClient(requiredUrlEnvironment("SUPABASE_URL"), serviceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const claim = await claimReview(
      supabase,
      weekStart,
      weekEnd,
      regenerate,
      now,
    );
    if (claim.kind === "existing") {
      return jsonResponse({
        success: true,
        review_id: claim.row.id,
        week_start: weekStart,
        week_end: weekEnd,
        status: claim.row.status,
        duplicate: true,
        narrative: claim.row.narrative,
        prompt_version: claim.row.prompt_version,
      });
    }
    if (claim.kind === "in_progress") {
      return jsonResponse({
        success: true,
        review_id: claim.row.id,
        week_start: weekStart,
        week_end: weekEnd,
        status: "generating",
        duplicate: true,
      }, 202);
    }
    if (claim.kind === "exhausted") {
      throw new HttpError(
        409,
        "GENERATION_ATTEMPTS_EXHAUSTED",
        "Weekly review requires an explicit regenerate request",
      );
    }

    try {
      const reviews = await loadSources(supabase, weekStart, weekEnd);
      const aggregation = aggregateWeeklyReview(
        reviews,
        weekStart,
        USER_TIMEZONE,
      );
      await persistFacts(supabase, claim.row.id, aggregation);
      const generated = await generateNarrative(aggregation, reviews);
      await markGenerated(
        supabase,
        claim.row.id,
        generated.narrative,
        generated.promptVersion,
      );
      return jsonResponse({
        success: true,
        review_id: claim.row.id,
        week_start: weekStart,
        week_end: weekEnd,
        status: "generated",
        duplicate: false,
        narrative: generated.narrative,
        prompt_version: generated.promptVersion,
        facts: aggregation.facts,
      });
    } catch (error) {
      const code = error instanceof NarrativeError
        ? error.errorCode
        : error instanceof HttpError
        ? error.errorCode
        : "WEEKLY_REVIEW_INTERNAL";
      await markFailed(supabase, claim.row.id, code);
      throw error;
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(
        { success: false, error_code: error.errorCode, message: error.message },
        error.status,
      );
    }
    if (error instanceof NarrativeError) {
      return jsonResponse(
        { success: false, error_code: error.errorCode, message: error.message },
        502,
      );
    }
    console.error("unexpected weekly-review error", error);
    return jsonResponse(
      { success: false, error_code: "SERVER_INTERNAL", message: "Unexpected server error" },
      500,
    );
  }
}

export default {
  fetch: handleRequest,
};
