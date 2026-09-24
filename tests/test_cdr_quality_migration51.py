"""Migration 51 (docker/postgres/init/51_cdr_quality_no_media.sql) and its
one-off reclassification (docker/postgres/backfill/51_reclassify_no_media.psql)
against an ephemeral PostgreSQL 16 with migrations 23/47/48/50 applied first.

Covers:
  * 51 applies twice via the real `psql -f` (idempotent) on top of 50; the
    5-argument cq_leg_status exists and is granted; the 4-argument
    migration-50 function is unchanged;
  * the SQL literals mirror the ONE set of Python constants
    (NO_RTP_RATIO / ONE_WAY_MIN_OUT_RATIO);
  * Python/SQL PARITY of the 5-argument rule over a random grid + the exact
    production cases (0/0 -> no_media, 2/613 12 s -> no_rtp, 1863/397 902 s
    -> no_media);
  * reclassification: Jul-style no_rtp rows (0 in / 0 out, out NULL, both
    sides quiet) -> no_media with grade/MOS NULL, genuine one-way untouched,
    call-level fields recomputed via cdr_refresh_call_quality() (A leg and
    B leg cases), idempotent re-run (UPDATE 0, nothing changes), the
    documented EXACT rollback, abort without migration 51.

Run:  TEST_PG_BIN=/opt/homebrew/bin python3 -m pytest tests/test_cdr_quality_migration51.py -q
"""
import asyncio
import os
import random
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import call_quality as cq  # noqa: E402

INIT = REPO / "docker" / "postgres" / "init"
MIG51 = INIT / "51_cdr_quality_no_media.sql"
RECLASS = REPO / "docker" / "postgres" / "backfill" / "51_reclassify_no_media.psql"


def _code(path):
    return "\n".join(ln.split("--", 1)[0] for ln in path.read_text().splitlines())


# ---------------------------------------------------------------------------
# Static checks (no DB)
# ---------------------------------------------------------------------------
def test_migration_51_is_functions_comments_grants_only():
    code = _code(MIG51)
    assert not re.search(r"\bALTER\s+TABLE\b|\bDROP\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b", code, re.I)
    for m in re.finditer(r"\bCREATE\s+(OR\s+REPLACE\s+)?(\w+)", code, re.I):
        assert m.group(1) and m.group(2).upper() == "FUNCTION", m.group(0)
    # 50 is never edited by 51: the new function is an overload with 5 REQUIRED args
    assert re.search(r"cq_leg_status\(p_answered bool, p_billable_ms int, p_in_packets int,\s+"
                     r"p_ptime_ms int, p_out_packets int\)", code)
    assert not re.search(r"p_out_packets int DEFAULT", code, re.I)


def test_sql_thresholds_mirror_the_python_constants():
    code = _code(MIG51)
    body = code.split("CREATE OR REPLACE FUNCTION cq_leg_status", 1)[1].split("$$", 2)[1]
    assert f"p_in_packets < {cq.NO_RTP_RATIO:.2f} * p_billable_ms::float8 / p_ptime_ms" in body
    assert f"p_out_packets >= {cq.ONE_WAY_MIN_OUT_RATIO:.2f} * p_billable_ms::float8 / p_ptime_ms" in body
    assert f"< {cq.MIN_TALK_MS} THEN 'short'" in body and f"< {cq.MIN_PACKETS} THEN 'low_sample'" in body


def test_reclassify_lives_outside_init_is_autocommit_and_ring_fenced():
    assert RECLASS.parent.name == "backfill"
    code = "\n".join(ln for ln in RECLASS.read_text().splitlines()
                     if not ln.lstrip().startswith("--"))
    assert "\\set ON_ERROR_STOP on" in code
    assert not re.search(r"^\s*BEGIN\b", code, re.I | re.M)
    assert "timescaledb.max_tuples_decompressed_per_dml_transaction = 0" in code
    assert "timescaledb_information.chunks" in code and "\\gexec" in code
    for col in ("billable_ms", "rate_per_min", "total_cost", "carrier_cost", "margin",
                "rated_at", "exported_at", "duration_ms", "inbound_media_ratio",
                "packet_loss_pct", "quality_source"):
        assert not re.search(rf"\b{col}\s*=", code), col


