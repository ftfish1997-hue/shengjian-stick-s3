# Shengjian · Voice Inbox for M5StickS3

[简体中文](README.zh-CN.md)

Shengjian (声笺) turns an M5StickS3 into a pocket voice inbox. It records short notes, queues them safely while offline, uploads them when connectivity returns, transcribes and categorizes them, and presents the results in a read-only web dashboard.

This repository is a self-hosted reference implementation. It contains no production credentials, recordings, transcripts, device dumps, or access to the author's private dashboard.

## Features

- One-button voice capture with finish/cancel controls and a 30-second limit
- Offline queue with restart recovery and idempotent uploads
- Multiple Wi-Fi profiles, battery display, and automatic screen sleep
- Built-in Pomodoro timer
- ASR through Alibaba Cloud Model Studio/DashScope `paraformer-v2`
- Text correction, title/summary generation, and six-way classification through `qwen-turbo`
- Categories: idea, activity, task, note, journal, and inbox
- Daily and weekly review generation
- Optional Notion export
- Read-only responsive dashboard with signed audio URLs
- Host-side simulators and automated tests

## Architecture

```text
M5StickS3 firmware
  -> authenticated, idempotent upload
Supabase Storage + PostgreSQL + Edge Functions
  -> ASR -> correction -> classification -> summaries/reviews
Read-only dashboard
```

The firmware owns recording, offline persistence, retry, and the device UI. Supabase owns durable metadata, private audio storage, processing state, scheduled reviews, and the read-only API. The dashboard never receives service-role credentials; it calls `dashboard-data` from the server with a dedicated read token.

See [architecture](docs/architecture.md), [API reference](docs/api.md), and [test plan](docs/test-plan.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `firmware/` | PlatformIO firmware for M5StickS3 |
| `supabase/` | Database migrations, seed data, and Edge Functions |
| `dashboard/` | Read-only Next.js dashboard |
| `simulator/` | Python state-machine simulator |
| `mobile-simulator/` | Browser audio-capture simulator |
| `shared/` | JSON schemas and synthetic fixtures |
| `scripts/` | Provisioning, validation, and release-audit tools |

## Requirements

- M5StickS3 and a USB-C cable
- Python 3.11+
- Node.js 22+
- PlatformIO Core
- Supabase CLI and a Supabase project
- A DashScope-compatible API account for ASR and language-model processing
- Optional: Notion integration credentials

Cloud services may charge for storage, function execution, transcription, and model calls. Review current provider pricing before deploying.

## Quick start

1. Copy `.env.example` to a local `.env` and fill only your own values. Never commit it.
2. Start Supabase locally or link your own project, apply the migrations, and configure the documented Vault secrets.
3. Provision a device token and replace the firmware's placeholder project host before flashing.
4. Build the firmware:

   ```bash
   PLATFORMIO_CORE_DIR="$PWD/.platformio-core" pio run -d firmware
   ```

5. Run the dashboard locally:

   ```bash
   cd dashboard
   npm ci
   npm run dev
   ```

6. Run the local checks:

   ```bash
   make test
   make validate-json
   make public-audit
   ```

Deployment details and required secrets are documented in [docs/architecture.md](docs/architecture.md). Do not reuse example device IDs or tokens in production.

## Privacy and security

- Audio storage must remain private; playback URLs are short-lived and signed.
- Device, function, and dashboard tokens serve different roles and should be rotated independently.
- Notion export is optional and disabled without explicit credentials.
- Preview records are synthetic. Add your own data only to your private deployment.
- Run `make public-audit` before publishing forks or bug reports.

The dashboard is intentionally read-only. Publicly hosting it does not make the source data safe to expose; keep authentication in front of any deployment that contains personal recordings.

## Current limitations

- The reference processing pipeline is optimized for Mandarin and the listed DashScope models.
- Wi-Fi and cloud setup require local provisioning; no end-user onboarding app is included.
- Weekly review generation is implemented, but scheduling and Notion export are deployment choices.
- This is a personal project, not a medical, financial, or archival-grade system.

## Contributing and license

Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening a pull request or reporting a vulnerability.

Released under the [MIT License](LICENSE). Copyright © 2026 Masicheng Ma.
