"""Migration 50 (docker/postgres/init/50_cdr_quality_accuracy.sql), its
backfill (docker/postgres/backfill/50_cdr_quality_backfill.psql) and the
media_guard.sh watchdog — against an ephemeral PostgreSQL 16 (no TimescaleDB:
the backfill's `\\if has_ts` branch runs in production only; its per-chunk
statement is the same UPDATE body the plain branch runs here).

Covers (plan §G.1):
  * 50 applies twice via asyncpg AND twice via the real `psql -f` (idempotent);
  * Python/SQL PARITY: 10,000 random (loss, burst, codec) ->
    round(cq_mos(cq_r_factor()),2) / round(cq_r_factor(),2) / cq_grade equal
    to services/call_quality.py; cq_leg_status over a random grid; cq_grade
    over every 2-dp MOS;
  * cdr_refresh_call_quality(): A-only, A+B in both insert orders, B no_rtp,
    two B attempts (only the answered one), B before A (0 then correct),
    idempotent re-run;
  * backfill: only quality_source IS NULL rows touched, second run changes
    nothing, snapshot populated, fs_mos = old mos, unanswered mos NULL,
    legacy rated loss_rate 0.02 -> 2.00 / 4.23, the documented EXACT rollback;
  * media_guard.sh: bash -n (+ shellcheck when installed), --dry-run pages
    exactly one line for 3 no_rtp A rows, silent exit 0 without the column.

Run:  TEST_PG_BIN=/opt/homebrew/bin python3 -m pytest tests/test_cdr_quality_migration50.py -q
"""
import asyncio
import os
import random
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import call_quality as cq  # noqa: E402

INIT = REPO / "docker" / "postgres" / "init"
MIG50 = INIT / "50_cdr_quality_accuracy.sql"
BACKFILL = REPO / "docker" / "postgres" / "backfill" / "50_cdr_quality_backfill.psql"
MEDIA_GUARD = REPO / "scripts" / "backup" / "media_guard.sh"


