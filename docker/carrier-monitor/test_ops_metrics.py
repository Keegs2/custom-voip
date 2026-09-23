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
  * the peak / high-watermark gauges (freeswitch_calls_active_peak /
    freeswitch_channels_peak): trailing-window pruning, max selection, empty-
    window fallback to last-good, failed/garbled reads NOT recorded, peak >=
    current, peak-thread failures never flip scrape_ok, exact exposition lines,
    and the `show channels count` parse

esl_api is faked by assigning om.esl_api (the module imports it by name) inside
try/finally — no pytest fixtures, so the plain-assert fallback runner still works.

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


# --------------------------------------------------------------------------- #
# Peak / high-watermark gauges
# --------------------------------------------------------------------------- #

T0 = 10_000.0  # fixed monotonic "now" for window math


def _reset_peaks(calls_last=0, channels_last=0):
    """Clear both peak windows and seed the last-good floors."""
    with om._PEAK_LOCK:
        om._CALLS_PEAK_SAMPLES.clear()
        om._CHANNELS_PEAK_SAMPLES.clear()
    with om._SAMPLE_LOCK:
        om._LAST_CALLS_ACTIVE = calls_last
        om._LAST_CHANNELS_TOTAL = channels_last


def _with_fake_esl(responses, fn):
    """Run fn() with om.esl_api replaced. `responses` maps verb -> tuple
    (ok, out, err) or an Exception instance to raise. Unknown verb -> failure.
    Returns (fn result, list of verbs called)."""
    calls = []

    def fake(verb, timeout=10.0):
        calls.append(verb)
        r = responses.get(verb, (False, "", "no fake for %s" % verb))
        if isinstance(r, Exception):
            raise r
        return r

    real = om.esl_api
    om.esl_api = fake
    try:
        return fn(), calls
    finally:
        om.esl_api = real


def _line(text, metric):
    """The single sample line for `metric{...}` in an exposition."""
    prefix = metric + "{"
    found = [ln for ln in text.splitlines() if ln.startswith(prefix)]
    assert len(found) == 1, (metric, found)
    return found[0]


def test_parse_channels_count():
    assert om.parse_channels_count("\n0 total.\n") == 0
    assert om.parse_channels_count("\n37 total.\n") == 37
    # A CSV table ahead of the summary can't shadow it (LAST match wins).
    assert om.parse_channels_count(
        "uuid,direction,total_x\nabc,inbound,5 total\n\n12 total.\n") == 12
    for bad in ("", None, "-ERR no such command", "total.", "abc total."):
        assert om.parse_channels_count(bad) is None


def test_peak_window_prunes_old_samples():
    _reset_peaks()
    w = om.PEAK_WINDOW
    om._record_peak_sample(om._CALLS_PEAK_SAMPLES, 90, now=T0)
    om._record_peak_sample(om._CALLS_PEAK_SAMPLES, 10, now=T0 + w - 1)
    # Still inside the window at T0 + w (cutoff is strict "older than").
    assert om._peak_value(om._CALLS_PEAK_SAMPLES, 0, now=T0 + w) == 90
    # 1s past the window: the 90 is pruned, only the 10 remains.
    assert om._peak_value(om._CALLS_PEAK_SAMPLES, 0, now=T0 + w + 1) == 10
    with om._PEAK_LOCK:
        assert list(om._CALLS_PEAK_SAMPLES) == [(T0 + w - 1, 10)]


def test_peak_selects_max_in_window():
    _reset_peaks()
    for i, v in enumerate((3, 41, 7, 40, 2)):
        om._record_peak_sample(om._CHANNELS_PEAK_SAMPLES, v, now=T0 + 2 * i)
    assert om._peak_value(om._CHANNELS_PEAK_SAMPLES, 0, now=T0 + 10) == 41


def test_empty_window_falls_back_to_last_good_not_phantom_peak():
    _reset_peaks(calls_last=5, channels_last=11)
    # A big burst long ago must NOT survive past the window...
    om._record_peak_sample(om._CALLS_PEAK_SAMPLES, 500, now=T0)
    om._record_peak_sample(om._CHANNELS_PEAK_SAMPLES, 999, now=T0)
    later = T0 + om.PEAK_WINDOW + 60
    text = om._render_peaks(now=later)
    node = om.FREESWITCH_NODE
    # ...the series falls back to the current last-good values instead.
    assert _line(text, "freeswitch_calls_active_peak") == (
        'freeswitch_calls_active_peak{freeswitch_node="%s"} 5' % node)
    assert _line(text, "freeswitch_channels_peak") == (
        'freeswitch_channels_peak{freeswitch_node="%s"} 11' % node)


