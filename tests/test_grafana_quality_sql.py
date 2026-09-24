"""Grafana call-quality SQL — structural + live-SQL tests (CALL_QUALITY_ACCURACY_PLAN.md E.1 / D / G.1).

Two layers:

1. Pure (no DB): the three CDR-reading NOC dashboards load, panel ids are
   unique, no gridPos overlaps, the re-pointed quality panels kept their
   place on the wall, every cdrs SQL carries the leg predicate, and no
   quality number is a MOS average / FS quality % / relabelled R-factor.

2. Live (ephemeral PostgreSQL 16): a production-shaped `cdrs` + the REAL
   migrations 23/47/48 + `50_cdr_quality_accuracy.sql` (owned by the API
   agent — read here, never edited). Seeded A/B legs get their call-level
   columns from the real `cdr_refresh_call_quality()`, then every cdrs-only
   rawSql on the dashboards is EXPLAINed, and every panel the plan re-points
   is EXECUTED (as grafana_ro, the datasource role) with Grafana macros
   substituted and its result shape + values asserted.

Macro substitution (plan G.1): $__timeFilter(x) -> x > now() - interval '1 day',
$__timeGroup(x,'N') -> date_bin('N'::interval, x, 'epoch'), $zone -> '%' (or a
named zone where a test says so).

Run:  TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python -m pytest tests/test_grafana_quality_sql.py -q
"""
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DASH_DIR = REPO / "docker" / "homer" / "grafana" / "dashboards" / "noc"
DASHBOARDS = ("call-quality.json", "noc-home.json", "traffic-status.json")
MIGRATION_50 = REPO / "docker" / "postgres" / "init" / "50_cdr_quality_accuracy.sql"

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Panels the plan (E.1) re-points. Ids stay stable; gridPos must not move.
CQ_EDITED = {
    43: {"h": 4, "w": 5, "x": 15, "y": 0},
    12: {"h": 8, "w": 8, "x": 0, "y": 4},
    21: {"h": 8, "w": 8, "x": 8, "y": 4},
    10: {"h": 1, "w": 24, "x": 0, "y": 20},
    20: {"h": 8, "w": 6, "x": 0, "y": 21},
    11: {"h": 8, "w": 6, "x": 6, "y": 21},
    13: {"h": 8, "w": 6, "x": 12, "y": 21},
    22: {"h": 8, "w": 6, "x": 18, "y": 21},
    30: {"h": 8, "w": 12, "x": 12, "y": 64},
}
NH_EDITED = {
    30: {"x": 0, "y": 23, "w": 4, "h": 3},
    31: {"x": 4, "y": 23, "w": 4, "h": 3},
    32: {"x": 8, "y": 23, "w": 4, "h": 3},
    33: {"x": 12, "y": 23, "w": 4, "h": 3},
}
CQ_TITLES = {
    43: "Good-or-better calls — last 15m",
    12: "Call MOS — p50 / p10 (10m)",
    21: "True packet loss — p95 by direction (10m)",
    10: "Quality detail — grades / loss / jitter / one-way audio (graded legs only)",
    20: "Jitter (RFC 3550) — p50 / p95 by direction (10m)",
    11: "Call grade distribution",
    13: "Loss distribution — graded legs",
    22: "One-way / no inbound audio — per hour",
    30: "Graded-call quality snapshot",
}
NH_TITLES = {
    30: "Voice · Good+ calls — 15m",
    31: "Voice · Loss p95 — 15m",
    32: "Voice · Jitter p95 — 15m",
    33: "Voice · One-way audio — 1h",
}
# Panels that are deliberately leg-aware (directions, not calls). Every other
# cdrs SQL must carry the A-leg predicate. See docker/homer/CLAUDE.md.
LEG_AWARE = {("call-quality.json", i) for i in (21, 20, 13, 22, 76)} | {("noc-home.json", i) for i in (31, 32)}


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def _walk(panels):
    for p in panels:
        yield p
        yield from _walk(p.get("panels", []) or [])


