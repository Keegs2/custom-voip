"""Migration 55 (docker/postgres/init/55_cdr_refresh_call_quality_fix.sql) —
the 2026-10-23 incident fix for cdr_refresh_call_quality() — against an
ephemeral vanilla PostgreSQL 16 (no TimescaleDB, like CI).

The TimescaleDB behaviour itself (the migration-50 UPDATE decompressing every
compressed chunk; 55 touching exactly one chunk and never a compressed one) is
reproduced by the MANUAL script scripts/db/repro_cq_refresh_compressed.sh —
CI has no TimescaleDB and skipped tests fail CI, so it is not a test here.

Covers:
  * static form of 55: same signature/return type, plpgsql, the fail-fast
    guard `SET timescaledb.enable_dml_decompression = off`, constant-bound
    UPDATE target, no DDL beyond CREATE OR REPLACE FUNCTION/COMMENT/guarded
    GRANT, and the combine (legs / w / agg CTEs + SET list) VERBATIM from 50;
  * 55 replays twice through the real `psql -f`; refuses to run without 50;
    check_migrations.sql reports it, and reports it MISSING after a replay of
    50 (which reverts the fix) until 55 is re-applied;
  * the migration-50 refresh scenarios, ported, against 55 — as role `api`
    (the GUC is an inert placeholder on plain PostgreSQL);
  * DIFFERENTIAL: thousands of randomized calls/anchors (window boundaries to
    the microsecond, legacy NULL-leg A rows, 0..3 B attempts, decoys, stale
    call_* values, UTC and a DST-crossing America/New_York session) — 55 and
    the migration-50 body return the same value and leave every row of the
    call identical;
  * the compressed-chunk skip branch, against a stand-in
    timescaledb_information.chunks: A row or B window in a compressed chunk
    -> 0 and NO new row version (xmin unchanged); boundaries; other
    hypertables / schemas ignored.

Run:  TEST_PG_BIN=/opt/homebrew/bin python3 -m pytest tests/test_cdr_refresh_call_quality_55.py -q
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
sys.path.insert(0, str(Path(__file__).resolve().parent))

INIT = REPO / "docker" / "postgres" / "init"
MIG50 = INIT / "50_cdr_quality_accuracy.sql"
MIG55 = INIT / "55_cdr_refresh_call_quality_fix.sql"
CHECK_MIGRATIONS = REPO / "scripts" / "db" / "check_migrations.sql"
PG_CLAUDE_MD = REPO / "docker" / "postgres" / "CLAUDE.md"
REPRO = REPO / "scripts" / "db" / "repro_cq_refresh_compressed.sh"
REFILL = REPO / "docker" / "postgres" / "backfill" / "55_cdr_call_quality_refill.psql"


def _code(path: Path) -> str:
    """SQL text with `--` comments removed (good enough for these files)."""
    return "\n".join(ln.split("--", 1)[0] for ln in path.read_text().splitlines())


def _ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------------------
# Static checks (no DB)
# ---------------------------------------------------------------------------
def test_55_form_same_signature_plpgsql_guard_and_no_ddl():
    code = _code(MIG55)
    assert re.search(
        r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+cdr_refresh_call_quality\s*\(\s*p_call_id\s+varchar\s*,"
        r"\s*p_anchor\s+timestamptz\s*\)\s*RETURNS\s+int\s+LANGUAGE\s+plpgsql\s+VOLATILE\s+"
        r"SET\s+timescaledb\.enable_dml_decompression\s*=\s*off\s+AS\s+\$fn\$", code, re.I), \
        "same signature + RETURNS int, plpgsql, function-level fail-fast guard"
    # every CREATE is the one CREATE OR REPLACE FUNCTION
    creates = re.findall(r"\bCREATE\s+(OR\s+REPLACE\s+)?(\w+)", code, re.I)
    assert creates and all(m[0] and m[1].upper() == "FUNCTION" for m in creates), creates
    assert len(creates) == 1
    for bad in (r"\bALTER\s+TABLE\b", r"\bTRUNCATE\b", r"\bCREATE\s+INDEX\b",
                r"\bINSERT\s+INTO\b", r"\bDELETE\s+FROM\b"):
        assert not re.search(bad, code, re.I), bad
    # the only DROP: an incompatible-shape incident stub, inside a guarded DO block
    assert re.findall(r"\bDROP\b[^;']*", code, re.I) == [
        "DROP FUNCTION cdr_refresh_call_quality(varchar, timestamptz)"]
    assert "IF FOUND AND (v_ret <> 'integer'::regtype" in code
    assert "-- cq-refresh-v55" in MIG55.read_text()        # sentinel lives in the body
    # the incident shape is gone; the target is bound constants (id AND start_time)
    assert not re.search(r"t\.id\s*=\s*a\.id", code)
    assert re.search(r"UPDATE\s+cdrs\s+t\s+SET.*?FROM\s+a\s*,\s*agg\s+WHERE\s+t\.id\s*=\s*\$1\s+AND\s+"
                     r"t\.start_time\s*=\s*\$2", code, re.S)
    assert re.search(r"USING\s+v_id\s*,\s*v_start\s*,\s*v_uuid\s*,\s*v_b_hi", code)
    # compressed-chunk skip, TimescaleDB-only (resolved at run time)
    assert "to_regclass('timescaledb_information.chunks') IS NOT NULL" in code
    assert re.search(r"ch\.is_compressed", code)
    # max_tuples is NOT the guard (2.26.3 checks it only after decompressing)
    assert "max_tuples_decompressed_per_dml_transaction" not in code
    # role-guarded grant, like 50
    assert re.search(r"IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'api'\) THEN\s+EXECUTE "
                     r"'GRANT EXECUTE ON FUNCTION cdr_refresh_call_quality\(varchar, timestamptz\) TO api'",
                     code)


def test_55_combine_is_migration_50_verbatim():
    """The legs / w / agg CTEs and the SET list are copied, not rewritten."""
    m50, m55 = _code(MIG50), _code(MIG55)

    def ctes(txt, end_marker):
        i = txt.index("), legs AS (")
        j = txt.index(end_marker, i)
        return _ws(txt[i:j])

    def set_list(txt):
        i = txt.index("UPDATE cdrs t SET")
        j = txt.index("FROM a, agg", i)
        return _ws(txt[i:j])

    assert ctes(m50, "), upd AS (") == ctes(m55, ")\nUPDATE cdrs t SET")
    assert set_list(m50) == set_list(m55)
    # the A predicate and the B predicate are 50's, with constants for the joins
    assert "uuid = $1 AND leg IS DISTINCT FROM ''B''" in m55
    assert "start_time >= $2 AND start_time <= $3" in m55
    assert _ws("WHERE c.call_id = $3 AND c.leg = 'B' AND c.answer_time IS NOT NULL "
               "AND c.start_time >= $2 AND c.start_time <= $4 "
               "ORDER BY c.leg_attempt DESC NULLS LAST, c.start_time DESC LIMIT 1") in _ws(m55)
    assert "p_anchor - interval '1 day', p_anchor + interval '1 minute'" in m55
    assert "v_b_hi := v_end + interval '1 minute'" in m55


def test_55_header_has_east_primary_apply_and_verify():
    txt = MIG55.read_text()
    assert ("hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on "
            "-f /opt/revup/docker/postgres/init/55_cdr_refresh_call_quality_fix.sql") in txt
    assert "/opt/revup/scripts/db/check_migrations.sql" in txt
    assert "scripts/db/repro_cq_refresh_compressed.sh" in txt and REPRO.is_file()
    assert os.access(REPRO, os.X_OK)
    assert "backfill/55_cdr_call_quality_refill.psql" in txt


def test_refill_script_form():
    txt = REFILL.read_text()
    assert REFILL.parent.name == "backfill"
    assert ("sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -v since='2026-10-23 09:00+00' "
            "-f /opt/revup/docker/postgres/backfill/55_cdr_call_quality_refill.psql") in txt
    assert ("SELECT count(*) FROM cdrs WHERE leg IS DISTINCT FROM 'B' AND call_quality_status IS NULL "
            "AND start_time >= '2026-10-23 09:00+00'") in txt
    code = "\n".join(ln for ln in txt.splitlines() if not ln.lstrip().startswith("--"))
    assert "\\set ON_ERROR_STOP on" in code
    assert not re.search(r"^\s*BEGIN\b", code, re.I | re.M), "autocommit: one transaction per batch"
    assert "\\if :{?since}" in code and "\\gexec" in code
    assert "cq-refresh-v55" in code and "timescaledb.enable_dml_decompression=off" in code
    # the script itself never writes cdrs: only the function's call_* UPDATE does
    assert not re.search(r"\bUPDATE\s+cdrs\b|\bINSERT\s+INTO\s+cdrs\b|\bDELETE\s+FROM\s+cdrs\b", code, re.I)
    for col in ("billable_ms", "rate_per_min", "total_cost", "carrier_cost", "margin",
                "rated_at", "exported_at", "duration_ms"):
        assert col not in code, col


def test_check_migrations_and_claude_md_know_55():
    chk = CHECK_MIGRATIONS.read_text()
    assert chk.splitlines()[0].startswith("-- Read-only: reports which hand-applied migrations (22..55)")
    assert "('55_cdr_refresh_call_quality_fix'," in chk
    assert re.search(r"^\| `55_cdr_refresh_call_quality_fix\.sql` \|", PG_CLAUDE_MD.read_text(), re.M)


# ---------------------------------------------------------------------------
# Ephemeral PostgreSQL
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg")

from cdr_schema import CDR_COLUMN_MIGRATIONS, apply_cdr_column_migrations  # noqa: E402
from test_tenant_redaction import _SCHEMA, _EphemeralPG, _find_pg_bin  # noqa: E402

PG_BIN = _find_pg_bin()
_SCHEMA_NO_ROLE = _SCHEMA.replace("CREATE ROLE api LOGIN PASSWORD 'api_secret';", "")
_PRE50 = tuple(n for n in CDR_COLUMN_MIGRATIONS if n[:2] < "50")
_PRE55 = tuple(n for n in CDR_COLUMN_MIGRATIONS if n[:2] < "55")


def _v50_oracle_sql() -> str:
    """The migration-50 function body, renamed — the reference implementation."""
    m = re.search(r"^CREATE OR REPLACE FUNCTION cdr_refresh_call_quality\(.*?^SELECT count\(\*\)::int FROM upd \$\$;",
                  MIG50.read_text(), re.S | re.M)
    assert m, "migration-50 function body not found"
    return m.group(0).replace("FUNCTION cdr_refresh_call_quality(",
                              "FUNCTION cdr_refresh_call_quality_v50(", 1)


class _Q55PG(_EphemeralPG):
    def __init__(self, pg_bin):
        super().__init__(pg_bin)
        self.port = 55465     # distinct from every other module


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


def _psql(pg, db, *args, check=True):
    cmd = [str(Path(PG_BIN, "psql")), "-X", "-h", pg.sock, "-p", str(pg.port),
           "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=on", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


@pytest.fixture(scope="module")
def q55():
    if PG_BIN is None or not Path(PG_BIN, "psql").exists():
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _Q55PG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    state = {"pg": pg, "pools": {}}

    async def _mkdb(name, *, names=CDR_COLUMN_MIGRATIONS, oracle=False, user="postgres"):
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres")
        await owner.execute(f"CREATE DATABASE {name}")
        await owner.close()
        conn = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres", database=name)
        await conn.execute(_SCHEMA_NO_ROLE)
        await conn.execute("CREATE INDEX idx_cdrs_uuid ON cdrs(uuid)")
        # 21_cdr_export.sql's watermark column (the refill must never touch it)
        await conn.execute("ALTER TABLE cdrs ADD COLUMN exported_at TIMESTAMPTZ")
        await apply_cdr_column_migrations(conn, names=names)     # incl. 55, twice
        await conn.execute("CREATE INDEX idx_cdrs_call_id ON cdrs(call_id) WHERE call_id IS NOT NULL")
        if oracle:
            await conn.execute(_v50_oracle_sql())
        await conn.close()
        kw = {"password": "api_secret"} if user == "api" else {}
        state["pools"][name] = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user=user, database=name,
            min_size=1, max_size=3, statement_cache_size=0, **kw)

    async def _setup():
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres")
        await owner.execute("CREATE ROLE api LOGIN PASSWORD 'api_secret'")
        await owner.execute("CREATE ROLE grafana_ro LOGIN")
        await owner.close()
        await _mkdb("q55", user="api")          # scenarios, as the API role
        await _mkdb("diff", oracle=True)        # differential vs the 50 body
        await _mkdb("ts")                       # stand-in timescaledb_information.chunks
        await _mkdb("rp")                       # replay order + check_migrations
        await _mkdb("pre50", names=_PRE50)      # 55 must refuse
        await _mkdb("stub", names=_PRE55)       # incident stub -> 55
        await _mkdb("rf")                       # refill backfill
        await _mkdb("rfts")                     # refill + stand-in compressed chunks

    _run(_setup())
    try:
        yield state
    finally:
        async def _teardown():
            for p in state["pools"].values():
                await p.close()
        _run(_teardown())
        pg.stop()


def _fn_meta(pg, db):
    out = _psql(pg, db, "-Atc",
                "SELECT l.lanname || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || "
                "has_function_privilege('api', p.oid, 'EXECUTE') FROM pg_proc p "
                "JOIN pg_language l ON l.oid = p.prolang "
                "WHERE p.oid = 'cdr_refresh_call_quality(varchar, timestamptz)'::regprocedure")
    return out.stdout.strip()


def _check_migrations_status(pg, db, migration):
    out = _psql(pg, db, "-At", "-F", "|", "-f", str(CHECK_MIGRATIONS))
    rows = dict(ln.split("|", 1) for ln in out.stdout.splitlines() if "|" in ln)
    return rows[migration]


def test_55_replays_via_psql_twice_and_keeps_signature(q55):
    pg = q55["pg"]
    for _ in range(2):
        out = _psql(pg, "rp", "-f", str(MIG55))
        assert out.returncode == 0, out.stderr
    assert _fn_meta(pg, "rp") == "plpgsql|timescaledb.enable_dml_decompression=off|true"
    n = _psql(pg, "rp", "-Atc", "SELECT count(*) FROM pg_proc WHERE proname = 'cdr_refresh_call_quality'")
    assert n.stdout.strip() == "1", "CREATE OR REPLACE must not add an overload"
    ret = _psql(pg, "rp", "-Atc",
                "SELECT pg_get_function_result('cdr_refresh_call_quality(varchar, timestamptz)'::regprocedure)")
    assert ret.stdout.strip() == "integer"
    cmt = _psql(pg, "rp", "-Atc", "SELECT obj_description('cdr_refresh_call_quality(varchar, timestamptz)'"
                "::regprocedure, 'pg_proc')")
    assert "compressed" in cmt.stdout and "migration 55" in cmt.stdout


def test_replaying_50_reverts_the_fix_and_check_migrations_says_so(q55):
    pg = q55["pg"]
    assert _check_migrations_status(pg, "rp", "55_cdr_refresh_call_quality_fix") == "applied"
    out = _psql(pg, "rp", "-f", str(MIG50))
    assert out.returncode == 0, out.stderr
    assert _fn_meta(pg, "rp").startswith("sql|")
    assert _check_migrations_status(pg, "rp", "55_cdr_refresh_call_quality_fix") == "*** MISSING ***"
    out = _psql(pg, "rp", "-f", str(MIG55))
    assert out.returncode == 0, out.stderr
    assert _check_migrations_status(pg, "rp", "55_cdr_refresh_call_quality_fix") == "applied"
    assert _check_migrations_status(pg, "rp", "50_cdr_quality_accuracy") == "applied"


def test_55_refuses_without_migration_50(q55):
    out = _psql(q55["pg"], "pre50", "-f", str(MIG55), check=False)
    assert out.returncode != 0
    assert "migration 50 not applied" in out.stderr
    n = _psql(q55["pg"], "pre50", "-Atc",
              "SELECT count(*) FROM pg_proc WHERE proname = 'cdr_refresh_call_quality'")
    assert n.stdout.strip() == "0"


# ---------------------------------------------------------------------------
# Ported migration-50 scenarios — run as role `api` against 55
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


def test_refresh_runs_as_api_role(q55):
    async def go():
        pool = q55["pools"]["q55"]
        assert await pool.fetchval("SELECT current_user") == "api"
        await _ins(pool, "api-1", leg="A", call_id="api-1")
        assert await _refresh(pool, "api-1", T0) == 1
        # the function-level SET is scoped to the call: the session is untouched
        assert await pool.fetchval(
            "SELECT current_setting('timescaledb.enable_dml_decompression', true)") in (None, "")
    _run(go())


def test_refresh_a_only_unknown_and_null_args(q55):
    async def go():
        pool = q55["pools"]["q55"]
        await _ins(pool, "ra-1", leg="A", call_id="ra-1")
        assert await _refresh(pool, "ra-1", T0) == 1
        assert await _call(pool, "ra-1") == ("rated", "great", 4.41, "A")
        # ungraded A only -> the A status, no grade
        await _ins(pool, "ra-2", leg="A", call_id="ra-2", talk_s=2, status="short",
                   grade=None, mos=None)
        assert await _refresh(pool, "ra-2", T0) == 1
        assert await _call(pool, "ra-2") == ("short", None, None, None)
        assert await _refresh(pool, "nope", T0) == 0
        assert await _refresh(pool, None, T0) == 0
        assert await _refresh(pool, "ra-1", None) == 0
        # a legacy (pre-48, leg NULL) row is an A row too
        await _ins(pool, "ra-3", leg=None, call_id=None, grade="good", mos=4.20)
        assert await _refresh(pool, "ra-3", T0) == 1
        assert await _call(pool, "ra-3") == ("rated", "good", 4.20, "A")
    _run(go())


@pytest.mark.parametrize("order", ["A_then_B", "B_then_A"])
def test_refresh_b_loss_makes_call_worse_either_order(q55, order):
    a, b = f"rab-{order}", f"rab-{order}-b1"

    async def go():
        pool = q55["pools"]["q55"]
        steps = [("A", a), ("B", b)] if order == "A_then_B" else [("B", b), ("A", a)]
        results = []
        for leg, _uuid in steps:
            if leg == "A":
                await _ins(pool, a, leg="A", call_id=a)
            else:
                await _ins(pool, b, leg="B", call_id=a, attempt=1, start=T0 + timedelta(seconds=1),
                           status="rated", grade="fair", mos=3.92)
            results.append(await _refresh(pool, a, T0 if leg == "A" else T0 + timedelta(seconds=1)))
        assert results == ([0, 1] if order == "B_then_A" else [1, 1])
        assert await _call(pool, a) == ("rated", "fair", 3.92, "B")
        assert await _refresh(pool, a, T0) == 1                       # idempotent
        assert await _call(pool, a) == ("rated", "fair", 3.92, "B")
        assert await _refresh(pool, b, T0 + timedelta(seconds=1)) == 0  # a B uuid is not a call
        assert (await _call(pool, b))[0] is None                     # B rows never get call_*
    _run(go())


def test_refresh_b_no_rtp_makes_call_no_rtp(q55):
    async def go():
        pool = q55["pools"]["q55"]
        await _ins(pool, "rn-1", leg="A", call_id="rn-1")
        await _ins(pool, "rn-1-b", leg="B", call_id="rn-1", attempt=1,
                   start=T0 + timedelta(seconds=1), status="no_rtp", grade="poor", mos=None)
        assert await _refresh(pool, "rn-1", T0 + timedelta(seconds=1)) == 1
        assert await _call(pool, "rn-1") == ("no_rtp", "poor", None, "B")
    _run(go())


def test_refresh_only_the_answered_b_attempt_counts(q55):
    async def go():
        pool = q55["pools"]["q55"]
        await _ins(pool, "r2-1", leg="A", call_id="r2-1", grade="good", mos=4.20)
        await _ins(pool, "r2-1-b1", leg="B", call_id="r2-1", attempt=1,
                   start=T0 + timedelta(seconds=1), answered=False, status="unanswered",
                   grade="poor", mos=None)
        await _ins(pool, "r2-1-b2", leg="B", call_id="r2-1", attempt=2,
                   start=T0 + timedelta(seconds=12), status="rated", grade="great", mos=4.41)
        assert await _refresh(pool, "r2-1", T0 + timedelta(seconds=12)) == 1
        assert await _call(pool, "r2-1") == ("rated", "good", 4.20, "A")
    _run(go())


def test_refresh_window_edges(q55):
    async def go():
        pool = q55["pools"]["q55"]
        await _ins(pool, "rw-1", leg="A", call_id="rw-1", talk_s=30)        # end = T0 + 33 s
        # B after A.end + 1 minute is not this call's leg
        await _ins(pool, "rw-1-late", leg="B", call_id="rw-1", attempt=1,
                   start=T0 + timedelta(minutes=5), status="no_rtp", grade="poor", mos=None)
        assert await _refresh(pool, "rw-1", T0) == 1
        assert await _call(pool, "rw-1") == ("rated", "great", 4.41, "A")
        # B exactly at A.end + 1 minute IS (inclusive bound)
        await _ins(pool, "rw-1-edge", leg="B", call_id="rw-1", attempt=2,
                   start=T0 + timedelta(seconds=93), status="rated", grade="fair", mos=3.92)
        assert await _refresh(pool, "rw-1", T0) == 1
        assert await _call(pool, "rw-1") == ("rated", "fair", 3.92, "B")
        # A lookup window: anchor - 1 day <= A.start <= anchor + 1 minute
        assert await _refresh(pool, "rw-1", T0 + timedelta(days=1)) == 1
        assert await _refresh(pool, "rw-1", T0 + timedelta(days=1, microseconds=1)) == 0
        assert await _refresh(pool, "rw-1", T0 - timedelta(minutes=1)) == 1
        assert await _refresh(pool, "rw-1", T0 - timedelta(minutes=1, microseconds=1)) == 0
    _run(go())


# ---------------------------------------------------------------------------
# Differential: 55 vs the migration-50 body over randomized calls
# ---------------------------------------------------------------------------
_STATUSES = ["rated", "rated", "rated", "no_rtp", "no_media", "low_sample", "short",
             "unanswered", "no_data", None]
_GRADES = ["great", "good", "fair", "poor", "poor", None, None, "weird"]
_DIFF_SQL = """
CREATE TABLE diff_cases (k int PRIMARY KEY, call_id varchar, anchor timestamptz, a_uuid varchar);
CREATE TABLE diff_results (tz text, k int, impl text, ret int, snap text);
CREATE FUNCTION diff_one(p_impl text, p_call_id varchar, p_anchor timestamptz, p_a_uuid varchar,
                         OUT ret int, OUT snap text)
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN   -- subtransaction: run, capture, roll back -> every case sees the same rows
    EXECUTE format('SELECT %I($1, $2)', p_impl) INTO ret USING p_call_id, p_anchor;
    SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', id, call_quality_status, call_quality_grade,
                             call_mos, call_quality_leg, quality_status, quality_grade, mos),
                      ';' ORDER BY id)
      INTO snap
      FROM cdrs WHERE uuid = p_a_uuid OR call_id = p_a_uuid;
    RAISE EXCEPTION USING ERRCODE = 'ZZ555', MESSAGE = 'diff rollback';
  EXCEPTION WHEN SQLSTATE 'ZZ555' THEN
    NULL;
  END;
