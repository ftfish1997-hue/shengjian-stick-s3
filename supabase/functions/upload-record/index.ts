import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import type { UploadAccepted, UploadMetadata } from "../_shared/contracts.ts";

const AUDIO_BUCKET = "voice-recordings";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_KINDS = new Set(["voice_record", "pomodoro_note", "pomodoro_event"]);

interface ExistingRecord {
  id: string;
  event_id: string;
  device_id: string;
  audio_sha256: string | null;
  audio_size_bytes: number | null;
  status: string;
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

function errorResponse(error: HttpError): Response {
  return jsonResponse(
    { success: false, error_code: error.errorCode, message: error.message },
    error.status,
  );
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
  throw new HttpError(500, "SERVER_MISCONFIGURED", "Supabase server key is not configured");
}

function parseBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]{16,256})$/.exec(authorization);
  if (!match) {
    throw new HttpError(401, "DEVICE_UNAUTHORIZED", "Missing or invalid device token");
  }
  return match[1];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function validateMetadata(value: unknown): UploadMetadata {
  if (!isObject(value)) {
    throw new HttpError(400, "INVALID_METADATA", "metadata must be a JSON object");
  }
  const expectedKeys = new Set([
    "event_id",
    "device_id",
    "captured_at",
    "kind",
    "session_id",
    "duration_seconds",
    "firmware_version",
    "schema_version",
  ]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new HttpError(400, "INVALID_METADATA", "metadata contains unknown fields");
  }
  if (typeof value.event_id !== "string" || !UUID_PATTERN.test(value.event_id)) {
    throw new HttpError(400, "INVALID_METADATA", "event_id must be a UUID");
  }
  if (
    typeof value.device_id !== "string" ||
    value.device_id.length < 1 ||
    value.device_id.length > 64
  ) {
    throw new HttpError(400, "INVALID_METADATA", "device_id is invalid");
  }
  if (
    value.captured_at !== null &&
    (typeof value.captured_at !== "string" || Number.isNaN(Date.parse(value.captured_at)))
  ) {
    throw new HttpError(400, "INVALID_METADATA", "captured_at must be an ISO date-time or null");
  }
  if (typeof value.kind !== "string" || !RECORD_KINDS.has(value.kind)) {
    throw new HttpError(400, "INVALID_METADATA", "kind is invalid");
  }
  if (!nullableString(value.session_id, 128)) {
    throw new HttpError(400, "INVALID_METADATA", "session_id is invalid");
  }
  if (
    value.duration_seconds !== null &&
    (typeof value.duration_seconds !== "number" ||
      !Number.isFinite(value.duration_seconds) ||
      value.duration_seconds < 0 ||
      value.duration_seconds > 60)
  ) {
    throw new HttpError(400, "INVALID_METADATA", "duration_seconds is invalid");
  }
  if (
    typeof value.firmware_version !== "string" ||
    value.firmware_version.length > 32
  ) {
    throw new HttpError(400, "INVALID_METADATA", "firmware_version is invalid");
  }
  if (value.schema_version !== 1) {
    throw new HttpError(400, "INVALID_METADATA", "schema_version must be 1");
  }
  return value as unknown as UploadMetadata;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function validateWav(bytes: Uint8Array): void {
  if (bytes.byteLength < 44) {
    throw new HttpError(400, "INVALID_AUDIO", "WAV file is shorter than its header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WAVE" ||
    readAscii(bytes, 12, 4) !== "fmt " ||
    readAscii(bytes, 36, 4) !== "data"
  ) {
    throw new HttpError(400, "INVALID_AUDIO", "Unsupported WAV chunk layout");
  }
  const riffSize = view.getUint32(4, true);
  const formatSize = view.getUint32(16, true);
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  if (
    formatSize !== 16 ||
    audioFormat !== 1 ||
    channels !== 1 ||
    sampleRate !== 16_000 ||
    byteRate !== 32_000 ||
    blockAlign !== 2 ||
    bitsPerSample !== 16 ||
    riffSize + 8 !== bytes.byteLength ||
    dataSize + 44 !== bytes.byteLength
  ) {
    throw new HttpError(400, "INVALID_AUDIO", "WAV must be 16 kHz, 16-bit, mono PCM");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; ++index) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function recordMatches(
  record: ExistingRecord,
  deviceId: string,
  audioSha256: string,
  audioSize: number,
): boolean {
  return record.device_id === deviceId &&
    record.audio_sha256 === audioSha256 &&
    record.audio_size_bytes === audioSize;
}

function acceptedResponse(record: ExistingRecord, duplicate: boolean): Response {
  const response: UploadAccepted = {
    success: true,
    event_id: record.event_id,
    record_id: record.id,
    status: "accepted",
    duplicate,
  };
  return jsonResponse(response);
}

function scheduleProcessing(record: ExistingRecord): void {
  if (["processed", "notion_sync_pending", "synced", "notion_sync_failed"].includes(record.status)) {
    return;
  }
  const processToken = Deno.env.get("PROCESS_RECORD_TOKEN")?.trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/$/, "");
  if (!processToken || !supabaseUrl) {
    console.error("process-record trigger is not configured", record.id);
    return;
  }
  const task = fetch(`${supabaseUrl}/functions/v1/process-record`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${processToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ record_id: record.id }),
  }).then((response) => {
    if (!response.ok) console.error("process-record trigger failed", record.id, response.status);
  }).catch(() => console.error("process-record trigger network failure", record.id));
  EdgeRuntime.waitUntil(task);
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is supported");
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw new HttpError(400, "INVALID_REQUEST", "Content-Type must be multipart/form-data");
    }

    const deviceId = request.headers.get("x-device-id")?.trim() ?? "";
    const eventId = request.headers.get("x-event-id")?.trim() ?? "";
    if (!deviceId || deviceId.length > 64 || !UUID_PATTERN.test(eventId)) {
      throw new HttpError(400, "INVALID_METADATA", "Device or event headers are invalid");
    }
    const deviceToken = parseBearerToken(request);

    const supabase = createClient(requiredEnvironment("SUPABASE_URL"), serviceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .select("id,token_hash,enabled")
      .eq("id", deviceId)
      .maybeSingle();
    if (deviceError) {
      console.error("device lookup failed", deviceError);
      throw new HttpError(503, "SERVER_TEMPORARY", "Device lookup failed");
    }
    const suppliedTokenHash = await sha256Hex(new TextEncoder().encode(deviceToken));
    const storedTokenHash = typeof device?.token_hash === "string"
      ? device.token_hash.replace(/^sha256:/, "")
      : "";
    if (!device?.enabled || !SHA256_PATTERN.test(storedTokenHash) ||
      !constantTimeEqual(suppliedTokenHash, storedTokenHash)) {
      throw new HttpError(401, "DEVICE_UNAUTHORIZED", "Device is not authorized");
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES + 64 * 1024) {
      throw new HttpError(413, "AUDIO_TOO_LARGE", "Request exceeds the upload limit");
    }

    const form = await request.formData();
    const audio = form.get("audio");
    const metadataText = form.get("metadata");
    if (!(audio instanceof File) || typeof metadataText !== "string") {
      throw new HttpError(400, "INVALID_REQUEST", "audio and metadata form fields are required");
    }
    if (audio.size <= 0) {
      throw new HttpError(400, "INVALID_AUDIO", "Audio file is empty");
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new HttpError(413, "AUDIO_TOO_LARGE", "Audio exceeds the 10 MiB limit");
    }

    let metadataValue: unknown;
    try {
      metadataValue = JSON.parse(metadataText);
    } catch {
      throw new HttpError(400, "INVALID_METADATA", "metadata is not valid JSON");
    }
    const metadata = validateMetadata(metadataValue);
    if (metadata.device_id !== deviceId || metadata.event_id !== eventId) {
      throw new HttpError(400, "INVALID_METADATA", "Headers and metadata do not match");
    }

    const audioBytes = new Uint8Array(await audio.arrayBuffer());
    validateWav(audioBytes);
    const audioSha256 = await sha256Hex(audioBytes);

    const selectRecord = () =>
      supabase.from("records")
        .select("id,event_id,device_id,audio_sha256,audio_size_bytes,status")
        .eq("event_id", eventId)
        .maybeSingle();
    const { data: existing, error: existingError } = await selectRecord();
    if (existingError) {
      console.error("record lookup failed", existingError);
      throw new HttpError(503, "SERVER_TEMPORARY", "Record lookup failed");
    }
    if (existing) {
      if (!recordMatches(existing as ExistingRecord, deviceId, audioSha256, audio.size)) {
        throw new HttpError(409, "EVENT_CONFLICT", "event_id already has different content");
      }
      scheduleProcessing(existing as ExistingRecord);
      return acceptedResponse(existing as ExistingRecord, true);
    }

    const audioPath = `${deviceId}/${eventId}.wav`;
    const { error: uploadError } = await supabase.storage
      .from(AUDIO_BUCKET)
      .upload(audioPath, audioBytes, { contentType: "audio/wav", upsert: false });
    if (uploadError) {
      const { data: storedAudio, error: downloadError } = await supabase.storage
        .from(AUDIO_BUCKET)
        .download(audioPath);
      if (downloadError || !storedAudio) {
        console.error("storage upload failed", uploadError, downloadError);
        throw new HttpError(503, "SERVER_TEMPORARY", "Storage upload failed");
      }
      const storedBytes = new Uint8Array(await storedAudio.arrayBuffer());
      const storedSha256 = await sha256Hex(storedBytes);
      if (storedBytes.byteLength !== audio.size || storedSha256 !== audioSha256) {
        throw new HttpError(409, "EVENT_CONFLICT", "Stored audio differs for event_id");
      }
    }

    const { data: inserted, error: insertError } = await supabase
      .from("records")
      .insert({
        event_id: eventId,
        device_id: deviceId,
        kind: metadata.kind,
        device_session_id: metadata.session_id,
        captured_at: metadata.captured_at,
        audio_path: audioPath,
        audio_sha256: audioSha256,
        audio_size_bytes: audio.size,
        status: "uploaded",
      })
      .select("id,event_id,device_id,audio_sha256,audio_size_bytes,status")
      .single();
    if (insertError || !inserted) {
      const { data: raced, error: racedError } = await selectRecord();
      if (racedError || !raced ||
        !recordMatches(raced as ExistingRecord, deviceId, audioSha256, audio.size)) {
        console.error("record insert failed", insertError, racedError);
        throw new HttpError(503, "SERVER_TEMPORARY", "Record insert failed");
      }
      scheduleProcessing(raced as ExistingRecord);
      return acceptedResponse(raced as ExistingRecord, true);
    }

    const { error: heartbeatError } = await supabase.from("devices").update({
      firmware_version: metadata.firmware_version,
      last_seen_at: new Date().toISOString(),
    }).eq("id", deviceId);
    if (heartbeatError) console.error("device heartbeat update failed", heartbeatError);

    scheduleProcessing(inserted as ExistingRecord);
    return acceptedResponse(inserted as ExistingRecord, false);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    console.error("unexpected upload-record error", error);
    return errorResponse(new HttpError(500, "SERVER_INTERNAL", "Unexpected server error"));
  }
}

export default {
  fetch: handleRequest,
};
