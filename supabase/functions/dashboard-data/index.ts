import { createClient } from "npm:@supabase/supabase-js@2";
import {
  DashboardQueryError,
  audioDurationSeconds,
  constantTimeEqual,
  parseDashboardQuery,
} from "../_shared/dashboard_data.ts";
import { jsonResponse } from "../_shared/http.ts";

const AUDIO_URL_TTL_SECONDS = 15 * 60;
const DAILY_REVIEW_LIMIT = 14;
const WEEKLY_REVIEW_LIMIT = 8;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(500, "SERVER_MISCONFIGURED", `${name} is not configured`);
  }
  return value;
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
  throw new HttpError(
    500,
    "SERVER_MISCONFIGURED",
    "Supabase server key is not configured",
  );
}

function authorize(request: Request): void {
  const expected = requiredEnvironment("DASHBOARD_READ_TOKEN");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{32,256})$/.exec(authorization);
  if (!match || !constantTimeEqual(match[1], expected)) {
    throw new HttpError(
      401,
      "DASHBOARD_UNAUTHORIZED",
      "Invalid dashboard token",
    );
  }
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "GET") {
      return jsonResponse(
        { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET" } },
        405,
        { Allow: "GET" },
      );
    }
    authorize(request);

    let recordLimit: number;
    try {
      recordLimit = parseDashboardQuery(new URL(request.url)).recordLimit;
    } catch (error) {
      if (error instanceof DashboardQueryError) {
        throw new HttpError(400, "INVALID_QUERY", error.message);
      }
      throw error;
    }

    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      serviceRoleKey(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const [recordsResult, dailyResult, weeklyResult, devicesResult] =
      await Promise.all([
        supabase.from("records").select(
          "id,event_id,device_id,captured_at,received_at,raw_text,clean_text,record_type,title,summary,project,tags,duration_minutes,completed,confidence,status,audio_path,audio_deleted_at,audio_size_bytes,error_code,created_at,updated_at",
        ).order("received_at", { ascending: false }).limit(recordLimit),
        supabase.from("daily_reviews").select(
          "id,review_date,timezone,completed_items,pomodoro_count,focus_minutes,idea_count,inbox_count,facts,narrative,prompt_version,status,error_code,created_at,updated_at",
        ).order("review_date", { ascending: false }).limit(DAILY_REVIEW_LIMIT),
        supabase.from("weekly_reviews").select(
          "id,week_start,week_end,timezone,major_outcomes,project_investment,unfinished_items,next_focus,pomodoro_count,focus_minutes,facts,narrative,prompt_version,status,error_code,created_at,updated_at",
        ).order("week_start", { ascending: false }).limit(WEEKLY_REVIEW_LIMIT),
        supabase.from("devices").select(
          "id,enabled,firmware_version,last_seen_at,updated_at",
        ).order("id", { ascending: true }),
      ]);

    for (const result of [
      recordsResult,
      dailyResult,
      weeklyResult,
      devicesResult,
    ]) {
      if (result.error) {
        throw new HttpError(
          503,
          "DASHBOARD_READ_FAILED",
          "Dashboard data lookup failed",
        );
      }
    }

    const records = await Promise.all(
      (recordsResult.data ?? []).map(async (record) => {
        let audioUrl: string | null = null;
        if (record.audio_path && !record.audio_deleted_at) {
          const { data } = await supabase.storage
            .from("voice-recordings")
            .createSignedUrl(record.audio_path, AUDIO_URL_TTL_SECONDS);
          audioUrl = data?.signedUrl ?? null;
        }
        const {
          audio_path: _audioPath,
          audio_deleted_at: _audioDeletedAt,
          audio_size_bytes,
          ...safeRecord
        } = record;
        return {
          ...safeRecord,
          audio_url: audioUrl,
          audio_url_expires_in_seconds: audioUrl
            ? AUDIO_URL_TTL_SECONDS
            : null,
          audio_duration_seconds: audioDurationSeconds(audio_size_bytes),
        };
      }),
    );

    return jsonResponse({
      generated_at: new Date().toISOString(),
      records,
      daily_reviews: dailyResult.data ?? [],
      weekly_reviews: weeklyResult.data ?? [],
      devices: devicesResult.data ?? [],
    }, 200, {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError
      ? error.errorCode
      : "INTERNAL_ERROR";
    const message = error instanceof HttpError
      ? error.message
      : "Dashboard request failed";
    return jsonResponse(
      { error: { code, message } },
      status,
      { "Cache-Control": "no-store" },
    );
  }
});
