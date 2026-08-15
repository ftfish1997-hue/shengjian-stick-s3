import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import { MAX_PROCESSING_ATTEMPTS } from "../_shared/retry_policy.ts";
import { cleanTranscript } from "../_shared/transcript_correction.ts";

const AUDIO_BUCKET = "voice-recordings";
const SIGNED_URL_TTL_SECONDS = 5 * 60;
const ASR_POLL_INTERVAL_MS = 2_000;
const ASR_MAX_POLLS = 45;
const STALE_CLAIM_MS = 3 * 60 * 1_000;
const LOW_CONFIDENCE_THRESHOLD = 0.55;
const PROMPT_VERSION = "qwen-turbo-record-v2";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_TYPES = new Set(["idea", "activity", "task", "note", "journal", "inbox"]);
const RETRYABLE_STATES = new Set([
  "uploaded",
  "transcription_failed",
  "classification_failed",
]);
const FINISHED_STATES = new Set([
  "processed",
  "notion_sync_pending",
  "synced",
  "notion_sync_failed",
]);

type SupabaseClient = ReturnType<typeof createClient>;
type ProcessingStage = "transcribing" | "classifying";

interface RecordRow {
  id: string;
  audio_path: string;
  captured_at: string | null;
  received_at: string;
  raw_text: string | null;
  clean_text: string | null;
  status: string;
  updated_at: string;
  processing_attempts: number;
}

interface FollowUp {
  content: string;
  due_date: string | null;
}

interface Classification {
  record_type: "idea" | "activity" | "task" | "note" | "journal" | "inbox";
  title: string;
  summary: string;
  project: string | null;
  duration_minutes: number | null;
  completed: boolean | null;
  tags: string[];
  follow_ups: FollowUp[];
  confidence: number;
}