def _load(name):
    return json.loads((DASH_DIR / name).read_text())


def _panels(name):
    return {p["id"]: p for p in _walk(_load(name)["panels"])}


def _sql_targets(name):
    for p in _walk(_load(name)["panels"]):
        for t in p.get("targets", []) or []:
            if t.get("rawSql"):
                yield p, t


def substitute(sql, zone="%"):
    """Grafana postgres macros -> plain SQL (plan G.1)."""
    sql = re.sub(r"\$__timeFilter\(\s*([\w.]+)\s*\)", r"\1 > now() - interval '1 day'", sql)
    sql = re.sub(r"\$__timeGroup\(\s*([\w.]+)\s*,\s*'([^']+)'\s*\)", r"date_bin('\2'::interval, \1, 'epoch')", sql)
    sql = sql.replace("$zone", zone)
    return sql.rstrip().rstrip(";")


_CTE_RE = re.compile(r"\b(\w+)\s+AS\s*\(", re.I)
_REL_RE = re.compile(r"\b(?:FROM|JOIN)\s+([a-z_][\w.]*)", re.I)


def _relations(sql):
    ctes = {c.lower() for c in _CTE_RE.findall(sql)}
    return {r.lower() for r in _REL_RE.findall(sql)} - ctes


# ----------------------------------------------------------------------------
# 1. pure structural checks
# ----------------------------------------------------------------------------
@pytest.mark.parametrize("name", DASHBOARDS)
def test_dashboard_loads_ids_unique_no_overlap(name):
    d = _load(name)
    ids = [p["id"] for p in _walk(d["panels"])]
    assert len(ids) == len(set(ids)), f"duplicate panel ids in {name}"
    boxes = [(p["id"], p["gridPos"]) for p in d["panels"] if "gridPos" in p]
    for i, (a, g) in enumerate(boxes):
        assert g["x"] + g["w"] <= 24, f"{name} panel {a} overflows the 24-col grid"
        for b, h in boxes[i + 1:]:
            overlap = g["x"] < h["x"] + h["w"] and h["x"] < g["x"] + g["w"] and \
                g["y"] < h["y"] + h["h"] and h["y"] < g["y"] + g["h"]
            assert not overlap, f"{name}: panels {a} and {b} overlap"
    for _, t in _sql_targets(name):
        ds = t.get("datasource") or {}
        if ds.get("type") == "postgres":
            assert ds.get("uid") == "voip-cdr-pg"


def test_edited_panels_keep_ids_titles_and_place():
    cq, nh = _panels("call-quality.json"), _panels("noc-home.json")
    for pid, grid in CQ_EDITED.items():
        assert cq[pid]["gridPos"] == grid, f"call-quality {pid} moved"
        assert cq[pid]["title"] == CQ_TITLES[pid]
    for pid, grid in NH_EDITED.items():
        assert nh[pid]["gridPos"] == grid, f"noc-home {pid} moved"
        assert nh[pid]["title"] == NH_TITLES[pid]
    assert cq[13]["type"] == "barchart" and cq[11]["type"] == "barchart"
    assert _load("call-quality.json")["version"] >= 4 and _load("noc-home.json")["version"] >= 4


@pytest.mark.parametrize("name", DASHBOARDS)
def test_leg_predicate_on_every_cdrs_query(name):
    for p, t in _sql_targets(name):
        sql = t["rawSql"]
        if not re.search(r"\bcdrs\b", sql):
            continue
        assert "leg IS DISTINCT FROM 'B'" in sql, f"{name} panel {p['id']}: cdrs SQL without the A-leg predicate"
        if (name, p["id"]) not in LEG_AWARE:
            assert not re.search(r"(?<![\w.])leg\s*=\s*'B'", sql), f"{name} panel {p['id']} reads B rows but is not leg-aware"


