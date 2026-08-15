#pragma once

#include <cstdint>

namespace app_config {
constexpr char kAppName[] = "Voice Inbox";
constexpr char kVersion[] = "0.8.0-pomodoro-ui";
constexpr char kDeviceId[] = "demo-device-001";
constexpr int kRecordingSampleRate = 16000;
constexpr int kRecordingBitsPerSample = 16;
constexpr int kRecordingMinSeconds = 1;
constexpr int kRecordingManualMaxSeconds = 30;
constexpr std::uint32_t kPomodoroFocusDurationMs = 25U * 60U * 1000U;
}  // namespace app_config