interface ClaimedRecord {
  record: RecordRow;
  stage: ProcessingStage;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

class ProcessingError extends Error {
  constructor(
    readonly stage: ProcessingStage,
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
  const expected = requiredEnvironment("PROCESS_RECORD_TOKEN");
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{32,256})$/.exec(authorization);
  if (!match || !constantTimeEqual(match[1], expected)) {
    throw new HttpError(401, "PROCESS_UNAUTHORIZED", "Invalid processing token");
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function externalCode(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (typeof value.code === "string" && value.code.length <= 100) return value.code;
  if (isObject(value.output) && typeof value.output.code === "string" &&
    value.output.code.length <= 100) {
    return value.output.code;
  }
  return null;
}

async function fetchJson(
  stage: ProcessingStage,
  errorCode: string,
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProcessingError(stage, `${errorCode}_NETWORK`, String(error));
  }
  const body = await readJson(response);
  if (!response.ok) {
    const providerCode = externalCode(body);
    throw new ProcessingError(
      stage,
      providerCode ? `${errorCode}_${providerCode}`.slice(0, 160) : `${errorCode}_HTTP_${response.status}`,
      `${errorCode} request failed`,
    );
  }
  return body;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function claimRecord(supabase: SupabaseClient, recordId: string): Promise<ClaimedRecord | null> {
  const { data, error } = await supabase.from("records")
    .select(
      "id,audio_path,captured_at,received_at,raw_text,clean_text,status,updated_at,processing_attempts",
    )
    .eq("id", recordId)
    .maybeSingle();
  if (error) throw new HttpError(503, "DATABASE_READ_FAILED", "Record lookup failed");
  if (!data) throw new HttpError(404, "RECORD_NOT_FOUND", "Record does not exist");

  const record = data as RecordRow;
  if (FINISHED_STATES.has(record.status)) return null;
  if (record.processing_attempts >= MAX_PROCESSING_ATTEMPTS) return null;
  const inProgress = record.status === "transcribing" || record.status === "classifying";
  if (inProgress && Date.now() - Date.parse(record.updated_at) < STALE_CLAIM_MS) return null;
  if (!inProgress && !RETRYABLE_STATES.has(record.status)) {
    throw new HttpError(409, "RECORD_STATE_INVALID", "Record cannot be processed from this state");
  }

  const stage: ProcessingStage = record.status === "classifying" ||
      (record.status === "classification_failed" &&
        typeof record.raw_text === "string" && record.raw_text.trim().length > 0)
    ? "classifying"
    : "transcribing";
  const { data: claimed, error: claimError } = await supabase.from("records")
    .update({
      status: stage,
      error_code: null,
      processing_attempts: record.processing_attempts + 1,
      last_processing_started_at: new Date().toISOString(),
    })
    .eq("id", recordId)
    .eq("status", record.status)
    .eq("updated_at", record.updated_at)
    .select(
      "id,audio_path,captured_at,received_at,raw_text,clean_text,status,updated_at,processing_attempts",
    )
    .maybeSingle();
  if (claimError) throw new HttpError(503, "DATABASE_CLAIM_FAILED", "Record claim failed");
  if (!claimed) return null;
  return { record: claimed as RecordRow, stage };
}

async function createAudioUrl(supabase: SupabaseClient, audioPath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(AUDIO_BUCKET)
    .createSignedUrl(audioPath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new ProcessingError("transcribing", "AUDIO_SIGNING_FAILED", "Could not sign audio URL");
  }
  return data.signedUrl;
}

function taskDetails(value: unknown): Record<string, unknown> | null {
  if (!isObject(value) || !isObject(value.output)) return null;
  return value.output;
}

async function transcribe(audioUrl: string): Promise<string> {
  const apiHost = requiredUrlEnvironment("DASHSCOPE_API_HOST");
  const apiKey = requiredEnvironment("DASHSCOPE_API_KEY");
  const model = Deno.env.get("DASHSCOPE_TRANSCRIPTION_MODEL")?.trim() || "paraformer-v2";
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-dashscope-async": "enable",
  };
  const submitted = await fetchJson(
    "transcribing",
    "ASR_SUBMIT",
    `${apiHost}/services/audio/asr/transcription`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: { file_urls: [audioUrl] },
        parameters: {
          channel_id: [0],
          language_hints: ["zh", "en"],
          disfluency_removal_enabled: false,
        },
      }),
    },
  );
  const taskId = taskDetails(submitted)?.task_id;
  if (typeof taskId !== "string" || !UUID_PATTERN.test(taskId)) {
    throw new ProcessingError("transcribing", "ASR_TASK_ID_MISSING", "ASR task ID missing");
  }

  let transcriptionUrl: string | null = null;
  for (let attempt = 0; attempt < ASR_MAX_POLLS; ++attempt) {
    if (attempt > 0) await delay(ASR_POLL_INTERVAL_MS);
    const task = await fetchJson(
      "transcribing",
      "ASR_POLL",
      `${apiHost}/tasks/${encodeURIComponent(taskId)}`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    const output = taskDetails(task);
    const status = output?.task_status;
    if (status === "SUCCEEDED") {
      const results = output?.results;
      const result = Array.isArray(results) && isObject(results[0]) ? results[0] : null;
      if (result?.subtask_status !== "SUCCEEDED") {
        const code = typeof result?.code === "string" ? result.code : "SUBTASK_FAILED";
        throw new ProcessingError("transcribing", `ASR_${code}`.slice(0, 160), "ASR subtask failed");
      }
      if (typeof result.transcription_url === "string") transcriptionUrl = result.transcription_url;
      break;
    }
    if (status === "FAILED" || status === "UNKNOWN") {
      const code = typeof output?.code === "string" ? output.code : `TASK_${status}`;
      throw new ProcessingError("transcribing", `ASR_${code}`.slice(0, 160), "ASR task failed");
    }
  }
  if (!transcriptionUrl) {
    throw new ProcessingError("transcribing", "ASR_TIMEOUT", "ASR task did not finish in time");
  }

  const result = await fetchJson(
    "transcribing",
    "ASR_RESULT",
    transcriptionUrl,
    undefined,
    20_000,
  );
  const text = extractTranscript(result);
  if (!text) {
    throw new ProcessingError("transcribing", "ASR_NO_TEXT", "ASR returned no speech text");
  }
  return text;
}