def test_peak_is_floored_at_current_value():
    # Window holds lower readings than the poll's current last-good -> peak is
    # never below what freeswitch_calls_active / _channels_total show.
    _reset_peaks(calls_last=20, channels_last=40)
    om._record_peak_sample(om._CALLS_PEAK_SAMPLES, 3, now=T0)
    om._record_peak_sample(om._CHANNELS_PEAK_SAMPLES, 6, now=T0)
    assert om._peak_value(om._CALLS_PEAK_SAMPLES, 20, now=T0) == 20
    assert om._peak_value(om._CHANNELS_PEAK_SAMPLES, 40, now=T0) == 40


def test_garbage_values_not_recorded():
    _reset_peaks()
    for bad in (None, "x", -1):
        om._record_peak_sample(om._CALLS_PEAK_SAMPLES, bad, now=T0)
    with om._PEAK_LOCK:
        assert len(om._CALLS_PEAK_SAMPLES) == 0


def test_peak_tick_records_fresh_reads():
    _reset_peaks()
    responses = {
        "show calls count": (True, "\n7 total.\n", ""),
        "show channels count": (True, "\n15 total.\n", ""),
    }
    recorded, verbs = _with_fake_esl(responses, om._peak_tick)
    assert recorded == 2
    # Only the two cheap summary verbs — never the heavy json verb.
    assert sorted(verbs) == ["show calls count", "show channels count"]
    assert om._peak_value(om._CALLS_PEAK_SAMPLES, 0) == 7
    assert om._peak_value(om._CHANNELS_PEAK_SAMPLES, 0) == 15


def test_peak_tick_failed_garbled_or_raising_reads_not_recorded():
    for responses in (
        {"show calls count": (False, "", "connection refused"),
         "show channels count": (False, "", "timeout")},
        {"show calls count": (True, "-ERR no such command", ""),
         "show channels count": (True, "", "")},
        {"show calls count": RuntimeError("boom"),
         "show channels count": ValueError("boom")},
    ):
        _reset_peaks(calls_last=4, channels_last=8)
        recorded, _ = _with_fake_esl(responses, om._peak_tick)
        assert recorded == 0
        with om._PEAK_LOCK:
            assert len(om._CALLS_PEAK_SAMPLES) == 0
            assert len(om._CHANNELS_PEAK_SAMPLES) == 0
        # Empty window -> last-good, not 0.
        assert om._peak_value(om._CALLS_PEAK_SAMPLES, 4) == 4
        assert om._peak_value(om._CHANNELS_PEAK_SAMPLES, 8) == 8


def test_peak_tick_one_verb_failing_does_not_block_other():
    _reset_peaks()
    responses = {
        "show calls count": RuntimeError("boom"),
        "show channels count": (True, "\n9 total.\n", ""),
    }
    recorded, _ = _with_fake_esl(responses, om._peak_tick)
    assert recorded == 1
    assert om._peak_value(om._CHANNELS_PEAK_SAMPLES, 0) == 9


def _poll_responses(n_channels, calls):
    rows = [_row(int(NOW - 30 - i)) for i in range(n_channels)]
    return {
        "show channels as json": (True, _payload(rows), ""),
        "status": (True, "UP 0 years\n123 session(s) since startup\n", ""),
        "show calls count": (True, "\n%d total.\n" % calls, ""),
    }


