import { createClient } from "npm:@supabase/supabase-js@2";
import {
  FINISHED_RECORD_STATES,
  aggregateDailyReview,
  decideDailyReviewClaim,
  defaultReviewDate,
  isValidReviewDate,
  localDateAt,
  parseDailyNarrative,
  reviewDateRange,
} from "../_shared/daily_review.ts";
import type {
  DailyAggregation,
  DailyPomodoroSession,
  DailyRecord,
} from "../_shared/daily_review.ts";
import { jsonResponse } from "../_shared/http.ts";

const USER_TIMEZONE = "Asia/Shanghai";
const PROMPT_VERSION = "qwen-turbo-daily-review-v1";
const EMPTY_PROMPT_VERSION = "deterministic-empty-daily-review-v1";
const CLAIM_STALE_MS = 5 * 60 * 1000;
const MAX_GENERATION_ATTEMPTS = 4;
const MAX_SOURCE_ROWS = 1000;
const MAX_NARRATIVE_RECORDS = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupabaseClient = ReturnType<typeof createClient>;

interface DailyReviewRow {
  id: string;
  review_date: string;
  status: string;
  updated_at: string;
  generation_attempts: number;
  narrative: string | null;
  prompt_version: string | null;
}

type ClaimResult =
  | { kind: "claimed"; row: DailyReviewRow }
  | { kind: "existing"; row: DailyReviewRow }
  | { kind: "in_progress"; row: DailyReviewRow }
  | { kind: "exhausted"; row: DailyReviewRow };

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
  const expected = requiredEnvironment("DAILY_REVIEW_TOKEN");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{32,256})$/.exec(authorization);
  if (!match || !constantTimeEqual(match[1], expected)) {
    throw new HttpError(401, "DAILY_REVIEW_UNAUTHORIZED", "Invalid daily review token");
  }
}

function parseRequestBody(
  body: unknown,
  now: Date,
): { reviewDate: string; regenerate: boolean } {
  if (body !== null &&
    (!isObject(body) ||
      Object.keys(body).some((key) => key !== "review_date" && key !== "regenerate"))) {
    throw new HttpError(400, "INVALID_REQUEST", "Request contains unknown fields");
  }
  const value = body as Record<string, unknown> | null;
  const requestedDate = value?.review_date;
  if (requestedDate !== undefined &&
    (typeof requestedDate !== "string" || !isValidReviewDate(requestedDate))) {
    throw new HttpError(400, "INVALID_REQUEST", "review_date must be YYYY-MM-DD");
  }
  const regenerate = value?.regenerate;
  if (regenerate !== undefined && typeof regenerate !== "boolean") {
    throw new HttpError(400, "INVALID_REQUEST", "regenerate must be boolean");
  }
  const reviewDate = typeof requestedDate === "string"
    ? requestedDate
    : defaultReviewDate(now, USER_TIMEZONE);
  if (reviewDate > localDateAt(now, USER_TIMEZONE)) {
    throw new HttpError(400, "INVALID_REQUEST", "review_date cannot be in the future");
  }
  return { reviewDate, regenerate: regenerate === true };
}

function isReviewRow(value: unknown): value is DailyReviewRow {
  return isObject(value) &&
    typeof value.id === "string" && UUID_PATTERN.test(value.id) &&
    typeof value.review_date === "string" &&
    typeof value.status === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.generation_attempts === "number" &&
    (value.narrative === null || typeof value.narrative === "string") &&
    (value.prompt_version === null || typeof value.prompt_version === "string");
}

async function loadReview(
  supabase: SupabaseClient,
  reviewDate: string,
): Promise<DailyReviewRow | null> {
  const { data, error } = await supabase.from("daily_reviews")
    .select(
      "id,review_date,status,updated_at,generation_attempts,narrative,prompt_version",
    )
    .eq("review_date", reviewDate)
    .maybeSingle();
  if (error) throw new HttpError(503, "DATABASE_READ_FAILED", "Daily review lookup failed");
  if (data === null) return null;
  if (!isReviewRow(data)) {
    throw new HttpError(503, "DATABASE_INVALID_ROW", "Daily review row is invalid");
  }
  return data;
}

