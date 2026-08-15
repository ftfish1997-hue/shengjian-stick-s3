# API Reference

All examples use local or placeholder endpoints. Replace them with services you own and never paste real tokens into shell history, source files, issues, or logs.

## Health

```http
GET /functions/v1/health
```

Returns a small liveness response and requires no credentials.

## Upload a recording

```http
POST /functions/v1/upload-record
Authorization: Bearer <device-token>
X-Device-ID: demo-device-001
X-Event-ID: <uuid>
Content-Type: multipart/form-data; boundary=<boundary>
```

Multipart fields:

- `audio`: 16 kHz, 16-bit, mono WAV
- `metadata`: JSON matching `shared/schemas/upload_metadata.schema.json`

Metadata fields:

```json
{
  "event_id": "00000000-0000-4000-8000-000000000001",
  "device_id": "demo-device-001",
  "captured_at": null,
  "kind": "voice_record",
  "session_id": null,
  "duration_seconds": 4.5,
  "firmware_version": "0.8.0-pomodoro-ui",
  "schema_version": 1
}
```

A successful response matches `shared/schemas/upload_response.schema.json`:

```json
{
  "success": true,
  "event_id": "00000000-0000-4000-8000-000000000001",
  "record_id": "00000000-0000-4000-8000-000000000002",
  "status": "accepted",
  "duplicate": false
}
```

Submitting the same device/event pair again must return the same record with `duplicate: true`. The device must keep its local files for any timeout, malformed response, mismatched event ID, invalid record ID, or non-200 status.

## Process a record

```http
POST /functions/v1/process-record
Authorization: Bearer <process-record-token>
Content-Type: application/json

{"record_id":"00000000-0000-4000-8000-000000000002"}
```

The function moves the record through transcription and classification states. `raw_text` is immutable model output; deterministic context correction writes `clean_text`. The structured result follows `shared/schemas/record_classification.schema.json` and uses one of:

```text
idea, activity, task, note, journal, inbox
```

The endpoint is internal. Do not expose its token to a device or browser.

## Retry failed processing

```http
POST /functions/v1/retry-failures
Authorization: Bearer <retry-failures-token>
Content-Type: application/json

{"limit":5}
```

The function atomically claims eligible transient failures or stale processing rows, observes attempt/backoff limits, and invokes `process-record`. It excludes permanent errors. The public Cron migration runs this function every five minutes after `project_url` and `retry_failures_token` are stored in Vault.

## Daily review

```http
POST /functions/v1/daily-review
Authorization: Bearer <daily-review-token>
Content-Type: application/json

{}
```

An empty body generates or returns the previous local day's review according to `USER_TIMEZONE`. A deployment may supply an explicit date or regeneration option as supported by the function implementation. Aggregated counts and source IDs are deterministic; the model writes only the narrative.

The supplied migration schedules the function at 00:10 Asia/Shanghai (16:10 UTC) and can be adapted for another timezone.

## Weekly review

```http
POST /functions/v1/weekly-review
Authorization: Bearer <weekly-review-token>
Content-Type: application/json

{}
```

The function aggregates the previous complete local week from daily-review facts. It is idempotent per week. The repository does not enable a weekly Cron by default.

## Read-only dashboard data

```http
GET /functions/v1/dashboard-data?limit=20
Authorization: Bearer <dashboard-read-token>
Accept: application/json
```

The response contains:

- `generated_at`
- a limited `records` list
- `daily_reviews`
- `weekly_reviews`
- `devices`
- optional short-lived `audio_url` values

It must not return device token hashes, service-role credentials, Storage object paths, internal tokens, or model keys. Signed audio URLs expire and should not be logged or cached as durable identifiers.

## Device serial commands

Provisioning and Wi-Fi commands transport values as base64 to avoid delimiter ambiguity; base64 is not encryption. Use a trusted local USB connection and the scripts in `scripts/`, which avoid printing secrets.

```text
PROVISION_V1 <base64-ssid> <base64-password> <base64-device-id> <base64-token> <minimum-sequence>
WIFI_SET_V1 <slot> <base64-ssid> <base64-password>
```

Slots `0`, `1`, and `2` represent primary, fallback, and hotspot. Successful responses report only slot/state metadata, never the SSID or password.

Read-only or RAM-only diagnostic commands include queue/network status, `POWER_STATUS`, `POMODORO_STATUS`, network pause/resume for controlled testing, and accelerated Pomodoro testing. Review the host scripts before using diagnostics on a device containing important recordings.
