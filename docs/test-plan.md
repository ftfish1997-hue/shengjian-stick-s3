# Reproducible Test Plan

This document is a checklist, not a record of the author's production environment. Use synthetic audio and identifiers only. Never attach real recordings, transcripts, Wi-Fi values, tokens, signed URLs, or device dumps to test reports.

## Automated local checks

- [ ] `python3 -m unittest discover -s simulator/tests -v`
- [ ] `python3 -m unittest discover -s scripts/tests -v`
- [ ] `make pomodoro-logic-test`
- [ ] `make validate-json`
- [ ] `node --experimental-strip-types --test supabase/functions/_shared/*.test.mjs`
- [ ] `make public-audit`
- [ ] `cd dashboard && npm ci && npm run lint && npm test`
- [ ] `PLATFORMIO_CORE_DIR="$PWD/.platformio-core" pio run -d firmware`

Expected result: every command exits zero and the privacy audit prints no matched values.

## Simulator scenarios

- [ ] Generated WAV is 16 kHz, 16-bit, mono, and has a valid header.
- [ ] Recordings made offline survive restart.
- [ ] A lost response after the server commits does not create a duplicate record.
- [ ] A response with the wrong event/record ID does not delete local files.
- [ ] Pomodoro time advances monotonically and handles 32-bit wraparound.
- [ ] Restart changes an active Pomodoro to interrupted.
- [ ] A Pomodoro note retains its session association.

## Local Supabase integration

Use a disposable local stack and synthetic tone WAV.

- [ ] Apply every migration to an empty database.
- [ ] Confirm the audio bucket is private.
- [ ] Unknown or disabled devices receive 401.
- [ ] A valid device upload returns an accepted response.
- [ ] Repeating the same event returns the same record with `duplicate: true`.
- [ ] Processing preserves `raw_text` and writes corrections only to `clean_text`.
- [ ] Classification is one of `idea`, `activity`, `task`, `note`, `journal`, or `inbox`.
- [ ] Transient failures observe retry/backoff/attempt limits; permanent failures are excluded.
- [ ] Daily and weekly requests are idempotent for the same date/week.
- [ ] Empty-day and empty-week paths do not invent facts.
- [ ] `dashboard-data` respects its limit and excludes private paths and credentials.
- [ ] Signed audio URL expires and cannot be used as a durable identifier.

## Hardware recording

Run only after reviewing the script and confirming the device contains no irreplaceable queue data.

- [ ] Twenty consecutive short recordings produce playable WAV files.
- [ ] A-key starts/finishes; B-key cancels without creating WAV or metadata.
- [ ] Recording automatically stops at 30 seconds.
- [ ] An interrupted write is never presented as a complete WAV.
- [ ] Low filesystem space refuses a new recording without overwriting an old one.
- [ ] Five offline recordings survive restart and later upload exactly once each.
- [ ] Local deletion occurs only after a matching valid acknowledgement.

## Network and provisioning

- [ ] Provisioning scripts do not print SSID, password, or device token.
- [ ] All three Wi-Fi slots reject invalid lengths and accept valid values.
- [ ] Primary failure rotates to fallback; fallback failure rotates to hotspot.
- [ ] A network without working time sync rotates instead of blocking forever.
- [ ] Transport failures can rotate networks; HTTP application errors do not.
- [ ] NVS and LittleFS survive a normal firmware update when erase is not requested.

## Screen, power, and Pomodoro

- [ ] Battery percentage and charge indicator react to USB connection state.
- [ ] Backlight turns off after the configured idle timeout.
- [ ] First A/B/power input while dark only wakes the display.
- [ ] Upload and queue processing continue while the backlight is off.
- [ ] Pomodoro start/pause/resume/reset controls match the UI labels.
- [ ] A complete focus interval stays within the selected timing tolerance.
- [ ] Accelerated RAM-only diagnostics leave NVS, LittleFS, and cloud data unchanged.

## Dashboard

- [ ] Development without environment variables shows clearly labeled synthetic preview data.
- [ ] Production without variables shows an unconfigured state, never preview data.
- [ ] Real data is fetched server-side with a dedicated read token.
- [ ] HTML contains no service-role key, model key, token hash, Storage path, or internal token.
- [ ] Records, daily review, weekly review, device state, and audio controls render on mobile and desktop.
- [ ] The deployed site requires the intended account authentication before returning personal data.

## Release gate

- [ ] All automated checks above pass from a fresh clone.
- [ ] `git rev-list --count main` and release history match the intended public history.
- [ ] Only synthetic fixtures and branding binaries are tracked.
- [ ] Anonymous users can read the public source but cannot access any private Dashboard or voice data.
