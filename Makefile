# RevUp test targets (Phase 0 safety net)
#
# Quick start:
#   make test           # everything that runs without the live stack
#   make test-lua       # FreeSWITCH Lua characterization tests
#   make test-lessons   # SIP/FreeSWITCH "hard-won lessons" regression guard
#   make test-homer     # existing Homer pipeline acceptance tests
#
# SIPp integration scenarios are NOT run here (they need the live docker compose
# stack + provisioned DB rows). See docker/sipp/scenarios/README.md.

# Pick a Lua interpreter (5.4 or 5.3) for the bundled fallback runner.
LUA := $(shell command -v lua 2>/dev/null || command -v lua5.4 2>/dev/null || command -v lua5.3 2>/dev/null)
PYTEST := python3 -m pytest

.PHONY: test test-lua test-lessons test-homer help

help:
	@echo "Targets: test | test-lua | test-lessons | test-homer"

# ---- FreeSWITCH Lua characterization tests ----
# Prefer real busted; fall back to the bundled pure-Lua runner (busted shim).
test-lua:
	@if command -v busted >/dev/null 2>&1; then \
		echo ">> busted tests/lua/spec"; \
		busted tests/lua/spec; \
	elif [ -n "$(LUA)" ]; then \
		echo ">> $(LUA) tests/lua/run.lua  (busted not installed; using bundled runner)"; \
		echo "   (install full runner with: luarocks install busted)"; \
		$(LUA) tests/lua/run.lua; \
	else \
		echo "ERROR: no 'busted' and no 'lua' interpreter found."; \
		echo "Install one: 'brew install lua' and/or 'luarocks install busted'."; \
		exit 1; \
	fi

# ---- SIP / FreeSWITCH lessons regression guard ----
test-lessons:
	$(PYTEST) tests/lessons/test_sip_lessons.py -v

# ---- Existing Homer pipeline acceptance tests ----
test-homer:
	$(PYTEST) tests/test_homer_pipeline.py -v

# ---- Everything runnable without the live stack ----
test: test-lua test-lessons test-homer
	@echo ""
	@echo "All Phase 0 offline test suites passed."