END $$;
"""


def _rand_quality(rnd):
    mos = rnd.choice([None, None, round(rnd.uniform(1.0, 4.5), 2), 4.41, 3.92, 3.92])
    return rnd.choice(_STATUSES), rnd.choice(_GRADES), mos


def _gen_calls(rnd, n, base):
    """Rows + refresh cases. Times are microsecond-exact around every bound."""
    rows, cases = [], []
    us = timedelta(microseconds=1)
    for i in range(n):
        start = base + timedelta(minutes=17 * i, microseconds=rnd.randint(0, 999_999))
        a_uuid = f"{21_000_000 + i}_{rnd.randint(10**8, 10**9)}@{rnd.choice(['206.146.100.24', '67.231.13.185'])}"
        talk = timedelta(seconds=rnd.choice([0, 2, 30, 61, 300, rnd.randint(1, 900)]),
                         microseconds=rnd.randint(0, 999_999))
        end = start + talk if rnd.random() > 0.03 else start - timedelta(seconds=30)
        st, gr, mos = _rand_quality(rnd)
        stale = rnd.random() < 0.3
        rows.append(dict(uuid=a_uuid, leg=rnd.choice(["A"] * 8 + [None] * 2), call_id=a_uuid,
                         attempt=None, start=start, answer=start + timedelta(seconds=3), end=end,
                         status=st, grade=gr, mos=mos,
                         cqs="rated" if stale else None, cqg="good" if stale else None,
                         cqm=4.2 if stale else None, cql="A" if stale else None))
        if rnd.random() < 0.05:   # same uuid 3 days earlier: outside every window
            r0 = dict(rows[-1])
            r0.update(start=start - timedelta(days=3), end=start - timedelta(days=3) + talk,
                      answer=start - timedelta(days=3), grade="poor", status="no_rtp", mos=None)
            rows.append(r0)
        b_end_bound = end + timedelta(minutes=1)
        offsets = [-timedelta(seconds=1), timedelta(0), timedelta(seconds=1),
                   (b_end_bound - start), (b_end_bound - start) + us, timedelta(minutes=2) + talk,
                   timedelta(seconds=rnd.randint(1, 600))]
        b_starts = []
        for j in range(rnd.choice([0, 1, 1, 2, 2, 3])):
            # +7j us: offsets differ by 1 us or >= 1 s, so (leg_attempt, start_time) never ties
            bst = start + rnd.choice(offsets) + timedelta(microseconds=7 * j)
            b_starts.append(bst)
            st, gr, mos = _rand_quality(rnd)
            rows.append(dict(uuid=f"{a_uuid}-b{j}", leg="B", call_id=a_uuid,
                             attempt=rnd.choice([1, 2, 3, None]) if j else rnd.choice([1, None]),
                             start=bst, answer=(bst + timedelta(seconds=2)) if rnd.random() < 0.75 else None,
                             end=bst + talk, status=st, grade=gr, mos=mos,
                             cqs=None, cqg=None, cqm=None, cql=None))
        if rnd.random() < 0.1:    # decoys: an A-leg row naming this call, a B of another call
            rows.append(dict(uuid=f"{a_uuid}-decoyA", leg="A", call_id=a_uuid, attempt=None,
                             start=start + timedelta(seconds=1), answer=start, end=end,
                             status="no_rtp", grade="poor", mos=None, cqs=None, cqg=None, cqm=None, cql=None))
            rows.append(dict(uuid=f"{a_uuid}-decoyB", leg="B", call_id=f"other-{a_uuid}", attempt=1,
                             start=start + timedelta(seconds=1), answer=start, end=end,
                             status="no_rtp", grade="poor", mos=None, cqs=None, cqg=None, cqm=None, cql=None))
        anchors = [start, start + timedelta(days=1), start + timedelta(days=1) + us,
                   start - timedelta(minutes=1), start - timedelta(minutes=1) - us,
                   start + timedelta(hours=rnd.randint(1, 30))] + b_starts
        for anc in rnd.sample(anchors, k=min(len(anchors), 4)) + [start]:
            cases.append((a_uuid, anc))
        if b_starts and rnd.random() < 0.3:
            cases.append((f"{a_uuid}-b0", b_starts[0]))          # a B uuid -> 0
        if rnd.random() < 0.1:
            cases.append((f"unknown-{i}", start))                # unknown -> 0
    return rows, cases


async def _load_diff(pool, rows, cases, k0):
    await pool.executemany(
        """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination, start_time,
               answer_time, end_time, leg, call_id, leg_attempt, quality_status, quality_grade, mos,
               call_quality_status, call_quality_grade, call_mos, call_quality_leg)
           VALUES ($1, 7, 'rcf', 'inbound', '+15550000000', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11, $12, $13, $14)""",
        [(r["uuid"], r["start"], r["answer"], r["end"], r["leg"], r["call_id"], r["attempt"],
          r["status"], r["grade"], r["mos"], r["cqs"], r["cqg"], r["cqm"], r["cql"]) for r in rows])
    await pool.executemany(
        "INSERT INTO diff_cases (k, call_id, anchor, a_uuid) VALUES ($1, $2, $3, $4)",
        [(k0 + i, cid, anc, cid.split("-b")[0].split("unknown-")[0] or cid)
         for i, (cid, anc) in enumerate(cases)])


@pytest.mark.parametrize("tz", ["UTC", "America/New_York"])
def test_differential_55_equals_migration_50_on_uncompressed_rows(q55, tz):
    pool = q55["pools"]["diff"]
    k0 = 0 if tz == "UTC" else 100_000
    # NY run straddles the 2026-11-01 DST fall-back: "anchor - 1 day" is 25 h there.
    base = (datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc) if tz == "UTC"
            else datetime(2026, 10, 31, 2, 0, tzinfo=timezone.utc))
    rnd = random.Random(20261023 + k0)
    rows, cases = _gen_calls(rnd, 450, base)

    async def go():
        async with pool.acquire() as conn:
            if not await conn.fetchval("SELECT to_regclass('diff_cases') IS NOT NULL"):
                await conn.execute(_DIFF_SQL)
        await _load_diff(pool, rows, cases, k0)
        async with pool.acquire() as conn:
            await conn.execute(f"SET TimeZone = '{tz}'")
            assert await conn.fetchval("SELECT to_regclass('timescaledb_information.chunks')") is None
            await conn.execute(
                """INSERT INTO diff_results
                   SELECT $1, c.k, i.impl, d.ret, d.snap
                     FROM diff_cases c
                    CROSS JOIN (VALUES ('cdr_refresh_call_quality_v50'), ('cdr_refresh_call_quality')) i(impl)
                    CROSS JOIN LATERAL diff_one(i.impl, c.call_id, c.anchor, c.a_uuid) d
                    WHERE c.k >= $2 AND c.k < $2 + 100000""", tz, k0)
            await conn.execute("RESET TimeZone")
            bad = await conn.fetch(
                """SELECT o.k, o.ret AS ret50, n.ret AS ret55, o.snap AS snap50, n.snap AS snap55
                     FROM diff_results o JOIN diff_results n ON n.k = o.k AND n.tz = o.tz
                    WHERE o.tz = $1 AND o.impl = 'cdr_refresh_call_quality_v50'
                      AND n.impl = 'cdr_refresh_call_quality'
                      AND (o.ret IS DISTINCT FROM n.ret OR o.snap IS DISTINCT FROM n.snap)
                    ORDER BY o.k LIMIT 5""", tz)
            stats = await conn.fetchrow(
                """SELECT count(*) AS n,
                          count(*) FILTER (WHERE ret = 1) AS updated,
                          count(*) FILTER (WHERE ret = 0) AS untouched
                     FROM diff_results WHERE tz = $1 AND impl = 'cdr_refresh_call_quality'""", tz)
            # every branch of the combine was exercised (a real, committed 55 pass over the
            # same rows; candidates materialised first, then read back)
            await conn.execute(
                """SELECT count(cdr_refresh_call_quality(t.uuid, t.start_time))
                     FROM (SELECT uuid, start_time FROM cdrs
                            WHERE leg IS DISTINCT FROM 'B' AND start_time >= $1
                            ORDER BY start_time) t""", base)
            branches = await conn.fetch(
                """SELECT DISTINCT call_quality_status, call_quality_grade IS NOT NULL AS graded,
                          call_quality_leg
                     FROM cdrs WHERE leg IS DISTINCT FROM 'B' AND start_time >= $1""", base)
        return bad, stats, branches

    bad, stats, branches = _run(go())
    assert not bad, [dict(r) for r in bad]
    assert stats["n"] == len(cases) >= 2000
    assert stats["updated"] > 1000 and stats["untouched"] > 300, dict(stats)
    combos = {(r["call_quality_status"], r["graded"], r["call_quality_leg"]) for r in branches}
    assert {("no_rtp", True, "A"), ("no_rtp", True, "B"), ("rated", True, "A"),
            ("rated", True, "B")} <= combos, combos
    assert any(s not in ("rated", "no_rtp") and not g for s, g, _ in combos), combos


# ---------------------------------------------------------------------------
# The compressed-chunk skip — stand-in timescaledb_information.chunks
# ---------------------------------------------------------------------------
_W1, _W2, _W3, _W4 = (datetime(2026, 10, d, tzinfo=timezone.utc) for d in (8, 15, 22, 29))
_FAKE_TS = """
CREATE SCHEMA timescaledb_information;
CREATE TABLE timescaledb_information.chunks (
  hypertable_schema name, hypertable_name name, chunk_name name,
  range_start timestamptz, range_end timestamptz, is_compressed boolean);
