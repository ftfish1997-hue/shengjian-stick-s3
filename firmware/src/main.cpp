#include <M5Unified.h>
#include <LittleFS.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <sys/stat.h>

#include <esp_heap_caps.h>
#include <mbedtls/sha256.h>

#include "app_config.h"
#include "network_sync.h"
#include "pomodoro_timer.h"

namespace {

constexpr size_t kMaxRecordingSampleCount =
    app_config::kRecordingSampleRate * app_config::kRecordingManualMaxSeconds;
constexpr size_t kMinRecordingSampleCount =
    app_config::kRecordingSampleRate * app_config::kRecordingMinSeconds;
constexpr size_t kMicBlockSamples = 320;
constexpr size_t kMicWarmupSamples = app_config::kRecordingSampleRate / 2;
constexpr uint32_t kMicWarmupTimeoutMs = 3000;
constexpr uint32_t kMicCaptureTimeoutMs =
    app_config::kRecordingManualMaxSeconds * 1000U + 3000U;
constexpr uint32_t kStartButtonSettleMs = 150;
constexpr size_t kStopButtonTrimSamples =
    app_config::kRecordingSampleRate * 150 / 1000;
constexpr size_t kWavHeaderBytes = 44;
constexpr size_t kFilesystemReserveBytes = 64 * 1024;
constexpr uint32_t kFilesystemFormatHoldMs = 3000;
constexpr uint32_t kScreenIdleTimeoutMs = 30000;
constexpr uint32_t kPomodoroCancelHoldMs = 1500;
constexpr char kPendingDirectory[] = "/pending";
constexpr char kLittleFsMountPoint[] = "/littlefs";
constexpr size_t kExportInputBlockBytes = 768;
constexpr size_t kExportOutputBlockBytes = 1024;
constexpr uint16_t kBackgroundColor = 0x0863;  // dark green
constexpr uint16_t kAccentColor = 0xC6E7;      // lime
constexpr uint16_t kMutedColor = 0x9CF3;
constexpr uint16_t kRecordingColor = 0xFBAA;

struct MicStats {
  int32_t dc_offset = 0;
  int32_t peak = 0;
  float rms = 0.0f;
  float dbfs = -96.0f;
  size_t active_samples = 0;
  size_t clipped_samples = 0;
};

struct CaptureResult {
  bool ok = false;
  bool cancelled = false;
  bool stopped_by_user = false;
  size_t sample_count = 0;
  uint32_t elapsed_ms = 0;
};

enum class UiView : uint8_t {
  kHome,
  kPomodoro,
};

int16_t* mic_buffer = nullptr;
bool mic_ready = false;
bool filesystem_ready = false;
size_t pending_recording_count = 0;
uint32_t next_recording_sequence = 1;
uint32_t format_hold_started_at = 0;
bool format_started = false;
bool interrupt_next_capture = false;
char serial_command[384] = {};
size_t serial_command_length = 0;
bool screen_off = false;
uint8_t screen_on_brightness = 128;
uint32_t last_user_activity_at = 0;
bool ignore_buttons_until_released = false;
bool home_screen_visible = false;
UiView current_view = UiView::kHome;
PomodoroTimer pomodoro_timer(app_config::kPomodoroFocusDurationMs);
uint32_t last_pomodoro_draw_second = 0xFFFFFFFFU;

void drawFilesystemFormatPrompt();
void drawCurrentView();

size_t expectedWavBytes(size_t sample_count) {
  return kWavHeaderBytes + sample_count * sizeof(int16_t);
}

size_t filesystemFreeBytes() {
  if (!filesystem_ready) {
    return 0;
  }
  const size_t total = LittleFS.totalBytes();
  const size_t used = LittleFS.usedBytes();
  return total >= used ? total - used : 0;
}

void resetDisplay(uint16_t background = kBackgroundColor) {
  home_screen_visible = false;
  M5.Display.fillScreen(background);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(TFT_WHITE, background);
}

void drawHeader(const char* section) {
  M5.Display.setTextColor(kAccentColor, kBackgroundColor);
  M5.Display.drawString("STICKS3 / STAGE 0", 10, 10);
  M5.Display.setTextColor(TFT_WHITE, kBackgroundColor);
  M5.Display.setTextSize(2);
  M5.Display.drawString(section, 10, 31);
  M5.Display.setTextSize(1);
}

void drawHome() {
  resetDisplay();
  home_screen_visible = true;
  drawHeader("WAV recorder");

  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("16 kHz / 16-bit / mono", 10, 62);

  M5.Display.drawRoundRect(10, 89, M5.Display.width() - 20, 67, 12, kAccentColor);
  M5.Display.setTextColor(kAccentColor, kBackgroundColor);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextSize(2);
  M5.Display.drawString("A", M5.Display.width() / 2, 111);
  M5.Display.setTextSize(1);
  M5.Display.drawString("A: start / stop", M5.Display.width() / 2, 135);
  M5.Display.drawString("B: focus timer", M5.Display.width() / 2, 148);

  M5.Display.setTextDatum(top_left);
  const PomodoroState pomodoro_state = pomodoro_timer.state();
  if (pomodoro_state == PomodoroState::kRunning ||
      pomodoro_state == PomodoroState::kPaused) {
    const uint32_t remaining_seconds =
        (pomodoro_timer.remainingMs(millis()) + 999U) / 1000U;
    char focus_status[32] = {};
    std::snprintf(
        focus_status, sizeof(focus_status), "FOCUS %02u:%02u %s",
        static_cast<unsigned>(remaining_seconds / 60U),
        static_cast<unsigned>(remaining_seconds % 60U),
        pomodoro_state == PomodoroState::kRunning ? "RUN" : "PAUSE");
    M5.Display.setTextColor(kRecordingColor, kBackgroundColor);
    M5.Display.drawString(focus_status, 10, 160);
  }
  const int32_t battery_level = M5.Power.getBatteryLevel();
  char device_status[40] = {};
  if (battery_level >= 0 && battery_level <= 100) {
    std::snprintf(device_status, sizeof(device_status), "%s  BAT %ld%%%s",
                  mic_ready ? "MIC OK" : "MIC ERR",
                  static_cast<long>(battery_level),
                  M5.Power.isCharging() == m5::Power_Class::is_charging
                      ? "+"
                      : "");
  } else {
    std::snprintf(device_status, sizeof(device_status), "%s  BAT ?",
                  mic_ready ? "MIC OK" : "MIC ERR");
  }
  M5.Display.setTextColor(mic_ready ? kAccentColor : kRecordingColor,
                          kBackgroundColor);
  M5.Display.drawString(device_status, 10, 174);
  char storage_status[64] = {};
  if (filesystem_ready) {
    std::snprintf(storage_status, sizeof(storage_status), "FS OK  %u pending  %u KB free",
                  static_cast<unsigned>(pending_recording_count),
                  static_cast<unsigned>(filesystemFreeBytes() / 1024));
  } else {
    std::snprintf(storage_status, sizeof(storage_status), "FS NOT READY");
  }
  M5.Display.setTextColor(filesystem_ready ? kAccentColor : kRecordingColor,
                          kBackgroundColor);
  M5.Display.drawString(storage_status, 10, 190);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString(network_sync::statusLine(), 10, 206);
  M5.Display.drawString(app_config::kVersion, 10, 222);
}

void drawPomodoro(bool full_redraw) {
  const uint32_t remaining_seconds =
      (pomodoro_timer.remainingMs(millis()) + 999U) / 1000U;
  const PomodoroState state = pomodoro_timer.state();

  if (full_redraw) {
    resetDisplay();
    drawHeader("Focus timer");
    M5.Display.setTextDatum(middle_center);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(kMutedColor, kBackgroundColor);

    const char* action = "A: start 25 min";
    if (state == PomodoroState::kRunning) {
      action = "A: pause";
    } else if (state == PomodoroState::kPaused) {
      action = "A: resume";
    } else if (state == PomodoroState::kCompleted) {
      action = "A: start again";
    }
    M5.Display.drawString(action, M5.Display.width() / 2, 166);
    M5.Display.drawString("B: home", M5.Display.width() / 2, 184);
    M5.Display.drawString("Hold B: reset", M5.Display.width() / 2, 201);
    M5.Display.setTextDatum(top_left);
    M5.Display.drawString(app_config::kVersion, 10, 222);
  }

  M5.Display.fillRect(0, 67, M5.Display.width(), 86, kBackgroundColor);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(
      state == PomodoroState::kCompleted ? kAccentColor : kMutedColor,
      kBackgroundColor);
  const char* label = "READY";
  if (state == PomodoroState::kRunning) {
    label = "FOCUS";
  } else if (state == PomodoroState::kPaused) {
    label = "PAUSED";
  } else if (state == PomodoroState::kCompleted) {
    label = "COMPLETE";
  }
  M5.Display.drawString(label, M5.Display.width() / 2, 78);

  char timer[8] = {};
  std::snprintf(timer, sizeof(timer), "%02u:%02u",
                static_cast<unsigned>(remaining_seconds / 60U),
                static_cast<unsigned>(remaining_seconds % 60U));
  M5.Display.setTextColor(
      state == PomodoroState::kPaused ? kMutedColor : kRecordingColor,
      kBackgroundColor);
  M5.Display.setTextSize(4);
  M5.Display.drawString(timer, M5.Display.width() / 2, 114);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
  last_pomodoro_draw_second = remaining_seconds;
}

void drawCurrentView() {
  if (!filesystem_ready) {
    drawFilesystemFormatPrompt();
  } else if (current_view == UiView::kPomodoro) {
    drawPomodoro(true);
  } else {
    drawHome();
  }
}

const char* chargingStatus() {
  switch (M5.Power.isCharging()) {
    case m5::Power_Class::is_charging:
      return "charging";
    case m5::Power_Class::is_discharging:
      return "discharging";
    default:
      return "unknown";
  }
}

void noteUserActivity() { last_user_activity_at = millis(); }

bool turnScreenOff(const char* reason) {
  if (screen_off) return false;
  M5.Display.setBrightness(0);
  screen_off = true;
  Serial.printf("screen_off reason=%s timeout_ms=%u\n", reason,
                static_cast<unsigned>(kScreenIdleTimeoutMs));
  return true;
}

bool turnScreenOn(const char* reason) {
  if (!screen_off) return false;
  M5.Display.setBrightness(screen_on_brightness);
  screen_off = false;
  noteUserActivity();
  drawCurrentView();
  Serial.printf("screen_on reason=%s brightness=%u\n", reason,
                static_cast<unsigned>(screen_on_brightness));
  return true;
}

bool handleScreenPowerInput() {
  if (ignore_buttons_until_released) {
    if (!M5.BtnA.isPressed() && !M5.BtnB.isPressed() &&
        !M5.BtnPWR.isPressed()) {
      ignore_buttons_until_released = false;
    }
    return true;
  }

  const bool a_pressed = M5.BtnA.wasPressed();
  const bool b_pressed = M5.BtnB.wasPressed();
  const bool power_pressed = M5.BtnPWR.wasPressed();
  const bool any_pressed = a_pressed || b_pressed || power_pressed;

  if (screen_off && any_pressed) {
    turnScreenOn("button");
    ignore_buttons_until_released = true;
    return true;
  }
  if (!screen_off && power_pressed) {
    turnScreenOff("power_button");
    return true;
  }
  if (a_pressed || b_pressed) noteUserActivity();
  if (!screen_off && millis() - last_user_activity_at >= kScreenIdleTimeoutMs) {
    turnScreenOff("idle");
  }
  return false;
}

void drawRecording(uint32_t elapsed_ms, bool full_redraw) {
  const uint32_t elapsed_seconds = elapsed_ms / 1000U;
  char timer[8] = {};
  std::snprintf(timer, sizeof(timer), "%02u:%02u",
                static_cast<unsigned>(elapsed_seconds / 60U),
                static_cast<unsigned>(elapsed_seconds % 60U));

  if (full_redraw) {
    resetDisplay();
    drawHeader("Recording");
    M5.Display.setTextDatum(middle_center);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(kMutedColor, kBackgroundColor);
    M5.Display.drawString("A: stop   B: cancel", M5.Display.width() / 2, 166);
    M5.Display.drawString("auto-stop at 00:30", M5.Display.width() / 2, 184);
  }

  M5.Display.fillRect(0, 70, M5.Display.width(), 76, kBackgroundColor);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(kRecordingColor, kBackgroundColor);
  M5.Display.setTextSize(4);
  M5.Display.drawString(timer, M5.Display.width() / 2, 103);
  M5.Display.setTextSize(1);
  M5.Display.setTextDatum(top_left);
}

void drawStarting() {
  resetDisplay();
  drawHeader("Get ready");
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("Release A to start", M5.Display.width() / 2, 113);
  M5.Display.setTextDatum(top_left);
}

void drawCancelled() {
  resetDisplay();
  drawHeader("Cancelled");
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("No WAV was saved.", 10, 90);
}

void drawSaving() {
  resetDisplay();
  drawHeader("Saving WAV");
  M5.Display.setTextColor(kAccentColor, kBackgroundColor);
  M5.Display.drawString("Finalizing audio...", 10, 91);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("Do not disconnect power.", 10, 119);
}

MicStats calculateStats(const int16_t* samples, size_t sample_count) {
  MicStats stats;
  if (samples == nullptr || sample_count == 0) {
    return stats;
  }

  int64_t sum = 0;
  for (size_t index = 0; index < sample_count; ++index) {
    sum += samples[index];
    const int32_t raw = samples[index];
    const int32_t absolute = raw < 0 ? -raw : raw;
    if (absolute >= 32760) {
      ++stats.clipped_samples;
    }
  }
  stats.dc_offset = static_cast<int32_t>(sum / static_cast<int64_t>(sample_count));

  uint64_t square_sum = 0;
  for (size_t index = 0; index < sample_count; ++index) {
    const int32_t centered = static_cast<int32_t>(samples[index]) - stats.dc_offset;
    const int32_t absolute = centered < 0 ? -centered : centered;
    if (absolute > stats.peak) {
      stats.peak = absolute;
    }
    if (absolute >= 64) {
      ++stats.active_samples;
    }
    square_sum += static_cast<int64_t>(centered) * centered;
  }

  stats.rms = std::sqrt(static_cast<float>(square_sum) /
                        static_cast<float>(sample_count));
  if (stats.rms > 0.0f) {
    stats.dbfs = 20.0f * std::log10(stats.rms / 32768.0f);
    if (stats.dbfs < -96.0f) {
      stats.dbfs = -96.0f;
    }
  }
  return stats;
}

void drawResults(const MicStats& stats, size_t sample_count,
                 const char* saved_path) {
  const float active_percent =
      100.0f * static_cast<float>(stats.active_samples) /
      static_cast<float>(sample_count);
  const bool signal_detected = stats.peak >= 64 && stats.active_samples > 0;

  resetDisplay();
  drawHeader(signal_detected ? "WAV saved" : "Saved / quiet");

  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("PEAK", 10, 69);
  M5.Display.drawString("RMS", 10, 93);
  M5.Display.drawString("LEVEL", 10, 117);
  M5.Display.drawString("ACTIVE", 10, 141);
  M5.Display.drawString("CLIPPED", 10, 165);

  M5.Display.setTextColor(TFT_WHITE, kBackgroundColor);
  M5.Display.setTextDatum(top_right);
  M5.Display.drawNumber(stats.peak, M5.Display.width() - 10, 69);
  M5.Display.drawNumber(static_cast<int32_t>(stats.rms), M5.Display.width() - 10,
                        93);
  M5.Display.drawFloat(stats.dbfs, 1, M5.Display.width() - 10, 117);
  M5.Display.drawFloat(active_percent, 1, M5.Display.width() - 10, 141);
  M5.Display.drawNumber(stats.clipped_samples, M5.Display.width() - 10, 165);

  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(kAccentColor, kBackgroundColor);
  const char* filename = std::strrchr(saved_path, '/');
  filename = filename == nullptr ? saved_path : filename + 1;
  M5.Display.drawString(filename, 10, 190);
  M5.Display.drawString("A: again", 10, 218);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("B: home", 76, 218);
}

void drawCaptureError(const char* message) {
  resetDisplay();
  drawHeader("Mic error");
  M5.Display.setTextColor(kRecordingColor, kBackgroundColor);
  M5.Display.drawString(message, 10, 81);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("Restarting safely...", 10, 112);
}

void drawStorageError(const char* message) {
  resetDisplay();
  drawHeader("Storage error");
  M5.Display.setTextColor(kRecordingColor, kBackgroundColor);
  M5.Display.drawString(message, 10, 81);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("No recording was replaced.", 10, 112);
  M5.Display.drawString("B: home", 10, 218);
}

void drawFilesystemFormatPrompt() {
  resetDisplay();
  drawHeader("FS not ready");
  M5.Display.setTextColor(kRecordingColor, kBackgroundColor);
  M5.Display.drawString("Recording is disabled.", 10, 70);
  M5.Display.setTextColor(TFT_WHITE, kBackgroundColor);
  M5.Display.drawString("Hold B for 3 seconds", 10, 105);
  M5.Display.drawString("to FORMAT storage.", 10, 125);
  M5.Display.setTextColor(kMutedColor, kBackgroundColor);
  M5.Display.drawString("Formatting erases queued files.", 10, 160);
  M5.Display.drawString(app_config::kVersion, 10, 218);
}

void putLe16(uint8_t* destination, uint16_t value) {
  destination[0] = static_cast<uint8_t>(value & 0xFF);
  destination[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void putLe32(uint8_t* destination, uint32_t value) {
  destination[0] = static_cast<uint8_t>(value & 0xFF);
  destination[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  destination[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  destination[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

void createWavHeader(uint8_t* header, uint32_t data_bytes) {
  std::memset(header, 0, kWavHeaderBytes);
  std::memcpy(header, "RIFF", 4);
  putLe32(header + 4, 36 + data_bytes);
  std::memcpy(header + 8, "WAVE", 4);
  std::memcpy(header + 12, "fmt ", 4);
  putLe32(header + 16, 16);
  putLe16(header + 20, 1);
  putLe16(header + 22, 1);
  putLe32(header + 24, app_config::kRecordingSampleRate);
  const uint32_t byte_rate = app_config::kRecordingSampleRate *
                             app_config::kRecordingBitsPerSample / 8;
  putLe32(header + 28, byte_rate);
  putLe16(header + 32, app_config::kRecordingBitsPerSample / 8);
  putLe16(header + 34, app_config::kRecordingBitsPerSample);
  std::memcpy(header + 36, "data", 4);
  putLe32(header + 40, data_bytes);
}

bool hasSuffix(const char* value, const char* suffix) {
  const size_t value_length = std::strlen(value);
  const size_t suffix_length = std::strlen(suffix);
  return value_length >= suffix_length &&
         std::strcmp(value + value_length - suffix_length, suffix) == 0;
}

bool filesystemPathExists(const char* littlefs_path) {
  char mounted_path[96] = {};
  const int length = std::snprintf(mounted_path, sizeof(mounted_path), "%s%s",
                                   kLittleFsMountPoint, littlefs_path);
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(mounted_path)) {
    return false;
  }
  struct stat info = {};
  return stat(mounted_path, &info) == 0;
}

uint32_t recordingSequenceFromName(const char* path) {
  const char* name = std::strrchr(path, '/');
  name = name == nullptr ? path : name + 1;
  if (std::strlen(name) != 20 || std::strncmp(name, "recording-", 10) != 0 ||
      std::strcmp(name + 16, ".wav") != 0) {
    return 0;
  }

  uint32_t sequence = 0;
  for (size_t index = 10; index < 16; ++index) {
    if (name[index] < '0' || name[index] > '9') {
      return 0;
    }
    sequence = sequence * 10 + static_cast<uint32_t>(name[index] - '0');
  }
  return sequence;
}

bool scanPendingDirectory() {
  pending_recording_count = 0;
  next_recording_sequence = 1;
  File directory = LittleFS.open(kPendingDirectory);
  if (!directory || !directory.isDirectory()) {
    return false;
  }

  File entry = directory.openNextFile();
  while (entry) {
    const char* path = entry.name();
    if (!entry.isDirectory() && hasSuffix(path, ".tmp")) {
      char stale_path[64] = {};
      std::snprintf(stale_path, sizeof(stale_path), "%s/%s", kPendingDirectory,
                    std::strrchr(path, '/') == nullptr ? path
                                                       : std::strrchr(path, '/') + 1);
      entry.close();
      const bool removed = LittleFS.remove(stale_path);
      Serial.printf("wav_recovery stale=%s removed=%s\n", stale_path,
                    removed ? "true" : "false");
    } else {
      const uint32_t sequence = recordingSequenceFromName(path);
      if (sequence > 0) {
        ++pending_recording_count;
        if (sequence >= next_recording_sequence) {
          next_recording_sequence = sequence + 1;
        }
      }
      entry.close();
    }
    entry = directory.openNextFile();
  }
  directory.close();
  return true;
}

void deleteLegacyRecordings() {
  if (!filesystem_ready || !network_sync::isProvisioned() ||
      network_sync::uploadMinimumSequence() != 7U) {
    Serial.printf(
        "legacy_delete_refused reason=invalid_migration_state fs=%s "
        "provisioned=%s upload_min=%u\n",
        filesystem_ready ? "ready" : "error",
        network_sync::isProvisioned() ? "true" : "false",
        static_cast<unsigned>(network_sync::uploadMinimumSequence()));
    return;
  }

  File directory = LittleFS.open(kPendingDirectory);
  if (!directory || !directory.isDirectory()) {
    Serial.println("legacy_delete_refused reason=pending_directory_unavailable");
    return;
  }
  bool only_legacy_wavs = true;
  File entry = directory.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      const uint32_t sequence = recordingSequenceFromName(entry.name());
      if (sequence > 6U) only_legacy_wavs = false;
    }
    entry.close();
    entry = directory.openNextFile();
  }
  directory.close();
  if (!only_legacy_wavs) {
    Serial.println("legacy_delete_refused reason=newer_recording_present");
    return;
  }

  bool delete_ok = true;
  size_t removed_wavs = 0;
  size_t removed_metadata = 0;
  for (uint32_t sequence = 1; sequence <= 6; ++sequence) {
    char wav_path[64] = {};
    char metadata_path[64] = {};
    std::snprintf(wav_path, sizeof(wav_path),
                  "/pending/recording-%06u.wav",
                  static_cast<unsigned>(sequence));
    std::snprintf(metadata_path, sizeof(metadata_path),
                  "/pending/recording-%06u.json",
                  static_cast<unsigned>(sequence));
    if (filesystemPathExists(wav_path)) {
      if (LittleFS.remove(wav_path)) {
        ++removed_wavs;
      } else {
        delete_ok = false;
      }
    }
    if (filesystemPathExists(metadata_path)) {
      if (LittleFS.remove(metadata_path)) {
        ++removed_metadata;
      } else {
        delete_ok = false;
      }
    }
  }

  const bool scan_ok = scanPendingDirectory();
  if (!delete_ok || !scan_ok || pending_recording_count != 0) {
    Serial.printf(
        "legacy_delete_incomplete removed_wavs=%u removed_metadata=%u "
        "pending=%u upload_min_unchanged=7\n",
        static_cast<unsigned>(removed_wavs),
        static_cast<unsigned>(removed_metadata),
        static_cast<unsigned>(pending_recording_count));
    drawHome();
    return;
  }
  if (!network_sync::setUploadMinimumSequence(1U)) {
    Serial.printf(
        "legacy_delete_incomplete removed_wavs=%u pending=0 "
        "reason=nvs_write_failed rerun_same_command=true\n",
        static_cast<unsigned>(removed_wavs));
    drawHome();
    return;
  }

  Serial.printf(
      "legacy_delete_done removed_wavs=%u removed_metadata=%u pending=0 "
      "next=1 upload_min=1\n",
      static_cast<unsigned>(removed_wavs),
      static_cast<unsigned>(removed_metadata));
  drawHome();
}

bool mountFilesystem() {
  if (!LittleFS.begin(false)) {
    Serial.println("filesystem_mount=false auto_format=false");
    return false;
  }
  if (!filesystemPathExists(kPendingDirectory) &&
      !LittleFS.mkdir(kPendingDirectory)) {
    Serial.println("filesystem_error reason=mkdir_failed");
    LittleFS.end();
    return false;
  }
  if (!scanPendingDirectory()) {
    Serial.println("filesystem_error reason=scan_failed");
    LittleFS.end();
    return false;
  }
  const size_t total = LittleFS.totalBytes();
  const size_t used = LittleFS.usedBytes();
  const size_t free = total >= used ? total - used : 0;
  Serial.printf("filesystem_mount=true total=%u used=%u free=%u pending=%u next=%u\n",
                static_cast<unsigned>(total), static_cast<unsigned>(used),
                static_cast<unsigned>(free),
                static_cast<unsigned>(pending_recording_count),
                static_cast<unsigned>(next_recording_sequence));
  return true;
}

void formatFilesystem() {
  format_started = true;
  resetDisplay();
  drawHeader("Formatting");
  M5.Display.setTextColor(kRecordingColor, kBackgroundColor);
  M5.Display.drawString("Do not disconnect power.", 10, 90);
  Serial.println("filesystem_format_start source=physical_hold");

  LittleFS.end();
  const bool formatted = LittleFS.format();
  filesystem_ready = formatted && mountFilesystem();
  Serial.printf("filesystem_format_done formatted=%s mounted=%s\n",
                formatted ? "true" : "false",
                filesystem_ready ? "true" : "false");
  if (filesystem_ready) {
    drawHome();
  } else {
    drawFilesystemFormatPrompt();
  }
}

bool writeWavAtomically(const int16_t* samples, size_t sample_count,
                        char* saved_path, size_t saved_path_size) {
  if (!filesystem_ready || samples == nullptr || next_recording_sequence > 999999) {
    return false;
  }

  const size_t data_bytes = sample_count * sizeof(int16_t);
  const size_t wav_bytes = kWavHeaderBytes + data_bytes;
  if (filesystemFreeBytes() < wav_bytes + kFilesystemReserveBytes) {
    Serial.printf("wav_write_error reason=no_space required=%u free=%u reserve=%u\n",
                  static_cast<unsigned>(wav_bytes),
                  static_cast<unsigned>(filesystemFreeBytes()),
                  static_cast<unsigned>(kFilesystemReserveBytes));
    return false;
  }

  char temporary_path[64] = {};
  std::snprintf(saved_path, saved_path_size, "/pending/recording-%06u.wav",
                static_cast<unsigned>(next_recording_sequence));
  std::snprintf(temporary_path, sizeof(temporary_path), "%s.tmp", saved_path);
  if (filesystemPathExists(saved_path) || filesystemPathExists(temporary_path)) {
    Serial.printf("wav_write_error reason=path_collision path=%s\n", saved_path);
    return false;
  }

  Serial.printf("wav_write_start temporary=%s final=%s bytes=%u\n", temporary_path,
                saved_path, static_cast<unsigned>(wav_bytes));
  File output = LittleFS.open(temporary_path, FILE_WRITE);
  if (!output) {
    Serial.println("wav_write_error reason=open_failed");
    return false;
  }

  uint8_t header[kWavHeaderBytes] = {};
  createWavHeader(header, static_cast<uint32_t>(data_bytes));
  bool write_ok = output.write(header, sizeof(header)) == sizeof(header);
  const uint8_t* audio_bytes = reinterpret_cast<const uint8_t*>(samples);
  size_t written = 0;
  constexpr size_t kWriteBlockBytes = 4096;
  while (write_ok && written < data_bytes) {
    const size_t remaining = data_bytes - written;
    const size_t block = remaining < kWriteBlockBytes ? remaining : kWriteBlockBytes;
    write_ok = output.write(audio_bytes + written, block) == block;
    written += block;
    delay(1);
  }
  output.flush();
  output.close();

  File verification = LittleFS.open(temporary_path, FILE_READ);
  const bool size_ok = verification && verification.size() == wav_bytes;
  if (verification) {
    verification.close();
  }
  if (!write_ok || !size_ok) {
    LittleFS.remove(temporary_path);
    Serial.printf("wav_write_error reason=short_write write_ok=%s size_ok=%s\n",
                  write_ok ? "true" : "false", size_ok ? "true" : "false");
    return false;
  }

  if (!LittleFS.rename(temporary_path, saved_path)) {
    LittleFS.remove(temporary_path);
    Serial.println("wav_write_error reason=rename_failed");
    return false;
  }

  ++pending_recording_count;
  ++next_recording_sequence;
  Serial.printf("wav_write_done path=%s bytes=%u pending=%u free=%u\n", saved_path,
                static_cast<unsigned>(wav_bytes),
                static_cast<unsigned>(pending_recording_count),
                static_cast<unsigned>(filesystemFreeBytes()));
  return true;
}

size_t encodeBase64Block(const uint8_t* input, size_t input_length,
                         char* output) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t input_index = 0;
  size_t output_index = 0;
  while (input_index < input_length) {
    const size_t remaining = input_length - input_index;
    const uint32_t first = input[input_index++];
    const uint32_t second = remaining > 1 ? input[input_index++] : 0;
    const uint32_t third = remaining > 2 ? input[input_index++] : 0;
    const uint32_t combined = (first << 16) | (second << 8) | third;
    output[output_index++] = kAlphabet[(combined >> 18) & 0x3F];
    output[output_index++] = kAlphabet[(combined >> 12) & 0x3F];
    output[output_index++] = remaining > 1 ? kAlphabet[(combined >> 6) & 0x3F]
                                           : '=';
    output[output_index++] = remaining > 2 ? kAlphabet[combined & 0x3F] : '=';
  }
  return output_index;
}

bool sha256File(File& input, uint8_t* digest) {
  if (!input || digest == nullptr || !input.seek(0)) {
    return false;
  }

  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  bool ok = mbedtls_sha256_starts_ret(&context, 0) == 0;
  uint8_t block[512] = {};
  while (ok && input.available()) {
    const size_t read = input.read(block, sizeof(block));
    if (read == 0) {
      ok = false;
      break;
    }
    ok = mbedtls_sha256_update_ret(&context, block, read) == 0;
  }
  if (ok) {
    ok = mbedtls_sha256_finish_ret(&context, digest) == 0;
  }
  mbedtls_sha256_free(&context);
  return ok && input.seek(0);
}

void digestToHex(const uint8_t* digest, char* output, size_t output_size) {
  static constexpr char kHex[] = "0123456789abcdef";
  if (output_size < 65) {
    if (output_size > 0) {
      output[0] = '\0';
    }
    return;
  }
  for (size_t index = 0; index < 32; ++index) {
    output[index * 2] = kHex[digest[index] >> 4];
    output[index * 2 + 1] = kHex[digest[index] & 0x0F];
  }
  output[64] = '\0';
}

void exportLatestWav() {
  if (!filesystem_ready || pending_recording_count == 0 ||
      next_recording_sequence <= 1) {
    Serial.println("wav_export_error reason=no_pending_recording");
    return;
  }

  char path[64] = {};
  std::snprintf(path, sizeof(path), "/pending/recording-%06u.wav",
                static_cast<unsigned>(next_recording_sequence - 1));
  File input = LittleFS.open(path, FILE_READ);
  if (!input) {
    Serial.printf("wav_export_error reason=open_failed path=%s\n", path);
    return;
  }

  const size_t file_size = input.size();
  uint8_t digest[32] = {};
  char digest_hex[65] = {};
  if (!sha256File(input, digest)) {
    input.close();
    Serial.println("wav_export_error reason=hash_failed");
    return;
  }
  digestToHex(digest, digest_hex, sizeof(digest_hex));

  Serial.printf("wav_export_start path=%s bytes=%u encoding=base64 sha256=%s\n",
                path, static_cast<unsigned>(file_size), digest_hex);
  uint8_t input_block[kExportInputBlockBytes] = {};
  char output_block[kExportOutputBlockBytes] = {};
  size_t exported_bytes = 0;
  bool read_ok = true;
  while (exported_bytes < file_size) {
    const size_t remaining = file_size - exported_bytes;
    const size_t requested = remaining < sizeof(input_block) ? remaining
                                                              : sizeof(input_block);
    const size_t read = input.read(input_block, requested);
    if (read != requested) {
      read_ok = false;
      break;
    }
    const size_t encoded = encodeBase64Block(input_block, read, output_block);
    Serial.print("B64:");
    Serial.write(reinterpret_cast<const uint8_t*>(output_block), encoded);
    Serial.print('\n');
    exported_bytes += read;
    delay(1);
  }
  input.close();

  if (!read_ok) {
    Serial.printf("wav_export_error reason=short_read exported=%u expected=%u\n",
                  static_cast<unsigned>(exported_bytes),
                  static_cast<unsigned>(file_size));
    return;
  }
  Serial.printf("wav_export_done bytes=%u sha256=%s\n",
                static_cast<unsigned>(exported_bytes), digest_hex);
}

void runSerialCommand(const char* command) {
  if (network_sync::isProvisionCommand(command)) {
    if (network_sync::handleProvisionCommand(command, next_recording_sequence)) {
      Serial.flush();
      delay(100);
      ESP.restart();
    }
  } else if (network_sync::isWifiConfigCommand(command)) {
    if (network_sync::handleWifiConfigCommand(command)) {
      Serial.flush();
      delay(100);
      ESP.restart();
    }
  } else if (std::strcmp(command, "WIFI_STATUS") == 0) {
    const int active_slot = network_sync::activeWifiSlot();
    const int connecting_slot = network_sync::connectingWifiSlot();
    Serial.printf(
        "wifi_status schema=2 configured=%u active=%d active_role=%s "
        "connecting=%d connecting_role=%s paused_for_test=%s "
        "credentials_redacted=true\n",
        static_cast<unsigned>(network_sync::configuredWifiCount()),
        active_slot,
        active_slot >= 0
            ? network_sync::wifiSlotRole(static_cast<size_t>(active_slot))
            : "NONE",
        connecting_slot,
        connecting_slot >= 0
            ? network_sync::wifiSlotRole(
                  static_cast<size_t>(connecting_slot))
            : "NONE",
        network_sync::networkPausedForTest() ? "true" : "false");
  } else if (std::strcmp(command, "EXPORT_LATEST") == 0) {
    exportLatestWav();
  } else if (std::strcmp(command, "TEST_INTERRUPT_NEXT") == 0) {
    if (!mic_ready || !filesystem_ready) {
      Serial.println("test_interrupt_error reason=device_not_ready");
    } else {
      interrupt_next_capture = true;
      Serial.println("test_interrupt_armed delay_ms=1000 one_shot=true");
    }
  } else if (std::strcmp(command, "TEST_DROP_ACK_NEXT") == 0) {
    if (network_sync::armDropAckNext()) {
      Serial.println("test_drop_ack_armed one_shot=true restart_clears=true");
    } else {
      Serial.println("test_drop_ack_error reason=not_ready_or_already_armed");
    }
  } else if (std::strcmp(command, "TEST_NETWORK_PAUSE") == 0) {
    if (network_sync::setNetworkPausedForTest(true)) {
      Serial.println(
          "test_network_paused ram_only=true restart_clears=true");
    } else {
      Serial.println(
          "test_network_pause_error reason=not_ready_or_already_paused");
    }
  } else if (std::strcmp(command, "TEST_NETWORK_RESUME") == 0) {
    if (network_sync::setNetworkPausedForTest(false)) {
      Serial.println("test_network_resumed reconnect=automatic");
    } else {
      Serial.println(
          "test_network_resume_error reason=not_ready_or_not_paused");
    }
  } else if (std::strcmp(command, "TEST_SCREEN_OFF") == 0) {
    if (!turnScreenOff("test")) {
      Serial.println("screen_test_error reason=already_off");
    }
  } else if (std::strcmp(command, "TEST_SCREEN_ON") == 0) {
    if (!turnScreenOn("test")) {
      Serial.println("screen_test_error reason=already_on");
    }
  } else if (std::strcmp(command, "POMODORO_STATUS") == 0) {
    const uint32_t now_ms = millis();
    Serial.printf(
        "pomodoro_status state=%s remaining_ms=%u planned_ms=%u "
        "view=%s screen=%s\n",
        PomodoroTimer::stateName(pomodoro_timer.state()),
        static_cast<unsigned>(pomodoro_timer.remainingMs(now_ms)),
        static_cast<unsigned>(pomodoro_timer.plannedMs()),
        current_view == UiView::kPomodoro ? "pomodoro" : "home",
        screen_off ? "off" : "on");
  } else if (std::strncmp(command, "TEST_POMODORO_START ", 20) == 0) {
    char* end = nullptr;
    const unsigned long duration_seconds =
        std::strtoul(command + 20, &end, 10);
    if (end == command + 20 || *end != '\0' || duration_seconds == 0 ||
        duration_seconds > 60 ||
        !pomodoro_timer.startForTest(
            millis(), static_cast<uint32_t>(duration_seconds * 1000UL))) {
      Serial.println(
          "pomodoro_test_error reason=invalid_duration_or_active");
    } else {
      current_view = UiView::kPomodoro;
      noteUserActivity();
      if (!screen_off) drawPomodoro(true);
      Serial.printf("pomodoro_test_started duration_ms=%u ram_only=true\n",
                    static_cast<unsigned>(duration_seconds * 1000UL));
    }
  } else if (std::strcmp(command, "TEST_POMODORO_RESET") == 0) {
    pomodoro_timer.reset();
    current_view = UiView::kHome;
    noteUserActivity();
    if (!screen_off) drawCurrentView();
    Serial.println("pomodoro_test_reset state=idle ram_only=true");
  } else if (std::strcmp(command, "POWER_STATUS") == 0) {
    Serial.printf(
        "power_status battery_pct=%ld battery_mv=%d vbus_mv=%d "
        "charging=%s screen=%s idle_ms=%u timeout_ms=%u\n",
        static_cast<long>(M5.Power.getBatteryLevel()),
        static_cast<int>(M5.Power.getBatteryVoltage()),
        static_cast<int>(M5.Power.getVBUSVoltage()), chargingStatus(),
        screen_off ? "off" : "on",
        static_cast<unsigned>(millis() - last_user_activity_at),
        static_cast<unsigned>(kScreenIdleTimeoutMs));
  } else if (std::strcmp(command, "DELETE_LEGACY_1_6 CONFIRM") == 0) {
    deleteLegacyRecordings();
  } else if (std::strcmp(command, "STATUS") == 0) {
    Serial.printf("status version=%s mic=%s fs=%s pending=%u free=%u next=%u "
                  "provisioned=%s upload_min=%u net=\"%s\"\n",
                  app_config::kVersion, mic_ready ? "ready" : "error",
                  filesystem_ready ? "ready" : "error",
                  static_cast<unsigned>(pending_recording_count),
                  static_cast<unsigned>(filesystemFreeBytes()),
                  static_cast<unsigned>(next_recording_sequence),
                  network_sync::isProvisioned() ? "true" : "false",
                  static_cast<unsigned>(network_sync::uploadMinimumSequence()),
                  network_sync::statusLine());
  } else if (command[0] != '\0') {
    Serial.println("command_error reason=unknown");
  }
}

void handleSerialCommands() {
  while (Serial.available()) {
    const int incoming = Serial.read();
    if (incoming < 0 || incoming == '\r') {
      continue;
    }
    if (incoming == '\n') {
      serial_command[serial_command_length] = '\0';
      runSerialCommand(serial_command);
      serial_command_length = 0;
      serial_command[0] = '\0';
      continue;
    }
    if (serial_command_length + 1 < sizeof(serial_command)) {
      serial_command[serial_command_length++] = static_cast<char>(incoming);
    } else {
      serial_command_length = 0;
      serial_command[0] = '\0';
      Serial.println("command_error reason=too_long");
    }
  }
}

bool queueFixedMicBlocks(int16_t* destination, size_t sample_count,
                         uint32_t started_at) {
  size_t queued_samples = 0;
  while (queued_samples < sample_count) {
    if (millis() - started_at > kMicWarmupTimeoutMs) {
      return false;
    }

    const size_t remaining = sample_count - queued_samples;
    const size_t block_samples =
        remaining < kMicBlockSamples ? remaining : kMicBlockSamples;
    if (!M5.Mic.record(destination + queued_samples, block_samples,
                       app_config::kRecordingSampleRate, false)) {
      return false;
    }
    queued_samples += block_samples;

    M5.update();
  }

  while (M5.Mic.isRecording()) {
    if (millis() - started_at > kMicWarmupTimeoutMs) {
      return false;
    }
    M5.update();
    delay(1);
  }
  return true;
}

bool waitForStartButtonRelease() {
  drawStarting();
  const uint32_t wait_started_at = millis();
  while (M5.BtnA.isPressed()) {
    if (millis() - wait_started_at > 5000U) return false;
    M5.update();
    delay(1);
  }
  const uint32_t settle_started_at = millis();
  while (millis() - settle_started_at < kStartButtonSettleMs) {
    M5.update();
    if (M5.BtnB.wasPressed()) return false;
    delay(1);
  }
  return true;
}

CaptureResult captureMicUntilStopped() {
  CaptureResult result;
  size_t queued_samples = 0;
  uint32_t last_draw_second = 0;
  const uint32_t started_at = millis();
  drawRecording(0, true);

  while (queued_samples < kMaxRecordingSampleCount) {
    const uint32_t elapsed = millis() - started_at;
    if (elapsed > kMicCaptureTimeoutMs) return result;

    const size_t remaining = kMaxRecordingSampleCount - queued_samples;
    const size_t block_samples =
        remaining < kMicBlockSamples ? remaining : kMicBlockSamples;
    if (!M5.Mic.record(mic_buffer + queued_samples, block_samples,
                       app_config::kRecordingSampleRate, false)) {
      return result;
    }
    queued_samples += block_samples;

    M5.update();
    const uint32_t updated_elapsed = millis() - started_at;
    if (interrupt_next_capture && updated_elapsed >= 1000U) {
      interrupt_next_capture = false;
      Serial.printf("test_interrupt_trigger elapsed_ms=%u phase=manual_capture\n",
                    static_cast<unsigned>(updated_elapsed));
      Serial.flush();
      delay(20);
      ESP.restart();
    }
    if (M5.BtnB.wasPressed()) {
      result.cancelled = true;
      break;
    }
    if (M5.BtnA.wasPressed()) {
      if (queued_samples >= kMinRecordingSampleCount) {
        result.stopped_by_user = true;
        break;
      }
      Serial.printf("mic_stop_ignored reason=minimum_duration samples=%u\n",
                    static_cast<unsigned>(queued_samples));
    }
    const uint32_t elapsed_second = updated_elapsed / 1000U;
    if (elapsed_second != last_draw_second) {
      drawRecording(updated_elapsed, false);
      last_draw_second = elapsed_second;
    }
  }

  if (M5.Mic.isRecording() && !result.cancelled) drawSaving();
  while (M5.Mic.isRecording()) {
    if (millis() - started_at > kMicCaptureTimeoutMs) return CaptureResult{};
    M5.update();
    delay(1);
  }

  result.elapsed_ms = millis() - started_at;
  if (result.cancelled) {
    result.ok = true;
    return result;
  }
  if (result.stopped_by_user &&
      queued_samples > kMinRecordingSampleCount + kStopButtonTrimSamples) {
    queued_samples -= kStopButtonTrimSamples;
  }
  result.sample_count = queued_samples;
  result.ok = queued_samples >= kMinRecordingSampleCount;
  return result;
}

void runWavCapture() {
  if (!filesystem_ready) {
    Serial.println("wav_record_refused reason=filesystem_not_ready");
    drawFilesystemFormatPrompt();
    return;
  }
  if (filesystemFreeBytes() <
      expectedWavBytes(kMaxRecordingSampleCount) + kFilesystemReserveBytes) {
    Serial.printf("wav_record_refused reason=no_space required=%u free=%u\n",
                  static_cast<unsigned>(expectedWavBytes(kMaxRecordingSampleCount) +
                                        kFilesystemReserveBytes),
                  static_cast<unsigned>(filesystemFreeBytes()));
    drawStorageError("Not enough free space");
    return;
  }
  if (!mic_ready || mic_buffer == nullptr) {
    Serial.println("mic_record_error reason=not_ready");
    drawHome();
    return;
  }

  if (!waitForStartButtonRelease()) {
    Serial.println("mic_record_cancelled phase=before_capture");
    drawCancelled();
    delay(500);
    drawHome();
    return;
  }

  std::memset(mic_buffer, 0, kMaxRecordingSampleCount * sizeof(int16_t));
  Serial.printf("mic_record_start rate=%d bits=%d channels=1 max_samples=%u\n",
                app_config::kRecordingSampleRate,
                app_config::kRecordingBitsPerSample,
                static_cast<unsigned>(kMaxRecordingSampleCount));

  const CaptureResult capture = captureMicUntilStopped();
  if (!capture.ok) {
    Serial.printf("mic_record_error reason=timeout_or_queue elapsed_ms=%u\n",
                  static_cast<unsigned>(capture.elapsed_ms));
    drawCaptureError("Capture timed out");
    delay(1500);
    ESP.restart();
    return;
  }
  if (capture.cancelled) {
    Serial.printf("mic_record_cancelled elapsed_ms=%u wav_saved=false\n",
                  static_cast<unsigned>(capture.elapsed_ms));
    drawCancelled();
    delay(700);
    drawHome();
    return;
  }

  drawSaving();
  const MicStats stats = calculateStats(mic_buffer, capture.sample_count);
  const float active_percent =
      100.0f * static_cast<float>(stats.active_samples) /
      static_cast<float>(capture.sample_count);
  Serial.printf(
      "mic_record_done samples=%u elapsed_ms=%u stop=%s dc=%ld peak=%ld "
      "rms=%.1f dbfs=%.1f active=%.1f%% clipped=%u\n",
      static_cast<unsigned>(capture.sample_count),
      static_cast<unsigned>(capture.elapsed_ms),
      capture.stopped_by_user ? "button_a" : "max_duration",
      static_cast<long>(stats.dc_offset), static_cast<long>(stats.peak),
      stats.rms, stats.dbfs, active_percent,
      static_cast<unsigned>(stats.clipped_samples));
  char saved_path[64] = {};
  if (!writeWavAtomically(mic_buffer, capture.sample_count, saved_path,
                          sizeof(saved_path))) {
    drawStorageError("WAV save failed");
    return;
  }
  const uint32_t saved_sequence = recordingSequenceFromName(saved_path);
  if (!network_sync::createMetadataForWav(saved_path, saved_sequence,
                                          capture.sample_count)) {
    Serial.printf("metadata_error sequence=%u wav_preserved=true\n",
                  static_cast<unsigned>(saved_sequence));
  }
  drawResults(stats, capture.sample_count, saved_path);
}


}  // namespace

void setup() {
  auto config = M5.config();
  config.fallback_board = m5::board_t::board_M5StickS3;
  config.internal_mic = true;
  config.internal_spk = false;
  M5.begin(config);
  M5.Display.setRotation(0);
  screen_on_brightness = M5.Display.getBrightness();
  if (screen_on_brightness == 0) screen_on_brightness = 128;
  M5.Display.setBrightness(screen_on_brightness);
  noteUserActivity();
  Serial.begin(115200);

  mic_buffer = static_cast<int16_t*>(heap_caps_malloc(
      kMaxRecordingSampleCount * sizeof(int16_t),
      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (mic_buffer == nullptr) {
    mic_buffer = static_cast<int16_t*>(heap_caps_malloc(
        kMaxRecordingSampleCount * sizeof(int16_t), MALLOC_CAP_8BIT));
  }

  if (mic_buffer != nullptr) {
    auto mic_config = M5.Mic.config();
    mic_config.sample_rate = app_config::kRecordingSampleRate;
    mic_config.over_sampling = 1;
    mic_config.magnification = 1;
    mic_config.noise_filter_level = 0;
    mic_config.dma_buf_len = kMicBlockSamples;
    mic_config.dma_buf_count = 4;
    M5.Mic.config(mic_config);
    mic_ready = M5.Mic.begin();
  }

  if (mic_ready) {
    const uint32_t warmup_started_at = millis();
    mic_ready =
        queueFixedMicBlocks(mic_buffer, kMicWarmupSamples, warmup_started_at);
    Serial.printf("mic_warmup=%s samples=%u elapsed_ms=%u\n",
                  mic_ready ? "complete" : "failed",
                  static_cast<unsigned>(kMicWarmupSamples),
                  static_cast<unsigned>(millis() - warmup_started_at));
  }

  Serial.printf("%s %s\n", app_config::kAppName, app_config::kVersion);
  Serial.printf("PSRAM bytes: %u\n", ESP.getPsramSize());
  Serial.printf("mic_ready=%s buffer_bytes=%u buffer_in_psram=%s\n",
                mic_ready ? "true" : "false",
                static_cast<unsigned>(kMaxRecordingSampleCount * sizeof(int16_t)),
                mic_buffer != nullptr && esp_ptr_external_ram(mic_buffer) ? "true"
                                                                          : "false");
  filesystem_ready = mountFilesystem();
  network_sync::begin();
  drawCurrentView();
}

void loop() {
  // M5Stack requires M5.update() in the loop so button transitions are sampled.
  M5.update();
  const uint32_t now_ms = millis();
  if (pomodoro_timer.update(now_ms)) {
    Serial.printf("pomodoro_completed planned_ms=%u persisted=false\n",
                  static_cast<unsigned>(pomodoro_timer.plannedMs()));
    if (!screen_off && current_view == UiView::kPomodoro) {
      drawPomodoro(true);
    }
  } else if (!screen_off && current_view == UiView::kPomodoro &&
             pomodoro_timer.state() == PomodoroState::kRunning) {
    const uint32_t remaining_seconds =
        (pomodoro_timer.remainingMs(now_ms) + 999U) / 1000U;
    if (remaining_seconds != last_pomodoro_draw_second) {
      drawPomodoro(false);
    }
  }
  const bool screen_input_consumed = handleScreenPowerInput();
  handleSerialCommands();

  if (screen_input_consumed) {
    delay(1);
    return;
  }

  if (!filesystem_ready) {
    if (M5.BtnB.isPressed()) {
      if (format_hold_started_at == 0) {
        format_hold_started_at = millis();
        Serial.println("filesystem_format_hold_start");
      } else if (!format_started &&
                 millis() - format_hold_started_at >= kFilesystemFormatHoldMs) {
        formatFilesystem();
      }
    } else {
      if (format_hold_started_at != 0 && !format_started) {
        Serial.println("filesystem_format_hold_cancelled");
      }
      format_hold_started_at = 0;
      format_started = false;
    }
    if (M5.BtnA.wasPressed()) {
      drawFilesystemFormatPrompt();
    }
    delay(1);
    return;
  }

  if (current_view == UiView::kPomodoro) {
    if (M5.BtnA.wasPressed()) {
      const uint32_t action_ms = millis();
      const PomodoroState before = pomodoro_timer.state();
      bool changed = false;
      if (before == PomodoroState::kIdle ||
          before == PomodoroState::kCompleted) {
        changed = pomodoro_timer.start(action_ms);
      } else if (before == PomodoroState::kRunning) {
        changed = pomodoro_timer.pause(action_ms);
      } else if (before == PomodoroState::kPaused) {
        changed = pomodoro_timer.resume(action_ms);
      }
      if (changed) {
        Serial.printf("pomodoro_button_a from=%s to=%s remaining_ms=%u\n",
                      PomodoroTimer::stateName(before),
                      PomodoroTimer::stateName(pomodoro_timer.state()),
                      static_cast<unsigned>(
                          pomodoro_timer.remainingMs(action_ms)));
        drawPomodoro(true);
      }
      noteUserActivity();
    } else if (M5.BtnB.wasReleased()) {
      if (M5.BtnB.wasReleaseFor(kPomodoroCancelHoldMs)) {
        const PomodoroState before = pomodoro_timer.state();
        pomodoro_timer.reset();
        Serial.printf("pomodoro_reset reason=button_b_hold from=%s\n",
                      PomodoroTimer::stateName(before));
        drawPomodoro(true);
      } else {
        current_view = UiView::kHome;
        Serial.println("pomodoro_view home");
        drawHome();
      }
      noteUserActivity();
    }
  } else if (M5.BtnA.wasPressed()) {
    Serial.println("button_a_pressed");
    runWavCapture();
    noteUserActivity();
  } else if (M5.BtnB.wasReleased()) {
    if (home_screen_visible) {
      current_view = UiView::kPomodoro;
      Serial.println("pomodoro_view pomodoro");
      drawPomodoro(true);
    } else {
      drawHome();
    }
    noteUserActivity();
  }

  if (network_sync::loop()) {
    scanPendingDirectory();
    if (!screen_off) drawCurrentView();
  }

  delay(1);
}
