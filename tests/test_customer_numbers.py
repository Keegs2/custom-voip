"""services/customer_numbers.py — the ONE definition of "a customer's numbers".

Plan: docs/CUSTOMER_NUMBERS_HOLISTIC_PLAN.md §3 (design), §4 (contract),
§6.3 item 3 (this module).

Covers:
  * pure helpers — product_filter ("all"/"" = no filter), parse_number_param,
    SQL-literal safety, precedence order, the shaping of /reports/my-numbers
    rows, /customers/me counts.numbers and /numbers/owned.
  * The REAL chain (02 03 09 17 20 22 24 31 34 -> 54 -> 56 -> 57 twice) on an
    ephemeral PostgreSQL 16, the REAL routers behind the REAL JWT middleware
    with REAL minted JWTs:
      - helper semantics on number_routing: disabled rcf IN; disabled trunk
        IN; suspended box enabled=false; voicemail_enabled=false ->
        enabled=false; deleted box OUT; api OUT; other customer OUT; a DID
        planted in two product tables -> ONE row, rcf wins.
      - EXPLAIN (enable_seqscan=off): every arm of the owned set reads its
        customer index (idx_rcf_customer, idx_trunks_customer ->
        idx_trunk_dids_trunk, idx_voicemail_boxes_customer); the hidden api
        arm is pruned at plan time; the unfiltered view's api arm reads
        idx_api_did_customer. No Seq Scan on any product table.
      - 57 idempotent; check_migrations.sql: MISSING before, applied after.
      - cdr_customer_number_sql canonicalization parity with
        utils.phone.normalize_e164 (and the safe direction of every known
        divergence: the SQL side passes the raw input through, never a
        different canonical number).
      - GET /v1/numbers/owned: exact body, admin only (user/readonly/support
        -> 403).
      - GET /v1/numbers/my: one number_routing fallback arm (fallback rows
        carry assigned_at null; voicemail + api present; deleted box absent).
      - GET /v1/search/did: rcf/api/trunk `details` + `status` golden-compared
        against the OLD per-table query text on the same DB; voicemail rows
        with {label, mailbox_id, enabled}.
      - GET /v1/customers/me: counts.numbers on the real schema.

Run:  JWT_SECRET_KEY=x python -m pytest -q -p no:cacheprovider tests/test_customer_numbers.py
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import customer_numbers as cn  # noqa: E402  (pure; no DB deps)
from services import reporting as rp  # noqa: E402
from utils.phone import normalize_e164  # noqa: E402

MIG_57 = REPO / "docker" / "postgres" / "init" / "57_trunk_dids_trunk_index.sql"


# ---------------------------------------------------------------------------
# 1) Pure helpers (no DB)
# ---------------------------------------------------------------------------
def test_constants_are_sql_safe_and_ordered():
    assert cn.HIDDEN_PRODUCTS == ("api",)
    assert cn.PRECEDENCE == ("rcf", "api", "trunk", "voicemail")
    assert cn.ALL_PRODUCTS == "all"
    assert cn.TENANT_NUMBER_KEYS == ("number", "name", "product", "enabled", "forwards_to")
    sql = cn.owned_numbers_sql("$1::int")
    assert "NOT IN ('api')" in sql and "nr.customer_id = $1::int" in sql
    assert "product_ref_id" not in sql and "customer_status" not in sql
    assert "number_routing" in sql
    for table in ("rcf_numbers", "trunk_dids", "voicemail_boxes", "api_dids"):
        assert table not in sql          # never re-lists product tables
    assert "nr.customer_id =" not in cn.owned_numbers_sql(None)


@pytest.mark.parametrize("bad", ["$1", "1", "$1::text", "$1::int; DROP TABLE x", "c.id"])
def test_owned_numbers_sql_rejects_non_bind(bad):
    with pytest.raises(ValueError):
        cn.owned_numbers_sql(bad)


def test_alias_and_column_validation():
    assert cn.cdr_customer_number_sql("c").count("c.direction") >= 1
    assert "c." not in cn.cdr_customer_number_sql()
    for bad in ("c;", "C", "1c", "c.d"):
        with pytest.raises(ValueError):
            cn.cdr_customer_number_sql(bad)
    with pytest.raises(ValueError):
        cn.precedence_sql("x; DROP")


@pytest.mark.parametrize("raw,expected", [
    (None, None), ("", None), ("  ", None), ("all", None), ("ALL", None), (" all ", None),
    ("rcf", "rcf"), ("voicemail", "voicemail"), ("trunk", "trunk"),
])
def test_product_filter(raw, expected):
    assert cn.product_filter(raw) == expected


def test_parse_number_param():
    assert cn.parse_number_param(None) is None
    assert cn.parse_number_param("  ") is None
    assert cn.parse_number_param("(617) 555-0101") == "+16175550101"
    assert cn.parse_number_param("16175550101") == "+16175550101"
    assert cn.parse_number_param("+447911123456") == "+447911123456"
    for junk in ("junk", "1001", "447911123456", "+1"):
        with pytest.raises(ValueError, match="number must be a phone number"):
            cn.parse_number_param(junk)


def test_precedence_order_and_unknown_products():
    assert cn.ordered_by_product({"voicemail": 1, "zeta": 1, "trunk": 1, "alpha": 1, "rcf": 1}) \
        == {"rcf": 1, "trunk": 1, "voicemail": 1, "alpha": 1, "zeta": 1}
    assert list(cn.ordered_by_product({"voicemail": 1, "rcf": 2})) == ["rcf", "voicemail"]


def test_shape_number_contract():
    rcf = cn.shape_number({"number": "+1", "name": "Main", "product": "rcf",
                           "enabled": True, "forwards_to": "+2", "customer_id": 9})
    assert tuple(rcf) == cn.TENANT_NUMBER_KEYS
    assert rcf == {"number": "+1", "name": "Main", "product": "rcf", "enabled": True,
                   "forwards_to": "+2"}
    vm = cn.shape_number({"number": "+3", "name": "VM", "product": "voicemail",
                          "enabled": None, "forwards_to": "+4", "customer_id": 9})
    assert vm["forwards_to"] is None and vm["enabled"] is False   # rcf only


def test_numbers_count_and_owned_counts_shapes():
    assert cn.numbers_count([]) == {"total": 0, "by_product": {}}
    assert cn.numbers_count([{"product": "voicemail", "n": 1}, {"product": "rcf", "n": 3},
                             {"product": "trunk", "n": 0}]) == {
        "total": 4, "by_product": {"rcf": 3, "voicemail": 1}}
    body = cn.shape_owned_counts([
        {"customer_id": 2, "product": "rcf", "total": 1, "enabled": 0},
        {"customer_id": 1, "product": "voicemail", "total": 2, "enabled": 1},
        {"customer_id": 1, "product": "rcf", "total": 3, "enabled": 3},
    ])
    assert body == {
        "total": 6, "enabled": 4,
        "by_product": {"rcf": {"total": 4, "enabled": 3},
                       "voicemail": {"total": 2, "enabled": 1}},
        "customers": [
            {"customer_id": 1, "total": 5, "enabled": 4,
             "by_product": {"rcf": {"total": 3, "enabled": 3},
                            "voicemail": {"total": 2, "enabled": 1}}},
            {"customer_id": 2, "total": 1, "enabled": 0,
             "by_product": {"rcf": {"total": 1, "enabled": 0}}},
        ]}
    assert list(body["customers"][0]["by_product"]) == ["rcf", "voicemail"]
    assert cn.shape_owned_counts([]) == {"total": 0, "enabled": 0, "by_product": {},
                                         "customers": []}


def test_voicemail_outcome_label():
    assert rp.outcome_fields(True, "NORMAL_CLEARING", "voicemail") == {
        "outcome": "answered", "outcome_label": "Answered by voicemail", "missed_reason": None}
    assert rp.outcome_fields(True, "NORMAL_CLEARING", "rcf")["outcome_label"] == "Answered"
    assert rp.outcome_fields(True, None)["outcome_label"] == "Answered"
    # a missed voicemail call is just missed (the mailbox never answered)
    assert rp.outcome_fields(False, "NO_ANSWER", "voicemail")["outcome_label"] == "Nobody picked up"


def test_migration_57_header_and_check_migrations_row():
    txt = MIG_57.read_text()
    assert "CREATE INDEX IF NOT EXISTS idx_trunk_dids_trunk ON trunk_dids (trunk_id);" in txt
    assert "SET LOCAL lock_timeout = '5s';" in txt
    assert ("sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f "
            "/opt/revup/docker/postgres/init/57_trunk_dids_trunk_index.sql") in txt
    chk = (REPO / "scripts" / "db" / "check_migrations.sql").read_text()
    assert chk.splitlines()[0].startswith(
        "-- Read-only: reports which hand-applied migrations (22..57)")
    assert ("('57_trunk_dids_trunk_index', to_regclass('public.idx_trunk_dids_trunk') "
            "IS NOT NULL)") in chk
    assert "| `57_trunk_dids_trunk_index.sql` |" in (
        REPO / "docker" / "postgres" / "CLAUDE.md").read_text()


# ---------------------------------------------------------------------------
# 2) Integration: real chain + routers on an ephemeral PostgreSQL 16
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for integration tests")
httpx = pytest.importorskip("httpx", reason="httpx required for integration tests")

from voicemail_db import (  # noqa: E402
    CHECK_MIGRATIONS,
    INIT,
    PREREQ_SCRIPTS,
    EphemeralPG,
    apply_prerequisites,
    apply_voicemail_schema,
    find_pg_bin,
)

PG_BIN = find_pg_bin()
PORT = 55481   # distinct from every other test module

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


C1, C2, C3 = 101, 202, 303
T1, T2, T3 = 71, 72, 73
VM_ON, VM_SUSP, VM_DEL, VM_C2 = 501, 502, 503, 504
R1_AT = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)

# C1 (hybrid, voicemail entitled)
R1 = "+16175551001"        # rcf, enabled, in did_inventory
R2 = "+16175551002"        # rcf, DISABLED -> still owned, enabled=false
TD1 = "+16175551003"       # trunk DID on enabled trunk T1
TD2 = "+16175551004"       # trunk DID on DISABLED trunk T2 -> owned, enabled=false
VM1 = "+16175551005"       # mailbox active -> enabled
VM2 = "+16175551006"       # mailbox suspended -> enabled=false
VM3 = "+16175551007"       # mailbox DELETED -> not owned
API1 = "+16175551008"      # api DID -> hidden from customer lists
DUP = "+16175551009"       # planted in rcf_numbers AND trunk_dids -> one row, rcf wins
# C2 (rcf, voicemail NOT entitled)
C2_RCF = "+12085552002"
C2_VM = "+12085552001"     # mailbox active but voicemail_enabled=false -> enabled=false
# C3 (trunk, credential auth) — only for the /search/did golden compare
C3_TD = "+13125553001"

SEED_SQL = f"""
INSERT INTO customers (id, name, account_type, status, voicemail_enabled) VALUES
  ({C1}, 'Granite Test', 'hybrid', 'active', true),
  ({C2}, 'Beta Co', 'rcf', 'suspended', false),
  ({C3}, 'Gamma LLC', 'trunk', 'active', false);
