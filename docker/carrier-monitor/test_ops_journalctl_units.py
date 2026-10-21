#!/usr/bin/env python3
"""
test_ops_journalctl_units.py — offline self-check for host.journalctl's unit allow-list.

Runs with NO live host and NO journal. It monkeypatches `_run_argv` so a run captures
the argv it WOULD execute, and forces JOURNAL_AVAILABLE where needed, then asserts:

  * every revup-*.service the installers copy (scripts/backup/systemd,
    scripts/fs-watchdog/systemd, scripts/vmalert-pager/systemd) is in KNOWN_UNITS,
    in both spellings — a new paging unit cannot ship without being readable,
  * the revup-alert@ relay template stays out (no open-ended instance names),
  * a known unit becomes exactly one argv element after `-u`, with bounded lines and
    a validated --since,
  * unknown units, injection attempts and template instances are rejected,
  * the build-time forbidden-pattern scan stays clean when rendered for EVERY known
    unit (the import-time audit only renders one representative unit),
  * the "journal unavailable" path returns exit 125 without executing anything,
  * host.journalctl remains a read command available on every role.

Run either way:
    python3 -m pytest -q test_ops_journalctl_units.py
    python3 test_ops_journalctl_units.py        # plain-assert fallback, no pytest
"""

import os
from pathlib import Path

# Pin a deterministic role/env BEFORE importing the module (role is detected once
# at import), same as test_ops_write_commands.py.
os.environ.setdefault("OPS_AGENT_ROLE", "services")
os.environ.setdefault("SBC_PROXY_IP", "10.142.0.100")

import ops_commands as oc  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
UNIT_DIRS = (
    REPO_ROOT / "scripts" / "backup" / "systemd",
    REPO_ROOT / "scripts" / "fs-watchdog" / "systemd",
    REPO_ROOT / "scripts" / "vmalert-pager" / "systemd",
)


class _Capture:
    """Patch oc._run_argv to record the argv instead of executing it."""

    def __init__(self, journal_available=True):
        self.argv = None
        self.journal_available = journal_available

    def __enter__(self):
        self._orig_argv = oc._run_argv
        self._orig_available = oc.JOURNAL_AVAILABLE

        def rec_argv(argv, timeout):
            self.argv = [str(a) for a in argv]
            return True, 0, "", ""

        oc._run_argv = rec_argv
        oc.JOURNAL_AVAILABLE = self.journal_available
        return self

    def __exit__(self, *exc):
        oc._run_argv = self._orig_argv
        oc.JOURNAL_AVAILABLE = self._orig_available
        return False


def _journal_argv(params):
    with _Capture() as cap:
        oc.run_command("host.journalctl", params, oc.ROLE_SERVICES)
    return cap.argv


def _expect_valueerror(params, label):
    try:
        with _Capture():
            oc.run_command("host.journalctl", params, oc.ROLE_SERVICES)
    except ValueError:
        return
    raise AssertionError(f"host.journalctl accepted {label}: {params!r}")


def _installed_revup_services():
    """Every non-template revup-*.service unit file the installers copy."""
    names = set()
    for unit_dir in UNIT_DIRS:
        assert unit_dir.is_dir(), f"missing unit directory {unit_dir}"
        for path in unit_dir.glob("revup-*.service"):
            if "@" in path.name:
                continue  # the revup-alert@ relay template
            names.add(path.name[: -len(".service")])
    return names


# --------------------------------------------------------------------------- #
# 1) The allow-list covers every installed paging unit, in both spellings.
# --------------------------------------------------------------------------- #

def test_every_installed_revup_unit_is_known():
    installed = _installed_revup_services()
    # Guard against a silently empty glob (moved directories).
    assert {"revup-asr-guard", "revup-fs-watchdog", "revup-vmalert-pager"} <= installed
    for unit in sorted(installed):
        assert unit in oc.KNOWN_UNITS, f"{unit} missing from KNOWN_UNITS"
        assert f"{unit}.service" in oc.KNOWN_UNITS, f"{unit}.service missing"


def test_known_revup_units_match_installed_units_exactly():
    # No stale entry for a unit that no longer exists in the repo.
    listed = {
        u[: -len(".service")] if u.endswith(".service") else u
        for u in oc.KNOWN_UNITS
        if u.startswith("revup-")
    }
    assert listed == _installed_revup_services(), listed ^ _installed_revup_services()


def test_relay_template_is_not_listed():
    assert not any("@" in unit for unit in oc.KNOWN_UNITS)


