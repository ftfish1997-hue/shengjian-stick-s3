.PHONY: test host-test pomodoro-logic-test simulate validate-json firmware-build public-audit dashboard-test

test:
	python3 -m unittest discover -s simulator/tests -v
	python3 -m unittest discover -s scripts/tests -v
	$(MAKE) pomodoro-logic-test

host-test:
	python3 -m unittest discover -s scripts/tests -v

pomodoro-logic-test:
	c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include \
		scripts/pomodoro_timer_test.cpp firmware/src/pomodoro_timer.cpp \
		-o /tmp/sticks3-pomodoro-timer-test
	/tmp/sticks3-pomodoro-timer-test

simulate:
	python3 -m simulator.run demo

validate-json:
	python3 scripts/validate_json.py shared/schemas shared/fixtures

firmware-build:
	PLATFORMIO_CORE_DIR="$(CURDIR)/.platformio-core" .venv/bin/pio run -d firmware

public-audit:
	python3 scripts/audit_public_release.py .

dashboard-test:
	cd dashboard && npm ci && npm run lint && npm test
