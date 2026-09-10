#!/usr/bin/env python3
"""
test_ops_metrics.py — offline self-check for the FS ESL exporter (:9103).

Runs with NO live FreeSWITCH. Exercises the pinned metric contract of
ops_metrics.parse_channels / _render, with emphasis on the teardown signals:

  * freeswitch_channel_max_age_seconds = now - min(created_epoch) (0 when idle)
  * freeswitch_channels_stale = count(age > STALE_CHANNEL_SECONDS)
  * rows with a missing/garbage/zero created_epoch still count toward total
    but never toward the age figures; ages are clamped at 0 (clock skew)
  * the idle shape {"row_count": 0} (no "rows" key) and non-JSON payloads
    render a valid zeroed sample
  * the existing direction/on_net buckets, total and bridged are unchanged

Run either way:
    python3 -m pytest -q test_ops_metrics.py
    python3 test_ops_metrics.py        # plain-assert fallback, no pytest
"""

import json

import ops_metrics as om


NOW = 1_800_000_000.0  # fixed "now" so ages are deterministic


def _payload(rows):
    return json.dumps({"row_count": len(rows), "rows": rows})


def _row(created_epoch, direction="inbound", on_net="false", call_uuid="c-1",
         **extra):
    row = {
        "uuid": "u-%s" % created_epoch,
        "direction": direction,
        "created": "2027-01-15 12:00:00",
        "created_epoch": created_epoch,
        "call_uuid": call_uuid,
        "on_net": on_net,
    }
    row.update(extra)
    return row


# --------------------------------------------------------------------------- #
# parse_channels — teardown figures
# --------------------------------------------------------------------------- #

def test_two_channels_of_different_ages():
    # 30s old (fresh) and 3h old (stale) — the fixture the alert is built on.
    raw = _payload([
        _row(int(NOW - 30), direction="inbound"),
        _row(int(NOW - 3 * 3600), direction="outbound"),
    ])
    buckets, total, bridged, max_age, stale = om.parse_channels(raw, now=NOW)
    assert total == 2
    assert bridged == 2
    assert buckets[("inbound", "false")] == 1
    assert buckets[("outbound", "false")] == 1
    assert max_age == 3 * 3600
    assert stale == 1


def test_stale_threshold_is_strictly_greater_than():
    raw = _payload([
        _row(int(NOW - om.STALE_CHANNEL_SECONDS)),      # exactly 2h -> not stale
        _row(int(NOW - om.STALE_CHANNEL_SECONDS - 1)),  # 2h + 1s -> stale
    ])
    _, total, _, max_age, stale = om.parse_channels(raw, now=NOW)
    assert total == 2
    assert max_age == om.STALE_CHANNEL_SECONDS + 1
    assert stale == 1


def test_missing_or_garbage_created_epoch_counts_but_has_no_age():
    raw = _payload([
        _row(int(NOW - 10)),
        {"uuid": "no-epoch", "direction": "inbound", "call_uuid": ""},
        _row("garbage"),
        _row(0),  # FS writes 0 for a not-yet-fully-created channel
    ])
    _, total, bridged, max_age, stale = om.parse_channels(raw, now=NOW)
    assert total == 4
    assert bridged == 3  # the no-epoch row has an empty call_uuid
    assert max_age == 10
    assert stale == 0


def test_clock_skew_clamps_age_at_zero():
    raw = _payload([_row(int(NOW + 600))])  # created "in the future"
    _, total, _, max_age, stale = om.parse_channels(raw, now=NOW)
    assert total == 1
    assert max_age == 0
    assert stale == 0


def test_created_epoch_as_string_is_accepted():
    # FS renders JSON numbers, but be tolerant of a stringified column.
    raw = _payload([_row(str(int(NOW - 9000)))])
    _, _, _, max_age, stale = om.parse_channels(raw, now=NOW)
    assert max_age == 9000
    assert stale == 1


def test_idle_switch_shape_and_non_json():
    for raw in ('{"row_count": 0}', "", "   ", "-ERR no such command", "[1,2]"):
        buckets, total, bridged, max_age, stale = om.parse_channels(raw, now=NOW)
        assert total == 0 and bridged == 0
        assert max_age == 0 and stale == 0
        assert set(buckets) == {(d, o) for d in om._DIRECTIONS for o in om._ONNET}
        assert all(v == 0 for v in buckets.values())


def test_now_defaults_to_wall_clock():
    raw = _payload([_row(1)])  # epoch second 1 -> enormous age with real clock
    _, _, _, max_age, stale = om.parse_channels(raw)
    assert max_age > om.STALE_CHANNEL_SECONDS
    assert stale == 1


# --------------------------------------------------------------------------- #
# _render — exposition lines
# --------------------------------------------------------------------------- #

def test_render_emits_teardown_series_with_help_and_type():
    buckets, total, bridged, max_age, stale = om.parse_channels(
        _payload([_row(int(NOW - 30)), _row(int(NOW - 3 * 3600))]), now=NOW
    )
    text = om._render(
        buckets, total, bridged, scrape_ok=True,
        sessions_total=5, calls_active=1, max_age=max_age, stale=stale,
    )
    node = om.FREESWITCH_NODE
    assert "# TYPE freeswitch_channel_max_age_seconds gauge" in text
    assert "# HELP freeswitch_channel_max_age_seconds " in text
    assert "# TYPE freeswitch_channels_stale gauge" in text
    assert "# HELP freeswitch_channels_stale " in text
    assert ('freeswitch_channel_max_age_seconds{freeswitch_node="%s"} 10800'
            % node) in text
    assert 'freeswitch_channels_stale{freeswitch_node="%s"} 1' % node in text
    # Pre-existing contract untouched.
    assert 'freeswitch_channels_total{freeswitch_node="%s"} 2' % node in text
    assert 'freeswitch_calls_bridged{freeswitch_node="%s"} 2' % node in text
    assert 'freeswitch_esl_scrape_ok{freeswitch_node="%s"} 1' % node in text
    assert text.endswith("\n")


def test_seeded_sample_is_valid_and_zeroed():
    om._init_sample()
    with om._SAMPLE_LOCK:
        text = om._CACHED_SAMPLE
    node = om.FREESWITCH_NODE
    assert ('freeswitch_channel_max_age_seconds{freeswitch_node="%s"} 0'
            % node) in text
    assert 'freeswitch_channels_stale{freeswitch_node="%s"} 0' % node in text
    assert 'freeswitch_esl_scrape_ok{freeswitch_node="%s"} 0' % node in text


if __name__ == "__main__":
    import sys
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok   ", name)
            except AssertionError as exc:
                failures += 1
                print("FAIL ", name, exc)
    sys.exit(1 if failures else 0)