def test_poll_feeds_peak_windows_and_peak_ge_current():
    _reset_peaks()
    om._init_sample()
    ok, _ = _with_fake_esl(_poll_responses(6, 3), om._refresh_sample)
    assert ok is True
    with om._SAMPLE_LOCK:
        assert om._LAST_CHANNELS_TOTAL == 6
        assert om._LAST_CALLS_ACTIVE == 3
    body = om._metrics_body()
    node = om.FREESWITCH_NODE
    assert 'freeswitch_channels_total{freeswitch_node="%s"} 6' % node in body
    assert 'freeswitch_calls_active{freeswitch_node="%s"} 3' % node in body
    assert _line(body, "freeswitch_channels_peak").endswith(" 6")
    assert _line(body, "freeswitch_calls_active_peak").endswith(" 3")

    # A burst seen only by the 2s sampler between two polls...
    burst = {"show calls count": (True, "\n50 total.\n", ""),
             "show channels count": (True, "\n100 total.\n", "")}
    _with_fake_esl(burst, om._peak_tick)
    # ...then the next poll sees it already gone.
    _with_fake_esl(_poll_responses(2, 1), om._refresh_sample)
    body = om._metrics_body()
    assert 'freeswitch_calls_active{freeswitch_node="%s"} 1' % node in body
    assert 'freeswitch_channels_total{freeswitch_node="%s"} 2' % node in body
    # The peak gauges still show the burst (the whole point).
    assert _line(body, "freeswitch_calls_active_peak").endswith(" 50")
    assert _line(body, "freeswitch_channels_peak").endswith(" 100")


def test_peak_thread_failures_never_flip_scrape_ok():
    _reset_peaks()
    om._init_sample()
    node = om.FREESWITCH_NODE
    ok_1 = 'freeswitch_esl_scrape_ok{freeswitch_node="%s"} 1' % node
    _with_fake_esl(_poll_responses(1, 1), om._refresh_sample)
    assert ok_1 in om._metrics_body()
    with om._SAMPLE_LOCK:
        before = om._CACHED_SAMPLE
    # Peak sampler fails every way it can -> cached sample untouched.
    _with_fake_esl({"show calls count": RuntimeError("x"),
                    "show channels count": (False, "", "refused")},
                   om._peak_tick)
    with om._SAMPLE_LOCK:
        assert om._CACHED_SAMPLE == before
    assert ok_1 in om._metrics_body()


def test_poll_failure_still_marks_scrape_failed_and_keeps_peaks():
    # _mark_scrape_failed behaviour unchanged; peak series still present.
    _reset_peaks()
    om._init_sample()
    node = om.FREESWITCH_NODE
    _with_fake_esl(_poll_responses(4, 2), om._refresh_sample)
    ok, _ = _with_fake_esl(
        {"show channels as json": (False, "", "refused")}, om._refresh_sample)
    assert ok is False
    body = om._metrics_body()
    assert 'freeswitch_esl_scrape_ok{freeswitch_node="%s"} 0' % node in body
    assert 'freeswitch_channels_total{freeswitch_node="%s"} 4' % node in body
    assert _line(body, "freeswitch_channels_peak").endswith(" 4")
    assert _line(body, "freeswitch_calls_active_peak").endswith(" 2")


def test_render_peaks_exact_exposition():
    _reset_peaks(calls_last=1, channels_last=2)
    om._record_peak_sample(om._CALLS_PEAK_SAMPLES, 12, now=T0)
    om._record_peak_sample(om._CHANNELS_PEAK_SAMPLES, 25, now=T0)
    text = om._render_peaks(now=T0 + 1)
    node = om.FREESWITCH_NODE
    lines = text.splitlines()
    assert lines[1] == "# TYPE freeswitch_calls_active_peak gauge"
    assert lines[2] == 'freeswitch_calls_active_peak{freeswitch_node="%s"} 12' % node
    assert lines[4] == "# TYPE freeswitch_channels_peak gauge"
    assert lines[5] == 'freeswitch_channels_peak{freeswitch_node="%s"} 25' % node
    assert lines[0].startswith("# HELP freeswitch_calls_active_peak ")
    assert lines[3].startswith("# HELP freeswitch_channels_peak ")
    assert text.endswith("\n") and len(lines) == 6


def test_metrics_body_appends_peaks_after_cached_sample():
    _reset_peaks()
    om._init_sample()
    with om._SAMPLE_LOCK:
        cached = om._CACHED_SAMPLE
    body = om._metrics_body()
    assert body.startswith(cached)
    tail = body[len(cached):]
    assert tail.startswith("# HELP freeswitch_calls_active_peak ")
    # Each metric family appears exactly once (valid exposition).
    types = [ln for ln in body.splitlines() if ln.startswith("# TYPE ")]
    assert len(types) == len(set(types))


def test_peak_config_defaults_and_clamps():
    assert om.PEAK_INTERVAL >= 1 and om.PEAK_WINDOW >= 1
    assert om.PEAK_ESL_TIMEOUT <= float(om.PEAK_INTERVAL)
    assert om.PEAK_ESL_TIMEOUT <= om.ESL_TIMEOUT


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
