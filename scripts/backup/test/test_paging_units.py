#!/usr/bin/env python3
"""
test_paging_units.py — offline checks for the revup paging units and the slot-WAL guard.

No systemd, no PostgreSQL, no root. Asserts:

  * every revup-*.service in scripts/{backup,fs-watchdog,vmalert-pager}/systemd,
    except the revup-alert@ relay template, declares
    OnFailure=revup-alert@%p.service in its [Unit] section — so a guard, watchdog
    or backup job that breaks always pages "unit-failed unit=<unit>",
  * the relay template itself has no OnFailure (a failing relay must not recurse),
  * slot_wal_guard.sh exits 0 after emitting its own revup-alert page (so OnFailure
    does not add a second, generic page every 15 minutes) and exits non-zero when
    the guard itself breaks (psql failure), which is what OnFailure pages.
    The script runs against PATH shims for `id`, `psql` and `logger`.

Run either way:
    python3 -m pytest -q scripts/backup/test/test_paging_units.py
    python3 scripts/backup/test/test_paging_units.py
"""

import os
import re
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
UNIT_DIRS = (
    REPO_ROOT / "scripts" / "backup" / "systemd",
    REPO_ROOT / "scripts" / "fs-watchdog" / "systemd",
    REPO_ROOT / "scripts" / "vmalert-pager" / "systemd",
)
RELAY_TEMPLATE = REPO_ROOT / "scripts" / "backup" / "systemd" / "revup-alert@.service"
SLOT_GUARD = REPO_ROOT / "scripts" / "backup" / "slot_wal_guard.sh"
ON_FAILURE = "OnFailure=revup-alert@%p.service"


def _unit_section(path):
    """Lines of the [Unit] section, comments stripped."""
    section, lines = None, []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        m = re.fullmatch(r"\[(\w+)\]", line)
        if m:
            section = m.group(1)
            continue
        if section == "Unit":
            lines.append(line)
    return lines


def _paging_units():
    units = []
    for unit_dir in UNIT_DIRS:
        assert unit_dir.is_dir(), unit_dir
        units += [p for p in sorted(unit_dir.glob("revup-*.service")) if "@" not in p.name]
    return units


def test_every_revup_service_pages_on_failure():
    units = _paging_units()
    assert len(units) >= 9, [u.name for u in units]   # guard against a broken glob
    missing = [u.name for u in units if ON_FAILURE not in _unit_section(u)]
    assert not missing, f"no {ON_FAILURE} in [Unit] of: {missing}"


def test_relay_template_has_no_on_failure():
    assert RELAY_TEMPLATE.is_file()
    assert not any(line.startswith("OnFailure=") for line in _unit_section(RELAY_TEMPLATE))


# --------------------------------------------------------------------------- #
# slot_wal_guard.sh exit semantics, against PATH shims.
# --------------------------------------------------------------------------- #

_SHIMS = {
    "id": '#!/bin/sh\nif [ "$1" = "-un" ]; then echo postgres; exit 0; fi\nexec /usr/bin/id "$@"\n',
    "psql": (
        "#!/bin/sh\n"
        'if [ -n "$FAKE_PSQL_FAIL" ]; then echo "psql: error: connection refused" >&2; exit 2; fi\n'
        'if [ -n "$FAKE_PSQL_OUT" ]; then printf "%s\\n" "$FAKE_PSQL_OUT"; fi\n'
    ),
    "logger": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOGGER_LOG"\n',
}


def _run_slot_guard(psql_out="", psql_fail=False):
    with tempfile.TemporaryDirectory() as tmp:
        shim_dir = Path(tmp) / "bin"
        shim_dir.mkdir()
        for name, body in _SHIMS.items():
            path = shim_dir / name
            path.write_text(body, encoding="utf-8")
            path.chmod(0o755)
        log = Path(tmp) / "logger.log"
        log.touch()
        env = {
            "PATH": f"{shim_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "FAKE_PSQL_OUT": psql_out,
            "FAKE_LOGGER_LOG": str(log),
            "SLOT_WAL_ALERT_BYTES": "1000",
        }
        if psql_fail:
            env["FAKE_PSQL_FAIL"] = "1"
        proc = subprocess.run(
            ["bash", str(SLOT_GUARD)], env=env, capture_output=True, text=True, timeout=30
        )
        lines = log.read_text(encoding="utf-8").splitlines()
    pages = [ln for ln in lines if "-t revup-alert" in ln]
    return proc.returncode, pages, lines, proc.stderr


def test_slot_guard_healthy_slot_no_page_exit_0():
    code, pages, lines, err = _run_slot_guard("standby_slot|t|reserved|10")
    assert code == 0, err
    assert pages == []
    assert any("slot-wal-guard: slot=standby_slot" in ln for ln in lines)


def test_slot_guard_lost_slot_pages_once_and_exits_0():
    code, pages, _lines, err = _run_slot_guard("standby_slot|f|lost|0")
    assert code == 0, err
    assert len(pages) == 1 and "replication-slot slot=standby_slot wal_status=lost" in pages[0]


def test_slot_guard_retained_over_threshold_pages_and_exits_0():
    code, pages, _lines, err = _run_slot_guard("standby_slot|f|reserved|5000")
    assert code == 0, err
    assert len(pages) == 1 and "retained_bytes=5000 exceeds 1000" in pages[0]


def test_slot_guard_one_bad_slot_of_two():
    code, pages, _lines, err = _run_slot_guard("a|t|reserved|10\nb|f|unreserved|0")
    assert code == 0, err
    assert len(pages) == 1 and "slot=b wal_status=unreserved" in pages[0]


def test_slot_guard_no_slots_exit_0():
    code, pages, lines, err = _run_slot_guard("")
    assert code == 0, err
    assert pages == [] and any("no replication slots present" in ln for ln in lines)


def test_slot_guard_psql_failure_exits_nonzero_for_on_failure():
    code, pages, _lines, _err = _run_slot_guard(psql_fail=True)
    assert code != 0, "a broken guard must fail the unit so OnFailure pages"
    assert pages == []


def _run_all():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\n{len(tests)}/{len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_run_all())