# ---------------------------------------------------------------------------
# Ephemeral PostgreSQL
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg")

from cdr_schema import CDR_COLUMN_MIGRATIONS, apply_cdr_column_migrations  # noqa: E402
from test_tenant_redaction import _SCHEMA, _EphemeralPG, _find_pg_bin  # noqa: E402

PG_BIN = _find_pg_bin()
_SCHEMA_NO_ROLE = _SCHEMA.replace("CREATE ROLE api LOGIN PASSWORD 'api_secret';", "")
_PRE51 = tuple(n for n in CDR_COLUMN_MIGRATIONS if not n.startswith("51_"))


class _Q51PG(_EphemeralPG):
    def __init__(self, pg_bin):
        super().__init__(pg_bin)
        self.port = 55458     # distinct from every other module (50 = 55457)


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


def _psql(pg, db, *args, check=True):
    cmd = [str(Path(PG_BIN, "psql")), "-X", "-h", pg.sock, "-p", str(pg.port),
           "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=on", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


@pytest.fixture(scope="module")
def q51():
    if PG_BIN is None or not Path(PG_BIN, "psql").exists():
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _Q51PG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    state = {"pg": pg, "pools": {}}

    async def _mkdb(name):
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres")
        await owner.execute(f"CREATE DATABASE {name}")
        await owner.close()
        conn = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                     database=name)
        await conn.execute(_SCHEMA_NO_ROLE)
        await conn.execute("CREATE INDEX idx_cdrs_uuid ON cdrs(uuid)")
        await apply_cdr_column_migrations(conn, names=_PRE51)     # 23/47/48/50 only
        await conn.close()
        state["pools"][name] = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database=name,
            min_size=1, max_size=3, statement_cache_size=0)

    async def _setup():
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres")
        await owner.execute("CREATE ROLE api LOGIN PASSWORD 'api_secret'")
        await owner.execute("CREATE ROLE grafana_ro LOGIN")
        await owner.close()
        await _mkdb("q51")        # migration + parity
        await _mkdb("rc")         # reclassification
        await _mkdb("pre51")      # 50 only: the reclassify must refuse

    _run(_setup())
    for db in ("q51", "rc"):
        for _ in range(2):        # applies on top of 50, twice
            out = _psql(pg, db, "-f", str(MIG51))
            assert out.returncode == 0, out.stderr
    try:
        yield state
    finally:
        async def _teardown():
            for p in state["pools"].values():
                await p.close()
        _run(_teardown())
        pg.stop()


def test_migration_51_objects_and_grants(q51):
    async def go():
        pool = q51["pools"]["q51"]
        ok = await pool.fetchval(
            "SELECT has_function_privilege('api', 'cq_leg_status(bool,int,int,int,int)', 'EXECUTE') "
            "AND has_function_privilege('grafana_ro', 'cq_leg_status(bool,int,int,int,int)', 'EXECUTE')")
        assert ok
        # the migration-50 inbound-only gate is untouched (still 'no_rtp')
        assert await pool.fetchval("SELECT cq_leg_status(true, 60000, 0, 20)") == "no_rtp"
        assert await pool.fetchval("SELECT cq_leg_status(true, 60000, 0)") == "no_rtp"
        assert await pool.fetchval("SELECT cq_leg_status(true, 60000, 0, 20, NULL)") == "no_media"
        assert await pool.fetchval("SELECT cq_leg_status(true, 60000, 0, 20, 3000)") == "no_rtp"
        cmt = await pool.fetchval("SELECT col_description('cdrs'::regclass, "
                                  "(SELECT attnum FROM pg_attribute WHERE attrelid='cdrs'::regclass "
                                  "AND attname='quality_status'))")
        assert "no_media" in cmt
    _run(go())


