#!/usr/bin/env python3
"""
test_fsdisp_metrics.py — offline self-check for the fsdisp exporter (:9104).

Runs with NO live Kamailio. Exercises the pinned Grafana metric contract:

  * FLAGS -> fs_dispatcher_disabled mapping: 'D'->1 ONLY (maintenance);
    'I' (probe-down/dead), 'A', 'T' -> 0. Inactive is NOT maintenance.
  * bare-IP fs_ip label extraction from dispatcher.list group-1 URIs
    (sip:192.168.10.2:5080 -> "192.168.10.2"), non-group-1 sets excluded.
  * Prometheus text exposition format (exact series lines, HELP/TYPE,
    trailing newline, no zone labels — vmagent stamps those externally).
  * fail-open scrape_ok semantics: kamcmd/parse failure keeps the last-good
    per-destination series and flips fsdisp_scrape_ok to 0; an empty group 1
    counts as a failure; recovery re-publishes fresh values with ok=1.
  * carrier_monitor integration: the shared-parse path (parse_dispatcher_records
    -> fs_destinations + carrier_trunks_from_records) feeds the exporter from
    ONE parse, and parse_dispatcher_list's carrier contract is unchanged.

Run either way:
    python3 -m pytest -q test_fsdisp_metrics.py
    python3 test_fsdisp_metrics.py        # plain-assert fallback, no pytest
"""

import carrier_monitor as cm
import fsdisp_metrics as fm


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _reset():
    """Reset the exporter's module state between test cases."""
    with fm._SAMPLE_LOCK:
        fm._LAST_GOOD = []
    fm._init_sample()


def _sample() -> str:
    """Read the currently-cached exposition (what GET /metrics would serve)."""
    with fm._SAMPLE_LOCK:
        return fm._CACHED_SAMPLE


# A realistic `kamcmd dispatcher.list` reply: group 1 = an FS HA pair
# (FS-1 Active, FS-2 admin-Disabled), group 2 = a Bandwidth carrier. Shape
# mirrors the tree rendering documented in carrier_monitor's parser notes.
SAMPLE_DISPATCHER_LIST = """{
    NRSETS: 2
    RECORDS: {
        SET: {
            id: 1
            TARGETS: {
                DEST: {
                    URI: sip:192.168.10.2:5080
                    FLAGS: AP
                    PRIORITY: 10
                    ATTRS: {
                        BODY: weight=100;maxload=2000;duid=fs-primary
                        DUID: fs-primary
                    }
                }
                DEST: {
                    URI: sip:192.168.10.3:5080
                    FLAGS: DX
                    PRIORITY: 5
                    ATTRS: {
                        BODY: weight=100;maxload=2000;duid=fs-standby
                        DUID: fs-standby
                    }
                }
            }
        }
        SET: {
            id: 2
            TARGETS: {
                DEST: {
                    URI: sip:67.231.2.12:5060
                    FLAGS: AP
                    PRIORITY: 0
                    ATTRS: {
                        BODY: weight=100;duid=bw-dallas-primary
                        DUID: bw-dallas-primary
                    }
                }
            }
        }
    }
}
"""


# --------------------------------------------------------------------------- #
# 1. FLAGS -> disabled mapping (the D-vs-I distinction is the whole point).
# --------------------------------------------------------------------------- #

def test_flags_disabled_mapping():
    # 'D' first char = admin-Disabled = maintenance -> 1.
    assert fm.flags_to_disabled("DX") is True
    assert fm.flags_to_disabled("DP") is True
    assert fm.flags_to_disabled("D") is True
    assert fm.flags_to_disabled("dx") is True          # case-insensitive
    assert fm.flags_to_disabled("  DX  ") is True      # whitespace-tolerant
    # 'I' = Inactive = probe-down/DEAD — explicitly NOT maintenance -> 0.
    assert fm.flags_to_disabled("IP") is False
    assert fm.flags_to_disabled("IX") is False
    assert fm.flags_to_disabled("I") is False
    # 'A' = Active, 'T' = Trying -> 0.
    assert fm.flags_to_disabled("AP") is False
    assert fm.flags_to_disabled("AX") is False
    assert fm.flags_to_disabled("TP") is False
    assert fm.flags_to_disabled("TX") is False
    # Garbage / empty fail safe to 0 (never a false "in maintenance").
    assert fm.flags_to_disabled("") is False
    assert fm.flags_to_disabled("   ") is False
    assert fm.flags_to_disabled("??") is False


# --------------------------------------------------------------------------- #
# 2. Group-1 extraction: bare IPs, group filtering, one parse feeds both paths.
# --------------------------------------------------------------------------- #

def test_fs_destinations_bare_ip_and_group_filter():
    records = cm.parse_dispatcher_records(SAMPLE_DISPATCHER_LIST)
    fs = cm.fs_destinations(records)
    # Only the two group-1 destinations, dispatcher order, BARE IPs (no sip:,
    # no :5080, no params).
    assert [d["fs_ip"] for d in fs] == ["192.168.10.2", "192.168.10.3"]
    assert [d["flags"] for d in fs] == ["AP", "DX"]
    # The Bandwidth group-2 gateway must NOT leak into the FS list.
    assert all(d["fs_ip"] != "67.231.2.12" for d in fs)