@pytest.mark.parametrize("name", DASHBOARDS)
def test_no_mos_averages_or_deprecated_quality_columns(name):
    banned = [r"avg\(\s*mos", r"avg\(\s*call_mos", r"\bquality_pct\b", r"\br_factor\b",
              r"billable_ms\s*>=\s*10000", r"rtp_audio_in_packet_count\s*>=\s*500", r"\bjitter_max_ms\b"]
    for p, t in _sql_targets(name):
        for pat in banned:
            assert not re.search(pat, t["rawSql"], re.I), f"{name} panel {p['id']} uses /{pat}/"


def test_grade_thresholds_are_the_plan_d_literals():
    cq = _panels("call-quality.json")
    steps = [s["value"] for s in cq[12]["fieldConfig"]["defaults"]["thresholds"]["steps"]]
    assert steps == [None, 3.6, 4.02, 4.34]
    assert cq[12]["fieldConfig"]["defaults"]["min"] == 1 and cq[12]["fieldConfig"]["defaults"]["max"] == 4.5
    for panels, pid in ((cq, 43), (_panels("noc-home.json"), 30)):
        steps = [s["value"] for s in panels[pid]["fieldConfig"]["defaults"]["thresholds"]["steps"]]
        assert steps == [None, 90, 97]
    # the retired MOS cuts (3.5 / 4.0 / 4.3) must be gone from every re-pointed panel
    def step_values(obj):
        if isinstance(obj, dict):
            if "steps" in obj:
                yield from (s.get("value") for s in obj["steps"])
            for v in obj.values():
                yield from step_values(v)
        elif isinstance(obj, list):
            for v in obj:
                yield from step_values(v)
    for pid in CQ_EDITED:
        assert not {3.5, 4.0, 4.3} & set(step_values(cq[pid].get("fieldConfig", {}))), \
            f"call-quality {pid} still carries a retired MOS cut"


def test_traffic_status_has_no_quality_panels():
    blob = json.dumps([t["rawSql"] for _, t in _sql_targets("traffic-status.json")])
    for col in ("mos", "packet_loss", "jitter", "quality_"):
        assert col not in blob


# ----------------------------------------------------------------------------
# 2. live SQL against an ephemeral PG16 + migration 50
# ----------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for the live-SQL tests")
from cdr_schema import CDR_COLUMN_MIGRATIONS, apply_cdr_column_migrations  # noqa: E402


def _find_pg_bin():
    override = os.getenv("TEST_PG_BIN")
    candidates = [override] if override else []
    pgctl = shutil.which("pg_ctl")
    if pgctl:
        candidates.append(str(Path(pgctl).parent))
    candidates += ["/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/bin",
                   "/usr/local/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin"]
    for d in candidates:
        if d and Path(d, "initdb").exists() and Path(d, "pg_ctl").exists():
            return d
    return None


PG_BIN = _find_pg_bin()