def test_parity_leg_status_5arg_grid(q51):
    rnd = random.Random(51)
    cases = []
    for _ in range(5000):
        bms = rnd.choice([0, 999, 4999, 5000, 5001, 12_000, 60_000, 902_000, rnd.randint(0, 900_000)])
        pt = rnd.choice([10, 20, 30, 40, 60, 120])
        exp = bms // pt if pt else 0
        cases.append((rnd.random() < 0.85, bms,
                      rnd.choice([None, 0, 2, 24, 25, 249, 250, exp // 10, exp // 10 - 1,
                                  rnd.randint(0, 9000)]),
                      pt,
                      rnd.choice([None, 0, exp // 2, exp // 2 - 1, exp // 2 + 1, exp,
                                  rnd.randint(0, 50_000)])))
    # the production cases + exact edges of both gates
    cases += [(True, 60_000, 0, 20, 0), (True, 12_000, 2, 20, 613), (True, 902_000, 1863, 20, 397),
              (True, 45_000, 134, 20, 2204), (True, 60_000, 299, 20, 1500),
              (True, 60_000, 299, 20, 1499), (True, 60_000, 300, 20, 0), (True, 11_000, 0, 20, None)]

    async def go():
        return await q51["pools"]["q51"].fetch(
            "SELECT i, cq_leg_status(a, b, p, t, o) AS s FROM unnest($1::bool[], $2::int[], "
            "$3::int[], $4::int[], $5::int[]) WITH ORDINALITY AS x(a, b, p, t, o, i)",
            [c[0] for c in cases], [c[1] for c in cases], [c[2] for c in cases],
            [c[3] for c in cases], [c[4] for c in cases])

    rows = _run(go())
    assert len(rows) == len(cases)
    seen = set()
    for row in rows:
        a, b, p, t, o = cases[row["i"] - 1]
        py = cq.leg_status(a, b, p, t, o)
        assert row["s"] == py, (a, b, p, t, o)
        seen.add(py)
    assert {"no_rtp", "no_media", "rated", "low_sample", "short", "unanswered", "no_data"} <= seen
    by_case = {cases[r["i"] - 1]: r["s"] for r in rows}
    assert by_case[(True, 60_000, 0, 20, 0)] == "no_media"
    assert by_case[(True, 12_000, 2, 20, 613)] == "no_rtp"
    assert by_case[(True, 902_000, 1863, 20, 397)] == "no_media"


# ---------------------------------------------------------------------------
# Reclassification
# ---------------------------------------------------------------------------
T_JUL = datetime(2026, 7, 21, 15, 0, 0, tzinfo=timezone.utc)
T_SEP = datetime(2026, 9, 20, 12, 0, 0, tzinfo=timezone.utc)

# uuid, start, leg, call_id, billable_ms, in, out, status, grade, mos
_ROWS = [
    # Jul-style load-test call: A leg 0 in / 0 out, only leg -> call was no_rtp/poor
    ("jul-a1", T_JUL, "A", "jul-a1", 30_000, 0, 0, "no_rtp", "poor", None),
    # outbound count never recorded -> no_media
    ("jul-a2", T_JUL + timedelta(minutes=1), "A", "jul-a2", 30_000, 0, None, "no_rtp", "poor", None),
    # 902 s, both directions quiet (1863 in / 397 out) -> no_media
    ("quiet-a", T_JUL + timedelta(minutes=2), "A", "quiet-a", 902_000, 1863, 397, "no_rtp", "poor", None),
    # A rated great + a carrier B leg 0/0 that made the call no_rtp -> call great via A
    ("mix-a", T_JUL + timedelta(minutes=3), "A", "mix-a", 60_000, 3000, 3000, "rated", "great", 4.41),
    ("mix-b", T_JUL + timedelta(minutes=3, seconds=1), "B", "mix-a", 59_000, 0, 0, "no_rtp", "poor", None),
    # genuine one-way audio: stays no_rtp (in 2 / out 613, 12 s)
    ("ow-a", T_SEP, "A", "ow-a", 12_000, 2, 613, "no_rtp", "poor", None),
    # genuine one-way on the B leg; A rated -> call stays no_rtp
    ("owb-a", T_SEP + timedelta(minutes=1), "A", "owb-a", 45_000, 2250, 2250, "rated", "good", 4.23),
    ("owb-b", T_SEP + timedelta(minutes=1, seconds=1), "B", "owb-a", 44_000, 134, 2204, "no_rtp", "poor", None),
    # clean rated call: never touched
    ("clean-a", T_SEP + timedelta(minutes=2), "A", "clean-a", 60_000, 3000, 3000, "rated", "great", 4.41),
]


