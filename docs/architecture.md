# Architecture

## System boundary

Shengjian is a self-hosted voice-capture pipeline. The public repository contains the application code but no hosted service, production account, or user data.

```text
M5StickS3
  recording -> LittleFS queue -> authenticated HTTPS upload
        |
        v
Supabase
  private Storage + PostgreSQL + Edge Functions + optional pg_cron
        |
        +-> DashScope ASR and classification
        +-> optional Notion sync
        +-> read-only dashboard-data API
                          |
                          v
                  private Dashboard
```

## Firmware

The PlatformIO firmware records 16 kHz, 16-bit mono WAV files. Each completed recording receives a UUID event ID and a JSON metadata sidecar. WAV and metadata writes are finished before the item becomes eligible for upload.

Pending items live in LittleFS and survive restart. The uploader sends the same event ID on retry; it deletes local files only after a valid response confirms the same event ID and a valid record ID. A lost response therefore causes a safe duplicate request instead of duplicate data.

Wi-Fi credentials, the device ID, and the device token live in NVS after local serial provisioning. They are never compiled into this repository. Up to three Wi-Fi profiles are supported. Screen sleep only turns off the backlight; networking and queue processing continue.

Before flashing, replace `YOUR_PROJECT_REF.supabase.co` in `firmware/src/network_sync.cpp` with the host of a Supabase project you own. Keep the TLS CA validation enabled.

## Supabase data plane

Database migrations create device, record, processing, daily-review, and weekly-review tables together with idempotency and retry constraints. Audio belongs in a private Storage bucket.

Edge Functions have separate responsibilities:

| Function | Responsibility | Authentication |
| --- | --- | --- |
| `health` | Liveness response | None |
| `upload-record` | Validate device request, persist private audio and record metadata | Device Bearer token plus device/event headers |
| `process-record` | ASR, deterministic correction, structured classification | Internal function token |
| `retry-failures` | Claim eligible failed/stale records and re-run processing | Dedicated internal token |
| `daily-review` | Aggregate one local day and generate a narrative | Dedicated internal token |
| `weekly-review` | Aggregate one complete local week and generate a narrative | Dedicated internal token |
| `dashboard-data` | Return a limited read-only snapshot and signed audio URLs | Dedicated read token |
| `sync-notion` | Optional export adapter | Internal invocation only |

`process-record` keeps the ASR response in `raw_text`. Deterministic contextual corrections write `clean_text`; classification, title, summary, tags, and follow-ups are based on the cleaned text. The reference defaults use DashScope `paraformer-v2` for transcription and `qwen-turbo` for correction-aware classification and review narratives.

## Authentication and secrets

Use independent random values for every role:

- device token: accepted only for one enabled device; store only a one-way hash in the database
- `PROCESS_RECORD_TOKEN`
- `RETRY_FAILURES_TOKEN`
- `DAILY_REVIEW_TOKEN`
- `WEEKLY_REVIEW_TOKEN`
- `DASHBOARD_READ_TOKEN`
- `SUPABASE_SERVICE_ROLE_KEY`: Edge Functions only
- `DASHSCOPE_API_KEY`: processing functions only
- optional Notion token and database/data-source IDs

Set Edge Function secrets with the Supabase CLI or dashboard. Never expose service-role, model, internal-function, or Notion credentials to firmware or browser JavaScript.

Cron migrations expect the following values in Supabase Vault:

- `project_url`: base URL of the deployer's Supabase project
- `retry_failures_token`
- `daily_review_token`

The SQL constructs function URLs from `project_url`; public migrations contain no hosted project reference. Weekly scheduling is intentionally left to the deployer.

## Dashboard

The Dashboard is read-only. Its server process calls `dashboard-data` with `DASHBOARD_API_URL` and `DASHBOARD_READ_TOKEN`. The browser receives rendered records and short-lived signed audio URLs, never Storage object paths or backend credentials.

Development mode uses clearly marked synthetic preview data when these variables are absent. Production mode returns an unconfigured state instead of silently displaying preview data.

A dashboard containing personal voice notes must remain behind account authentication even though its application code is public.

## Local deployment outline

1. Copy `.env.example` to an ignored local file and populate your own values.
2. Start Supabase locally or link your own project.
3. Apply migrations and seed only the synthetic `demo-device-001` row locally.
4. Create the private audio bucket and configure Edge Function secrets.
5. Store Cron values in Vault before enabling scheduled jobs.
6. Deploy functions from `supabase/functions/`.
7. Provision a unique device ID/token, configure the firmware host, build, and flash.
8. Deploy the Dashboard with server-only read API variables and external account access control.

Exact CLI syntax varies by Supabase and hosting-tool version. Review current official documentation before operating a live project.

## Data retention and privacy

`AUDIO_RETENTION_DAYS` defines the intended audio retention window for deployments that enable cleanup. Database facts and generated reviews may outlive audio unless the deployer implements matching deletion rules. Notion creates an additional copy and must be evaluated separately.

Logs should contain event state and rule names, not tokens, Wi-Fi credentials, transcription bodies, or signed URLs. Run `make public-audit` before publishing logs, forks, or releases.
