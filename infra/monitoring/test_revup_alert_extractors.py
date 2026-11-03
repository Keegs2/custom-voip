#!/usr/bin/env python3
"""
test_revup_alert_extractors.py — offline check of the revup_alert_log policy regexes.

No tofu, no GCP. Reads the filter regex and the `kind` label-extractor regex straight
out of main.tf (so the test cannot drift from what gets applied) and runs them, with
Python `re`, against every page line the on-VM scripts emit. The patterns use only
the RE2/Python common subset (classes, non-capturing groups, alternation, + * ?), so
the match results are the same in Cloud Logging. Each fixture also asserts that its
template text still exists in the emitting script, so a reworded page line fails here
instead of silently changing incident grouping.

Asserts:
  * every real page line matches the filter, under both rsyslog line formats
    ("tag:" and "tag[pid]:"),
  * systemd's own lines about the revup-alert@ relay unit and the INFO lines of
    other tags do NOT match (they would otherwise open their own incidents),
  * `kind` is stable for one condition (variable numbers do not change it) and
    distinct between different conditions,
  * the documentation subject uses the extracted host and kind.

Run:
    python3 infra/monitoring/test_revup_alert_extractors.py
    python3 -m pytest -q infra/monitoring/test_revup_alert_extractors.py
"""

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
MAIN_TF = HERE / "main.tf"


def _policy_block():
    text = MAIN_TF.read_text(encoding="utf-8")
    start = text.index('resource "google_monitoring_alert_policy" "revup_alert_log" {')
    end = text.index("\n}\n", start)
    return text[start:end]


def _filter_regexes():
    block = _policy_block()
    json_re = re.search(r'jsonPayload\.message=~\\"(.*?)\\"', block).group(1)
    text_re = re.search(r'textPayload=~\\"(.*?)\\"', block).group(1)
    return json_re, text_re


def _kind_regex():
    block = _policy_block()
    m = re.search(
        r'kind\s*=\s*"REGEXP_EXTRACT\(jsonPayload\.message, \\"(.*?)\\"\)"', block
    )
    assert m, "kind extractor not found in revup_alert_log"
    return m.group(1)


# (emitting file, template text that must still be in it, rendered page text,
#  expected kind). Identifiers are placeholders (vm-a, 192.0.2.10 = TEST-NET-1).
PAGES = (
    ("scripts/backup/systemd/revup-alert@.service",
     '"unit-failed unit=%i host=%H — investigate with: journalctl -u %i -n 50"',
     "unit-failed unit=revup-pgdump host=vm-a — investigate with: journalctl -u revup-pgdump -n 50",
     "unit-failed unit=revup-pgdump"),
    ("scripts/backup/systemd/revup-alert@.service",
     '"unit-failed unit=%i host=%H',
     "unit-failed unit=revup-asr-guard host=vm-a — investigate with: journalctl -u revup-asr-guard -n 50",
     "unit-failed unit=revup-asr-guard"),
    ("scripts/backup/asr_guard.sh",
     '"ASR ${ASR}% over 15m (vol=${VOL}) — calls failing, check carrier/route/Homer"',
     "ASR 23% over 15m (vol=140) — calls failing, check carrier/route/Homer",
     "ASR"),
    ("scripts/backup/replication_guard.sh",
     '"HA standby ${REPL_GUARD_STANDBY_IP} is NOT connected to the primary',
     "HA standby 192.0.2.10 is NOT connected to the primary — replication down, no failover target.",
     "HA standby 192.0.2.10 is"),
    ("scripts/backup/replication_guard.sh",
     '"HA standby ${REPL_GUARD_STANDBY_IP} lag ${LAG_MB}MB exceeds ${REPL_GUARD_LAG_MB}MB',
     "HA standby 192.0.2.10 lag 300MB exceeds 256MB — replication falling behind, failover RPO growing.",
     "HA standby 192.0.2.10 lag"),
    ("scripts/backup/slot_wal_guard.sh",
     '"replication-slot slot=${slot} wal_status=${wal_status} — slot invalidated',
     "replication-slot slot=standby_slot wal_status=lost — slot invalidated or at the max_slot_wal_keep_size cap",
     "replication-slot slot=standby_slot wal_status"),
    ("scripts/backup/slot_wal_guard.sh",
     '"replication-slot slot=${slot} retained_bytes=${retained} exceeds ${SLOT_WAL_ALERT_BYTES}',
     "replication-slot slot=standby_slot retained_bytes=987654321 exceeds 5368709120 — standby down/lagging?",
     "replication-slot slot=standby_slot retained_bytes"),
    ("scripts/fs-watchdog/fs_watchdog.sh",
     '"FreeSWITCH DOWN on ${HOST}: ${reason}',
     "FreeSWITCH DOWN on vm-b: container not running — 2 consecutive failed checks (~2 min).",
     "FreeSWITCH"),
    ("scripts/vmalert-pager/vmalert_pager.sh",
     'page "vmalert ${name} FIRING zone=${zone} host=${HOST}: ${msg}"',
     "vmalert SipByeFailureShare FIRING zone=east host=vm-a: BYE failure share above threshold",
     "vmalert SipByeFailureShare FIRING zone=east"),
    ("scripts/vmalert-pager/vmalert_pager.sh",
     'page "vmalert ${name} FIRING zone=${zone} host=${HOST}: ${msg}"',
     "vmalert SipByeFailureShare FIRING zone=west host=vm-a: BYE failure share above threshold",
     "vmalert SipByeFailureShare FIRING zone=west"),
    ("scripts/vmalert-pager/vmalert_pager.sh",
     'page "vmalert ${name} FIRING zone=${zone} host=${HOST}: ${msg}"',
     "vmalert SbcDialogLeak FIRING zone=west host=vm-a: active dialogs growing without calls",
     "vmalert SbcDialogLeak FIRING zone=west"),
    ("scripts/vmalert-pager/vmalert_pager.sh",
     'page "vmalert ${name} FIRING zone=${zone} host=${HOST}: ${msg}"',
     "vmalert VzIpsecZoneDown FIRING zone=central host=vm-a: Verizon trunk DARK in zone central: no healthy IPsec gateway (gateway ILB has no backend)",
     "vmalert VzIpsecZoneDown FIRING zone=central"),
    ("scripts/vmalert-pager/vmalert_pager.sh",
     'page "vmalert API unreachable on ${HOST}:',
     "vmalert API unreachable on vm-a: http://127.0.0.1:8880/api/v1/alerts failed 5 consecutive polls",
     "vmalert API"),
    ("infra/monitoring/README.md",
     'logger -p user.err -t revup-alert -- "test page — ignore"',
     "test page — ignore",
     "test"),
    ("infra/monitoring/README.md",
     'logger -p user.err -t revup-alert -- "TEST vmalert pager — ignore"',
     "TEST vmalert pager — ignore",
     "TEST"),
)

