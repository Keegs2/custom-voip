#!/usr/bin/env python3
"""Local proof of the SIP number index against a REAL ClickHouse 23.3.

NOT a pytest file (CI has no ClickHouse, and a skipping test would fail
check_no_skips). Run it on a workstation against a throwaway container — it
DROPS and recreates the ``qryn`` and ``bench`` databases, so it refuses any
URL that is not loopback:

  docker run -d --name crag-ch-idx -p 127.0.0.1:18123:8123 -v "$PWD/docker/homer/clickhouse-users.xml:/etc/clickhouse-server/users.d/custom-users.xml" clickhouse/clickhouse-server:23.3-alpine
  CH_CLIENT="docker exec -i crag-ch-idx clickhouse-client" python3 scripts/homer/test_sip_number_index_clickhouse.py [--scale]
  docker rm -f crag-ch-idx

The repo's clickhouse-users.xml MUST be mounted (production's profile):
check 0 asserts materialized_views_ignore_errors=1 for the inserting user.

What it proves:
  1. The DDL applies, and re-applies as a no-op (one 'mv' coverage row).
  2. The MV extracts the right (number, role, call_id) rows from realistic SIP:
     INVITE/100/180/200/ACK/BYE, compact f:/t:/i:, tel: URIs, +1 / 11 / 10
     digit forms, npdi user params, %2B, multi-URI PAI/Diversion, LF-only
     line endings — and nothing from SDP bodies, Contact, OPTIONS, host-only
     URIs, anonymous users or non-SIP rows.
  3. Junk rows (random bytes, invalid UTF-8, 1 MiB strings) never fail a
     samples_v3 insert and yield zero index rows.
  4. The backfill fills pre-MV history, is resumable ("already filled") and
     idempotent (--redo leaves query results and post-merge row counts
     unchanged).
  5. The API's own SQL (routers/homer_index.build_lookup / build_state_sql /
     compute_capability) runs on ClickHouse and returns the expected calls
     for full, +1, formatted and partial needles, role filters and AND.
  6. Hostile values are data: passed as query parameters they come back
     verbatim and alter nothing; readonly=2 refuses writes.
  7. Ingest overhead of the MV (wall clock, same rows, with vs without it).
  8. Why there is no ngram bloom-filter skip index (EXPLAIN on 2M numbers).
  9. Failure modes: a throwing MV with ignore-errors on (insert succeeds,
     our index still fills), a dropped target table while the MV exists
     (insert FAILS — why rollback drops the MV first), schema drift, and the
     memory/time a 95 MB / 50k-row and a 200k-row insert block costs.
 10. --scale: 30M unmerged index rows over 7 days; exact 10/11-digit,
     international, 4- and 3-digit partial lookups with read rows/bytes,
     memory and time from system.query_log under the API's caps, and the
     same queries without PREWHERE for comparison.
"""
import json
import os
import random
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DDL = REPO / "docker/homer/clickhouse/10_sip_number_index.sql"
BACKFILL = REPO / "scripts/homer/backfill_sip_number_index.sh"
URL = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:18123")
CH_CLIENT = os.environ.get("CH_CLIENT", "docker exec -i crag-ch-idx clickhouse-client")
if urllib.parse.urlparse(URL).hostname not in ("127.0.0.1", "localhost", "::1"):
    sys.exit("refusing a non-loopback ClickHouse: this script drops databases")


def load(name, rel):
    spec = spec_from_file_location(name, REPO / rel)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hi = load("homer_index", "docker/api/src/routers/homer_index.py")
hp = load("homer_pipeline", "docker/api/src/routers/homer_pipeline.py")


class CHError(Exception):
    def __init__(self, code, text):
        super().__init__(f"{code}: {text[:300]}")
        self.code, self.text = code, text


