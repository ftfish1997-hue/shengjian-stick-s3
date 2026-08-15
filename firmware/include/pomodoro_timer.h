#pragma once

#include <cstdint>

enum class PomodoroState : std::uint8_t {
  kIdle,
  kRunning,
  kPaused,
  kCompleted,
};

class PomodoroTimer {
 public:
  explicit PomodoroTimer(std::uint32_t default_duration_ms);

  bool start(std::uint32_t now_ms);
  bool startForTest(std::uint32_t now_ms, std::uint32_t duration_ms);
  bool pause(std::uint32_t now_ms);
  bool resume(std::uint32_t now_ms);
  bool update(std::uint32_t now_ms);
  void reset();

  PomodoroState state() const;
  std::uint32_t remainingMs(std::uint32_t now_ms) const;
  std::uint32_t plannedMs() const;
  static const char* stateName(PomodoroState state);

 private:
  bool startWithDuration(std::uint32_t now_ms, std::uint32_t duration_ms);

  const std::uint32_t default_duration_ms_;
  PomodoroState state_ = PomodoroState::kIdle;
  std::uint32_t planned_ms_ = 0;
  std::uint32_t remaining_at_anchor_ms_ = 0;
  std::uint32_t anchor_ms_ = 0;
};