function extractTranscript(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.transcripts)) return "";
  const parts: string[] = [];
  for (const transcript of value.transcripts) {
    if (!isObject(transcript)) continue;
    if (typeof transcript.text === "string" && transcript.text.trim()) {
      parts.push(transcript.text.trim());
      continue;
    }
    if (!Array.isArray(transcript.sentences)) continue;
    const sentenceText = transcript.sentences
      .filter(isObject)
      .map((sentence) => typeof sentence.text === "string" ? sentence.text.trim() : "")
      .filter(Boolean)
      .join("");
    if (sentenceText) parts.push(sentenceText);
  }
  return parts.join("\n").trim();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validateClassification(value: unknown): value is Classification {
  if (!isObject(value)) return false;
  const expectedKeys = new Set([
    "record_type",
    "title",
    "summary",
    "project",
    "duration_minutes",
    "completed",
    "tags",
    "follow_ups",
    "confidence",
  ]);
  if (Object.keys(value).length !== expectedKeys.size ||
    Object.keys(value).some((key) => !expectedKeys.has(key))) return false;
  if (typeof value.record_type !== "string" || !RECORD_TYPES.has(value.record_type)) return false;
  if (typeof value.title !== "string" || codePointLength(value.title) < 1 ||
    codePointLength(value.title) > 120) return false;
  if (typeof value.summary !== "string" || codePointLength(value.summary) > 1000) return false;
  if (value.project !== null &&
    (typeof value.project !== "string" || codePointLength(value.project) > 120)) return false;
  if (value.duration_minutes !== null &&
    (typeof value.duration_minutes !== "number" || !Number.isInteger(value.duration_minutes) ||
      value.duration_minutes < 0)) return false;
  if (value.completed !== null && typeof value.completed !== "boolean") return false;
  if (!Array.isArray(value.tags) || value.tags.length > 12 ||
    value.tags.some((tag) => typeof tag !== "string" || codePointLength(tag) > 40) ||
    new Set(value.tags).size !== value.tags.length) return false;
  if (!Array.isArray(value.follow_ups) || value.follow_ups.length > 10) return false;
  for (const followUp of value.follow_ups) {
    if (!isObject(followUp) || Object.keys(followUp).length !== 2 ||
      !Object.hasOwn(followUp, "content") || !Object.hasOwn(followUp, "due_date") ||
      typeof followUp.content !== "string" || codePointLength(followUp.content) < 1 ||
      codePointLength(followUp.content) > 300 ||
      (followUp.due_date !== null &&
        (typeof followUp.due_date !== "string" || !isValidDate(followUp.due_date)))) return false;
  }
  return typeof value.confidence === "number" && Number.isFinite(value.confidence) &&
    value.confidence >= 0 && value.confidence <= 1;
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function fallbackClassification(text: string): Classification {
  return {
    record_type: "inbox",
    title: truncate(text, 120) || "待整理语音记录",
    summary: truncate(text, 1000),
    project: null,
    duration_minutes: null,
    completed: null,
    tags: [],
    follow_ups: [],
    confidence: 0,
  };
}

function normalizeClassification(result: Classification): Classification {
  if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { ...result, record_type: "inbox" };
  }
  // A concrete follow-up is an actionable task. This removes a known model
  // inconsistency where Qwen emits a dated reminder but labels it as inbox.
  if (result.record_type === "inbox" && result.follow_ups.length > 0) {
    return { ...result, record_type: "task" };
  }
  return result;
}

function classificationPrompt(): string {
  return [
    "你是个人语音收件箱的结构化助手。只输出一个 JSON 对象，不要 Markdown。",
    "输入的 clean_text 是保留原意并做过最小同音词纠正的待分类文本；标题、摘要和待办必须以它为准。",
    "严禁补造原文没有的项目、时长、完成状态或日期；无法可靠判断时使用 null、空数组或 inbox。",
    "record_type 只能是 idea/activity/task/note/journal/inbox。",
    "相对日期只能根据提供的 captured_at 和 Asia/Shanghai 时区解析；不确定则 due_date=null。",
    "必须且只能包含这些字段：record_type,title,summary,project,duration_minutes,completed,tags,follow_ups,confidence。",
    "follow_ups 每项必须且只能包含 content,due_date；due_date 为 YYYY-MM-DD 或 null。",
    "限制：title 1-120字，summary 最多1000字，project 最多120字或null，duration_minutes为非负整数或null，",
    "tags 最多12个且不重复，每个最多40字；follow_ups 最多10项，content 1-300字；confidence 为0到1。",
  ].join("\n");
}

async function classify(text: string, capturedAt: string): Promise<Classification> {
  const apiHost = requiredUrlEnvironment("DASHSCOPE_API_HOST");
  const apiKey = requiredEnvironment("DASHSCOPE_API_KEY");
  const model = Deno.env.get("DASHSCOPE_CLASSIFICATION_MODEL")?.trim() || "qwen-turbo";
  const response = await fetchJson(
    "classifying",
    "QWEN",
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
            { role: "system", content: classificationPrompt() },
            {
              role: "user",
              content: JSON.stringify({
                captured_at: capturedAt,
                timezone: "Asia/Shanghai",
                clean_text: text,
              }),
            },
          ],
        },
        parameters: {
          result_format: "message",
          response_format: { type: "json_object" },
        },
      }),
    },
    30_000,
  );

  const output = isObject(response) && isObject(response.output) ? response.output : null;
  const choice = output && Array.isArray(output.choices) && isObject(output.choices[0])
    ? output.choices[0]
    : null;
  const message = choice && isObject(choice.message) ? choice.message : null;
  const content = message?.content;
  if (typeof content !== "string") return fallbackClassification(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return fallbackClassification(text);
  }
  if (!validateClassification(parsed)) return fallbackClassification(text);
  return normalizeClassification(parsed);
}