def test_pre_existing_units_still_listed():
    for unit in ("docker", "docker.service", "pgbouncer", "postgresql.service",
                 "google-guest-agent", "systemd-journald.service"):
        assert unit in oc.KNOWN_UNITS, unit


# --------------------------------------------------------------------------- #
# 2) argv shape for the new units.
# --------------------------------------------------------------------------- #

def test_argv_for_guard_unit():
    argv = _journal_argv({"unit": "revup-asr-guard", "lines": 50})
    assert argv == ["journalctl", "--no-pager", "-u", "revup-asr-guard", "-n", "50"]


def test_argv_for_service_spelling_with_since():
    argv = _journal_argv({
        "unit": "revup-fs-watchdog.service",
        "lines": 200,
        "since": "30 minutes ago",
    })
    assert argv == [
        "journalctl", "--no-pager", "-u", "revup-fs-watchdog.service",
        "-n", "200", "--since", "30 minutes ago",
    ]


def test_default_lines():
    argv = _journal_argv({"unit": "revup-vmalert-pager"})
    assert argv[-2:] == ["-n", "100"]


# --------------------------------------------------------------------------- #
# 3) Validation still rejects everything outside the closed set.
# --------------------------------------------------------------------------- #

def test_rejects_unknown_and_hostile_units():
    for unit in (
        "revup-alert@revup-pgdump.service",   # relay instance: not listed
        "revup-alert@.service",
        "revup-asr-guard.timer",              # timers hold no page lines
        "revup-asr-guard ",                   # trailing space
        "revup-asr-guard;id",
        "--all",
        "-urevup-asr-guard",
        "../revup-asr-guard",
        "kamailio",
        "sshd",
        "",
        None,
    ):
        _expect_valueerror({"unit": unit}, f"unit {unit!r}")


def test_rejects_bad_lines_and_since():
    _expect_valueerror({"unit": "revup-pgdump", "lines": 0}, "lines=0")
    _expect_valueerror({"unit": "revup-pgdump", "lines": 501}, "lines=501")
    _expect_valueerror({"unit": "revup-pgdump", "lines": True}, "lines=True")
    _expect_valueerror({"unit": "revup-pgdump", "since": "yesterday; reboot"},
                       "free-text since")
    _expect_valueerror({"unit": "revup-pgdump", "since": "--until=now"}, "option since")


# --------------------------------------------------------------------------- #
# 4) Forbidden-pattern scan over the argv of EVERY known unit.
# --------------------------------------------------------------------------- #

def test_forbidden_scan_clean_for_every_known_unit():
    for unit in sorted(oc.KNOWN_UNITS):
        text = " ".join(_journal_argv({"unit": unit, "lines": 10}))
        for pat in oc._FORBIDDEN_PATTERNS:
            assert not pat.search(text), (
                f"unit {unit!r} renders forbidden pattern {pat.pattern!r}: {text!r}"
            )
        assert "bgapi" not in text.lower()


def test_import_time_audit_still_passes():
    oc.assert_no_forbidden_commands()


# --------------------------------------------------------------------------- #
# 5) Degradation + catalog placement unchanged.
# --------------------------------------------------------------------------- #

def test_unavailable_journal_returns_125_without_running():
    with _Capture(journal_available=False) as cap:
        res = oc.run_command(
            "host.journalctl", {"unit": "revup-slot-wal-guard"}, oc.ROLE_SERVICES
        )
    assert cap.argv is None, "journalctl ran although the journal is unavailable"
    assert res["ok"] is False and res["exit_code"] == 125
    assert "unavailable" in res["stderr"]


def test_unavailable_journal_still_validates_first():
    try:
        with _Capture(journal_available=False):
            oc.run_command("host.journalctl", {"unit": "sshd"}, oc.ROLE_SERVICES)
    except ValueError:
        return
    raise AssertionError("unknown unit accepted while the journal is unavailable")


def test_journalctl_is_read_only_and_all_roles():
    assert "host.journalctl" not in oc.WRITE_COMMAND_IDS
    assert not oc.is_mutating("host.journalctl")
    for role in oc.VALID_ROLES:
        assert oc.is_valid_for_role("host.journalctl", role)


# --------------------------------------------------------------------------- #
# Plain-assert runner (no pytest dependency required).
# --------------------------------------------------------------------------- #

def _run_all():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        t()
        passed += 1
        print(f"  ok  {t.__name__}")
    print(f"\n{passed}/{len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_run_all())
