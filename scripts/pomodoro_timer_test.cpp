#include <cassert>
#include <cstdint>
#include <limits>

#include "pomodoro_timer.h"

int main() {
  PomodoroTimer timer(1500000);
  assert(timer.state() == PomodoroState::kIdle);
  assert(timer.remainingMs(123) == 1500000);

  assert(timer.start(1000));
  assert(!timer.start(1001));
  assert(timer.remainingMs(61000) == 1440000);
  assert(timer.pause(61000));
  assert(timer.state() == PomodoroState::kPaused);
  assert(timer.remainingMs(999999) == 1440000);

  assert(timer.resume(100000));
  assert(timer.remainingMs(160000) == 1380000);
  assert(!timer.update(1539999));
  assert(timer.update(1540000));
  assert(timer.state() == PomodoroState::kCompleted);
  assert(timer.remainingMs(1540000) == 0);

  timer.reset();
  assert(timer.startForTest(5000, 3000));
  assert(!timer.update(7999));
  assert(timer.update(8000));

  timer.reset();
  const std::uint32_t near_wrap =
      std::numeric_limits<std::uint32_t>::max() - 1000;
  assert(timer.startForTest(near_wrap, 2000));
  assert(timer.remainingMs(499) == 500);
  assert(timer.update(999));

  return 0;
}