def ch(sql, params=None, data=None):
    qs = urllib.parse.urlencode(params or {})
    body = sql.encode() if data is None else data
    url = URL + "/" + (("?query=" + urllib.parse.quote(sql) + ("&" + qs if qs else "")) if data is not None else ("?" + qs if qs else ""))
    req = urllib.request.Request(url, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        raise CHError(e.headers.get("X-ClickHouse-Exception-Code"), e.read().decode())


def client(sql_text):
    subprocess.run(CH_CLIENT.split() + ["--multiquery"], input=sql_text.encode(), check=True)


QRYN_SCHEMA = """
CREATE TABLE IF NOT EXISTS {db}.samples_v3 (fingerprint UInt64, timestamp_ns Int64 CODEC(DoubleDelta), value Float64 CODEC(Gorilla), string String, type UInt8 DEFAULT 0) ENGINE = MergeTree PARTITION BY toStartOfDay(toDateTime(timestamp_ns / 1000000000)) ORDER BY timestamp_ns TTL toDateTime(timestamp_ns / 1000000000) + INTERVAL 7 DAY SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;
CREATE TABLE IF NOT EXISTS {db}.time_series (date Date, fingerprint UInt64, labels String, name String, type UInt8 DEFAULT 0) ENGINE = ReplacingMergeTree(date) PARTITION BY date ORDER BY fingerprint;
CREATE TABLE IF NOT EXISTS {db}.time_series_gin (date Date, key String, val String, fingerprint UInt64, type UInt8 DEFAULT 0) ENGINE = ReplacingMergeTree() PARTITION BY date ORDER BY (key, val, fingerprint);
CREATE TABLE IF NOT EXISTS {db}.metrics_15s (fingerprint UInt64, timestamp_ns Int64 CODEC(DoubleDelta), last AggregateFunction(argMax, Float64, Int64), max SimpleAggregateFunction(max, Float64), min SimpleAggregateFunction(min, Float64), count AggregateFunction(count), sum SimpleAggregateFunction(sum, Float64), bytes SimpleAggregateFunction(sum, Float64)) ENGINE = AggregatingMergeTree PARTITION BY toDate(toDateTime(intDiv(timestamp_ns, 1000000000))) ORDER BY (fingerprint, timestamp_ns);
CREATE MATERIALIZED VIEW IF NOT EXISTS {db}.metrics_15s_mv TO {db}.metrics_15s AS SELECT fingerprint, intDiv(samples.timestamp_ns, 15000000000) * 15000000000 as timestamp_ns, argMaxState(value, samples.timestamp_ns) as last, maxSimpleState(value) as max, minSimpleState(value) as min, countState() as count, sumSimpleState(value) as sum, sumSimpleState(length(string)) as bytes FROM {db}.samples_v3 as samples GROUP BY fingerprint, timestamp_ns;
"""

NS = 1_000_000_000
DAYNS = 86400 * NS
NOW = datetime.now(timezone.utc)
TODAY = NOW.date()
SDP = ("v=0\r\no=- 6179990000 1 IN IP4 67.231.13.185\r\ns=-\r\nc=IN IP4 67.231.13.185\r\n"
       "t=0 0\r\nm=audio 30000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=x-num:sip:6179990000@x\r\n")


def msg(lines, body=""):
    return "\r\n".join(lines) + "\r\n\r\n" + body


def a_leg(cid, ts):
    frm = 'From: "WIRELESS CALLER" <sip:+15087282017@67.231.13.185:5060;user=phone>;tag=gK0a'
    to = "To: <sip:+17744045256@34.24.133.82:5060>"
    rows = [
        (ts, msg(["INVITE sip:+17744045256@34.24.133.82:5060 SIP/2.0",
                  "Via: SIP/2.0/UDP 67.231.13.185:5060;branch=z9hG4bKa1", frm, to,
                  f"Call-ID: {cid}", "CSeq: 1 INVITE",
                  "P-Asserted-Identity: <sip:+15087282017@67.231.13.185:5060;user=phone>",
                  "Contact: <sip:+16179990000@67.231.13.185:5060>",
                  "Content-Type: application/sdp", "Content-Length: 200"], SDP)),
        (ts + 2_000_000, msg(["SIP/2.0 100 Trying", "Via: SIP/2.0/UDP 67.231.13.185:5060;branch=z9hG4bKa1",
                              frm, to, f"Call-ID: {cid}", "CSeq: 1 INVITE", "Content-Length: 0"])),
        (ts + 900_000_000, msg(["SIP/2.0 180 Ringing", frm, to + ";tag=fs1", f"Call-ID: {cid}",
                                "CSeq: 1 INVITE", "Content-Length: 0"])),
        (ts + 5 * NS, msg(["SIP/2.0 200 OK", frm, to + ";tag=fs1", f"Call-ID: {cid}", "CSeq: 1 INVITE",
                           "Contact: <sip:mod_sofia@192.168.10.2:5080>", "Content-Length: 200"], SDP)),
        (ts + 5 * NS + 30_000_000, msg(["ACK sip:mod_sofia@192.168.10.2:5080 SIP/2.0", frm,
                                        to + ";tag=fs1", f"Call-ID: {cid}", "CSeq: 1 ACK"])),
        (ts + 65 * NS, msg(["BYE sip:+15087282017@67.231.13.185:5060 SIP/2.0", "From: <sip:+17744045256@34.24.133.82>;tag=fs1",
                            'To: "WIRELESS CALLER" <sip:+15087282017@67.231.13.185>;tag=gK0a',
                            f"Call-ID: {cid}", "CSeq: 2 BYE"])),
        (ts + 65 * NS + 40_000_000, msg(["SIP/2.0 200 OK", "From: <sip:+17744045256@34.24.133.82>;tag=fs1",
                                         'To: "WIRELESS CALLER" <sip:+15087282017@67.231.13.185>;tag=gK0a',
                                         f"Call-ID: {cid}", "CSeq: 2 BYE"])),
    ]
    return rows


def b_leg(cid, a_cid, ts):
    # Compact headers, tel: To, multi-URI Diversion/PAI, 503 then (new CSeq) 200.
    return [
        (ts, msg(["INVITE sip:+16174544217@67.231.2.12:5060 SIP/2.0", "v: SIP/2.0/UDP 192.168.10.2:5090;branch=z9b1",
                  "f: <sip:+17744045256@34.24.133.82>;tag=xyz", "t: <tel:+16174544217>", f"i: {cid}",
                  "CSeq: 21 INVITE",
                  "Diversion: <sip:+17744045256@34.24.133.82>;reason=unconditional;counter=1, <sip:5551234567@10.0.0.1>;reason=user-busy",
                  f"X-CID: {a_cid}",
                  'P-Asserted-Identity: "Granite" <sip:+17744045256@34.24.133.82>, <tel:+17744045256;phone-context=x>',
                  "l: 0"])),
        (ts + 300_000_000, msg(["SIP/2.0 503 Service Unavailable", "f: <sip:+17744045256@34.24.133.82>;tag=xyz",
                                "t: <tel:+16174544217>;tag=c1", f"i: {cid}", "CSeq: 21 INVITE"])),
        (ts + 2 * NS, msg(["SIP/2.0 200 OK", "f: <sip:+17744045256@34.24.133.82>;tag=xyz",
                           "t: <tel:+16174544217>;tag=c1", f"i: {cid}", "CSeq: 22 INVITE"])),
    ]


def oddities(ts):
    return [
        # npdi/rn user params: only the dialed number is indexed, never rn=.
        (ts, msg(["INVITE sip:+15085550100;npdi;rn=+15085559999@1.2.3.4 SIP/2.0",
                  "From: <sip:%2B12125550123@host.example>;tag=1", "To: <sip:+15085550100@1.2.3.4>",
                  "call-id : odd-npdi@x", "CSeq: 1 INVITE"])),
        # LF-only line endings, lowercase headers.
        (ts + 1, "INVITE sip:3125550199@10.1.1.1 SIP/2.0\nfrom: <sip:3125550100@10.1.1.2>;tag=2\n"
                 "to: <sip:3125550199@10.1.1.1>\ncall-id: odd-lf@x\ncseq: 7 INVITE\n\n"),
        # Scanner: host-only R-URI, short numeric From.
        (ts + 2, msg(["INVITE sip:1.2.3.4 SIP/2.0", "From: <sip:100@1.2.3.4>;tag=s", "To: <sip:1.2.3.4>",
                      "Call-ID: odd-scan@x", "CSeq: 1 INVITE"])),
        # Anonymous caller with digits only in the display name.
        (ts + 3, msg(["INVITE sip:+19785550111@34.24.133.82 SIP/2.0",
                      'From: "6175550000" <sip:anonymous@anonymous.invalid>;tag=a',
                      "To: <sip:+19785550111@34.24.133.82>", "Call-ID: odd-anon@x", "CSeq: 1 INVITE"])),
        # Keepalive: never indexed.
        (ts + 4, msg(["OPTIONS sip:67.231.2.12:5060 SIP/2.0", "From: <sip:5085550000@10.142.0.100>;tag=o",
                      "To: <sip:67.231.2.12>", "Call-ID: odd-options@x", "CSeq: 10 OPTIONS"])),
        (ts + 5, msg(["SIP/2.0 200 OK", "From: <sip:5085550000@10.142.0.100>;tag=o",
                      "To: <sip:67.231.2.12>;tag=b", "Call-ID: odd-options@x", "CSeq: 10 OPTIONS"])),
        # No Call-ID: skipped.
        (ts + 6, msg(["INVITE sip:+15085550222@x SIP/2.0", "From: <sip:+15085550223@y>", "CSeq: 1 INVITE"])),
    ]


OTHER_A = {("5087282017", "other"), ("15087282017", "other"), ("7744045256", "other"), ("17744045256", "other")}
OTHER_B = {("7744045256", "other"), ("17744045256", "other"), ("6174544217", "other"), ("16174544217", "other")}
EXPECT = {
    # Roles from the INITIAL INVITE only; every other message -> 'other'
    # (the callee's BYE has From/To swapped and R-URI = caller Contact).
    "a-leg-1@67.231.13.185": {
        ("7744045256", "ruri"), ("17744045256", "ruri"),
        ("5087282017", "from"), ("15087282017", "from"),
        ("7744045256", "to"), ("17744045256", "to"),
        ("5087282017", "pai"), ("15087282017", "pai"),
    } | OTHER_A,
    "b-leg-1@192.168.10.2": {
        ("6174544217", "ruri"), ("16174544217", "ruri"), ("7744045256", "from"), ("17744045256", "from"),
        ("6174544217", "to"), ("16174544217", "to"), ("7744045256", "pai"), ("17744045256", "pai"),
        ("7744045256", "diversion"), ("17744045256", "diversion"), ("5551234567", "diversion"),
    } | OTHER_B,
    "odd-npdi@x": {("5085550100", "ruri"), ("15085550100", "ruri"), ("2125550123", "from"),
                   ("12125550123", "from"), ("5085550100", "to"), ("15085550100", "to")},
    "odd-lf@x": {("3125550199", "ruri"), ("3125550100", "from"), ("3125550199", "to")},
    "odd-scan@x": {("100", "from")},
    "odd-anon@x": {("9785550111", "ruri"), ("19785550111", "ruri"), ("9785550111", "to"), ("19785550111", "to")},
}


def insert_samples(rows, db="qryn"):
    data = "\n".join(json.dumps({"fingerprint": random.getrandbits(63), "timestamp_ns": ts,
                                 "value": 0, "string": s}) for ts, s in rows).encode()
    ch(f"INSERT INTO {db}.samples_v3 (fingerprint, timestamp_ns, value, string) FORMAT JSONEachRow", data=data)


def index_pairs(cid):
    out = ch("SELECT number, role FROM qryn.sip_number_index WHERE call_id = {c:String} "
             "GROUP BY number, role FORMAT JSONEachRow", {"param_c": cid})
    return {(r["number"], r["role"]) for r in hi.parse_rows(out)}


def ts_of(d, hour=12):
    return int(datetime(d.year, d.month, d.day, hour, tzinfo=timezone.utc).timestamp()) * NS


RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))