async def _seed(pool):
    for uuid, start, leg, call_id, bms, pin, pout, st, grade, mos in _ROWS:
        answer = start + timedelta(seconds=1)
        imr = cq.inbound_media_ratio(pin, bms)
        await pool.execute(
            """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
                   start_time, answer_time, end_time, billable_ms, duration_ms,
                   rtp_audio_in_packet_count, rtp_audio_out_packet_count,
                   leg, call_id, leg_attempt, quality_status, quality_grade, mos, r_factor,
                   quality_source, inbound_media_ratio, fs_mos, total_cost)
               VALUES ($1, 7, 'rcf', $2, '+1555', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15::numeric, $16::numeric, 'backfill_v1', $17::numeric,
                       4.50, 0.0123)""",
            uuid, "outbound" if leg == "B" else "inbound", start, answer,
            answer + timedelta(milliseconds=bms), bms, bms + 1000, pin, pout, leg, call_id,
            1 if leg == "B" else None, st, grade,
            None if mos is None else str(mos), None if mos is None else "93.20",
            None if imr is None else str(imr))
    for uuid, start, leg, *_ in _ROWS:
        if leg == "A":
            assert await pool.fetchval(
                "SELECT cdr_refresh_call_quality($1::varchar, $2::timestamptz)", uuid, start) == 1


async def _dump(pool):
    return {r["uuid"]: dict(r) for r in await pool.fetch("SELECT * FROM cdrs ORDER BY uuid")}


def _call(row):
    m = row["call_mos"]
    return (row["call_quality_status"], row["call_quality_grade"],
            None if m is None else float(m), row["call_quality_leg"])