_SCHEMA = """
CREATE ROLE api LOGIN;
CREATE ROLE grafana_ro NOLOGIN;
CREATE TABLE cdrs (
  id BIGSERIAL, uuid VARCHAR(64) NOT NULL, customer_id INT NOT NULL, product_type VARCHAR(10) NOT NULL,
  trunk_id INT, direction VARCHAR(10) NOT NULL, caller_id VARCHAR(30), destination VARCHAR(30) NOT NULL,
  destination_prefix VARCHAR(20), start_time TIMESTAMPTZ NOT NULL, answer_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ NOT NULL, duration_ms INT NOT NULL DEFAULT 0, billable_ms INT NOT NULL DEFAULT 0,
  rate_per_min DECIMAL(10,6), total_cost DECIMAL(12,6) DEFAULT 0, carrier_cost DECIMAL(12,6) DEFAULT 0,
  margin DECIMAL(12,6) DEFAULT 0, rated_at TIMESTAMPTZ, hangup_cause VARCHAR(50), sip_code INT,
  carrier_used VARCHAR(50), traffic_grade VARCHAR(10), fraud_score SMALLINT DEFAULT 0, fraud_flags JSONB,
  freeswitch_node VARCHAR(50), mos NUMERIC(3,2), quality_pct NUMERIC(5,2), jitter_min_ms NUMERIC(8,3),
  jitter_max_ms NUMERIC(8,3), jitter_avg_ms NUMERIC(8,3), packet_loss_count INTEGER, packet_total_count INTEGER,
  packet_loss_pct NUMERIC(5,2), flaw_total INTEGER, r_factor NUMERIC(5,2), rtp_audio_in_raw_bytes BIGINT,
  rtp_audio_in_media_bytes BIGINT, rtp_audio_out_raw_bytes BIGINT, rtp_audio_out_media_bytes BIGINT,
  rtp_audio_in_packet_count INTEGER, rtp_audio_out_packet_count INTEGER, rtp_audio_in_jitter_burst_rate NUMERIC(8,4),
  rtp_audio_in_jitter_loss_rate NUMERIC(8,4), rtp_audio_in_mean_interval NUMERIC(8,3), read_codec VARCHAR(20),
  write_codec VARCHAR(20), read_rate INTEGER, write_rate INTEGER, sip_from_user VARCHAR(64), sip_to_user VARCHAR(64),
  hangup_cause_q850 SMALLINT, sip_hangup_disposition VARCHAR(30), sip_user_agent VARCHAR(128),
  network_addr VARCHAR(45), bridge_uuid VARCHAR(64), sbc_id VARCHAR(30),
  inbound_carrier VARCHAR(32), inbound_carrier_pop VARCHAR(32),
  PRIMARY KEY (id, start_time));
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_grafana_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55444  # distinct from every other test module's throwaway cluster

    def start(self):
        subprocess.run([f"{self.pg_bin}/initdb", "-D", self.data, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
                       check=True, capture_output=True)
        subprocess.run([f"{self.pg_bin}/pg_ctl", "-D", self.data,
                        "-o", f"-p {self.port} -k {self.sock} -c listen_addresses=''",
                        "-w", "-l", os.path.join(self.tmp, "log"), "start"], check=True, capture_output=True)

    def stop(self):
        subprocess.run([f"{self.pg_bin}/pg_ctl", "-D", self.data, "-w", "stop"], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


NOW = datetime.now(timezone.utc).replace(microsecond=0)

# (uuid, zone node, minutes ago, A-leg spec, [B-leg specs]).
# Leg spec: status, grade, mos, loss %, jitter ms, inbound_media_ratio, answered.
def _leg(status, grade=None, mos=None, loss=None, jit=None, imr=None, answered=True):
    return dict(status=status, grade=grade, mos=mos, loss=loss, jit=jit, imr=imr, answered=answered)


CALLS = [
    ("c1", "fs-media-v2", 5, _leg("rated", "great", 4.41, 0.00, 1.9, 1.01), [_leg("rated", "good", 4.23, 2.00, 3.0, 1.0)]),
    ("c2", "west-fs", 5, _leg("rated", "great", 4.41, 0.00, 2.0, 0.45), []),
    ("c3", "central-fs", 6, _leg("rated", "fair", 3.92, 5.00, 8.0, 1.0), [_leg("rated", "great", 4.37, 0.50, 4.0, 1.0)]),
    ("c4", "fs-media-v2", 6, _leg("rated", "great", 4.41, 0.00, None, 1.0), [_leg("no_rtp", "poor", None, None, None, 0.0)]),
    ("c5", "fs-media-v2", 7, _leg("no_rtp", "poor", None, None, None, 0.02), []),
    ("c6", "fs-media-v2", 7, _leg("unanswered", answered=False), [_leg("unanswered", answered=False)]),
    ("c7", "west-fs", 8, _leg("short"), []),
    ("c8", "fs-media-v2", 8, _leg("rated", "poor", 2.63, 20.00, 60.0, 1.0), [_leg("low_sample", None, None, None, None, 0.30)]),
    ("c9", "fs-media-v2", 40, _leg("no_rtp", "poor", None, None, None, 0.0), []),
]


async def _insert_leg(conn, uuid, node, start, spec, leg, attempt, call_id):
    answer = start + timedelta(seconds=1) if spec["answered"] else None
    billable = 60000 if spec["answered"] and spec["status"] != "short" else (2000 if spec["answered"] else 0)
    await conn.execute(
        """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination, start_time, answer_time, end_time,
                             duration_ms, billable_ms, freeswitch_node, leg, call_id, leg_attempt,
                             quality_status, quality_grade, quality_source, mos, packet_loss_pct, jitter_avg_ms,
                             inbound_media_ratio, rtp_audio_in_packet_count)
           VALUES ($1, 101, 'rcf', $2, '+15555550100', $3, $4, $5, 61000, $6, $7, $8, $9, $10,
                   $11, $12, 'fs_patch_v1', $13::numeric, $14::numeric, $15::numeric, $16::numeric, 3000)""",
        uuid, "inbound" if leg == "A" else "outbound", start, answer, start + timedelta(seconds=61), billable, node,
        leg, call_id, attempt, spec["status"], spec["grade"], spec["mos"], spec["loss"], spec["jit"], spec["imr"])


@pytest.fixture(scope="module")
def pg():
    if not MIGRATION_50.is_file():
        pytest.skip("docker/postgres/init/50_cdr_quality_accuracy.sql not present yet (API/DB agent owns it)")
    if not PG_BIN:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    srv = _EphemeralPG(PG_BIN)
    try:
        srv.start()
    except Exception as e:  # pragma: no cover
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    async def setup():
        conn = await asyncpg.connect(host=srv.sock, port=srv.port, user="postgres", database="postgres")
        await conn.execute(_SCHEMA)
        await apply_cdr_column_migrations(conn, names=tuple(n for n in CDR_COLUMN_MIGRATIONS if not n.startswith("50_")))
        m50 = MIGRATION_50.read_text()
        await conn.execute(m50)
        await conn.execute(m50)  # idempotent replay
        for uuid, node, ago, a, bs in CALLS:
            start = NOW - timedelta(minutes=ago)
            await _insert_leg(conn, uuid, node, start, a, "A", None, uuid)
            for i, b in enumerate(bs, 1):
                await _insert_leg(conn, f"{uuid}-b{i}", node, start + timedelta(seconds=1), b, "B", i, uuid)
        for uuid, _node, ago, _a, _bs in CALLS:
            n = await conn.fetchval("SELECT cdr_refresh_call_quality($1::varchar, $2::timestamptz)",
                                    uuid, NOW - timedelta(minutes=ago))
            assert n == 1, f"refresh did not update A row {uuid}"
        return conn

    conn = _run(setup())
    yield conn
    _run(conn.close())
    srv.stop()


async def _as_grafana(conn, sql, explain=False):
    async with conn.transaction():
        await conn.execute("SET LOCAL ROLE grafana_ro")
        if explain:
            return await conn.fetch("EXPLAIN " + sql)
        return await conn.fetch(sql)


def _q(conn, dash, pid, ref="A", zone="%", explain=False):
    p = _panels(dash)[pid]
    t = next(t for t in p["targets"] if t["refId"] == ref)
    return _run(_as_grafana(conn, substitute(t["rawSql"], zone), explain))


def test_seed_call_level_columns_from_real_refresh(pg):
    rows = {r["uuid"]: r for r in _run(pg.fetch(
        "SELECT uuid, call_quality_status, call_quality_grade, call_mos, call_quality_leg FROM cdrs WHERE leg = 'A'"))}
    assert (rows["c1"]["call_quality_grade"], float(rows["c1"]["call_mos"]), rows["c1"]["call_quality_leg"]) == ("good", 4.23, "B")
    assert (rows["c4"]["call_quality_status"], rows["c4"]["call_quality_grade"], rows["c4"]["call_mos"]) == ("no_rtp", "poor", None)
    assert rows["c6"]["call_quality_grade"] is None and rows["c7"]["call_quality_grade"] is None


@pytest.mark.parametrize("name", DASHBOARDS)
def test_explain_every_cdrs_only_query(pg, name):
    explained = 0
    for p, t in _sql_targets(name):
        sql = t["rawSql"]
        if (t.get("datasource") or {}).get("uid") != "voip-cdr-pg" or not re.search(r"\bcdrs\b", sql):
            continue
        if not _relations(sql) <= {"cdrs"}:
            continue  # cdr_hourly_stats / carrier_trunk_health are not part of this scratch schema
        s = substitute(sql)
        assert "$" not in s.replace("$$", ""), f"{name} panel {p['id']}: unsubstituted macro in {s}"
        plan = _run(_as_grafana(pg, s, explain=True))
        assert plan, f"{name} panel {p['id']} produced no plan"
        explained += 1
    assert explained > 0 or name == "traffic-status.json"


def test_cq43_good_or_better_share_by_zone(pg):
    # 15m graded: c1 good, c2 great, c3 fair, c4/c5/c8 poor -> 2/6
    assert float(_q(pg, "call-quality.json", 43)[0]["good_or_better_pct"]) == pytest.approx(100 * 2 / 6)
    assert float(_q(pg, "call-quality.json", 43, zone="west")[0]["good_or_better_pct"]) == pytest.approx(100.0)
    assert float(_q(pg, "call-quality.json", 43, zone="central")[0]["good_or_better_pct"]) == pytest.approx(0.0)
    assert _q(pg, "noc-home.json", 30)[0]["good_or_better_pct"] == _q(pg, "call-quality.json", 43)[0]["good_or_better_pct"]


def test_cq12_call_mos_percentiles(pg):
    rows = _q(pg, "call-quality.json", 12)
    assert rows and list(rows[0].keys()) == ["time", "p50 call MOS", "p10 call MOS"]
    for r in rows:
        assert 1 <= r["p10 call MOS"] <= r["p50 call MOS"] <= 4.5
    # c4/c5/c9 (one-way) and c6/c7 (ungraded) have no call_mos -> never in the series
    total = _run(pg.fetchval("SELECT count(*) FROM cdrs WHERE leg='A' AND call_quality_status='rated' AND call_mos IS NOT NULL"))
    assert total == 4


def test_cq21_loss_p95_by_direction(pg):
    rows = _q(pg, "call-quality.json", 21)
    assert rows and list(rows[0].keys()) == ["time", "caller→platform p95", "callee→platform p95"]
    assert max(float(r["caller→platform p95"]) for r in rows if r["caller→platform p95"] is not None) <= 20.0
    assert any(r["callee→platform p95"] is not None for r in rows)  # B rows (c1, c3) are read


def test_cq20_jitter_by_direction(pg):
    rows = _q(pg, "call-quality.json", 20)
    assert rows and list(rows[0].keys()) == ["time", "caller→platform p50", "caller→platform p95",
                                             "callee→platform p50", "callee→platform p95"]


def test_cq11_grade_distribution(pg):
    rows = _q(pg, "call-quality.json", 11)
    assert [(r["band"], r["calls"]) for r in rows] == [
        ("Great", 1), ("Good", 1), ("Fair", 1), ("Poor (audio)", 1), ("One-way / no audio", 3)]
    # zone filter honoured; empty bands still render
    rows = _q(pg, "call-quality.json", 11, zone="central")
    assert [(r["band"], r["calls"]) for r in rows] == [
        ("Great", 0), ("Good", 0), ("Fair", 1), ("Poor (audio)", 0), ("One-way / no audio", 0)]


def test_cq13_loss_distribution(pg):
    rows = _q(pg, "call-quality.json", 13)
    got = [(r["band"], r["caller→platform"], r["callee→platform"]) for r in rows]
    # A rated: c1 0, c2 0, c3 5, c4 0, c8 20 · B rated: c1 2.0, c3 0.5
    assert got == [("0%", 3, 0), ("0–0.5%", 0, 0), ("0.5–1%", 0, 1), ("1–2%", 0, 0),
                   ("2–4%", 0, 1), ("4–8%", 1, 0), ("≥8%", 1, 0)]


def test_cq22_one_way_and_partial_media(pg):
    rows = _q(pg, "call-quality.json", 22, "A")
    assert list(rows[0].keys()) == ["time", "caller→platform silent", "callee→platform silent"]
    assert sum(r["caller→platform silent"] for r in rows) == 2   # c5, c9
    assert sum(r["callee→platform silent"] for r in rows) == 1   # c4's B
    rows = _q(pg, "call-quality.json", 22, "B")
    assert list(rows[0].keys()) == ["time", "partial inbound media"]
    assert sum(r["partial inbound media"] for r in rows) == 2    # c2 A (0.45) + c8 B low_sample (0.30)


def test_cq30_snapshot(pg):
    (r,) = _q(pg, "call-quality.json", 30)
    assert list(r.keys()) == ["Graded calls", "Good+ %", "Poor % (incl. one-way)", "p10 call MOS",
                              "One-way audio calls", "Not graded"]
    assert r["Graded calls"] == 7
    assert float(r["Good+ %"]) == pytest.approx(100 * 2 / 7)
    assert float(r["Poor % (incl. one-way)"]) == pytest.approx(100 * 4 / 7)
    assert r["p10 call MOS"] == pytest.approx(2.63 + 0.3 * (3.92 - 2.63))  # [2.63, 3.92, 4.23, 4.41]
    assert r["One-way audio calls"] == 3
    assert r["Not graded"] == 2


def test_noc_home_voice_row(pg):
    # 31: pooled rated legs in 15m: [0, 0, 0, 0.5, 2, 5, 20] -> p95 = 5 + 0.7*15
    assert _q(pg, "noc-home.json", 31)[0]["p95_loss_pct"] == pytest.approx(15.5)
    # 32: pooled rated jitter: [1.9, 2.0, 3.0, 4.0, 8.0, 60.0] -> p95 = 8 + 0.75*52
    assert _q(pg, "noc-home.json", 32)[0]["p95_jitter_ms"] == pytest.approx(47.0)
    # 33: one-way calls in the last hour: c4, c5, c9
    assert _q(pg, "noc-home.json", 33)[0]["one_way_calls"] == 3


def test_slos_voice_quality_sli_sql(pg):
    """infra/monitoring/SLOS.md "Voice quality SLI": both SQL blocks run and agree with the seed."""
    text = (REPO / "infra" / "monitoring" / "SLOS.md").read_text()
    section = text.split("## Voice quality SLI", 1)[1].split("\n## ", 1)[0]
    blocks = re.findall(r"```sql\n(.*?)```", section, re.S)
    assert len(blocks) == 2
    for sql in blocks:
        assert "leg IS DISTINCT FROM 'B'" in sql and not re.search(r"avg\(", sql, re.I)
    (sli1,) = _run(_as_grafana(pg, blocks[0].strip().rstrip(";")))
    assert float(sli1["good_or_better_pct"]) == pytest.approx(100 * 2 / 7)
    (sli2,) = _run(_as_grafana(pg, blocks[1].strip().rstrip(";")))
    # 3 one-way calls / 7 answered >= 5 s A rows (c1-c5, c8, c9)
    assert float(sli2["one_way_per_1000"]) == pytest.approx(1000 * 3 / 7)