"""


async def _set_chunks(conn, compressed_weeks, *, table="cdrs", schema=None):
    await conn.execute("DELETE FROM timescaledb_information.chunks")
    schema = schema or await conn.fetchval("SELECT current_schema()")
    for i, (lo, hi) in enumerate([(_W1, _W2), (_W2, _W3), (_W3, _W4)], 1):
        await conn.execute(
            "INSERT INTO timescaledb_information.chunks VALUES ($1, $2, $3, $4, $5, $6)",
            schema, table, f"_hyper_1_{i}_chunk", lo, hi, i in compressed_weeks)


async def _xmin(conn, uuid):
    return await conn.fetchval("SELECT xmin::text FROM cdrs WHERE uuid = $1", uuid)


def test_skip_when_a_row_or_b_window_is_in_a_compressed_chunk(q55):
    pool = q55["pools"]["ts"]
    old = datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc)
    cur = datetime(2026, 10, 23, 9, 15, tzinfo=timezone.utc)
    # A ends 23:59:00 -> B window upper bound exactly 2026-10-22 00:00:00 (inclusive)
    edge = datetime(2026, 10, 21, 23, 58, 57, tzinfo=timezone.utc)
    # one microsecond earlier -> the window stays in week 2
    near = datetime(2026, 10, 21, 23, 50, 0, tzinfo=timezone.utc)

    async def go():
        for uuid, start, talk_s in (("old-a", old, 60), ("cur-a", cur, 60), ("edge-a", edge, 0)):
            await _ins(pool, uuid, leg="A", call_id=uuid, start=start, talk_s=talk_s)
            await _ins(pool, f"{uuid}-b", leg="B", call_id=uuid, attempt=1,
                       start=start + timedelta(seconds=1), status="rated", grade="fair", mos=3.92)
        await pool.execute(
            """INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination, start_time,
                   answer_time, end_time, leg, call_id, quality_status, quality_grade, mos)
               VALUES ('near-a', 7, 'rcf', 'inbound', '+1555', $1, $1, $2, 'A', 'near-a',
                       'rated', 'great', 4.41)""",
            near, _W3 - timedelta(minutes=1, microseconds=1))
        async with pool.acquire() as conn:
            await conn.execute(_FAKE_TS)

            # nothing compressed -> normal refresh
            await _set_chunks(conn, set())
            assert await _refresh(conn, "old-a", old) == 1
            assert await _call(conn, "old-a") == ("rated", "fair", 3.92, "B")

            # week 2 compressed: the A row there -> 0, and NO DML (same row version)
            await conn.execute("UPDATE cdrs SET call_quality_grade = 'great' WHERE uuid = 'old-a'")
            await _set_chunks(conn, {2})
            x0 = await _xmin(conn, "old-a")
            assert await _refresh(conn, "old-a", old) == 0
            assert await _refresh(conn, "old-a", old + timedelta(seconds=1)) == 0
            assert await _xmin(conn, "old-a") == x0
            assert (await _call(conn, "old-a"))[1] == "great"           # untouched
            # ... while the current week still refreshes
            assert await _refresh(conn, "cur-a", cur) == 1
            assert await _call(conn, "cur-a") == ("rated", "fair", 3.92, "B")

            # week 3 compressed only: B window reaching week 3's first instant -> 0
            await _set_chunks(conn, {3})
            x0 = await _xmin(conn, "edge-a")
            assert await _refresh(conn, "edge-a", edge) == 0
            assert await _xmin(conn, "edge-a") == x0
            # window ending 1 us before week 3 -> refreshed
            assert await _refresh(conn, "near-a", near) == 1
            assert await _call(conn, "near-a") == ("rated", "great", 4.41, "A")

            # a compressed chunk of ANOTHER hypertable / schema is ignored
            await _set_chunks(conn, {1, 2, 3}, table="other_hypertable")
            assert await _refresh(conn, "old-a", old) == 1
            await _set_chunks(conn, {1, 2, 3}, schema="not_this_schema")
            assert await _refresh(conn, "old-a", old) == 1

            # unknown call / B uuid still 0 with the TimescaleDB branch active
            await _set_chunks(conn, set())
            assert await _refresh(conn, "nope", cur) == 0
            assert await _refresh(conn, "cur-a-b", cur) == 0
    _run(go())


# ---------------------------------------------------------------------------
# The incident stub -> 55, and the refill backfill
# ---------------------------------------------------------------------------
_STUB = ("CREATE OR REPLACE FUNCTION cdr_refresh_call_quality(p_call_id varchar, p_anchor timestamptz) "
         "RETURNS int LANGUAGE sql AS $$ SELECT 0 $$")
_SINCE = "2026-10-23 09:00+00"
_BOUND = datetime(2026, 10, 23, 9, 0, tzinfo=timezone.utc)


def _refill(pg, db, *extra, check=False):
    return _psql(pg, db, *extra, "-f", str(REFILL), check=check)


def test_55_replaces_the_incident_stub_and_refill_refuses_until_then(q55):
    pg = q55["pg"]
    # the hand-installed no-op (same shape as 50's function)
    assert _psql(pg, "stub", "-c", _STUB).returncode == 0
    out = _refill(pg, "stub", "-v", f"since={_SINCE}")
    assert out.returncode != 0 and "not the migration-55" in out.stderr, out.stderr
    assert _check_migrations_status(pg, "stub", "55_cdr_refresh_call_quality_fix") == "*** MISSING ***"
    out = _psql(pg, "stub", "-f", str(MIG55))
    assert out.returncode == 0, out.stderr
    assert "dropping incompatible" not in out.stderr            # replaced in place
    assert _fn_meta(pg, "stub") == "plpgsql|timescaledb.enable_dml_decompression=off|true"
    assert _check_migrations_status(pg, "stub", "55_cdr_refresh_call_quality_fix") == "applied"

    # a stub with other parameter names + return type: CREATE OR REPLACE alone would
    # fail ("cannot change name of input parameter"); 55 drops it first
    assert _psql(pg, "stub", "-c", "DROP FUNCTION cdr_refresh_call_quality(varchar, timestamptz)").returncode == 0
    assert _psql(pg, "stub", "-c",
                 "CREATE FUNCTION cdr_refresh_call_quality(call_id varchar, anchor timestamptz) "
                 "RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$").returncode == 0
    out = _psql(pg, "stub", "-f", str(MIG55))
    assert out.returncode == 0, out.stderr
    assert "dropping incompatible cdr_refresh_call_quality" in out.stderr
    assert _fn_meta(pg, "stub") == "plpgsql|timescaledb.enable_dml_decompression=off|true"

    # the migration-50 body is refused too
    assert _psql(pg, "stub", "-f", str(MIG50)).returncode == 0
    out = _refill(pg, "stub", "-v", f"since={_SINCE}")
    assert out.returncode != 0 and "not the migration-55" in out.stderr


def test_refill_requires_since(q55):
    out = _refill(q55["pg"], "rf")
    assert out.returncode != 0
    assert '"since" is not set' in out.stderr


async def _seed_refill(pool):
    seed = [
        # uuid, start offset from the bound, A (status, grade, mos), B or None, stale call_*?
        ("pre-1", -timedelta(minutes=1), ("rated", "great", 4.41), ("rated", "fair", 3.92), None),
        ("in-1", timedelta(minutes=5), ("rated", "great", 4.41), ("rated", "fair", 3.92), None),
        ("in-2", timedelta(minutes=6), ("rated", "great", 4.41), None, None),
        ("in-3", timedelta(minutes=7), ("no_rtp", "poor", None), ("rated", "great", 4.41), None),
        ("in-4", timedelta(minutes=8), ("short", None, None), None, None),
        ("in-5", timedelta(0), ("rated", "good", 4.20), None, None),            # == bound
        ("done-1", timedelta(minutes=9), ("rated", "great", 4.41), ("rated", "fair", 3.92),
         ("rated", "good", 4.20, "A")),                                       # already set: not a candidate
    ] + [(f"bulk-{i}", timedelta(minutes=10 + i), ("rated", "great", 4.41), None, None)
         for i in range(7)]
    for uuid, off, (st, gr, mos), b, stale in seed:
        start = _BOUND + off
        await _ins(pool, uuid, leg="A", call_id=uuid, start=start, status=st, grade=gr, mos=mos)
        await pool.execute(
            "UPDATE cdrs SET billable_ms = 61000, total_cost = 0.0123, rated_at = $2, "
            "exported_at = $2, call_quality_status = $3, call_quality_grade = $4, call_mos = $5, "
            "call_quality_leg = $6 WHERE uuid = $1",
            uuid, start, *(stale or (None, None, None, None)))
        if b:
            await _ins(pool, f"{uuid}-b", leg="B", call_id=uuid, attempt=1,
                       start=start + timedelta(seconds=1), status=b[0], grade=b[1], mos=b[2])


async def _dump(pool):
    return {r["uuid"]: dict(r) for r in await pool.fetch("SELECT xmin::text AS xmin_, * FROM cdrs")}


_CALL_COLS = ("call_quality_status", "call_quality_grade", "call_mos", "call_quality_leg")


def test_refill_populates_null_a_rows_since_bound_only_and_is_idempotent(q55):
    pg, pool = q55["pg"], q55["pools"]["rf"]
    _run(_seed_refill(pool))
    before = _run(_dump(pool))

    out = _refill(pg, "rf", "-v", f"since={_SINCE}", "-v", "batch=3")
    assert out.returncode == 0, out.stderr
    lines = [ln for ln in out.stdout.splitlines() if ln.startswith("batch ")]
    assert lines == ["batch 1/4: 3 rows, 3 refreshed", "batch 2/4: 3 rows, 3 refreshed",
                     "batch 3/4: 3 rows, 3 refreshed", "batch 4/4: 3 rows, 3 refreshed"], out.stdout
    after = _run(_dump(pool))

    def call(uuid):
        r = after[uuid]
        return (r["call_quality_status"], r["call_quality_grade"],
                None if r["call_mos"] is None else float(r["call_mos"]), r["call_quality_leg"])

    assert call("in-1") == ("rated", "fair", 3.92, "B")
    assert call("in-2") == ("rated", "great", 4.41, "A")
    assert call("in-3") == ("no_rtp", "poor", None, "A")
    assert call("in-4") == ("short", None, None, None)
    assert call("in-5") == ("rated", "good", 4.20, "A")
    assert all(call(f"bulk-{i}") == ("rated", "great", 4.41, "A") for i in range(7))
    assert call("pre-1") == (None, None, None, None)                    # before the bound
    assert call("done-1") == ("rated", "good", 4.20, "A")               # was set: untouched
    for uuid, row in after.items():
        changed = {k for k in row if row[k] != before[uuid][k]} - {"xmin_"}
        if uuid.startswith(("in-", "bulk-")):
            assert changed <= set(_CALL_COLS), (uuid, changed)          # billing/exported_at intact
        else:
            assert not changed and row["xmin_"] == before[uuid]["xmin_"], (uuid, changed)
    marker = _run(pool.fetchval(
        "SELECT cutoff_time FROM data_migrations WHERE migration_id = '55_cdr_call_quality_refill'"))
    assert marker == _BOUND

    # re-run: nothing left, no batch, no new row versions
    out = _refill(pg, "rf", "-v", f"since={_SINCE}", "-v", "batch=3")
    assert out.returncode == 0, out.stderr
    assert not [ln for ln in out.stdout.splitlines() if ln.startswith("batch ")], out.stdout
    again = _run(_dump(pool))
    assert again == after


def test_refill_never_touches_rows_in_compressed_chunks(q55):
    pg, pool = q55["pg"], q55["pools"]["rfts"]

    async def go():
        await _ins(pool, "c-old", leg="A", call_id="c-old",
                   start=datetime(2026, 10, 21, 14, 0, tzinfo=timezone.utc))
        await _ins(pool, "c-cur", leg="A", call_id="c-cur",
                   start=datetime(2026, 10, 23, 10, 0, tzinfo=timezone.utc))
        async with pool.acquire() as conn:
            await conn.execute(_FAKE_TS)
            await _set_chunks(conn, {2})                     # Oct 15-22 compressed
        return await _dump(pool)

    before = _run(go())
    out = _refill(pg, "rfts", "-v", "since=2026-10-21 00:00+00")
    assert out.returncode == 0, out.stderr
    assert [ln for ln in out.stdout.splitlines() if ln.startswith("batch ")] == [
        "batch 1/1: 1 rows, 1 refreshed"], out.stdout
    assert re.search(r"\|\s+2\s+\|\s+1\s+\|\s+1\s+\|", out.stdout), out.stdout   # null | skipped | to_refresh
    after = _run(_dump(pool))
    assert after["c-old"] == before["c-old"]                 # same row version, still NULL
    assert after["c-old"]["call_quality_status"] is None
    assert after["c-cur"]["call_quality_status"] == "rated"
