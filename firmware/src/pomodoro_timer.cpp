#include "pomodoro_timer.h"

PomodoroTimer::PomodoroTimer(std::uint32_t default_duration_ms)
    : default_duration_ms_(default_duration_ms),
      planned_ms_(default_duration_ms),
      remaining_at_anchor_ms_(default_duration_ms) {}

bool PomodoroTimer::start(std::uint32_t now_ms) {
  return startWithDuration(now_ms, default_duration_ms_);
}

bool PomodoroTimer::startForTest(std::uint32_t now_ms,
                                 std::uint32_t duration_ms) {
  return startWithDuration(now_ms, duration_ms);
}

bool PomodoroTimer::startWithDuration(std::uint32_t now_ms,
                                      std::uint32_t duration_ms) {
  if (duration_ms == 0 ||
      state_ == PomodoroState::kRunning ||
      state_ == PomodoroState::kPaused) {
    return false;
  }
  state_ = PomodoroState::kRunning;
  planned_ms_ = duration_ms;
  remaining_at_anchor_ms_ = duration_ms;
  anchor_ms_ = now_ms;
  return true;
}

bool PomodoroTimer::pause(std::uint32_t now_ms) {
  if (state_ != PomodoroState::kRunning) return false;
  if (update(now_ms)) return false;
  remaining_at_anchor_ms_ = remainingMs(now_ms);
  anchor_ms_ = now_ms;
  state_ = PomodoroState::kPaused;
  return true;
}

bool PomodoroTimer::resume(std::uint32_t now_ms) {
  if (state_ != PomodoroState::kPaused ||
      remaining_at_anchor_ms_ == 0) {
    return false;
  }
  anchor_ms_ = now_ms;
  state_ = PomodoroState::kRunning;
  return true;
}

bool PomodoroTimer::update(std::uint32_t now_ms) {
  if (state_ != PomodoroState::kRunning ||
      remainingMs(now_ms) != 0) {
    return false;
  }
  state_ = PomodoroState::kCompleted;
  remaining_at_anchor_ms_ = 0;
  anchor_ms_ = now_ms;
  return true;
}

void PomodoroTimer::reset() {
  state_ = PomodoroState::kIdle;
  planned_ms_ = default_duration_ms_;
  remaining_at_anchor_ms_ = default_duration_ms_;
  anchor_ms_ = 0;
}

PomodoroState PomodoroTimer::state() const { return state_; }

std::uint32_t PomodoroTimer::remainingMs(std::uint32_t now_ms) const {
  if (state_ != PomodoroState::kRunning) {
    return remaining_at_anchor_ms_;
  }
  const std::uint32_t elapsed_ms = now_ms - anchor_ms_;
  return elapsed_ms >= remaining_at_anchor_ms_
             ? 0
             : remaining_at_anchor_ms_ - elapsed_ms;
}

std::uint32_t PomodoroTimer::plannedMs() const { return planned_ms_; }

const char* PomodoroTimer::stateName(PomodoroState state) {
  switch (state) {
    case PomodoroState::kIdle:
      return "idle";
    case PomodoroState::kRunning:
      return "running";
    case PomodoroState::kPaused:
      return "paused";
    case PomodoroState::kCompleted:
      return "completed";
    default:
      return "unknown";
  }
}