# Same condition, different numbers/reasons -> must keep the same kind.
SAME_CONDITION = (
    ("ASR 23% over 15m (vol=140) — calls failing", "ASR 41% over 15m (vol=9) — calls failing"),
    ("HA standby 192.0.2.10 lag 300MB exceeds 256MB", "HA standby 192.0.2.10 lag 9000MB exceeds 256MB"),
    ("replication-slot slot=s1 retained_bytes=1 exceeds 2", "replication-slot slot=s1 retained_bytes=7 exceeds 2"),
    ("FreeSWITCH DOWN on vm-b: container not running", "FreeSWITCH DOWN on vm-b: ESL not answering"),
    ("vmalert FsStaleChannels FIRING zone=east host=vm-a: 3 stale",
     "vmalert FsStaleChannels FIRING zone=east host=vm-a: 9 stale"),
)

# Lines that contain "revup-alert" but are NOT pages.
NOT_PAGES = (
    "Oct 21 12:00:00 vm-a systemd[1]: Starting revup-alert@revup-pgdump.service - revup alert relay for failed unit revup-pgdump...",
    "Oct 21 12:00:00 vm-a systemd[1]: revup-alert@revup-pgdump.service: Deactivated successfully.",
    "Oct 21 12:00:00 vm-a systemd[1]: Finished revup-alert@revup-pgdump.service - revup alert relay for failed unit revup-pgdump.",
    "Oct 21 12:00:00 vm-a systemd[1]: revup-pgdump.service: Triggering OnFailure= dependencies.",
    "Oct 21 12:00:00 vm-a revup-vmalert-pager: vmalert SipByeFailureShare cleared zone=east",
    "Oct 21 12:00:00 vm-a revup-fs-watchdog: RECOVERED: FreeSWITCH healthy again on vm-b",
    "Oct 21 12:00:00 vm-a revup-backup: asr-guard: call asr=97% volume=140 window=15m",
)


def _syslog_lines(text):
    """The raw /var/log/syslog shapes the Ops Agent ships as jsonPayload.message."""
    return (
        f"Oct 21 12:00:00 vm-a revup-alert: {text}",
        f"2026-10-21T12:00:00.123456+00:00 vm-a revup-alert[4242]: {text}",
    )


def _kind(line):
    m = re.search(_kind_regex(), line)
    assert m, f"kind extractor does not match {line!r}"
    return m.group(1)


def test_patterns_stay_in_re2_subset():
    for pattern in (*_filter_regexes(), _kind_regex()):
        for construct in ("(?=", "(?!", "(?<", "\\1", "\\"):
            assert construct not in pattern, f"{construct!r} in {pattern!r}"
    json_re, text_re = _filter_regexes()
    assert json_re == text_re, "jsonPayload and textPayload filters differ"


def test_page_templates_still_exist_in_scripts():
    for rel_path, template, _text, _kind_expected in PAGES:
        source = (REPO_ROOT / rel_path).read_text(encoding="utf-8")
        assert template in source, f"{rel_path} no longer contains {template!r}"


def test_every_page_matches_filter_and_yields_kind():
    json_re, _ = _filter_regexes()
    for _rel, _tpl, text, expected in PAGES:
        for line in _syslog_lines(text):
            assert re.search(json_re, line), f"filter misses page line {line!r}"
            assert _kind(line) == expected, (line, _kind(line), expected)


def test_non_pages_do_not_match_filter():
    json_re, _ = _filter_regexes()
    for line in NOT_PAGES:
        assert not re.search(json_re, line), f"filter matches non-page {line!r}"


def test_kind_stable_within_a_condition():
    for first, second in SAME_CONDITION:
        a = _kind(_syslog_lines(first)[0])
        b = _kind(_syslog_lines(second)[1])
        assert a == b, (first, second, a, b)


def test_kinds_distinct_between_conditions():
    kinds = [expected for _rel, _tpl, _text, expected in PAGES]
    assert len(kinds) == len(set(kinds)), sorted(kinds)


def test_subject_uses_extracted_labels():
    block = _policy_block()
    assert "$${log.extracted_label.kind}" in block
    assert "$${log.extracted_label.host}" in block
    assert 'host = "EXTRACT(labels.\\"compute.googleapis.com/resource_name\\")"' in block


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