INSERT INTO rcf_numbers (customer_id, did, name, forward_to, enabled, failover_to,
                         ring_timeout, pass_caller_id) VALUES
  ({C1}, '{R1}', 'Main line', '+17745550000', true, '+17745550009', 25, false),
  ({C1}, '{R2}', 'Old line', '+17745550001', false, NULL, 30, true),
  ({C1}, '{DUP}', 'Dup line', '+17745550002', true, NULL, 30, true),
  ({C2}, '{C2_RCF}', NULL, '1001', true, NULL, 45, true);
INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, auth_type, enabled) VALUES
  ({T1}, {C1}, 'pbx-1', 10, 'ip', true),
  ({T2}, {C1}, 'pbx-2', 5, 'ip', false),
  ({T3}, {C3}, 'gamma-sbc', 20, 'credential', true);
INSERT INTO trunk_dids (trunk_id, did) VALUES
  ({T1}, '{TD1}'), ({T2}, '{TD2}'), ({T1}, '{DUP}'), ({T3}, '{C3_TD}');
INSERT INTO api_dids (customer_id, did, voice_url, fallback_url, voice_method, enabled) VALUES
  ({C1}, '{API1}', 'https://example.invalid/voice', NULL, 'GET', false);
INSERT INTO voicemail_boxes (id, customer_id, did, label, status) VALUES
  ({VM_ON}, {C1}, '{VM1}', 'Front desk', 'active'),
  ({VM_SUSP}, {C1}, '{VM2}', 'After hours', 'suspended'),
  ({VM_DEL}, {C1}, '{VM3}', 'Gone', 'deleted'),
  ({VM_C2}, {C2}, '{C2_VM}', 'Voicemail', 'active');