# ---------------------------------------------------------------------------
# Static checks (no DB)
# ---------------------------------------------------------------------------
def test_migration_form_is_additive_only():
    code = "\n".join(ln.split("--", 1)[0] for ln in MIG50.read_text().splitlines())
    assert not re.search(r"\bDROP\s+COLUMN\b", code, re.I)
    for add in re.findall(r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([^,;]+)", code, re.I):
        assert not re.search(r"\bNOT\s+NULL\b|\bDEFAULT\b", add, re.I), add
    assert len(re.findall(r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS", code, re.I)) == 17
    assert not re.search(r"\bDEFAULT\b(?!\s+(0|25\.1|20)\b)", code, re.I), \
        "only function-argument defaults are allowed (no column DEFAULT)"
    assert not re.search(r"\bCHECK\b", code, re.I)
    assert not re.search(r"\bCREATE\s+(UNIQUE\s+)?INDEX\b", code, re.I)
    # every non-cdrs object is a CREATE OR REPLACE FUNCTION
    for m in re.finditer(r"\bCREATE\s+(OR\s+REPLACE\s+)?(\w+)", code, re.I):
        assert m.group(1) and m.group(2).upper() == "FUNCTION", m.group(0)


def test_backfill_lives_outside_init_and_is_autocommit():
    assert BACKFILL.parent.name == "backfill"
    txt = BACKFILL.read_text()
    code = "\n".join(ln for ln in txt.splitlines() if not ln.lstrip().startswith("--"))
    assert "\\set ON_ERROR_STOP on" in code
    assert not re.search(r"^\s*BEGIN\b", code, re.I | re.M)
    assert "timescaledb.max_tuples_decompressed_per_dml_transaction = 0" in code
    assert "timescaledb_information.chunks" in code and "\\gexec" in code
    # ring-fenced: never writes billing/rating columns
    for col in ("billable_ms", "rate_per_min", "total_cost", "carrier_cost",
                "margin", "rated_at", "exported_at", "duration_ms"):
        assert not re.search(rf"\b{col}\s*=", code), col


# ---------------------------------------------------------------------------
# Ephemeral PostgreSQL
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg")

from cdr_schema import apply_cdr_column_migrations  # noqa: E402
from test_tenant_redaction import _SCHEMA, _EphemeralPG, _find_pg_bin  # noqa: E402

PG_BIN = _find_pg_bin()
_SCHEMA_NO_ROLE = _SCHEMA.replace("CREATE ROLE api LOGIN PASSWORD 'api_secret';", "")


class _Q50PG(_EphemeralPG):
    def __init__(self, pg_bin):
        super().__init__(pg_bin)
        self.port = 55457     # distinct from every other module


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


def _psql(pg, db, *args, check=True, env=None):
    cmd = [str(Path(PG_BIN, "psql")), "-X", "-h", pg.sock, "-p", str(pg.port),
           "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=on", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check, env=env)


@pytest.fixture(scope="module")
def q50():
    if PG_BIN is None or not Path(PG_BIN, "psql").exists():
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _Q50PG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    state = {"pg": pg, "pools": {}}

    async def _mkdb(name, *, with_50=True):
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres")
        await owner.execute(f"CREATE DATABASE {name}")
        await owner.close()
        conn = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                     database=name)
        await conn.execute(_SCHEMA_NO_ROLE)
        await conn.execute("CREATE INDEX idx_cdrs_uuid ON cdrs(uuid)")
        names = None if with_50 else ("23_onnet_cdr_columns.sql", "47_cdr_stir_outcome.sql",
                                      "48_cdr_call_legs.sql")
        if names:
            await apply_cdr_column_migrations(conn, names=names)
        else:
            await apply_cdr_column_migrations(conn)          # 23/47/48/50, twice
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
        await _mkdb("q50")        # parity + refresh
        await _mkdb("bf")         # backfill (own history)
        await _mkdb("mg")         # media guard
        await _mkdb("mgold", with_50=False)

    _run(_setup())
    try:
        yield state
    finally:
        async def _teardown():
            for p in state["pools"].values():
                await p.close()
        _run(_teardown())
        pg.stop()


def test_migration_50_replays_via_psql_twice(q50):
    for _ in range(2):
        out = _psql(q50["pg"], "q50", "-f", str(MIG50))
        assert out.returncode == 0, out.stderr

    async def go():
        pool = q50["pools"]["q50"]
        cols = await pool.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name='cdrs' "
            "AND column_name = ANY($1::text[])", list(cq.LEG_QUALITY_KEYS) + [
                "call_quality_status", "call_quality_grade", "call_mos", "call_quality_leg"])
        assert len(cols) == len(cq.LEG_QUALITY_KEYS) + 4 == 25
        # plan H verify commands
        r = await pool.fetchrow("SELECT round(cq_mos(cq_r_factor(0,1))::numeric,2) a, "
                                "round(cq_mos(cq_r_factor(1,1))::numeric,2) b")
        assert (str(r["a"]), str(r["b"])) == ("4.41", "4.33")
        n = await pool.fetchval(
            "SELECT count(*) FROM information_schema.columns WHERE table_name='cdrs' AND "
            "column_name IN ('quality_status','quality_grade','quality_source',"
            "'call_quality_grade','call_mos')")
        assert n == 5
        # grants reached the roles
        ok = await pool.fetchval(
            "SELECT has_function_privilege('api', 'cdr_refresh_call_quality(varchar, timestamptz)', 'EXECUTE') "
            "AND has_function_privilege('grafana_ro', 'cq_mos(float8)', 'EXECUTE') "
            "AND has_table_privilege('grafana_ro', 'cdrs', 'SELECT')")
        assert ok
    _run(go())


# ---------------------------------------------------------------------------
# Python / SQL parity
# ---------------------------------------------------------------------------
def test_parity_model_10000_random(q50):
    rnd = random.Random(20260924)
    n = 10_000
    loss, burst, ie, bpl = [], [], [], []
    for _ in range(n):
        loss.append(rnd.choice([rnd.uniform(0, 100), rnd.uniform(0, 5), rnd.uniform(0, 12),
                                round(rnd.uniform(0, 20), 2), float(rnd.randint(0, 100)),
                                rnd.uniform(-5, 0), rnd.uniform(100, 150)]))
        burst.append(rnd.choice([1.0, rnd.uniform(0.2, 14), rnd.uniform(1, 3),
                                 round(rnd.uniform(1, 10), 3)]))
        codec = rnd.choice(["PCMU", "PCMA", "G729", "OPUS"])
        i, b = cq.codec_params(codec)
        ie.append(i)
        bpl.append(b)

    async def go():
        return await q50["pools"]["q50"].fetch(
            """SELECT i, cq_r_factor(l, b, e, p) AS r,
                      round(cq_r_factor(l, b, e, p)::numeric, 2)::text AS r2,
                      round(cq_mos(cq_r_factor(l, b, e, p))::numeric, 2)::text AS m2,
                      cq_grade(round(cq_mos(cq_r_factor(l, b, e, p))::numeric, 2)) AS g
                 FROM unnest($1::float8[], $2::float8[], $3::float8[], $4::float8[])
                      WITH ORDINALITY AS t(l, b, e, p, i)""", loss, burst, ie, bpl)

    rows = _run(go())
    assert len(rows) == n
    bad = []
    for row in rows:
        k = row["i"] - 1
        r = cq.r_factor(loss[k], burst[k], ie[k], bpl[k])
        m = cq.round_half_up(cq.mos_from_r(r), 2)
        py = (r, Decimal(repr(cq.round_half_up(r, 2))), Decimal(repr(m)), cq.grade_for_mos(m))
        sq = (row["r"], Decimal(row["r2"]), Decimal(row["m2"]), row["g"])
        if py != sq:
            bad.append((loss[k], burst[k], ie[k], bpl[k], py, sq))
    assert not bad, bad[:5]


def test_parity_leg_status_grid(q50):
    rnd = random.Random(7)
    cases = []
    for _ in range(4000):
        cases.append((rnd.random() < 0.85,
                      rnd.choice([0, 999, 4999, 5000, 5001, rnd.randint(0, 200_000)]),
                      rnd.choice([None, 0, 24, 25, 249, 250, rnd.randint(0, 9000)]),
                      rnd.choice([10, 20, 30, 40, 60, 120])))
    # exact edges of rule 4 (10% of expected)
    cases += [(True, 60_000, 299, 20), (True, 60_000, 300, 20), (True, 5_000, 25, 20),
              (True, 5_000, 24, 20), (True, 11_000, 0, 20), (False, 0, None, 20)]

    async def go():
        return await q50["pools"]["q50"].fetch(
            "SELECT i, cq_leg_status(a, b, p, t) AS s FROM unnest($1::bool[], $2::int[], "
            "$3::int[], $4::int[]) WITH ORDINALITY AS x(a, b, p, t, i)",
            [c[0] for c in cases], [c[1] for c in cases], [c[2] for c in cases],
            [c[3] for c in cases])

    # The migration-50 4-argument function is the inbound-only gate: its
    # no_rtp covers both statuses the current (migration-51) rule splits it
    # into — the 5-argument parity lives in tests/test_cdr_quality_migration51.py.
    for row in _run(go()):
        a, b, p, t = cases[row["i"] - 1]
        py = cq.leg_status(a, b, p, t)
        assert row["s"] == ("no_rtp" if py == cq.STATUS_NO_MEDIA else py), (a, b, p, t)


def test_parity_grade_every_2dp_mos(q50):
    vals = [Decimal(i) / 100 for i in range(100, 451)]

    async def go():
        return await q50["pools"]["q50"].fetch(
            "SELECT m::text AS m, cq_grade(m) AS g, cq_grade_rank(cq_grade(m)) AS rk "
            "FROM unnest($1::numeric[]) AS t(m)", vals)

    for row in _run(go()):
        g = cq.grade_for_mos(Decimal(row["m"]))
        assert row["g"] == g, row["m"]
        assert row["rk"] == cq.grade_rank(g)
    assert _run(q50["pools"]["q50"].fetchval("SELECT cq_grade(NULL)")) is None


# ---------------------------------------------------------------------------
# cdr_refresh_call_quality()
# ---------------------------------------------------------------------------
T0 = datetime(2026, 9, 20, 12, 0, 0, tzinfo=timezone.utc)


async def _ins(pool, uuid, *, leg, call_id, attempt=None, start=T0, answered=True,
               talk_s=60, status="rated", grade="great", mos=4.41):
    answer = start + timedelta(seconds=3) if answered else None
    end = start + timedelta(seconds=3 + talk_s)
    await pool.execute(
        """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
               start_time, answer_time, end_time, leg, call_id, leg_attempt,
               quality_status, quality_grade, mos, quality_source)
           VALUES ($1, 7, 'rcf', 'inbound', '+15550000000', $2, $3, $4, $5, $6, $7,
                   $8, $9, $10, 'fs_patch_v1')""",
        uuid, start, answer, end, leg, call_id, attempt, status, grade, mos)


async def _refresh(pool, call_id, anchor):
    return await pool.fetchval("SELECT cdr_refresh_call_quality($1::varchar, $2::timestamptz)",
                               call_id, anchor)


async def _call(pool, uuid):
    r = await pool.fetchrow("SELECT call_quality_status s, call_quality_grade g, call_mos m, "
                            "call_quality_leg l FROM cdrs WHERE uuid = $1", uuid)
    return (r["s"], r["g"], None if r["m"] is None else float(r["m"]), r["l"])


def test_refresh_a_only(q50):
    async def go():
        pool = q50["pools"]["q50"]
        await _ins(pool, "ra-1", leg="A", call_id="ra-1")
        assert await _refresh(pool, "ra-1", T0) == 1
        assert await _call(pool, "ra-1") == ("rated", "great", 4.41, "A")
        # ungraded A only -> the A status, no grade
        await _ins(pool, "ra-2", leg="A", call_id="ra-2", talk_s=2, status="short",
                   grade=None, mos=None)
        assert await _refresh(pool, "ra-2", T0) == 1
        assert await _call(pool, "ra-2") == ("short", None, None, None)
        # unknown call -> 0 rows
        assert await _refresh(pool, "nope", T0) == 0
    _run(go())


@pytest.mark.parametrize("order", ["A_then_B", "B_then_A"])
def test_refresh_b_loss_makes_call_worse_either_order(q50, order):
    a, b = f"rab-{order}", f"rab-{order}-b1"

    async def go():
        pool = q50["pools"]["q50"]
        steps = [("A", a), ("B", b)] if order == "A_then_B" else [("B", b), ("A", a)]
        results = []
        for leg, uuid in steps:
            if leg == "A":
                await _ins(pool, a, leg="A", call_id=a)
            else:
                await _ins(pool, b, leg="B", call_id=a, attempt=1, start=T0 + timedelta(seconds=1),
                           status="rated", grade="fair", mos=3.92)
            results.append(await _refresh(pool, a, T0 if leg == "A" else T0 + timedelta(seconds=1)))
        if order == "B_then_A":
            assert results == [0, 1]      # B before A: nothing to update yet
        else:
            assert results == [1, 1]
        assert await _call(pool, a) == ("rated", "fair", 3.92, "B")
        # idempotent re-run
        assert await _refresh(pool, a, T0) == 1
        assert await _call(pool, a) == ("rated", "fair", 3.92, "B")
    _run(go())


def test_refresh_b_no_rtp_makes_call_no_rtp(q50):
    async def go():
        pool = q50["pools"]["q50"]
        await _ins(pool, "rn-1", leg="A", call_id="rn-1")
        await _ins(pool, "rn-1-b", leg="B", call_id="rn-1", attempt=1,
                   start=T0 + timedelta(seconds=1), status="no_rtp", grade="poor", mos=None)
        await _refresh(pool, "rn-1", T0 + timedelta(seconds=1))
        assert await _call(pool, "rn-1") == ("no_rtp", "poor", None, "B")
    _run(go())


def test_refresh_only_the_answered_b_attempt_counts(q50):
    async def go():
        pool = q50["pools"]["q50"]
        await _ins(pool, "r2-1", leg="A", call_id="r2-1", grade="good", mos=4.20)
        # attempt 1 failed (unanswered) — must be ignored even though "worse"
        await _ins(pool, "r2-1-b1", leg="B", call_id="r2-1", attempt=1,
                   start=T0 + timedelta(seconds=1), answered=False, status="unanswered",
                   grade="poor", mos=None)
        await _ins(pool, "r2-1-b2", leg="B", call_id="r2-1", attempt=2,
                   start=T0 + timedelta(seconds=12), status="rated", grade="great", mos=4.41)
        await _refresh(pool, "r2-1", T0 + timedelta(seconds=12))
        assert await _call(pool, "r2-1") == ("rated", "good", 4.20, "A")
    _run(go())


def test_refresh_ignores_b_rows_of_other_calls_and_out_of_window(q50):
    async def go():
        pool = q50["pools"]["q50"]
        await _ins(pool, "rw-1", leg="A", call_id="rw-1", talk_s=30)
        # a B row whose start is after A.end + 1 minute is not this call's leg
        await _ins(pool, "rw-1-late", leg="B", call_id="rw-1", attempt=1,
                   start=T0 + timedelta(minutes=5), status="no_rtp", grade="poor", mos=None)
        await _refresh(pool, "rw-1", T0)
        assert await _call(pool, "rw-1") == ("rated", "great", 4.41, "A")
    _run(go())


# ---------------------------------------------------------------------------
# Backfill (plain-PG branch) + exact rollback
# ---------------------------------------------------------------------------
_OLD_ROWS = [
    # uuid, answered, billable_ms, pkts, loss_rate, old mos, old pl_count, old jmax, codec, leg, call_id
    ("bf-rated", True, 60_000, 3000, "0.0200", "4.50", 7, "3.300", "PCMU", "A", "bf-rated"),
    ("bf-unans", False, 0, 0, "0.0000", "4.50", 0, "0.000", "PCMU", "A", "bf-unans"),
    ("bf-short", True, 900, 45, "0.0000", "4.50", 0, "1.000", "PCMU", "A", "bf-short"),
    ("bf-oneway", True, 11_000, 0, None, "4.50", 0, None, "PCMU", "A", "bf-oneway"),
    ("bf-g729", True, 60_000, 3000, "0.0000", "4.10", 0, "2.000", "G729", "A", "bf-g729"),
    ("bf-noloss", True, 60_000, 3000, None, "4.40", 0, "2.000", "PCMU", "A", "bf-noloss"),
    ("bf-legacy", True, 60_000, 3000, "0.0100", "4.45", 3, "5.000", "PCMU", None, None),
    ("bf-b", True, 55_000, 2750, "0.0500", "4.30", 9, "4.000", "PCMU", "B", "bf-rated"),
]
_SNAPSHOT_COLS = ("mos", "quality_pct", "r_factor", "packet_loss_pct", "packet_loss_count",
                  "jitter_min_ms", "jitter_max_ms", "jitter_avg_ms")


async def _seed_backfill(pool):
    for (uuid, answered, bms, pkts, lr, mos, plc, jmax, codec, leg, call_id) in _OLD_ROWS:
        start = T0 + (timedelta(seconds=1) if leg == "B" else timedelta(0))
        await pool.execute(
            """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
                   start_time, answer_time, end_time, billable_ms, rtp_audio_in_packet_count,
                   rtp_audio_in_jitter_loss_rate, mos, quality_pct, r_factor,
                   packet_loss_count, packet_loss_pct, jitter_min_ms, jitter_max_ms,
                   jitter_avg_ms, read_codec, leg, call_id, leg_attempt)
               VALUES ($1, 7, 'rcf', 'inbound', '+1555', $2, $3, $4, $5, $6, $7::numeric,
                       $8::numeric, 97.5, 93, $9, 1.2, 0.5, $10::numeric, 2.0, $11, $12, $13, $14)""",
            uuid, start, (start + timedelta(seconds=2)) if answered else None,
            start + timedelta(seconds=2 + bms / 1000), bms, pkts, lr, mos, plc, jmax, codec,
            leg, call_id, 1 if leg == "B" else None)
    # a NEW-API row: must never be touched by the backfill
    await pool.execute(
        """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
               start_time, answer_time, end_time, billable_ms, mos, quality_status,
               quality_grade, quality_source, leg, call_id,
               call_quality_status, call_quality_grade, call_mos, call_quality_leg)
           VALUES ('bf-new', 7, 'rcf', 'inbound', '+1555', $1::timestamptz, $1::timestamptz, $1::timestamptz + interval '1 minute',
                   60000, 4.41, 'rated', 'great', 'fs_patch_v1', 'A', 'bf-new',
                   'rated', 'great', 4.41, 'A')""", T0)


async def _dump(pool):
    rows = await pool.fetch("SELECT * FROM cdrs ORDER BY uuid")
    return {r["uuid"]: dict(r) for r in rows}


def test_backfill_run_rerun_and_exact_rollback(q50):
    pool = q50["pools"]["bf"]
    _run(_seed_backfill(pool))
    before = _run(_dump(pool))

    out = _psql(q50["pg"], "bf", "-f", str(BACKFILL))
    assert out.returncode == 0, out.stderr
    after1 = _run(_dump(pool))

    # only quality_source IS NULL rows touched; the new-API row is byte-identical
    assert after1["bf-new"] == before["bf-new"]
    for uuid, row in after1.items():
        if uuid != "bf-new":
            assert row["quality_source"] == "backfill_v1", uuid
    # snapshot populated with the OLD values
    snap = {r["uuid"]: dict(r) for r in _run(pool.fetch(
        "SELECT * FROM cdr_quality_backfill_50_snapshot"))}
    assert set(snap) == {r[0] for r in _OLD_ROWS}
    for uuid, s in snap.items():
        for col in _SNAPSHOT_COLS:
            assert s[col] == before[uuid][col], (uuid, col)

    r = after1["bf-rated"]
    assert r["fs_mos"] == Decimal("4.50")                 # fs_mos = old mos
    assert r["fs_quality_pct"] == Decimal("97.50")
    assert r["fs_jitter_max_std_ms"] == Decimal("3.300")
    assert r["rtp_audio_in_skip_packet_count"] == 7        # old packet_loss_count
    assert r["quality_status"] == "rated"
    assert r["packet_loss_pct"] == Decimal("2.00")
    assert r["mos"] == Decimal("4.23") and r["r_factor"] == Decimal("86.19")
    assert r["quality_grade"] == "good" and r["packet_loss_count"] == 60
    assert r["burst_ratio"] == Decimal("1.000") and r["inbound_media_ratio"] == Decimal("1.000")
    assert r["quality_pct"] is None and r["jitter_min_ms"] is None
    assert r["jitter_max_ms"] is None and r["jitter_avg_ms"] is None
    # the backfilled row agrees with the live Python legacy model on the same inputs
    py = cq.assess_leg({"rtp_audio_in_packet_count": "3000",
                        "rtp_audio_in_jitter_loss_rate": "0.0200", "read_codec": "PCMU"},
                       answered=True, billable_ms=60_000)
    assert (py["mos"], py["r_factor"], py["packet_loss_pct"], py["packet_loss_count"]) == (
        4.23, 86.19, 2.0, 60)
    # call level: A great? no — A is good (2% loss); B (5% loss) is fair -> call fair via B
    assert r["call_quality_status"] == "rated"
    assert r["call_quality_grade"] == "fair" and r["call_quality_leg"] == "B"
    assert r["call_mos"] == Decimal("3.92")

    u = after1["bf-unans"]
    assert u["quality_status"] == "unanswered" and u["mos"] is None and u["quality_grade"] is None
    assert u["fs_mos"] == Decimal("4.50")
    assert after1["bf-short"]["quality_status"] == "short" and after1["bf-short"]["mos"] is None
    ow = after1["bf-oneway"]
    assert (ow["quality_status"], ow["quality_grade"], ow["mos"]) == ("no_rtp", "poor", None)
    assert ow["call_quality_status"] == "no_rtp" and ow["call_mos"] is None
    assert after1["bf-g729"]["mos"] == Decimal("4.10")
    assert after1["bf-noloss"]["quality_status"] == "no_data" and after1["bf-noloss"]["mos"] is None
    lg = after1["bf-legacy"]                 # pre-48 row (leg NULL) is an A row too
    assert lg["mos"] == Decimal("4.33") and lg["call_quality_grade"] == "good"
    assert after1["bf-b"]["call_quality_status"] is None   # B rows never get call_*
    marker = _run(pool.fetchval(
        "SELECT count(*) FROM data_migrations WHERE migration_id = '50_cdr_quality_backfill'"))
    assert marker == 1

    # second run changes NOTHING
    out = _psql(q50["pg"], "bf", "-f", str(BACKFILL))
    assert out.returncode == 0, out.stderr
    assert "UPDATE 0" in out.stdout
    assert _run(_dump(pool)) == after1

    # the documented EXACT rollback (extracted verbatim from the file header)
    m = re.search(r'^--\s+hostname \| grep -q .\^services\$. && sudo -u postgres psql -d voip '
                  r'-v ON_ERROR_STOP=on -c "(?P<sql>[^"]+)"', BACKFILL.read_text(), re.M)
    assert m, "rollback command not found in the backfill header"
    out = _psql(q50["pg"], "bf", "-c", m.group("sql"))
    assert out.returncode == 0, out.stderr
    restored = _run(_dump(pool))
    assert restored == before, "rollback must restore every row exactly"


def test_backfill_aborts_without_migration_50(q50):
    out = _psql(q50["pg"], "mgold", "-f", str(BACKFILL), check=False)
    assert out.returncode != 0
    assert "migration 50 not applied" in out.stderr


# ---------------------------------------------------------------------------
# media_guard.sh
# ---------------------------------------------------------------------------
def test_media_guard_bash_syntax_and_shellcheck():
    subprocess.run(["bash", "-n", str(MEDIA_GUARD)], check=True)
    sc = shutil.which("shellcheck")
    if sc:
        subprocess.run([sc, "-S", "warning", str(MEDIA_GUARD)], check=True)
    txt = MEDIA_GUARD.read_text()
    assert "leg IS DISTINCT FROM 'B'" in txt
    assert "column_name = 'call_quality_status'" in txt
    units = REPO / "scripts" / "backup" / "systemd"
    svc = (units / "revup-media-guard.service").read_text()
    assert "OnFailure=revup-alert@%p.service" in svc and "User=postgres" in svc
    assert "OnCalendar=*:0/10" in (units / "revup-media-guard.timer").read_text()
    inst = (REPO / "scripts" / "backup" / "install_backup_timers.sh").read_text()
    assert "revup-media-guard.timer" in inst and "media_guard.sh" in inst


def _guard(q50, db, *args, **env_extra):
    pg = q50["pg"]
    env = dict(os.environ, PGHOST=pg.sock, PGPORT=str(pg.port), PGUSER="postgres",
               BACKUP_DB=db, MEDIA_GUARD_SKIP_SUDO="1",
               PATH=f"{PG_BIN}:{os.environ.get('PATH', '')}", **env_extra)
    return subprocess.run(["bash", str(MEDIA_GUARD), *args], capture_output=True,
                          text=True, env=env)


def test_media_guard_pages_one_line_on_one_way_spike(q50):
    pool = q50["pools"]["mg"]
    now = datetime.now(timezone.utc)

    async def seed():
        for i in range(3):
            await pool.execute(
                """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
                       start_time, answer_time, end_time, leg, call_id, call_quality_status,
                       inbound_carrier, inbound_carrier_pop)
                   VALUES ($1, 7, 'rcf', 'inbound', '+1555', $2, $2, $3, 'A', $1, 'no_rtp',
                           $4, $5)""",
                f"mg-{i}", now - timedelta(minutes=5), now - timedelta(minutes=4),
                "sinch" if i == 0 else None, "denver" if i == 0 else None)
        # a no_rtp B row must never be counted (one row per call)
        await pool.execute(
            """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
                   start_time, end_time, leg, call_id, call_quality_status)
               VALUES ('mg-b', 7, 'rcf', 'outbound', '+1555', $1, $1, 'B', 'mg-0', 'no_rtp')""",
            now - timedelta(minutes=5))
        for i in range(7):
            await pool.execute(
                """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination,
                       start_time, answer_time, end_time, leg, call_id, call_quality_status)
                   VALUES ($1, 7, 'rcf', 'inbound', '+1555', $2, $2, $3, 'A', $1, 'rated')""",
                f"mg-ok-{i}", now - timedelta(minutes=6), now - timedelta(minutes=3))
    _run(seed())

    out = _guard(q50, "mg", "--dry-run")
    assert out.returncode == 0, out.stderr
    lines = [ln for ln in out.stdout.splitlines() if ln.strip()]
    assert len(lines) == 1, out.stdout
    assert lines[0] == (
        "one-way-audio calls=3/10 window=30m carriers=bandwidth/-,sinch/denver — check media "
        "path (Cloud NAT/bypass-vpn, SDP c=, RTPs source IP) + Homer")

    # below the MIN_CALLS floor -> no page
    out = _guard(q50, "mg", "--dry-run", MEDIA_GUARD_MIN_CALLS="4")
    assert out.returncode == 0 and out.stdout.strip() == ""
    # share below the floor -> no page (3/10 = 30% < 40%)
    out = _guard(q50, "mg", "--dry-run", MEDIA_GUARD_MIN_SHARE_PCT="40")
    assert out.returncode == 0 and out.stdout.strip() == ""
    # window excludes the calls -> nothing to check, quiet
    out = _guard(q50, "mg", "--dry-run", MEDIA_GUARD_WINDOW_MIN="1")
    assert out.returncode == 0 and out.stdout.strip() == ""
    # garbage tunable -> refuses (never inlined into SQL)
    out = _guard(q50, "mg", "--dry-run", MEDIA_GUARD_WINDOW_MIN="1; DROP TABLE cdrs")
    assert out.returncode == 2


def test_media_guard_silent_without_migration_50(q50):
    out = _guard(q50, "mgold", "--dry-run")
    assert out.returncode == 0
    assert out.stdout == "" and out.stderr == ""