def test_reclassify_run_rerun_and_exact_rollback(q51):
    pool = q51["pools"]["rc"]
    _run(_seed(pool))
    before = _run(_dump(pool))
    # the production pre-state: every seeded no_rtp call is "one-way"
    assert _call(before["jul-a1"]) == ("no_rtp", "poor", None, "A")
    assert _call(before["mix-a"]) == ("no_rtp", "poor", None, "B")

    out = _psql(q51["pg"], "rc", "-f", str(RECLASS))
    assert out.returncode == 0, out.stderr
    after = _run(_dump(pool))

    # --- per leg -------------------------------------------------------------
    for uuid in ("jul-a1", "jul-a2", "quiet-a", "mix-b"):
        r = after[uuid]
        assert (r["quality_status"], r["quality_grade"], r["mos"], r["r_factor"]) == (
            "no_media", None, None, None), uuid
        # nothing else on the row moved
        for col in ("inbound_media_ratio", "quality_source", "fs_mos", "billable_ms",
                    "total_cost", "rtp_audio_in_packet_count", "rtp_audio_out_packet_count"):
            assert r[col] == before[uuid][col], (uuid, col)
    for uuid in ("ow-a", "owb-b"):
        assert (after[uuid]["quality_status"], after[uuid]["quality_grade"]) == ("no_rtp", "poor")
    assert after["clean-a"] == before["clean-a"]
    assert after["owb-a"] == before["owb-a"]
    assert after["ow-a"] == before["ow-a"]

    # --- call level, recomputed by the real cdr_refresh_call_quality() ---------
    assert _call(after["jul-a1"]) == ("no_media", None, None, None)      # not graded
    assert _call(after["jul-a2"]) == ("no_media", None, None, None)
    assert _call(after["quiet-a"]) == ("no_media", None, None, None)
    assert _call(after["mix-a"]) == ("rated", "great", 4.41, "A")       # B no longer one-way
    assert _call(after["owb-a"]) == ("no_rtp", "poor", None, "B")       # true one-way stays
    assert after["mix-b"]["call_quality_status"] is None                # B rows never get call_*

    # the Python model agrees with the reclassified legs on the same inputs
    for uuid, _s, _l, _c, bms, pin, pout, *_ in _ROWS:
        if uuid in ("jul-a1", "jul-a2", "quiet-a", "mix-b", "ow-a", "owb-b"):
            v = {"rtp_audio_in_packet_count": str(pin), "rtp_audio_in_jitter_loss_rate": "0"}
            if pout is not None:
                v["rtp_audio_out_packet_count"] = str(pout)
            assert cq.assess_leg(v, answered=True, billable_ms=bms)["quality_status"] == \
                after[uuid]["quality_status"], uuid

    snap = _run(pool.fetch("SELECT uuid, is_a, reclassified FROM cdr_quality_reclass_51_snapshot"))
    assert {r["uuid"]: (r["is_a"], r["reclassified"]) for r in snap} == {
        "jul-a1": (True, True), "jul-a2": (True, True), "quiet-a": (True, True),
        "mix-b": (False, True), "mix-a": (True, False)}
    assert "legs_reclassified" in out.stdout and "call_rows_refreshed" in out.stdout
    assert re.search(r"no_media\s*\|\s*4\b", out.stdout) and re.search(r"no_rtp\s*\|\s*2\b", out.stdout)
    marker = _run(pool.fetchval(
        "SELECT count(*) FROM data_migrations WHERE migration_id = '51_reclassify_no_media'"))
    assert marker == 1

    # --- idempotent re-run -------------------------------------------------------
    out = _psql(q51["pg"], "rc", "-f", str(RECLASS))
    assert out.returncode == 0, out.stderr
    assert "UPDATE 0" in out.stdout and "INSERT 0 0" in out.stdout
    assert _run(_dump(pool)) == after

    # --- the documented EXACT rollback (verbatim from the header) ---------------
    m = re.search(r'^--\s+hostname \| grep -q .\^services\$. && sudo -u postgres psql -d voip '
                  r'-v ON_ERROR_STOP=on -c "(?P<sql>[^"]+)"', RECLASS.read_text(), re.M)
    assert m, "rollback command not found in the reclassify header"
    out = _psql(q51["pg"], "rc", "-c", m.group("sql"))
    assert out.returncode == 0, out.stderr
    assert _run(_dump(pool)) == before, "rollback must restore every row exactly"
    out = _psql(q51["pg"], "rc", "-c", m.group("sql"))       # re-runnable
    assert out.returncode == 0 and _run(_dump(pool)) == before

    # --- and it can be re-applied after a rollback ------------------------------
    out = _psql(q51["pg"], "rc", "-f", str(RECLASS))
    assert out.returncode == 0, out.stderr
    assert _run(_dump(pool)) == after


def test_reclassify_aborts_without_migration_51(q51):
    out = _psql(q51["pg"], "pre51", "-f", str(RECLASS), check=False)
    assert out.returncode != 0
    assert "migration 51 not applied" in out.stderr
    n = _run(q51["pools"]["pre51"].fetchval(
        "SELECT count(*) FROM pg_tables WHERE tablename = 'cdr_quality_reclass_51_snapshot'"))
    assert n == 0