INSERT INTO did_inventory (did, customer_id, product_type, status, assigned_at, city, state)
  VALUES ('{R1}', {C1}, 'rcf', 'assigned', '{R1_AT.isoformat()}', 'Boston', 'MA');
"""

#: C1's owned set (number -> name, product, enabled, forwards_to).
C1_OWNED = {
    R1: ("Main line", "rcf", True, "+17745550000"),
    R2: ("Old line", "rcf", False, "+17745550001"),
    TD1: ("pbx-1", "trunk", True, None),
    TD2: ("pbx-2", "trunk", False, None),
    VM1: ("Front desk", "voicemail", True, None),
    VM2: ("After hours", "voicemail", False, None),
    DUP: ("Dup line", "rcf", True, "+17745550002"),
}


#: Production-like volume for the EXPLAIN tests (a separate database, so the
#: API fixture's exact counts stay small): 200 customers, 5000 rcf numbers,
#: 400 trunks with 5000 DIDs, 1000 mailboxes, 1000 api DIDs. On 4-row tables
#: the planner (rightly) prefers full index scans; with real selectivity it
#: must drive every arm off the customer indexes.
PLAN_FILLER_SQL = """
INSERT INTO customers (id, name, account_type, voicemail_enabled)
  SELECT g, 'c' || g, 'hybrid', true FROM generate_series(1000, 1199) g;
