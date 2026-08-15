import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import {
  DEFAULT_RETRY_BATCH_SIZE,
  MAX_PROCESSING_ATTEMPTS,
  MAX_RETRY_BATCH_SIZE,
  RETRY_SCAN_LIMIT,
  selectRetryCandidates,
} from "../_shared/retry_policy.ts";
import type { RetryCandidate } from "../_shared/retry_policy.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_STATES = [
  "uploaded",
  "transcribing",
  "classifying",
  "transcription_failed",
  "classification_failed",
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
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
  const expected = requiredEnvironment("RETRY_FAILURES_TOKEN");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{32,256})$/.exec(authorization);
  if (!match || !constantTimeEqual(match[1], expected)) {
    throw new HttpError(401, "RETRY_UNAUTHORIZED", "Invalid retry token");
  }
}

function requestedBatchSize(body: unknown): number {
  if (body === null) return DEFAULT_RETRY_BATCH_SIZE;
  if (!isObject(body) || Object.keys(body).some((key) => key !== "limit") ||
    (Object.hasOwn(body, "limit") &&
      (typeof body.limit !== "number" || !Number.isInteger(body.limit) ||
        body.limit < 1 || body.limit > MAX_RETRY_BATCH_SIZE))) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `limit must be an integer from 1 to ${MAX_RETRY_BATCH_SIZE}`,
    );
  }
  return typeof body.limit === "number" ? body.limit : DEFAULT_RETRY_BATCH_SIZE;
}

async function dispatchRecord(
  supabaseUrl: string,
  processToken: string,
  recordId: string,
): Promise<"dispatched" | "unchanged"> {
  const response = await fetch(`${supabaseUrl}/functions/v1/process-record`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${processToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ record_id: recordId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`process-record returned ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (!isObject(body) || body.success !== true || body.record_id !== recordId ||
    (body.status !== "transcribing" && body.status !== "classifying" &&
      body.status !== "unchanged")) {
    throw new Error("process-record returned an invalid response");
  }
  return body.status === "unchanged" ? "unchanged" : "dispatched";
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is supported");
    }
    authorize(request);
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const batchSize = requestedBatchSize(body);
    const supabaseUrl = requiredUrlEnvironment("SUPABASE_URL");
    const processToken = requiredEnvironment("PROCESS_RECORD_TOKEN");
    const supabase = createClient(supabaseUrl, serviceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supabase.from("records")
      .select("id,status,processing_attempts,error_code,updated_at")
      .in("status", CANDIDATE_STATES)
      .order("updated_at", { ascending: true })
      .limit(RETRY_SCAN_LIMIT);
    if (error) throw new HttpError(503, "DATABASE_READ_FAILED", "Retry scan failed");

    const candidates = (data ?? []).filter((value): value is RetryCandidate => {
      return isObject(value) && typeof value.id === "string" && UUID_PATTERN.test(value.id) &&
        typeof value.status === "string" &&
        typeof value.processing_attempts === "number" &&
        (value.error_code === null || typeof value.error_code === "string") &&
        typeof value.updated_at === "string";
    });
    const eligible = selectRetryCandidates(candidates, Date.now(), batchSize);

    let dispatched = 0;
    let unchanged = 0;
    let dispatchFailed = 0;
    for (const candidate of eligible) {
      try {
        const result = await dispatchRecord(supabaseUrl, processToken, candidate.id);
        if (result === "dispatched") dispatched += 1;
        else unchanged += 1;
      } catch (error) {
        dispatchFailed += 1;
        console.error("retry dispatch failed", candidate.id, String(error));
      }
    }

    return jsonResponse({
      success: true,
      scanned: candidates.length,
      eligible: eligible.length,
      dispatched,
      unchanged,
      dispatch_failed: dispatchFailed,
      exhausted: candidates.filter(
        (candidate) => candidate.processing_attempts >= MAX_PROCESSING_ATTEMPTS,
      ).length,
      limit: batchSize,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse(
        { success: false, error_code: "INVALID_JSON", message: "Request body is not valid JSON" },
        400,
      );
    }
    if (error instanceof HttpError) {
      return jsonResponse(
        { success: false, error_code: error.errorCode, message: error.message },
        error.status,
      );
    }
    console.error("unexpected retry-failures error", error);
    return jsonResponse(
      { success: false, error_code: "SERVER_INTERNAL", message: "Unexpected server error" },
      500,
    );
  }
}

export default {
  fetch: handleRequest,
};