async function persistTranscription(
  supabase: SupabaseClient,
  recordId: string,
  rawText: string,
  cleanText: string,
): Promise<void> {
  const { error } = await supabase.from("records").update({
    raw_text: rawText,
    clean_text: cleanText,
    status: "classifying",
    error_code: null,
  }).eq("id", recordId).eq("status", "transcribing");
  if (error) {
    throw new ProcessingError("transcribing", "TRANSCRIPT_SAVE_FAILED", "Transcript save failed");
  }
}

async function persistClassification(
  supabase: SupabaseClient,
  recordId: string,
  result: Classification,
): Promise<void> {
  const { error } = await supabase.from("records").update({
    record_type: result.record_type,
    title: result.title,
    summary: result.summary,
    project: result.project,
    duration_minutes: result.duration_minutes,
    completed: result.completed,
    tags: result.tags,
    follow_ups: result.follow_ups,
    confidence: result.confidence,
    structured_result: result,
    prompt_version: PROMPT_VERSION,
    status: "processed",
    error_code: null,
  }).eq("id", recordId).eq("status", "classifying");
  if (error) {
    throw new ProcessingError("classifying", "CLASSIFICATION_SAVE_FAILED", "Result save failed");
  }
}

async function markFailure(
  supabase: SupabaseClient,
  recordId: string,
  error: ProcessingError,
): Promise<void> {
  const status = error.stage === "transcribing" ? "transcription_failed" : "classification_failed";
  const { error: updateError } = await supabase.from("records").update({
    status,
    error_code: error.errorCode.slice(0, 200),
  }).eq("id", recordId).eq("status", error.stage);
  if (updateError) console.error("failed to persist processing error", recordId, status);
}

async function processClaim(supabase: SupabaseClient, claim: ClaimedRecord): Promise<void> {
  const record = claim.record;
  try {
    let rawText = record.raw_text?.trim() ?? "";
    let cleanText = record.clean_text?.trim() ?? "";
    if (claim.stage === "transcribing") {
      const signedUrl = await createAudioUrl(supabase, record.audio_path);
      rawText = await transcribe(signedUrl);
      cleanText = cleanTranscript(rawText);
      await persistTranscription(supabase, record.id, rawText, cleanText);
    }
    if (!rawText) {
      throw new ProcessingError("classifying", "RAW_TEXT_MISSING", "Transcript is empty");
    }
    if (!cleanText) cleanText = cleanTranscript(rawText);
    const capturedAt = record.captured_at || record.received_at;
    const result = await classify(cleanText, capturedAt);
    await persistClassification(supabase, record.id, result);
  } catch (error) {
    const processingError = error instanceof ProcessingError
      ? error
      : new ProcessingError(claim.stage, "PROCESSING_INTERNAL", String(error));
    console.error("process-record failed", record.id, processingError.errorCode);
    await markFailure(supabase, record.id, processingError);
  }
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is supported");
    }
    authorize(request);
    const body = await request.json().catch(() => null);
    if (!isObject(body) || Object.keys(body).length !== 1 ||
      typeof body.record_id !== "string" || !UUID_PATTERN.test(body.record_id)) {
      throw new HttpError(400, "INVALID_REQUEST", "record_id must be a UUID");
    }

    const supabase = createClient(requiredUrlEnvironment("SUPABASE_URL"), serviceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const claim = await claimRecord(supabase, body.record_id);
    if (!claim) {
      return jsonResponse({ success: true, record_id: body.record_id, status: "unchanged" });
    }
    EdgeRuntime.waitUntil(processClaim(supabase, claim));
    return jsonResponse(
      { success: true, record_id: body.record_id, status: claim.stage },
      202,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(
        { success: false, error_code: error.errorCode, message: error.message },
        error.status,
      );
    }
    console.error("unexpected process-record error", error);
    return jsonResponse(
      { success: false, error_code: "SERVER_INTERNAL", message: "Unexpected server error" },
      500,
    );
  }
}

export default {
  fetch: handleRequest,
};