INSERT INTO rcf_numbers (customer_id, did, name, forward_to)
  SELECT 1000 + (g % 200), '+1617' || g, 'n', '+17745550000'
    FROM generate_series(2000000, 2004999) g;
INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels)
  SELECT g, 1000 + (g % 200), 't' || g, 10 FROM generate_series(1000, 1399) g;
INSERT INTO trunk_dids (trunk_id, did)
  SELECT 1000 + (g % 400), '+1508' || g FROM generate_series(2000000, 2004999) g;
INSERT INTO voicemail_boxes (customer_id, did, label)
  SELECT 1000 + (g % 200), '+1781' || g, 'VM' FROM generate_series(2000000, 2000999) g;
INSERT INTO api_dids (customer_id, did, voice_url)
  SELECT 1000 + (g % 200), '+1339' || g, 'https://example.invalid/v'
    FROM generate_series(2000000, 2000999) g;
ANALYZE;
"""
PLAN_CUSTOMER = 1007


async def _connect(pg, role="postgres", database="postgres"):
    kw = {"password": "api_secret"} if role == "api" else {}
    return await asyncpg.connect(host=pg.sock, port=pg.port, user=role,
                                 database=database, statement_cache_size=0, **kw)


async def _build_plan_db(pg) -> None:
    """Second database, same REAL chain (+ 57), production-like volume."""
    owner = await _connect(pg)
    try:
        await owner.execute("CREATE DATABASE plandb")
    finally:
        await owner.close()
    conn = await _connect(pg, database="plandb")
    try:
        for name in PREREQ_SCRIPTS:                 # roles already exist (cluster-wide)
            await conn.execute((INIT / name).read_text())
        await apply_voicemail_schema(conn)
        await conn.execute(MIG_57.read_text())
        await conn.execute(PLAN_FILLER_SQL)
    finally:
        await conn.close()


async def _check_migrations(conn) -> dict:
    return {r["migration"]: r["status"] for r in await conn.fetch(CHECK_MIGRATIONS.read_text())}


@pytest.fixture(scope="module")
def numbers_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = EphemeralPG(PG_BIN, PORT)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db
    state = {"pg": pg, "db": db}

    async def _setup():
        owner = await _connect(pg)
        try:
            await apply_prerequisites(owner)
            await apply_voicemail_schema(owner)
            state["check_before"] = await _check_migrations(owner)
            await owner.execute(MIG_57.read_text())
            await owner.execute(MIG_57.read_text())       # idempotent
            state["check_after"] = await _check_migrations(owner)
            state["idx_57"] = await owner.fetch(
                "SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'idx_trunk_dids_trunk'")
            await owner.execute(SEED_SQL)
            await owner.execute("ANALYZE")
        finally:
            await owner.close()
        await _build_plan_db(pg)
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _run(_setup())
    try:
        yield state
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(scope="module")
def client(numbers_db):
    from fastapi import FastAPI
    from fastapi.responses import ORJSONResponse
    from middleware.auth import JWTAuthMiddleware
    from routers import customers, number_inventory, search

    app = FastAPI(default_response_class=ORJSONResponse)
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(customers.router, prefix="/v1/customers")
    app.include_router(number_inventory.router, prefix="/v1/numbers")
    app.include_router(search.router, prefix="/v1/search")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(numbers_db):
    from auth.security import create_access_token

    def mint(sub, role, cid):
        return create_access_token(
            {"sub": sub, "email": f"{sub}@test.local", "role": role, "customer_id": cid})

    return {
        "admin": mint("1", "admin", None),
        "support": mint("2", "support", None),
        "user_c1": mint("3", "user", C1),
        "readonly_c1": mint("4", "readonly", C1),
        "user_c2": mint("5", "user", C2),
    }


def _get(client, tokens, who, path, **params):
    return _run(client.get(path, params=params,
                           headers={"Authorization": f"Bearer {tokens[who]}"}))


def _ok(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _fetch(db, sql, *args):
    async with db.pool.acquire() as conn:
        return await conn.fetch(sql, *args)


def _owned(numbers_db, customer_id):
    rows = _run(_fetch(numbers_db["db"], cn.owned_numbers_sql("$1::int"), customer_id))
    return {r["number"]: (r["name"], r["product"], r["enabled"], r["forwards_to"]) for r in rows}


# -- helper semantics ---------------------------------------------------------
def test_owned_set_semantics(numbers_db):
    owned = _owned(numbers_db, C1)
    assert owned == C1_OWNED
    assert VM3 not in owned          # deleted mailbox: not ours any more
    assert API1 not in owned         # api: hidden (retired)
    assert C2_RCF not in owned and C2_VM not in owned


def test_dup_did_listed_once_rcf_wins(numbers_db):
    rows = _run(_fetch(numbers_db["db"],
                       f"SELECT * FROM ({cn.owned_numbers_sql('$1::int')}) o WHERE number = $2",
                       C1, DUP))
    assert len(rows) == 1 and rows[0]["product"] == "rcf"
    # the raw view really has both arms for it
    raw = _run(_fetch(numbers_db["db"], "SELECT product_type FROM number_routing WHERE did = $1", DUP))
    assert sorted(r["product_type"] for r in raw) == ["rcf", "trunk"]


def test_voicemail_entitlement_off_means_disabled(numbers_db):
    # C2 is ALSO suspended: customer status is NOT applied (still their numbers)
    assert _owned(numbers_db, C2) == {
        C2_RCF: (None, "rcf", True, "1001"),
        C2_VM: ("Voicemail", "voicemail", False, None),
    }


def test_all_customers_variant(numbers_db):
    rows = _run(_fetch(numbers_db["db"], cn.owned_numbers_sql(None)))
    by_cust = {}
    for r in rows:
        by_cust.setdefault(r["customer_id"], set()).add(r["number"])
    assert by_cust == {C1: set(C1_OWNED), C2: {C2_RCF, C2_VM}, C3: {C3_TD}}
    assert len(rows) == len({r["number"] for r in rows})        # one row per DID


# -- performance: every arm on its customer index -----------------------------
async def _explain(pg, sql, *args, seqscan_off=True):
    """EXPLAIN on the production-volume plandb, as the api role."""
    conn = await _connect(pg, role="api", database="plandb")
    try:
        async with conn.transaction():
            if seqscan_off:
                await conn.execute("SET LOCAL enable_seqscan = off")
            rows = await conn.fetch("EXPLAIN " + sql, *args)
    finally:
        await conn.close()
    return [r[0] for r in rows]


#: index -> the Index Cond it must carry (a full index scan without a
#: customer condition would also "name" the index — that must not pass).
_ARM_INDEXES = {
    "idx_rcf_customer": f"Index Cond: (customer_id = {PLAN_CUSTOMER})",
    "idx_trunks_customer": f"Index Cond: (customer_id = {PLAN_CUSTOMER})",
    "idx_trunk_dids_trunk": "Index Cond: (trunk_id = t.id)",
    "idx_voicemail_boxes_customer": f"Index Cond: (customer_id = {PLAN_CUSTOMER})",
}


def _assert_driven_by(lines, indexes):
    text = "\n".join(lines)
    for idx, cond in indexes.items():
        # "Index Scan using <idx>" / "Bitmap Index Scan on <idx>"
        at = [i for i, ln in enumerate(lines)
              if f"using {idx} " in ln or f"Index Scan on {idx} " in ln]
        assert at, f"{idx} missing:\n{text}"
        assert any(cond in lines[i + 1] for i in at if i + 1 < len(lines)), \
            f"{idx} without '{cond}':\n{text}"
    for table in ("rcf_numbers", "trunk_dids", "sip_trunks", "voicemail_boxes", "api_dids"):
        assert f"Seq Scan on {table}" not in text, text


@pytest.mark.parametrize("seqscan_off", [True, False])
def test_owned_set_uses_customer_index_on_every_arm(numbers_db, seqscan_off):
    """Even with the DEFAULT planner (seqscan_off=False) on production-like
    volume, every product arm is driven by its customer index (57 supplies
    the trunk_dids one)."""
    lines = _run(_explain(numbers_db["pg"], cn.owned_numbers_sql("$1::int"), PLAN_CUSTOMER,
                          seqscan_off=seqscan_off))
    _assert_driven_by(lines, _ARM_INDEXES)
    # The hidden api arm is pruned at plan time ('api' NOT IN ('api') is a
    # constant false): api_dids is not read at all.
    assert not any("api_dids" in ln for ln in lines), "\n".join(lines)


def test_unfiltered_view_api_arm_uses_customer_index(numbers_db):
    """The /numbers/my fallback arm reads the view by customer WITHOUT the
    hidden-product filter: the api arm must use idx_api_did_customer too."""
    lines = _run(_explain(numbers_db["pg"],
                          "SELECT * FROM number_routing WHERE customer_id = $1::int",
                          PLAN_CUSTOMER))
    _assert_driven_by(lines, {**_ARM_INDEXES, "idx_api_did_customer":
                              f"Index Cond: (customer_id = {PLAN_CUSTOMER})"})


# -- migration 57 -------------------------------------------------------------
def test_migration_57_applied_idempotent_and_checked(numbers_db):
    assert numbers_db["check_before"]["57_trunk_dids_trunk_index"] == "*** MISSING ***"
    assert numbers_db["check_after"]["57_trunk_dids_trunk_index"] == "applied"
    assert numbers_db["check_after"]["22_number_routing"] == "applied"
    (idx,) = numbers_db["idx_57"]
    assert idx["indexdef"] == ("CREATE INDEX idx_trunk_dids_trunk ON public.trunk_dids "
                               "USING btree (trunk_id)")


# -- canonicalization parity ---------------------------------------------------
_PARITY_INPUTS = [
    "+16175550101", "6175550101", "16175550101", "(617) 555-0101", "617-555-0101",
    "617.555.0101", "1 (617) 555-0101", "+1 (617) 555-0101", "+1-617-555-0101",
    "+447911123456", "+5215512345678",
]
#: Python rejects these; SQL must pass the RAW value through (never canonical).
_REJECTED_INPUTS = ["1001", "447911123456", "anonymous", "", "0175550101", "1175550101"]
#: Known divergence: SQL returns the raw value where Python canonicalizes (a
#: formatted international number) or rejects (a too-short '+' number). Safe
#: direction: it can only fail to match a DID, never match the wrong one.
_DIVERGENT_INPUTS = ["+44 7911 123456", "+1234567"]


def test_cdr_customer_number_sql_parity(numbers_db):
    inputs = _PARITY_INPUTS + _REJECTED_INPUTS + _DIVERGENT_INPUTS
    sql = (f"SELECT v.raw, {cn.cdr_customer_number_sql('v')} AS canon_in, "
           f"{cn.cdr_customer_number_sql('w')} AS canon_out "
           "FROM unnest($1::text[]) AS v0(raw) "
           "CROSS JOIN LATERAL (SELECT 'inbound'::text AS direction, 'x'::text AS caller_id, "
           "v0.raw AS destination, v0.raw AS raw) v "
           "CROSS JOIN LATERAL (SELECT 'outbound'::text AS direction, v0.raw AS caller_id, "
           "'x'::text AS destination) w")
    rows = _run(_fetch(numbers_db["db"], sql, inputs))
    got = {r["raw"]: (r["canon_in"], r["canon_out"]) for r in rows}
    for raw in _PARITY_INPUTS:
        assert got[raw] == (normalize_e164(raw), normalize_e164(raw)), raw
    for raw in _REJECTED_INPUTS:
        with pytest.raises(ValueError):
            normalize_e164(raw)
        assert got[raw] == (raw, raw), raw
    for raw in _DIVERGENT_INPUTS:
        assert got[raw] == (raw, raw), raw
    # anything not 'outbound' is inbound (destination side)
    rows = _run(_fetch(numbers_db["db"],
                       f"SELECT {cn.cdr_customer_number_sql('v')} AS n FROM (VALUES "
                       "(NULL::text, '6175550199', '6175550101')) v(direction, caller_id, destination)"))
    assert rows[0]["n"] == "+16175550101"


# -- GET /v1/numbers/owned ------------------------------------------------------
def test_numbers_owned_body(client, tokens):
    body = _ok(_get(client, tokens, "admin", "/v1/numbers/owned"))
    assert body == {
        "total": 10, "enabled": 6,
        "by_product": {"rcf": {"total": 4, "enabled": 3},
                       "trunk": {"total": 3, "enabled": 2},
                       "voicemail": {"total": 3, "enabled": 1}},
        "customers": [
            {"customer_id": C1, "total": 7, "enabled": 4,
             "by_product": {"rcf": {"total": 3, "enabled": 2},
                            "trunk": {"total": 2, "enabled": 1},
                            "voicemail": {"total": 2, "enabled": 1}}},
            {"customer_id": C2, "total": 2, "enabled": 1,
             "by_product": {"rcf": {"total": 1, "enabled": 1},
                            "voicemail": {"total": 1, "enabled": 0}}},
            {"customer_id": C3, "total": 1, "enabled": 1,
             "by_product": {"trunk": {"total": 1, "enabled": 1}}},
        ]}
    assert list(body["by_product"]) == ["rcf", "trunk", "voicemail"]
    assert "api" not in json.dumps(body)


@pytest.mark.parametrize("who", ["user_c1", "readonly_c1", "support"])
def test_numbers_owned_admin_only(client, tokens, who):
    assert _get(client, tokens, who, "/v1/numbers/owned").status_code == 403


def test_numbers_owned_unauthenticated(client):
    assert _run(client.get("/v1/numbers/owned")).status_code == 401


# -- GET /v1/numbers/my --------------------------------------------------------
def test_numbers_my_tenant_fallback_from_number_routing(client, tokens):
    rows = _ok(_get(client, tokens, "user_c1", "/v1/numbers/my"))
    by = {r["did"]: r for r in rows}
    dids = [r["did"] for r in rows]
    assert dids == sorted(dids)                                      # ORDER BY did
    # every product incl. api (admin cleanup tool); never the deleted box
    assert set(by) == set(C1_OWNED) | {API1}
    assert VM3 not in by
    # the did_inventory row wins for R1 (lifecycle record, assigned_at kept)
    assert by[R1]["status"] == "assigned" and by[R1]["city"] == "Boston"
    assert datetime.fromisoformat(by[R1]["assigned_at"]) == R1_AT
    # fallback-only rows: number_routing product, status assigned, assigned_at null
    for did in set(by) - {R1}:
        assert by[did]["status"] == "assigned" and by[did]["assigned_at"] is None, by[did]
        assert by[did]["customer_id"] == C1 and by[did]["customer_name"] == "Granite Test"
    assert by[VM1]["product_type"] == "voicemail" and by[VM2]["product_type"] == "voicemail"
    assert by[TD2]["product_type"] == "trunk" and by[API1]["product_type"] == "api"
    assert by[DUP]["product_type"] in ("rcf", "trunk")       # UNION keeps both arms' rows
    assert set(rows[0]) == {"did", "product_type", "status", "city", "state", "assigned_at",
                            "notes", "customer_id", "customer_name"}


def test_numbers_my_admin_all_customers(client, tokens):
    rows = _ok(_get(client, tokens, "admin", "/v1/numbers/my"))
    dids = {r["did"] for r in rows}
    assert {R1, VM1, VM2, C2_VM, C2_RCF, C3_TD, API1} <= dids
    assert VM3 not in dids
    assert _get(client, tokens, "support", "/v1/numbers/my").status_code == 403


def test_numbers_my_other_tenant(client, tokens):
    rows = _ok(_get(client, tokens, "user_c2", "/v1/numbers/my"))
    assert {r["did"] for r in rows} == {C2_RCF, C2_VM}


# -- GET /v1/search/did: golden compare vs the OLD per-table query -------------
#: The pre-number_routing /search/did query text, VERBATIM (RCF-V1 @ 1aa0104,
#: routers/search.py), with-q variant. Its rcf/api/trunk rows must be
#: byte-identical to the new query's.
_OLD_SEARCH_SQL = """
        WITH matched AS (
            -- RCF
            SELECT
                r.did,
                'rcf'::text              AS product,
                c.id                     AS customer_id,
                c.name                   AS customer_name,
                CASE WHEN r.enabled THEN 'active' ELSE 'disabled' END AS status,
                jsonb_build_object(
                    'name',           r.name,
                    'forward_to',     r.forward_to,
                    'enabled',        r.enabled,
                    'ring_timeout',   r.ring_timeout,
                    'failover_to',    r.failover_to,
                    'pass_caller_id', r.pass_caller_id
                ) AS details
            FROM rcf_numbers r
            JOIN customers c ON c.id = r.customer_id
            WHERE r.did LIKE $1

            UNION ALL

            -- API Calling
            SELECT
                a.did,
                'api'::text              AS product,
                c.id                     AS customer_id,
                c.name                   AS customer_name,
                CASE WHEN a.enabled THEN 'active' ELSE 'disabled' END AS status,
                jsonb_build_object(
                    'voice_url',      a.voice_url,
                    'fallback_url',   a.fallback_url,
                    'voice_method',   a.voice_method,
                    'enabled',        a.enabled
                ) AS details
            FROM api_dids a
            JOIN customers c ON c.id = a.customer_id
            WHERE a.did LIKE $1

            UNION ALL

            -- SIP Trunk
            SELECT
                td.did,
                'trunk'::text            AS product,
                c.id                     AS customer_id,
                c.name                   AS customer_name,
                CASE WHEN t.enabled THEN 'active' ELSE 'disabled' END AS status,
                jsonb_build_object(
                    'trunk_id',       t.id,
                    'trunk_name',     t.trunk_name,
                    'trunk_enabled',  t.enabled,
                    'max_channels',   t.max_channels,
                    'auth_type',      t.auth_type
                ) AS details
            FROM trunk_dids td
            JOIN sip_trunks t ON t.id = td.trunk_id
            JOIN customers c  ON c.id = t.customer_id
            WHERE td.did LIKE $1
        )
        SELECT *, COUNT(*) OVER() AS _total
        FROM matched
        ORDER BY did
        LIMIT $2 OFFSET $3
        """


def _rows_key(rows):
    """(did, product) -> (customer_id, customer_name, status, details-as-text)."""
    return {(r["did"], r["product"]): (r["customer_id"], r["customer_name"], r["status"],
                                       r["details"] if isinstance(r["details"], str)
                                       else json.dumps(r["details"]))
            for r in rows}


@pytest.mark.parametrize("pattern", ["%%", "%617%", "%5551009%", "%312%"])
def test_search_did_golden_compare_old_query(numbers_db, pattern):
    from routers import search
    db = numbers_db["db"]
    old = _rows_key(_run(_fetch(db, _OLD_SEARCH_SQL, pattern, 10_000, 0)))
    new_rows = _run(_fetch(db, search.did_search_sql(True), pattern, 10_000, 0))
    new = _rows_key(r for r in new_rows if r["product"] != "voicemail")
    assert old, "golden compare needs rows"
    # jsonb text is canonical (sorted keys): byte-identical details + status
    assert new == old
    # and every product (incl. api) is present for the admin tool
    if pattern == "%%":
        assert {p for _, p in old} == {"rcf", "api", "trunk"}


def test_search_did_list_all_matches_old_and_adds_voicemail(numbers_db):
    from routers import search
    db = numbers_db["db"]
    old = _rows_key(_run(_fetch(db, _OLD_SEARCH_SQL, "%", 10_000, 0)))
    new_rows = _run(_fetch(db, search.did_search_sql(False), 10_000, 0))
    assert _rows_key(r for r in new_rows if r["product"] != "voicemail") == old
    vm = {r["did"] for r in new_rows if r["product"] == "voicemail"}
    assert vm == {VM1, VM2, C2_VM}                                   # never the deleted box
    assert {int(r["_total"]) for r in new_rows} == {len(new_rows)}


def test_search_did_http_voicemail_details(client, tokens):
    body = _ok(_get(client, tokens, "admin", "/v1/search/did", q="617555100", limit=200))
    by = {(r["did"], r["product"]): r for r in body["results"]}
    assert body["total"] == len(body["results"])
    assert by[(VM1, "voicemail")] == {
        "did": VM1, "product": "voicemail", "customer_id": C1, "customer_name": "Granite Test",
        "status": "active",
        "details": {"label": "Front desk", "mailbox_id": VM_ON, "enabled": True}}
    assert by[(VM2, "voicemail")]["status"] == "disabled"
    assert by[(VM2, "voicemail")]["details"] == {
        "label": "After hours", "mailbox_id": VM_SUSP, "enabled": False}
    assert (VM3, "voicemail") not in by
    # existing products: same shapes as before
    assert by[(R1, "rcf")]["details"] == {
        "name": "Main line", "forward_to": "+17745550000", "enabled": True,
        "ring_timeout": 25, "failover_to": "+17745550009", "pass_caller_id": False}
    assert by[(TD2, "trunk")]["status"] == "disabled"
    assert by[(API1, "api")]["details"] == {
        "voice_url": "https://example.invalid/voice", "fallback_url": None,
        "voice_method": "GET", "enabled": False}
    assert (DUP, "rcf") in by and (DUP, "trunk") in by          # admin sees both arms
    # pagination: ordered by did then product precedence, stable across pages
    p1 = _ok(_get(client, tokens, "admin", "/v1/search/did", limit=3))
    p2 = _ok(_get(client, tokens, "admin", "/v1/search/did", limit=3, offset=3))
    keys = [(r["did"], r["product"]) for r in p1["results"] + p2["results"]]
    assert len(set(keys)) == 6 and keys == sorted(
        keys, key=lambda k: (k[0], cn.product_sort_key(k[1])))
    # rcf 4 + api 1 + trunk 4 (DUP's trunk arm too) + voicemail 3 (not the deleted box)
    assert p1["total"] == p2["total"] == 12
    assert _get(client, tokens, "user_c1", "/v1/search/did", q="617").status_code == 403


# -- GET /v1/customers/me counts.numbers -----------------------------------------
def test_customers_me_counts_numbers(client, tokens):
    for who in ("user_c1", "readonly_c1"):
        me = _ok(_get(client, tokens, who, "/v1/customers/me"))
        assert me["counts"] == {
            "rcf": 3, "api_dids": 0, "trunks": 2,
            "numbers": {"total": 7, "by_product": {"rcf": 3, "trunk": 2, "voicemail": 2}}}
        assert list(me["counts"]["numbers"]["by_product"]) == ["rcf", "trunk", "voicemail"]
        assert "product_ref_id" not in json.dumps(me) and "customer_status" not in json.dumps(me)
    me = _ok(_get(client, tokens, "user_c2", "/v1/customers/me"))
    assert me["counts"]["numbers"] == {"total": 2, "by_product": {"rcf": 1, "voicemail": 1}}


def test_customers_me_api_hidden_even_when_flag_on(client, tokens, monkeypatch):
    monkeypatch.setenv("API_CALLING_ENABLED", "true")
    me = _ok(_get(client, tokens, "user_c1", "/v1/customers/me"))
    assert me["counts"]["api_dids"] == 1                     # legacy key, flag on
    assert "api" not in me["counts"]["numbers"]["by_product"]
    assert me["counts"]["numbers"]["total"] == 7
