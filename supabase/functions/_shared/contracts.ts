export type RecordKind = "voice_record" | "pomodoro_note" | "pomodoro_event";

export interface UploadMetadata {
  event_id: string;
  device_id: string;
  captured_at: string | null;
  kind: RecordKind;
  session_id: string | null;
  duration_seconds: number | null;
  firmware_version: string;
  schema_version: 1;
}

export interface UploadAccepted {
  success: true;
  event_id: string;
  record_id: string;
  status: "accepted";
  duplicate: boolean;
}

export const PROCESSING_STATES = [
  "uploaded",
  "transcribing",
  "classifying",
  "processed",
  "notion_sync_pending",
  "synced",
] as const;