async function claimReview(
  supabase: SupabaseClient,
  reviewDate: string,
  regenerate: boolean,
  now: Date,
): Promise<ClaimResult> {
  const existing = await loadReview(supabase, reviewDate);
  if (!existing) {
    const { data, error } = await supabase.from("daily_reviews").insert({
      review_date: reviewDate,
      timezone: USER_TIMEZONE,
      status: "generating",
      generation_attempts: 1,
      last_generation_started_at: now.toISOString(),
      error_code: null,
    }).select(
      "id,review_date,status,updated_at,generation_attempts,narrative,prompt_version",
    ).single();
    if (!error && isReviewRow(data)) return { kind: "claimed", row: data };
    if (error?.code === "23505") {
      const raced = await loadReview(supabase, reviewDate);
      if (raced) return { kind: "in_progress", row: raced };
    }
    throw new HttpError(503, "DATABASE_CLAIM_FAILED", "Daily review claim failed");
  }

  const decision = decideDailyReviewClaim(
    existing,
    regenerate,
    now.getTime(),
    CLAIM_STALE_MS,
    MAX_GENERATION_ATTEMPTS,
  );
  if (decision.kind === "existing") {
    return { kind: "existing", row: existing };
  }
  if (decision.kind === "in_progress") {
    return { kind: "in_progress", row: existing };
  }
  if (decision.kind === "exhausted") {
    return { kind: "exhausted", row: existing };
  }

  const { data, error } = await supabase.from("daily_reviews").update({
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
      "id,review_date,status,updated_at,generation_attempts,narrative,prompt_version",
    )
    .maybeSingle();
  if (error) throw new HttpError(503, "DATABASE_CLAIM_FAILED", "Daily review claim failed");
  if (!data) return { kind: "in_progress", row: existing };
  if (!isReviewRow(data)) {
    throw new HttpError(503, "DATABASE_INVALID_ROW", "Claimed daily review is invalid");
  }
  return { kind: "claimed", row: data };
}

function isDailyRecord(value: unknown): value is DailyRecord {
  return isObject(value) &&
    typeof value.id === "string" && UUID_PATTERN.test(value.id) &&
    (value.record_type === null || typeof value.record_type === "string") &&
    (value.title === null || typeof value.title === "string") &&
    (value.summary === null || typeof value.summary === "string") &&
    (value.project === null || typeof value.project === "string") &&
    (value.duration_minutes === null || typeof value.duration_minutes === "number") &&
    (value.completed === null || typeof value.completed === "boolean") &&
    (value.captured_at === null || typeof value.captured_at === "string") &&
    typeof value.received_at === "string" &&
    typeof value.status === "string";
}

function isPomodoroSession(value: unknown): value is DailyPomodoroSession {
  return isObject(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    (value.actual_seconds === null || typeof value.actual_seconds === "number");
}

async function loadSources(
  supabase: SupabaseClient,
  reviewDate: string,
): Promise<{ records: DailyRecord[]; sessions: DailyPomodoroSession[] }> {
  const range = reviewDateRange(reviewDate, USER_TIMEZONE);
  const recordRange = [
    `and(captured_at.gte.${range.start},captured_at.lt.${range.end})`,
    `and(captured_at.is.null,received_at.gte.${range.start},received_at.lt.${range.end})`,
  ].join(",");
  const { data: recordData, error: recordError, count: recordCount } =
    await supabase.from("records").select(
      "id,record_type,title,summary,project,duration_minutes,completed," +
        "follow_ups,captured_at,received_at,status",
      { count: "exact" },
    ).in("status", [...FINISHED_RECORD_STATES])
      .or(recordRange)
      .order("received_at", { ascending: true })
      .limit(MAX_SOURCE_ROWS);
  if (recordError) {
    throw new HttpError(503, "DATABASE_READ_FAILED", "Daily record scan failed");
  }
  if ((recordCount ?? 0) > MAX_SOURCE_ROWS) {
    throw new HttpError(409, "SOURCE_LIMIT_EXCEEDED", "Daily record count exceeds safe limit");
  }

  const { data: sessionData, error: sessionError, count: sessionCount } =
    await supabase.from("pomodoro_sessions").select(
      "id,status,actual_seconds",
      { count: "exact" },
    ).eq("status", "completed")
      .gte("started_at", range.start)
      .lt("started_at", range.end)
      .order("started_at", { ascending: true })
      .limit(MAX_SOURCE_ROWS);
  if (sessionError) {
    throw new HttpError(503, "DATABASE_READ_FAILED", "Pomodoro session scan failed");
  }
  if ((sessionCount ?? 0) > MAX_SOURCE_ROWS) {
    throw new HttpError(409, "SOURCE_LIMIT_EXCEEDED", "Pomodoro count exceeds safe limit");
  }

  const records = (recordData ?? []).filter(isDailyRecord);
  const sessions = (sessionData ?? []).filter(isPomodoroSession);
  if (records.length !== (recordData ?? []).length ||
    sessions.length !== (sessionData ?? []).length) {
    throw new HttpError(503, "DATABASE_INVALID_ROW", "Daily source row is invalid");
  }
  return { records, sessions };
}

async function persistFacts(
  supabase: SupabaseClient,
  reviewId: string,
  aggregation: DailyAggregation,
): Promise<void> {
  const { data, error } = await supabase.from("daily_reviews").update({
    completed_items: aggregation.completed_items,
    pomodoro_count: aggregation.pomodoro_count,
    focus_minutes: aggregation.focus_minutes,
    idea_count: aggregation.idea_count,
    inbox_count: aggregation.inbox_count,
    source_record_ids: aggregation.source_record_ids,
    facts: aggregation.facts,
  }).eq("id", reviewId).eq("status", "generating")
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new HttpError(503, "DATABASE_WRITE_FAILED", "Daily facts save failed");
  }
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function narrativeInput(
  aggregation: DailyAggregation,
  records: DailyRecord[],
): Record<string, unknown> {
  return {
    review_date: aggregation.facts.review_date,
    timezone: USER_TIMEZONE,
    facts: aggregation.facts,
    completed_items: aggregation.completed_items,
    records: records.slice(0, MAX_NARRATIVE_RECORDS).map((record) => ({
      record_type: record.record_type,
      title: record.title ? truncate(record.title, 120) : null,
      summary: record.summary ? truncate(record.summary, 500) : null,
      project: record.project ? truncate(record.project, 120) : null,
      completed: record.completed,
      duration_minutes: record.duration_minutes,
    })),
    records_truncated: records.length > MAX_NARRATIVE_RECORDS,
  };
}

function narrativePrompt(): string {
  return [
    "你是个人日报助手，只输出一个 JSON 对象，不要 Markdown。",
    "只能根据输入 facts、completed_items 和 records 叙述，严禁补造事项、项目、时长、数量或完成状态。",
    "数字必须与 facts 完全一致；没有记录时不得虚构活动。",
    "输出必须且只能包含 narrative，内容使用简洁中文，概括完成事项、关注点和仍待处理内容，最多 3000 字。",
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
  aggregation: DailyAggregation,
  records: DailyRecord[],
): Promise<{ narrative: string; promptVersion: string }> {
  if (aggregation.facts.record_count === 0 &&
    aggregation.facts.pomodoro_count === 0) {
    return {
      narrative: "这一天没有已处理的语音记录或已完成的番茄专注。",
      promptVersion: EMPTY_PROMPT_VERSION,
    };
  }

  const apiHost = requiredUrlEnvironment("DASHSCOPE_API_HOST");
  const apiKey = requiredEnvironment("DASHSCOPE_API_KEY");
  const model = Deno.env.get("DASHSCOPE_DAILY_REVIEW_MODEL")?.trim() ||
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
                content: JSON.stringify(narrativeInput(aggregation, records)),
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
    throw new NarrativeError("QWEN_NETWORK", "Daily narrative request failed");
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new NarrativeError(
      `QWEN_HTTP_${response.status}`,
      "Daily narrative request failed",
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
  const narrative = parseDailyNarrative(parsed);
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
  const { error } = await supabase.from("daily_reviews").update({
    status: "failed",
    error_code: errorCode.slice(0, 200),
  }).eq("id", reviewId).eq("status", "generating");
  if (error) console.error("failed to persist daily review error", reviewId);
}

async function markGenerated(
  supabase: SupabaseClient,
  reviewId: string,
  narrative: string,
  promptVersion: string,
): Promise<void> {
  const { data, error } = await supabase.from("daily_reviews").update({
    narrative,
    prompt_version: promptVersion,
    status: "generated",
    error_code: null,
  }).eq("id", reviewId).eq("status", "generating")
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new HttpError(503, "DATABASE_WRITE_FAILED", "Daily narrative save failed");
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
    const { reviewDate, regenerate } = parseRequestBody(body, now);
    const configuredTimezone = Deno.env.get("USER_TIMEZONE")?.trim() || USER_TIMEZONE;
    if (configuredTimezone !== USER_TIMEZONE) {
      throw new HttpError(
        500,
        "SERVER_MISCONFIGURED",
        "daily-review currently requires Asia/Shanghai",
      );
    }

    const supabase = createClient(requiredUrlEnvironment("SUPABASE_URL"), serviceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const claim = await claimReview(supabase, reviewDate, regenerate, now);
    if (claim.kind === "existing") {
      return jsonResponse({
        success: true,
        review_id: claim.row.id,
        review_date: reviewDate,
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
        review_date: reviewDate,
        status: "generating",
        duplicate: true,
      }, 202);
    }
    if (claim.kind === "exhausted") {
      throw new HttpError(
        409,
        "GENERATION_ATTEMPTS_EXHAUSTED",
        "Daily review requires an explicit regenerate request",
      );
    }

    try {
      const sources = await loadSources(supabase, reviewDate);
      const aggregation = aggregateDailyReview(
        sources.records,
        sources.sessions,
        reviewDate,
        USER_TIMEZONE,
      );
      await persistFacts(supabase, claim.row.id, aggregation);
      const generated = await generateNarrative(aggregation, sources.records);
      await markGenerated(
        supabase,
        claim.row.id,
        generated.narrative,
        generated.promptVersion,
      );
      return jsonResponse({
        success: true,
        review_id: claim.row.id,
        review_date: reviewDate,
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
        : "DAILY_REVIEW_INTERNAL";
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
    console.error("unexpected daily-review error", error);
    return jsonResponse(
      { success: false, error_code: "SERVER_INTERNAL", message: "Unexpected server error" },
      500,
    );
  }
}

export default {
  fetch: handleRequest,
};