def run_backfill(*args):
    env = dict(os.environ, CH_CLIENT=CH_CLIENT)
    p = subprocess.run(["bash", str(BACKFILL), *args], env=env, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def lookup(needles, start_ns, end_ns, limit=50, db="qryn", tag=None):
    q = hi.build_lookup(db, needles, start_ns, end_ns, limit)
    extra = {"log_comment": tag} if tag else {}
    return [h.call_id for h in hi.parse_lookup(ch(q.sql, {**q.params, **hi.INDEX_QUERY_SETTINGS, **extra}))]


def scale():
    """30M unmerged index rows over 7 days, then the API's lookups."""
    ch("DROP DATABASE IF EXISTS scale SYNC")
    ch("CREATE DATABASE scale")
    client(DDL.read_text().split("-- 3) The materialized view.")[0].replace("qryn.", "scale."))
    ch("SYSTEM STOP MERGES scale.sip_number_index")
    per_insert, inserts_per_day = 430_000, 10
    t0 = time.time()
    for d in range(7):
        day = TODAY - timedelta(days=d)
        for part in range(inserts_per_day):
            off = (d * inserts_per_day + part) * per_insert
            ch(f"""INSERT INTO scale.sip_number_index
SELECT toDate('{day.isoformat()}') AS day,
  multiIf(k % 10 = 0, concat('508', toString(1000000 + cityHash64(k, 1) % 9000000)),
          k % 10 = 1, concat('1', toString(2000000000 + cityHash64(k, 2) % 8000000000)),
          toString(2000000000 + cityHash64(k, 3) % 8000000000)) AS number,
  ['ruri', 'from', 'to', 'pai', 'diversion', 'other'][1 + k % 6] AS role,
  concat(hex(cityHash64(intDiv(k, 6))), '-', toString(intDiv(k, 6)), '@67.231.13.185') AS call_id,
  toInt64({hi.midnight_ns(day)} + cityHash64(k, 4) % {DAYNS}) AS first_ns,
  first_ns + 30000000000 AS last_ns,
  arrayReduce('argMaxState', [toUInt16(200)], [first_ns]) AS final_code
FROM (SELECT number + {off} AS k FROM numbers({per_insert}))""")
        # Planted calls: 3 per day for the full number, 2 international.
        for k in range(3):
            for num, role in (("5087282017", "from"), ("15087282017", "from"), ("5087282017", "other")):
                ts = hi.midnight_ns(day) + (k * 6 + 3) * 3600 * NS
                ch(f"INSERT INTO scale.sip_number_index SELECT toDate('{day.isoformat()}'), '{num}', '{role}', 'target-{d}-{k}@x', {ts}, {ts + 60 * NS}, arrayReduce('argMaxState', [toUInt16(200)], [toInt64({ts})])")
        for k in range(2):
            ts = hi.midnight_ns(day) + (k * 8 + 1) * 3600 * NS
            ch(f"INSERT INTO scale.sip_number_index SELECT toDate('{day.isoformat()}'), '442079460958', 'to', 'intl-{d}-{k}@x', {ts}, {ts + 60 * NS}, arrayReduce('argMaxState', [toUInt16(200)], [toInt64({ts})])")
    rows = int(ch("SELECT count() FROM scale.sip_number_index").strip())
    parts = ch("SELECT count() FROM system.parts WHERE database = 'scale' AND table = 'sip_number_index' AND active").strip()
    size = ch("SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE database = 'scale' AND table = 'sip_number_index' AND active").strip()
    print(f"SCALE loaded {rows:,} rows in {parts} active parts ({size} on disk), merges stopped, {time.time() - t0:.0f}s")
    w0 = hi.midnight_ns(TODAY - timedelta(days=6))
    w1 = hi.midnight_ns(TODAY + timedelta(days=1))
    cases = [("exact 10-digit (+1 (508) 728-2017)", [("number", hp.normalize_number_needle("+1 (508) 728-2017"))]),
             ("11-digit 15087282017 (normalized)", [("number", hp.normalize_number_needle("15087282017"))]),
             ("international 12-digit exact", [("number", "442079460958")]),
             ("from_user exact", [("from_user", "5087282017")]),
             ("4-digit partial 2017", [("number", "2017")]),
             ("3-digit partial 508", [("number", "508")])]
    ok_all = True
    for name, needles in cases:
        for mode in ("prewhere", "no-prewhere"):
            tag = f"scale-{mode}-{abs(hash(name)) % 10**8}"
            q = hi.build_lookup("scale", needles, w0, w1, 70)
            sql = q.sql
            if mode == "no-prewhere":
                pre = sql.split("PREWHERE ")[1].split(" WHERE day")[0]
                sql = sql.replace(f"PREWHERE {pre} WHERE day >= {{d0:Date}} AND day <= {{d1:Date}}",
                                  f"WHERE day >= {{d0:Date}} AND day <= {{d1:Date}} AND ({pre})")
            try:
                got = hi.parse_lookup(ch(sql, {**q.params, **hi.INDEX_QUERY_SETTINGS, "log_comment": tag}))
                res = f"{len(got)} calls"
            except CHError as e:
                res = f"REFUSED code {e.code}"
                if mode == "prewhere":
                    ok_all = False
            ch("SYSTEM FLUSH LOGS")
            r = ch(f"SELECT read_rows, read_bytes, memory_usage, query_duration_ms FROM system.query_log WHERE log_comment = '{tag}' AND type != 'QueryStart' ORDER BY event_time_microseconds DESC LIMIT 1 FORMAT TSV").split()
            if r:
                print(f"SCALE {name:<36} {mode:<11} {res:<18} read {int(r[0]):>11,} rows {int(r[1]) / 1e6:>8.1f} MB  mem {int(r[2]) / 2**20:>6.0f} MiB  {int(r[3]):>5} ms")
    check("scale: every lookup (exact and partial) answers under the API caps with PREWHERE", ok_all)
    exact = hi.parse_lookup(ch(hi.build_lookup("scale", [("number", "5087282017")], w0, w1, 70).sql,
                               {**hi.build_lookup("scale", [("number", "5087282017")], w0, w1, 70).params, **hi.INDEX_QUERY_SETTINGS}))
    planted = {f"target-{d}-{k}@x" for d in range(7) for k in range(3)}
    check("scale: the exact number finds all 21 planted calls (random rows may collide)",
          planted <= {h.call_id for h in exact}, str(len(exact)))
    ch("DROP DATABASE scale SYNC")


def main():
    random.seed(7)
    setting = ch("SELECT value FROM system.settings WHERE name = 'materialized_views_ignore_errors'").strip()
    check("0. repo clickhouse-users.xml mounted: materialized_views_ignore_errors = 1 for the inserting user",
          setting == "1", setting)
    for db in ("qryn", "bench", "drift"):
        ch(f"DROP DATABASE IF EXISTS {db} SYNC")
        ch(f"CREATE DATABASE {db}")
        client(QRYN_SCHEMA.format(db=db))

    # --- history inserted BEFORE the index exists (backfill must find it) ---
    y = TODAY - timedelta(days=1)
    insert_samples(a_leg("hist-y@x", ts_of(y, 12)) + a_leg("hist-today-early@x", ts_of(TODAY, 0) + NS))
    insert_samples(a_leg("hist-6d@x", ts_of(TODAY - timedelta(days=6), 3)))

    ddl = DDL.read_text()
    client(ddl)
    client(ddl)
    mv_rows = ch("SELECT count() FROM qryn.sip_number_index_coverage WHERE kind = 'mv'").strip()
    check("DDL applies twice; exactly one 'mv' coverage row", mv_rows == "1", mv_rows)

    # --- live ingest through the MV ---
    t = ts_of(TODAY, 0) + 3600 * NS   # today 01:00 UTC
    insert_samples(a_leg("a-leg-1@67.231.13.185", t) + b_leg("b-leg-1@192.168.10.2", "a-leg-1@67.231.13.185", t + 40_000_000)
                   + oddities(t + 10 * NS))
    for cid, want in EXPECT.items():
        got = index_pairs(cid)
        check(f"MV extracts {cid}", got == want, f"missing={want - got} extra={got - want}")
    leaked = ch("SELECT count() FROM qryn.sip_number_index WHERE number IN ('6179990000', '16179990000', '5085559999', '15085559999', '6175550000', '5085550000', '15085550222', '5085550223')").strip()
    check("nothing from SDP body, Contact, rn=, display name, OPTIONS, no-Call-ID rows", leaked == "0", leaked)
    fc = ch("SELECT argMaxMerge(final_code) FROM qryn.sip_number_index WHERE call_id = 'b-leg-1@192.168.10.2'").strip()
    check("final_code = last final INVITE response (503 then 200 -> 200)", fc == "200", fc)
    fc = ch("SELECT argMaxMerge(final_code) FROM qryn.sip_number_index WHERE call_id = 'a-leg-1@67.231.13.185'").strip()
    check("final_code ignores the BYE's 200 and keeps the INVITE 200", fc == "200", fc)

    # --- junk never fails ingest ---
    junk = [(t + 100 + i, s) for i, s in enumerate([
        "", "hello world", '{"type":200,"ssrc":1}', "\x00\x01\x02" * 50, "INVITE " + "9" * 1_000_000,
        "SIP/2.0 " + "x" * 300_000, "INVITE sip:+15085550333@x SIP/2.0\r\nCall-ID: " + "z" * 600 + "\r\n\r\n",
        "SIP/2.0 2", "INVITE  SIP/2.0", "\r\n\r\n\r\n",
    ])]
    before = int(ch("SELECT count() FROM qryn.sip_number_index").strip())
    ok = True
    try:
        insert_samples(junk)
        # Raw random bytes (invalid UTF-8), generated server-side.
        ch(f"INSERT INTO qryn.samples_v3 (fingerprint, timestamp_ns, value, string) "
           f"SELECT rand64(), {t + 1000} + number, 0, randomString(rand() % 4096) FROM numbers(2000)")
    except CHError as e:
        ok = False
        print(e)
    after = int(ch("SELECT count() FROM qryn.sip_number_index").strip())
    check("2,010 junk / random-byte / oversized rows insert fine", ok)
    check("they add zero index rows (incl. a >512-byte Call-ID)", after == before, f"{before}->{after}")
    try:
        # SIP-shaped messages with random bytes in every field: must insert.
        ch(f"INSERT INTO qryn.samples_v3 (fingerprint, timestamp_ns, value, string) "
           f"SELECT rand64(), {t + 5000} + number, 0, concat('INVITE sip:', randomString(rand() % 40), '@x SIP/2.0\\r\\n"
           f"From: <sip:', randomString(rand() % 40), '@y>;tag=1\\r\\nTo: <tel:', randomString(rand() % 40), '>\\r\\n"
           f"Diversion: ', randomString(rand() % 400), '\\r\\nCall-ID: ', randomString(1 + rand() % 60), '\\r\\n"
           f"CSeq: 1 INVITE\\r\\n\\r\\n', randomString(rand() % 2000)) FROM numbers(5000)")
        ok2 = True
    except CHError as e:
        ok2 = False
        print(e)
    check("5,000 SIP-shaped random-byte messages insert fine", ok2)

    # --- capability before backfill = MV start ---
    st = hi.build_state_sql("qryn")
    tables = hi.parse_state(ch(st.sql, {**st.params, **hi.STATE_QUERY_SETTINGS}))
    cov = hi.parse_rows(ch(hi.build_coverage_sql("qryn"), hi.STATE_QUERY_SETTINGS))
    now_ns = int(time.time() * NS)
    cap = hi.compute_capability(tables, cov, now_ns)
    check("capability before backfill: index on, covered from the MV start (minutes ago)",
          cap.number_index and now_ns - 600 * NS < cap.covered_from_ns <= now_ns, str(cap))
    check("history not searchable before backfill", lookup([("number", "5087282017")], ts_of(TODAY - timedelta(days=7), 0), now_ns + NS).count("hist-y@x") == 0)

    # --- backfill: fill, resume, redo ---
    t0 = time.time()
    rc, out = run_backfill()
    first_run_s = time.time() - t0
    print(out)
    check("backfill run 1 succeeds", rc == 0, out[-500:])
    rc2, out2 = run_backfill()
    check("backfill run 2 skips every day (already filled)", rc2 == 0 and out2.count("already filled") == 8, out2[-400:])
    snap = ch("SELECT call_id, number, role, min(first_ns), max(last_ns), argMaxMerge(final_code) FROM qryn.sip_number_index GROUP BY call_id, number, role ORDER BY call_id, number, role FORMAT TSV")
    rc3, out3 = run_backfill("--redo", TODAY.isoformat())
    snap2 = ch("SELECT call_id, number, role, min(first_ns), max(last_ns), argMaxMerge(final_code) FROM qryn.sip_number_index GROUP BY call_id, number, role ORDER BY call_id, number, role FORMAT TSV")
    check("--redo today (overlaps the MV) leaves results identical", rc3 == 0 and snap == snap2)
    ch("OPTIMIZE TABLE qryn.sip_number_index FINAL")
    dup = ch("SELECT count() - uniqExact(number, role, call_id) FROM qryn.sip_number_index").strip()
    check("after merge: one row per (number, role, call_id) per day", dup == "0", dup)
    for cid in ("hist-y@x", "hist-today-early@x", "hist-6d@x"):
        check(f"backfill indexed pre-MV {cid}", ("5087282017", "from") in index_pairs(cid))

    cov = hi.parse_rows(ch(hi.build_coverage_sql("qryn"), hi.STATE_QUERY_SETTINGS))
    cap = hi.compute_capability(tables, cov, int(time.time() * NS))
    want_from = hi.midnight_ns(TODAY - timedelta(days=hi.INDEX_RETENTION_DAYS))
    check("capability after backfill: covered from midnight today-7", cap.covered_from_ns == want_from,
          f"{cap.covered_from_iso}")

    # --- the API's lookup SQL on real ClickHouse ---
    w0, w1 = ts_of(TODAY - timedelta(days=7), 0), int(time.time() * NS) + NS
    for raw in ("5087282017", "15087282017", "+1 (508) 728-2017", "508.728.2017"):
        got = set(lookup([("number", hp.normalize_number_needle(raw))], w0, w1))
        check(f"needle {raw!r} finds the A leg and history", {"a-leg-1@67.231.13.185", "hist-y@x", "hist-6d@x", "hist-today-early@x"} <= got, str(got))
    check("partial '4217' finds the B leg", "b-leg-1@192.168.10.2" in lookup([("number", "4217")], w0, w1))
    check("partial '15087' (includes the 1) still matches", "a-leg-1@67.231.13.185" in lookup([("number", "15087")], w0, w1))
    check("from_user 5087282017 -> A leg", "a-leg-1@67.231.13.185" in lookup([("from_user", "5087282017")], w0, w1))
    check("to_user <caller> matches nothing: the callee's BYE (From/To swapped) carries no role",
          lookup([("to_user", "5087282017")], t - NS, t + 100 * NS) == [])
    check("number <caller> still finds the A leg via every message",
          "a-leg-1@67.231.13.185" in lookup([("number", "5087282017")], t - NS, t + 100 * NS))
    check("from_user 6174544217 matches nothing (it is only ever the callee)",
          lookup([("from_user", "6174544217")], w0, w1) == [])
    check("to_user 6174544217 -> B leg", lookup([("to_user", "6174544217")], w0, w1) == ["b-leg-1@192.168.10.2"])
    check("AND: from 7744045256 + to 6174544217 -> B leg only",
          lookup([("from_user", "7744045256"), ("to_user", "6174544217")], w0, w1) == ["b-leg-1@192.168.10.2"])
    check("diversion number found by `number`", "b-leg-1@192.168.10.2" in lookup([("number", "5551234567")], w0, w1))
    order = lookup([("number", "5087282017")], w0, w1)
    check("newest first", order.index("a-leg-1@67.231.13.185") < order.index("hist-y@x") < order.index("hist-6d@x"), str(order))
    check("window bound respected (yesterday only)", lookup([("number", "5087282017")], ts_of(y, 0), ts_of(TODAY, 0)) == ["hist-y@x"])
    check("full number is an exact match: an international number containing it is not returned",
          "a-leg-1@67.231.13.185" in lookup([("number", "5087282017")], w0, w1)
          and lookup([("number", "4450872820179")], w0, w1) == [])

    # --- hostile input is data ---
    hostile = "'; DROP TABLE qryn.samples_v3; --\\\u0663"
    echo = hi.parse_rows(ch("SELECT {n:String} AS n FORMAT JSONEachRow", {"param_n": hostile, **hi.INDEX_QUERY_SETTINGS}))
    check("hostile parameter comes back verbatim", echo and echo[0]["n"] == hostile)
    try:
        ch("SELECT count() FROM qryn.sip_number_index WHERE number LIKE {n:String} FORMAT JSONEachRow",
           {"param_n": "%" + hostile + "%", **hi.INDEX_QUERY_SETTINGS})
        survived = ch("SELECT count() FROM system.tables WHERE database = 'qryn' AND name = 'samples_v3'").strip() == "1"
    except CHError as e:
        survived = False
        print(e)
    check("hostile LIKE parameter alters nothing", survived)
    try:
        ch("DROP TABLE qryn.sip_number_index_coverage", hi.INDEX_QUERY_SETTINGS)
        ro = False
    except CHError as e:
        ro = e.code == "164"
    check("readonly=2 refuses writes on index queries", ro)

    # --- ingest overhead benchmark ---
    ddl_bench = ddl.replace("qryn.", "bench.")
    rows = []
    base = ts_of(TODAY, 2)
    for i in range(6000):
        a = f"bench-a-{i}@67.231.13.185"
        rows += a_leg(a, base + i * 10_000_000) + b_leg(f"bench-b-{i}@192.168.10.2", a, base + i * 10_000_000 + 40_000_000)
    total_bytes = sum(len(s) for _ts, s in rows)
    batches = [rows[i:i + 200] for i in range(0, len(rows), 200)]

    def timed():
        t0 = time.perf_counter()
        for b in batches:
            insert_samples(b, db="bench")
        return time.perf_counter() - t0
    no_mv = [timed()]
    client(ddl_bench)
    with_mv = [timed()]
    ch("DROP VIEW bench.sip_number_index_mv SYNC")
    no_mv.append(timed())
    client(ddl_bench)
    with_mv.append(timed())
    nm, wm = min(no_mv), min(with_mv)
    print(f"BENCH {len(rows)} SIP rows ({total_bytes / 1e6:.1f} MB) in {len(batches)} inserts of 200: "
          f"without our MV {nm:.2f}s, with {wm:.2f}s -> +{(wm / nm - 1) * 100:.0f}% wall "
          f"({(wm - nm) / len(rows) * 1e6:.1f} us per message)")
    try:
        ch("SYSTEM FLUSH LOGS")
        vq = ch("SELECT round(avg(view_duration_ms), 2), max(view_duration_ms), count() FROM system.query_views_log WHERE view_name = 'bench.sip_number_index_mv' FORMAT TSV").strip()
        print(f"BENCH system.query_views_log for the MV: avg_ms, max_ms, inserts = {vq}")
    except CHError as e:
        print(f"BENCH query_views_log unavailable: {e}")
    # Backfill throughput on the bench data (one day, all hours).
    t0 = time.time()
    ch("TRUNCATE TABLE bench.sip_number_index")
    sel = ddl.split("-- BEGIN sip_number_index extract\n")[1].split("-- END sip_number_index extract")[0]
    ch("INSERT INTO bench.sip_number_index " + sel.replace("qryn.samples_v3", "bench.samples_v3").replace("/*BACKFILL_RANGE*/", "")
       + " SETTINGS max_memory_usage = 1500000000, max_threads = 2")
    bf = time.time() - t0
    src = int(ch("SELECT count() FROM bench.samples_v3").strip())
    srcb = int(ch("SELECT sum(length(string)) FROM bench.samples_v3").strip())
    print(f"BENCH backfill SELECT over {src} rows / {srcb / 1e6:.1f} MB: {bf:.2f}s -> {srcb / 1e6 / bf:.0f} MB/s at max_threads=2")
    check("benchmark ran", nm > 0 and wm > 0)

    # --- failure modes ---
    ch("TRUNCATE TABLE bench.sip_number_index")
    ch("CREATE TABLE bench.bad_target (n UInt8) ENGINE = MergeTree ORDER BY tuple()")
    ch("CREATE MATERIALIZED VIEW bench.bad_mv TO bench.bad_target AS SELECT throwIf(length(string) > 0, 'simulated MV bug') AS n FROM bench.samples_v3")
    try:
        insert_samples(a_leg("fail-1@x", base), db="bench")
        ok = True
    except CHError as e:
        ok = False
        print(e)
    ch("SYSTEM FLUSH LOGS")
    logged = ch("SELECT count() FROM system.query_views_log WHERE view_name = 'bench.bad_mv' AND status = 'ExceptionWhileProcessing'").strip()
    check("a throwing MV with ignore-errors: the samples insert succeeds and the error is logged",
          ok and int(logged) > 0, logged)
    check("... and the index MV still indexes that batch", ("5087282017", "from") in
          {(r["number"], r["role"]) for r in hi.parse_rows(ch("SELECT number, role FROM bench.sip_number_index WHERE call_id = 'fail-1@x' FORMAT JSONEachRow"))})
    ch("DROP VIEW bench.bad_mv SYNC")
    ch("DROP TABLE bench.bad_target SYNC")   # an MV whose target is gone ...
    ch("CREATE TABLE bench.bad_target (n UInt8) ENGINE = MergeTree ORDER BY tuple()")
    ch("CREATE MATERIALIZED VIEW bench.bad_mv TO bench.bad_target AS SELECT toUInt8(1) AS n FROM bench.samples_v3")
    ch("DROP TABLE bench.bad_target SYNC")
    try:
        insert_samples(a_leg("fail-2@x", base), db="bench")
        failed_code = None
    except CHError as e:
        failed_code = e.code
    check("target table dropped while its MV exists: the insert FAILS (Code 60) even with ignore-errors — rollback must drop the MV first",
          failed_code == "60", str(failed_code))
    ch("DROP VIEW bench.bad_mv SYNC")
    try:
        insert_samples(a_leg("fail-3@x", base), db="bench")
        ok = True
    except CHError:
        ok = False
    check("after DROP VIEW the insert works again", ok)

    # Schema drift: qryn renames/drops the text column.
    try:
        client(ddl.replace("qryn.", "drift."))
        drift_ok = True
    except subprocess.CalledProcessError:
        drift_ok = False
    ch("ALTER TABLE drift.samples_v3 RENAME COLUMN string TO string_v2")
    try:
        ch("INSERT INTO drift.samples_v3 (fingerprint, timestamp_ns, value, string_v2) VALUES (1, 1, 0, 'x')")
        drift_insert = "ok"
    except CHError as e:
        drift_insert = e.code
    check("schema drift after deploy (qryn renames `string`): inserts FAIL — the pre-upgrade check in docker/homer/CLAUDE.md is required",
          drift_ok and drift_insert != "ok", str(drift_insert))
    ch("DROP DATABASE drift SYNC")
    ch("CREATE DATABASE drift")
    client(QRYN_SCHEMA.format(db="drift").replace("string String", "body String").replace("length(string)", "length(body)"))
    try:
        client(ddl.replace("qryn.", "drift."))
        drift_ddl = "applied"
    except subprocess.CalledProcessError:
        drift_ddl = "failed"
    objs = ch("SELECT groupArray(name) FROM system.tables WHERE database = 'drift' AND name LIKE 'sip_number_index%'").strip()
    check("schema drift before deploy: the DDL fails at the MV, no MV exists, the API sees no index",
          drift_ddl == "failed" and "sip_number_index_mv" not in objs, objs)
    ch("DROP DATABASE drift SYNC")

    # Insert block cost: realistic ~1.9 KB messages.
    def big(i):
        cid = f"blk-{i}@67.231.13.185"
        return msg([f"INVITE sip:+1774404{i % 10000:04d}@34.24.133.82:5060 SIP/2.0",
                    "Via: SIP/2.0/UDP 67.231.13.185:5060;branch=z9hG4bK" + "a" * 30,
                    "Via: SIP/2.0/UDP 10.142.0.100:5060;branch=z9hG4bK" + "b" * 30,
                    "Record-Route: <sip:34.24.133.82:5060;lr;fs=5080>", "Record-Route: <sip:10.142.0.250:5060;r2=on;lr>",
                    f'From: "CALLER {i}" <sip:+1508728{i % 10000:04d}@67.231.13.185:5060;user=phone>;tag=gK{i}',
                    f"To: <sip:+1774404{i % 10000:04d}@34.24.133.82:5060>", f"Call-ID: {cid}", "CSeq: 1 INVITE",
                    f"P-Asserted-Identity: <sip:+1508728{i % 10000:04d}@67.231.13.185:5060;user=phone>",
                    "Identity: " + "e" * 700 + ";info=<https://cert.example/x.pem>;alg=ES256;ppt=shaken",
                    "Allow: INVITE,ACK,CANCEL,BYE,OPTIONS,UPDATE,PRACK,INFO", "Supported: timer,100rel",
                    "User-Agent: carrier-sbc/1.0", "Contact: <sip:+15087280000@67.231.13.185:5060>",
                    "Content-Type: application/sdp", "Content-Length: 300"], SDP + "a=" + "x" * 150 + "\r\n")

    def block_cost(n, tag):
        rows = [(base + 10 * DAYNS + i, big(i)) for i in range(n)]
        data = "\n".join(json.dumps({"fingerprint": i, "timestamp_ns": ts, "value": 0, "string": m}) for i, (ts, m) in enumerate(rows)).encode()
        try:
            ch("INSERT INTO bench.samples_v3 (fingerprint, timestamp_ns, value, string) FORMAT JSONEachRow", data=data,
               params={"log_comment": tag})
            res = "ok"
        except CHError as e:
            res = f"FAILED {e.code}"
        ch("SYSTEM FLUSH LOGS")
        row = ch(f"SELECT memory_usage, query_duration_ms FROM system.query_log WHERE log_comment = '{tag}' AND type != 'QueryStart' ORDER BY event_time_microseconds DESC LIMIT 1 FORMAT TSV").split()
        return res, len(data), row
    out = {}
    for n in (50_000, 200_000):
        ch("DROP VIEW IF EXISTS bench.sip_number_index_mv SYNC")
        out[(n, "without")] = block_cost(n, f"blk-{n}-nomv")
        client(ddl_bench)
        out[(n, "with")] = block_cost(n, f"blk-{n}-mv")
    for (n, k), (res, nbytes, row) in sorted(out.items()):
        mem = int(row[0]) / 2**20 if row else -1
        dur = int(row[1]) if row else -1
        print(f"BLOCK {n} rows / {nbytes / 1e6:.0f} MB JSON {k:>7} our MV: {res}, memory {mem:.0f} MiB, {dur} ms")
    # The MV hits a memory limit: ignore-errors must keep the insert.
    rows = [(base + 20 * DAYNS + i, big(i)) for i in range(200_000)]
    data = "\n".join(json.dumps({"fingerprint": i, "timestamp_ns": ts, "value": 0, "string": m}) for i, (ts, m) in enumerate(rows)).encode()
    try:
        ch("INSERT INTO bench.samples_v3 (fingerprint, timestamp_ns, value, string) FORMAT JSONEachRow", data=data,
           params={"max_memory_usage": "1500000000", "log_comment": "blk-memcap"})
        capped = "ok"
    except CHError as e:
        capped = f"FAILED {e.code}"
    ch("SYSTEM FLUSH LOGS")
    vfail = ch("SELECT count() FROM system.query_views_log WHERE view_name = 'bench.sip_number_index_mv' AND status = 'ExceptionWhileProcessing' AND exception_code = 241").strip()
    print(f"BLOCK 200000 rows with max_memory_usage 1.5e9: insert {capped}, MV memory-limit failures logged: {vfail}")
    check("MV over its memory limit: the samples insert still succeeds (index gap, no trace loss)", capped == "ok", capped)
    check("a 50k-row ~95 MB block inserts with the MV", out[(50_000, "with")][0] == "ok")
    check("a 200k-row block inserts with the MV (ignore-errors or fits)", out[(200_000, "with")][0] == "ok")

    # --- why no ngram bloom filter ---
    ch("CREATE TABLE bench.ngram (number String, INDEX ng number TYPE ngrambf_v1(3, 4096, 3, 0) GRANULARITY 1) ENGINE = MergeTree ORDER BY number")
    ch("INSERT INTO bench.ngram SELECT toString(2000000000 + rand() % 8000000000) FROM numbers(2000000)")
    for pat in ("%508%", "%5087282%"):
        ex = ch(f"EXPLAIN indexes = 1 SELECT count() FROM bench.ngram WHERE number LIKE '{pat}'")
        gr = [ln.strip() for ln in ex.splitlines() if "Granules" in ln]
        print(f"NGRAM {pat}: {gr}")

    print(f"first backfill run (8 days, tiny data): {first_run_s:.1f}s")
    if "--scale" in sys.argv:
        scale()
    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