def test_carrier_contract_unchanged_by_shared_parse():
    # parse_dispatcher_list (the carrier-report contract) still returns ONLY
    # carrier setids, correctly shaped — the refactor to a shared record parse
    # must be behavior-identical for the existing consumer.
    trunks = cm.parse_dispatcher_list(SAMPLE_DISPATCHER_LIST)
    assert len(trunks) == 1
    t = trunks[0]
    assert t["setid"] == 2
    assert t["duid"] == "bw-dallas-primary"
    assert t["ip"] == "67.231.2.12"
    assert t["is_up"] is True
    assert t["flags"] == "AP"


def test_fs_destinations_skips_unparseable_uri():
    records = [
        {"setid": 1, "uri": "not-a-sip-uri", "flags": "AP"},
        {"setid": 1, "uri": "sip:192.168.20.2:5080", "flags": "AP"},
    ]
    fs = cm.fs_destinations(records)
    assert fs == [{"fs_ip": "192.168.20.2", "flags": "AP"}]


# --------------------------------------------------------------------------- #
# 3. Exposition format (the pinned series names/labels, verbatim).
# --------------------------------------------------------------------------- #

def test_exposition_format():
    _reset()
    ok = fm.update_from_destinations([
        {"fs_ip": "192.168.10.2", "flags": "AP"},
        {"fs_ip": "192.168.10.3", "flags": "DX"},
    ])
    assert ok is True
    body = _sample()
    # Exact pinned series lines.
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.2"} 0' in body
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.3"} 1' in body
    assert "\nfsdisp_scrape_ok 1\n" in body
    # Well-formed text exposition: HELP/TYPE present, trailing newline, and
    # NO zone/reporting_instance labels (vmagent stamps those externally).
    assert "# TYPE fs_dispatcher_disabled gauge" in body
    assert "# HELP fs_dispatcher_disabled" in body
    assert "# TYPE fsdisp_scrape_ok gauge" in body
    assert body.endswith("\n")
    assert "zone=" not in body and "reporting_instance=" not in body


def test_exposition_dedupes_duplicate_ips():
    # Duplicate series lines would make the whole scrape unparseable — the
    # first occurrence wins, defensively.
    _reset()
    fm.update_from_destinations([
        {"fs_ip": "192.168.10.2", "flags": "AP"},
        {"fs_ip": "192.168.10.2", "flags": "DX"},
    ])
    body = _sample()
    assert body.count('fs_dispatcher_disabled{fs_ip="192.168.10.2"}') == 1
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.2"} 0' in body


# --------------------------------------------------------------------------- #
# 4. Fail-open scrape_ok semantics (last-good retained, empty = failure).
# --------------------------------------------------------------------------- #

def test_initial_sample_before_first_poll():
    _reset()
    body = _sample()
    # Valid, parseable, scrape_ok=0, no per-destination series yet.
    assert "fsdisp_scrape_ok 0" in body
    assert "fs_dispatcher_disabled{" not in body
    assert body.endswith("\n")


def test_scrape_failure_retains_last_good_series():
    _reset()
    fm.update_from_destinations([{"fs_ip": "192.168.10.2", "flags": "DX"}])
    assert "fsdisp_scrape_ok 1" in _sample()
    # kamcmd/parse failure this cycle -> ok flips to 0, the D=1 series stays.
    fm.mark_scrape_failed()
    body = _sample()
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.2"} 1' in body
    assert "fsdisp_scrape_ok 0" in body
    # Recovery re-publishes fresh values with ok=1 (drain lifted: D -> A).
    fm.update_from_destinations([{"fs_ip": "192.168.10.2", "flags": "AP"}])
    body = _sample()
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.2"} 0' in body
    assert "fsdisp_scrape_ok 1" in body


def test_empty_group1_is_a_failure():
    _reset()
    fm.update_from_destinations([{"fs_ip": "192.168.10.2", "flags": "AP"}])
    # An empty group 1 on a live SBC means a malformed/truncated reply — treat
    # as failure: keep the last-good series, ok=0, and report False.
    assert fm.update_from_destinations([]) is False
    body = _sample()
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.2"} 0' in body
    assert "fsdisp_scrape_ok 0" in body
    # Entries with no parseable fs_ip are skipped; all-skipped == empty.
    assert fm.update_from_destinations([{"fs_ip": "", "flags": "AP"}]) is False


# --------------------------------------------------------------------------- #
# 5. carrier_monitor -> exporter integration (the poll_once publish hooks).
# --------------------------------------------------------------------------- #

def test_publish_hooks_feed_exporter_from_shared_parse():
    _reset()
    records = cm.parse_dispatcher_records(SAMPLE_DISPATCHER_LIST)
    cm._fsdisp_publish(records)
    body = _sample()
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.2"} 0' in body
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.3"} 1' in body
    assert "fsdisp_scrape_ok 1" in body
    cm._fsdisp_mark_failed()
    body = _sample()
    assert 'fs_dispatcher_disabled{fs_ip="192.168.10.3"} 1' in body
    assert "fsdisp_scrape_ok 0" in body


def test_publish_hooks_never_raise_without_module():
    # Standalone carrier_monitor deployment (sibling module absent): the hooks
    # must be inert no-ops, not crashes.
    orig = cm.fsdisp_metrics
    try:
        cm.fsdisp_metrics = None
        cm._fsdisp_publish([{"setid": 1, "uri": "sip:1.2.3.4:5080", "flags": "AP"}])
        cm._fsdisp_mark_failed()
    finally:
        cm.fsdisp_metrics = orig


# --------------------------------------------------------------------------- #
# Plain-assert fallback runner (no pytest needed).
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    import sys
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    if failures:
        print(f"{failures} test(s) failed")
        sys.exit(1)
    print("all fsdisp tests passed")
