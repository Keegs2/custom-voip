"""Customer Reporting (/v1/reports) — contract + safety tests.

Contract: docs/CUSTOMER_REPORTING_DESIGN.md.

Covers:
  * services/reporting.py pure logic — date/span validation (366-day cap),
    bucket auto-selection, missed-reason mapping, MOS grade thresholds,
    numbers-filter canonicalization, CSV formula-injection guard.
  * The REAL router over an ephemeral PostgreSQL 16 behind the REAL JWT
    middleware with REAL minted JWTs (same harness as
    test_tenant_redaction.py): two customers, rcf + trunk + voicemail
    numbers (+ a suspended and a deleted mailbox and a hidden api DID), CDRs
    straddling America/Boise local-day boundaries. The product tables and
    the number_routing view come from the REAL init chain (02 03 09 17 20 22
    24 31 34 -> 54 -> 56 -> 57): "the customer's numbers" is
    services/customer_numbers.py over number_routing.
      - exact response shapes for overview / trend / numbers / calls /
        calls.csv / my-numbers (every product; api hidden; deleted box out)
      - voicemail: per-number rows, the `numbers` filter, call `product` +
        "Answered by voicemail" (JSON + CSV), on-net RCF -> voicemail
        attributed to the dialed RCF number, calls to a released number
        counted in totals with no number row
      - tenant isolation (customer_id param + numbers param cannot widen)
      - staff must pass customer_id (422)
      - minutes rounded ONCE at the aggregate; no seconds / costs /
        answer/end timestamps / raw hangup causes anywhere (JSON + CSV)
      - tz day boundaries (23:30 Boise lands on the Boise date)
      - zero-filled trend buckets (day / week / auto month)
      - unknown tz 422; CSV header / escaping / truncation header
  * Per-customer byte identity: the sha256 of the SQL (+ bind types) every
    one-customer request runs, and of its response, pinned at RCF-V1 202f51b.
  * Staff "all customers" (all_customers=true): every endpoint over A + B,
    unattributed customer_id 0 rows (z01-z03) never counted, rows carry
    customer_id + customer_name, the CSV's leading Customer column, tenants
    ignore the flag, both-params / numbers-filter 422s, the fail-closed
    $1/$5 guards and the start_time-index plan shape.

Run:  python -m pytest -q -p no:cacheprovider tests/test_reports.py
"""
import asyncio
import csv
import io
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import reporting as rp  # noqa: E402  (pure; no DB deps)
from services import tenant_redaction as tr  # noqa: E402


# ---------------------------------------------------------------------------
# 1) Pure logic (no DB)
# ---------------------------------------------------------------------------
def test_period_validation_and_366_day_cap():
    p = rp.parse_period("2026-08-01", "2026-08-31")
    assert p.days == 31
    assert p.previous() == rp.Period(date(2026, 7, 1), date(2026, 7, 31))
    assert rp.parse_period("2026-01-01", "2027-01-01").days == 366   # at cap: ok
    with pytest.raises(rp.ReportValidationError):
        rp.parse_period("2026-01-01", "2027-01-02")                   # 367
    with pytest.raises(rp.ReportValidationError):
        rp.parse_period("2026-08-02", "2026-08-01")                   # end < start
    for bad in ("2026-8-1", "2026-02-30", "20260801", "", None, "2026-08-01T00:00"):
        with pytest.raises(rp.ReportValidationError):
            rp.parse_period(bad, "2026-08-31")


@pytest.mark.parametrize("days,bucket", [
    (1, "day"), (62, "day"), (63, "week"), (190, "week"), (191, "month"), (366, "month"),
])
def test_auto_bucket(days, bucket):
    assert rp.auto_bucket(days) == bucket
    assert rp.choose_bucket(None, days) == bucket


def test_explicit_bucket_validated():
    assert rp.choose_bucket("week", 5) == "week"
    with pytest.raises(rp.ReportValidationError):
        rp.choose_bucket("hour", 5)


@pytest.mark.parametrize("cause,key", [
    ("NO_ANSWER", "no_answer"), ("NO_USER_RESPONSE", "no_answer"),
    ("ALLOTTED_TIMEOUT", "no_answer"), ("ORIGINATOR_CANCEL", "caller_hung_up"),
    ("USER_BUSY", "busy"), ("UNALLOCATED_NUMBER", "not_in_service"),
    ("INVALID_NUMBER_FORMAT", "not_in_service"), ("NO_ROUTE_DESTINATION", "not_in_service"),
    ("CALL_REJECTED", "declined"), ("NORMAL_TEMPORARY_FAILURE", "network"),
    ("NORMAL_CLEARING", "network"), ("", "network"), (None, "network"),
    ("no_answer", "no_answer"),
])
def test_missed_reason_mapping(cause, key):
    assert rp.missed_reason_key(cause) == key


def test_missed_reasons_list_sorted_and_labelled():
    out = rp.missed_reasons_list([
        ("USER_BUSY", 1), ("NO_ANSWER", 2), ("NO_USER_RESPONSE", 1),
        ("WEIRD", 1), ("CALL_REJECTED", 0)])
    assert out == [
        {"key": "no_answer", "label": "Nobody picked up", "calls": 3},
        {"key": "busy", "label": "The line was busy", "calls": 1},
        {"key": "network", "label": "A network problem stopped the call", "calls": 1},
    ]


@pytest.mark.parametrize("mos,grade", [
    # docs/CALL_QUALITY_ACCURACY_PLAN.md §D — G.107/G.109 R bands 90/80/70
    (None, "none"), (4.5, "great"), (4.41, "great"), (4.34, "great"), (4.33, "good"),
    (4.02, "good"), (4.01, "fair"), (3.6, "fair"), (3.59, "poor"), (1.0, "poor"),
])
def test_grade_thresholds(mos, grade):
    assert rp.grade_for_mos(mos) == grade


def test_grade_delegates_to_call_quality():
    from services import call_quality as cq
    for i in range(100, 451):
        m = i / 100
        assert rp.grade_for_mos(m) == (cq.grade_for_mos(m) or "none")


def test_numbers_filter_canonicalizes_and_drops_junk():
    assert rp.parse_numbers_filter(None) is None
    assert rp.parse_numbers_filter(" ") is None
    assert rp.parse_numbers_filter("6175550101, +16175550101,junk,(617) 555-0202") == [
        "+16175550101", "+16175550202"]
    assert rp.parse_numbers_filter("junk,1001") == []      # narrows to nothing
    with pytest.raises(rp.ReportValidationError):
        rp.parse_numbers_filter(",".join(f"+1617555{i:04d}" for i in range(501)))


def test_csv_safe_guards_formulas_but_not_phone_numbers():
    assert rp.csv_safe("+16175550101") == "+16175550101"
    assert rp.csv_safe("=cmd|x") == "'=cmd|x"
    assert rp.csv_safe("@SUM(A1)") == "'@SUM(A1)"
    assert rp.csv_safe("+SUM(A1)") == "'+SUM(A1)"
    assert rp.csv_safe("-2+3") == "'-2+3"
    assert rp.csv_safe("+1 (617) 555-0101") == "+1 (617) 555-0101"
    assert rp.csv_safe("\t=1") == "'\t=1"
    assert rp.csv_safe(None) == ""


def test_pct_and_offsets():
    assert rp.pct(4, 11) == 36.4
    assert rp.pct(0, 0) is None
    assert rp.format_offset(-6 * 3600) == "-06:00"
    assert rp.format_offset(5 * 3600 + 1800) == "+05:30"


# ---------------------------------------------------------------------------
# 2) Integration: real router + ephemeral PostgreSQL
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for integration tests")
httpx = pytest.importorskip("httpx", reason="httpx required for integration tests")

from cdr_schema import apply_cdr_column_migrations  # noqa: E402
from test_tenant_redaction import _CDR_SCHEMA, _EphemeralPG, _find_pg_bin  # noqa: E402
from voicemail_db import (  # noqa: E402
    INIT, apply_prerequisites, apply_voicemail_schema, seed_token_users,
)

MIG_57 = INIT / "57_trunk_dids_trunk_index.sql"

PG_BIN = _find_pg_bin()


class _ReportsPG(_EphemeralPG):
    def __init__(self, pg_bin):
        super().__init__(pg_bin)
        self.port = 55440   # distinct from every other test module


_LOOP = asyncio.new_event_loop()
_PG: dict = {}


def _run(coro):
    return _LOOP.run_until_complete(coro)


BOISE = ZoneInfo("America/Boise")
CID_A, CID_B = 101, 202
CID_NONE = 0          # cdrs.customer_id of an unattributed call (ingest default)
TRUNK_A = 71
A_MAIN = "+16175550101"     # rcf, "Main line"
A_TRUNK = "+16175550202"    # trunk DID on trunk 'alpha'
A_SPARE = "+16175550303"    # rcf, zero calls
A_VM = "+16175550404"       # voicemail mailbox (active)
A_VM_OFF = "+16175550505"   # voicemail mailbox (suspended) -> owned, enabled=false
A_VM_GONE = "+16175550606"  # voicemail mailbox DELETED -> not owned any more
A_API = "+16175550707"      # api DID (API Calling retired) -> hidden
B_MAIN = "+12085550900"     # tenant B rcf

# Seeded durations: none of these ms values (nor 95 s) may appear anywhere
# in a report response.
SEEDED_MS = {20_000, 30_000, 40_000, 60_000, 95_000, 155_000, 195_000, 215_000}


def _utc(y, mo, d, h, mi, s=0):
    """Boise-local wall time -> aware UTC."""
    return datetime(y, mo, d, h, mi, s, tzinfo=BOISE).astimezone(timezone.utc)


#       uuid   customer  local (Boise)             dir         caller          dest          ms      answered cause                     mos   trunk
CDRS = [
    ("a01", CID_A, (2026, 7, 15, 12, 0), "inbound", "+12085550001", A_MAIN, 60_000, True, "NORMAL_CLEARING", 4.5, None),
    ("a02", CID_A, (2026, 7, 31, 23, 30), "inbound", "+12085550002", A_MAIN, 20_000, True, "NORMAL_CLEARING", 4.1, None),
    ("a03", CID_A, (2026, 8, 1, 0, 5), "inbound", "+12085550003", A_MAIN, 20_000, True, "NORMAL_CLEARING", 4.1, None),
    ("a04", CID_A, (2026, 8, 14, 10, 2, 31), "inbound", "+12085550100", A_MAIN, 20_000, True, "NORMAL_CLEARING", 3.7, None),
    ("a05", CID_A, (2026, 8, 14, 10, 30), "inbound", "+12085550005", A_MAIN, 30_000, False, "NO_ANSWER", None, None),
    ("a06", CID_A, (2026, 8, 14, 23, 30), "inbound", "+12085550006", A_MAIN, 95_000, True, "NORMAL_CLEARING", 4.3, None),
    ("a07", CID_A, (2026, 8, 20, 10, 15), "outbound", "6175550202", "+12125551111", 20_000, True, "NORMAL_CLEARING", 3.0, TRUNK_A),
    ("a08", CID_A, (2026, 8, 21, 8, 0), "inbound", "+12085550008", A_TRUNK, 0, False, "ORIGINATOR_CANCEL", None, TRUNK_A),
    ("a09", CID_A, (2026, 8, 22, 9, 0), "inbound", "+12085550009", A_TRUNK, 0, False, "USER_BUSY", None, TRUNK_A),
    ("a10", CID_A, (2026, 8, 22, 9, 10), "outbound", A_TRUNK, "+12125550000", 0, False, "UNALLOCATED_NUMBER", None, TRUNK_A),
    ("a11", CID_A, (2026, 8, 22, 9, 20), "inbound", "+12085550011", A_MAIN, 0, False, "CALL_REJECTED", None, None),
    ("a12", CID_A, (2026, 8, 23, 10, 0), "inbound", '=cmd|"x",1', A_MAIN, 0, False, "NORMAL_TEMPORARY_FAILURE", None, None),
    ("a13", CID_A, (2026, 8, 31, 23, 59), "inbound", "+12085550013", A_MAIN, 0, False, "NO_USER_RESPONSE", None, None),
    ("a14", CID_A, (2026, 9, 1, 0, 10), "inbound", "+12085550014", A_MAIN, 20_000, True, "NORMAL_CLEARING", None, None),
    ("a15", CID_A, (2026, 8, 25, 11, 0), "inbound", "+12085550015", A_MAIN, 20_000, True, "NORMAL_CLEARING", None, None),
    ("a16", CID_A, (2026, 8, 25, 11, 5), "inbound", "+12085550016", A_MAIN, 20_000, True, "NORMAL_CLEARING", None, None),
    ("a17", CID_A, (2026, 8, 25, 11, 10), "inbound", "+12085550017", A_MAIN, 20_000, True, "NORMAL_CLEARING", None, None),
    # tenant B — including a CDR whose destination is one of A's numbers
    ("b01", CID_B, (2026, 8, 14, 12, 0), "inbound", "+12085559999", B_MAIN, 60_000, True, "NORMAL_CLEARING", 4.4, None),
    ("b02", CID_B, (2026, 8, 14, 12, 5), "inbound", "+12085559998", A_MAIN, 60_000, True, "NORMAL_CLEARING", 4.4, None),
    # UNATTRIBUTED rows (customer_id 0 = the CDR ingest default when FS sent
    # no customer): no customer's report — not even staff "all customers" —
    # may count them. z01 even dials A's number; z03 is older than every
    # attributed call (it would move "data_available_from").
    ("z01", CID_NONE, (2026, 8, 14, 10, 45), "inbound", "+12085550771", A_MAIN, 40_000, True, "NORMAL_CLEARING", 4.4, None),
    ("z02", CID_NONE, (2026, 8, 20, 9, 0), "inbound", "+12085550772", "+13125550000", 0, False, "NO_ANSWER", None, None),
    ("z03", CID_NONE, (2026, 7, 1, 8, 0), "inbound", "+12085550773", B_MAIN, 20_000, True, "NORMAL_CLEARING", None, None),
]
_UNATTRIBUTED_CALLERS = ("+12085550771", "+12085550772", "+12085550773")


#: Voicemail CDRs (2026-09-15 Boise — outside AUG, so the August
#: expectations above are untouched). product_type='voicemail',
#: direction inbound, customer_id = the mailbox owner (FS dispatch_terminal).
#:   v01 direct dial to A's mailbox
#:   v02 on-net RCF -> voicemail forward: destination = the DIALED RCF DID
#:       (A_MAIN), on_net, origin = A (plan §3.2: attributed to the dialed number)
#:   v03 to a since-deleted mailbox DID: in totals, no number row
#:   uuid   local (Boise)           caller          dest       ms      on_net
VM_CDRS = [
    ("v01", (2026, 9, 15, 9, 0), "+12085550101", A_VM, 30_000, False),
    ("v02", (2026, 9, 15, 9, 30), "+12085550102", A_MAIN, 60_000, True),
    ("v03", (2026, 9, 15, 10, 0), "+12085550103", A_VM_GONE, 20_000, False),
]

#: A calls that also carry carrier B-leg rows (every report must still count
#: each of these ONCE — `leg IS DISTINCT FROM 'B'`).
_B_LEG_TAGS = {"a01", "a03", "a04", "a05", "a06", "a07", "a14"}


def _uuid(tag):
    return f"{tag}000000-0000-0000-0000-000000000000"


@pytest.fixture(scope="module")
def reports_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _ReportsPG(PG_BIN)
    _PG["pg"] = pg          # owner connections for the plan-shape tests
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            # Product tables + number_routing from the REAL init chain (02 03
            # 09 17 20 22 24 31 34, then 54 56, then 57); cdrs is the shared
            # production-shaped scratch table + its real column migrations.
            await apply_prerequisites(conn)
            await apply_voicemail_schema(conn)
            await conn.execute(MIG_57.read_text())
            await conn.execute(_CDR_SCHEMA)
            await apply_cdr_column_migrations(conn)
            await conn.execute("CREATE INDEX idx_cdrs_customer_time ON cdrs(customer_id, start_time DESC)")
            # Only the cdrs side (a blanket GRANT ALL would widen 54's
            # append-only voicemail_access_log grants).
            await conn.execute("GRANT ALL ON cdrs, call_attestations, active_calls TO api")
            await conn.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api")
            await conn.execute(
                "INSERT INTO customers (id, name, account_type, voicemail_enabled) VALUES "
                "($1, 'Tenant A', 'hybrid', true), ($2, 'Tenant B', 'rcf', false)", CID_A, CID_B)
            # The users the `tokens` fixture mints (admin 1 is 09's seed).
            await seed_token_users(conn, ((2, "support", None), (3, "user", CID_A),
                                          (4, "readonly", CID_A), (5, "user", CID_B)))
            await conn.execute(
                "INSERT INTO rcf_numbers (customer_id, did, name, forward_to) VALUES "
                "($1, $2, 'Main line', '+17745550000'), ($1, $3, 'Spare', '+17745550001'), "
                "($4, $5, 'B line', '+17745559999')",
                CID_A, A_MAIN, A_SPARE, CID_B, B_MAIN)
            await conn.execute(
                "INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels) "
                "VALUES ($1, $2, 'alpha', 10)", TRUNK_A, CID_A)
            await conn.execute(
                "INSERT INTO trunk_dids (trunk_id, did) VALUES ($1, $2)", TRUNK_A, A_TRUNK)
            await conn.execute(
                "INSERT INTO voicemail_boxes (customer_id, did, label, status) VALUES "
                "($1, $2, 'Voicemail', 'active'), ($1, $3, 'After hours', 'suspended'), "
                "($1, $4, 'Old box', 'deleted')", CID_A, A_VM, A_VM_OFF, A_VM_GONE)
            await conn.execute(
                "INSERT INTO api_dids (customer_id, did, voice_url) "
                "VALUES ($1, $2, 'https://example.invalid/voice')", CID_A, A_API)
            for tag, local, caller, dest, ms, on_net in VM_CDRS:
                start = _utc(*local)
                answer = start + timedelta(seconds=7)
                await conn.execute(
                    """
                    INSERT INTO cdrs (uuid, customer_id, product_type, direction,
                      caller_id, destination, start_time, answer_time, end_time,
                      duration_ms, billable_ms, rate_per_min, total_cost,
                      hangup_cause, carrier_used, sbc_id, freeswitch_node,
                      on_net, origin_customer_id, terminating_customer_id,
                      leg, call_id, call_quality_status)
                    VALUES ($1, $2, 'voicemail', 'inbound', $3, $4, $5, $6, $7,
                      $8, 0, 0, 0, 'NORMAL_CLEARING', 'bandwidth-dallas',
                      'east-sbc-1', 'east-fs', $9, $2, $2, 'A', $1, 'unanswered')
                    """,
                    _uuid(tag), CID_A, caller, dest, start, answer,
                    answer + timedelta(milliseconds=ms), ms + 7_000, on_net)
            for (tag, cid, local, direction, caller, dest, ms, answered,
                 cause, mos, trunk) in CDRS:
                start = _utc(*local)
                answer = start + timedelta(seconds=7) if answered else None
                end = start + timedelta(seconds=7) + timedelta(milliseconds=ms)
                await conn.execute(
                    """
                    INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id,
                      direction, caller_id, destination, destination_prefix,
                      start_time, answer_time, end_time, duration_ms, billable_ms,
                      rate_per_min, total_cost, carrier_cost, margin,
                      hangup_cause, sip_code, carrier_used, traffic_grade,
                      fraud_score, freeswitch_node, mos, sbc_id,
                      inbound_carrier, network_addr)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, '1212', $8, $9, $10, $11,
                      $12, 0.012, 0.024, 0.010, 0.014, $13, 487, 'bandwidth-dallas',
                      'standard', 7, 'east-fs', $14, 'east-sbc-1', 'bandwidth',
                      '203.0.113.9')
                    """,
                    # duration_ms = RING (7 s) + talk: customer minutes must
                    # come from talk time (end - answer), never duration_ms
                    # (contract "Customer minutes") — every minute assertion
                    # below would shift if a report read duration_ms.
                    _uuid(tag), cid, "trunk" if trunk else "rcf", trunk, direction,
                    caller, dest, start, answer, end, ms + 7_000, (ms // 6000) * 6000,
                    cause, mos)
                await conn.execute(
                    "UPDATE cdrs SET leg = 'A', call_id = uuid WHERE uuid = $1",
                    _uuid(tag))
                # Migration 50: reports read the CALL-level columns
                # (worse direction). The seed's mos becomes call_mos/grade;
                # the per-leg mos is then poisoned to 1.0 to prove reports
                # never read it.
                await conn.execute(
                    "UPDATE cdrs SET call_mos = mos, "
                    "call_quality_grade = cq_grade(mos), "
                    "call_quality_status = CASE WHEN mos IS NULL THEN 'unanswered' "
                    "ELSE 'rated' END, mos = 1.0 WHERE uuid = $1", _uuid(tag))
                if cid == CID_A and tag in _B_LEG_TAGS:
                    # Carrier B-legs of the same call (contract row model):
                    # same customer, direction 'outbound', caller = the
                    # customer's own number (masking) so the B row WOULD land
                    # in /numbers + counts if a report forgot the leg filter.
                    # One failed attempt (unanswered) + the answered leg.
                    for attempt, b_answered in ((1, False), (2, answered)):
                        b_start = start + timedelta(seconds=attempt)
                        b_answer = b_start + timedelta(seconds=6) if b_answered else None
                        b_end = end if b_answered else b_start + timedelta(seconds=2)
                        await conn.execute(
                            """
                            INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id,
                              direction, caller_id, destination, start_time, answer_time,
                              end_time, duration_ms, billable_ms, hangup_cause, mos,
                              leg, call_id, leg_attempt)
                            VALUES ($1, $2, 'rcf', $3, 'outbound', $4, '+17745550000',
                              $5, $6, $7, 99999, 99999, $8, 1.0, 'B', $9, $10)
                            """,
                            f"{tag}b{attempt}00000-0000-0000-0000-000000000000"[:36],
                            cid, trunk, A_MAIN, b_start, b_answer, b_end,
                            "NORMAL_CLEARING" if b_answered else "USER_BUSY",
                            _uuid(tag), attempt)
            # a15: answered, one-way audio -> graded POOR with no MOS
            await conn.execute(
                "UPDATE cdrs SET call_quality_status = 'no_rtp', "
                "call_quality_grade = 'poor', call_mos = NULL WHERE uuid = $1",
                _uuid("a15"))
            # a16: answered, no audio either way (no_media, migration 51) ->
            # NOT graded: grade NULL, never Poor / one-way
            await conn.execute(
                "UPDATE cdrs SET call_quality_status = 'no_media', "
                "call_quality_grade = NULL, call_mos = NULL WHERE uuid = $1",
                _uuid("a16"))
        await owner.close()
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _run(_setup())
    try:
        yield db
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(scope="module")
def client(reports_db):
    from fastapi import FastAPI
    from fastapi.responses import ORJSONResponse
    from middleware.auth import JWTAuthMiddleware
    from routers import reports

    reports._TZ_CACHE.update(names=None, at=0.0)
    app = FastAPI(default_response_class=ORJSONResponse)
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(reports.router, prefix="/v1/reports")
    app.include_router(reports.router, prefix="/reports")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(reports_db):
    from auth.security import create_access_token

    def mint(sub, role, cid):
        return create_access_token(
            {"sub": sub, "email": f"{sub}@test.local", "role": role, "customer_id": cid})

    return {
        "admin": mint("1", "admin", None),
        "support": mint("2", "support", None),
        "user_a": mint("3", "user", CID_A),
        "readonly_a": mint("4", "readonly", CID_A),
        "user_b": mint("5", "user", CID_B),
    }


AUG = {"start": "2026-08-01", "end": "2026-08-31", "tz": "America/Boise"}


def _get(client, tokens, who, path, **params):
    return _run(client.get(f"/v1/reports/{path}", params=params,
                           headers={"Authorization": f"Bearer {tokens[who]}"}))


def _ok(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()


# -- recursive safety net -------------------------------------------------
_EXTRA_FORBIDDEN_KEYS = {"answer_time", "end_time", "answered_at", "ended_at",
                         "duration", "billsec", "hangup_cause", "sip_code",
                         "customer_id", "trunk_id", "uuid",
                         # number_routing internals (services/customer_numbers.py)
                         "product_ref_id", "customer_status", "product_type",
                         "on_net", "origin_customer_id", "terminating_customer_id"}
_FORBIDDEN_SUBSTRINGS = ("sec", "cost", "rate_per", "carrier", "margin", "sbc",
                         "billable", "_ms", "fraud")
_RAW_CAUSES = ("NO_ANSWER", "ORIGINATOR_CANCEL", "USER_BUSY", "UNALLOCATED_NUMBER",
               "CALL_REJECTED", "NORMAL_TEMPORARY_FAILURE", "NO_USER_RESPONSE",
               "NORMAL_CLEARING", "bandwidth", "east-fs", "east-sbc", "203.0.113")


def assert_report_safe(obj, path="$", allow=frozenset()):
    """No forbidden key (tenant denylist + timestamps/causes), no seconds-ish
    key, no seeded exact duration value, anywhere in the body. `allow` lifts
    named keys off the denylist (the staff all-customers rows carry
    `customer_id`); everything else still applies."""
    if isinstance(obj, dict):
        keys = set(obj)
        hit = ((tr.FORBIDDEN_TENANT_CDR_KEYS | _EXTRA_FORBIDDEN_KEYS) & keys) - allow
        assert not hit, f"forbidden keys at {path}: {sorted(hit)}"
        for k in keys:
            low = k.lower()
            assert not any(s in low for s in _FORBIDDEN_SUBSTRINGS), f"bad key {path}.{k}"
        for k, v in obj.items():
            assert_report_safe(v, f"{path}.{k}", allow)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            assert_report_safe(v, f"{path}[{i}]", allow)
    elif isinstance(obj, bool) or obj is None:
        return
    elif isinstance(obj, (int, float)):
        assert obj not in SEEDED_MS and obj != 95, f"exact duration value at {path}: {obj}"
    elif isinstance(obj, str):
        for raw in _RAW_CAUSES:
            assert raw not in obj, f"internal value {raw!r} leaked at {path}"


# ---------------------------------------------------------------------------
# overview
# ---------------------------------------------------------------------------
def test_overview_shape_and_values(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "overview", **AUG))
    assert_report_safe(body)
    assert set(body) == {"period", "data_available_from", "totals", "previous_period",
                         "quality", "busiest_day", "busiest_hour", "missed_reasons"}
    assert body["period"] == {"start": "2026-08-01", "end": "2026-08-31",
                              "tz": "America/Boise", "days": 31}
    assert body["data_available_from"] == "2026-07-15"
    # a02 (07-31 23:30 Boise = 08-01 UTC) excluded, a13 (08-31 23:59 Boise =
    # 09-01 UTC) included, a14 (09-01 Boise) excluded.
    assert body["totals"] == {
        "calls": 14, "inbound": 12, "outbound": 2, "answered": 7, "missed": 7,
        "answer_rate_pct": 50.0,
        # answered ms = 20+20+95+20+3*20 = 215 s -> 3.58 -> 4 (rounded ONCE);
        # the per-call-ceiling sum would be 1+1+2+1+1+1+1 = 8.
        "minutes": 4,
        "avg_minutes": 1.1,          # mean of per-call whole minutes 8/7
    }
    # previous = 07-01..07-31, which starts before data_available_from -> nulls
    assert body["previous_period"] == {"start": "2026-07-01", "end": "2026-07-31",
                                       "calls": None, "answered": None,
                                       "minutes": None, "answer_rate_pct": None}
    # graded = a03 4.1 good, a04 3.7 fair, a06 4.3 good, a07 3.0 poor, a15
    # one-way (poor, no MOS): avg over graded calls WITH a MOS = 3.775 -> 3.78
    # (fair); good-or-better = 2 of 5.
    assert body["quality"] == {"rated_calls": 5, "avg_mos": 3.78, "grade": "fair",
                               "pct_good_or_better": 40.0}
    assert body["busiest_day"] == {"date": "2026-08-14", "calls": 3}   # tie -> earliest
    assert body["busiest_hour"] == {"hour": 10, "calls": 4}
    assert body["missed_reasons"] == [
        {"key": "no_answer", "label": "Nobody picked up", "calls": 2},
        {"key": "caller_hung_up", "label": "The caller hung up before it was answered", "calls": 1},
        {"key": "busy", "label": "The line was busy", "calls": 1},
        {"key": "not_in_service", "label": "The number called isn't in service", "calls": 1},
        {"key": "declined", "label": "The call was declined or blocked", "calls": 1},
        {"key": "network", "label": "A network problem stopped the call", "calls": 1},
    ]


def test_overview_previous_period_known(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "overview",
                    start="2026-08-16", end="2026-08-31", tz="America/Boise"))
    # previous 16 days = 07-31..08-15: a02, a03, a04, a05, a06
    assert body["previous_period"] == {"start": "2026-07-31", "end": "2026-08-15",
                                       "calls": 5, "answered": 4, "minutes": 3,
                                       "answer_rate_pct": 80.0}


def test_overview_utc_vs_boise_day_boundary(client, tokens):
    utc = _ok(_get(client, tokens, "user_a", "overview",
                   start="2026-08-01", end="2026-08-31", tz="UTC"))
    # In UTC a02 (08-01 05:30Z) is in, a13 (09-01 05:59Z) is out.
    assert utc["totals"]["calls"] == 14
    assert utc["period"]["tz"] == "UTC"
    boise_day = _ok(_get(client, tokens, "user_a", "trend",
                         start="2026-08-14", end="2026-08-15", tz="America/Boise"))
    utc_day = _ok(_get(client, tokens, "user_a", "trend",
                       start="2026-08-14", end="2026-08-15", tz="UTC"))
    # a06 at 23:30 Boise on 08-14 is 05:30Z on 08-15.
    assert [p["calls"] for p in boise_day["points"]] == [3, 0]
    assert [p["calls"] for p in utc_day["points"]] == [2, 1]


def test_overview_empty_range(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "overview",
                    start="2025-01-01", end="2025-01-31", tz="America/Boise"))
    assert body["totals"] == {"calls": 0, "inbound": 0, "outbound": 0, "answered": 0,
                              "missed": 0, "answer_rate_pct": None, "minutes": 0,
                              "avg_minutes": None}
    assert body["quality"] == {"rated_calls": 0, "avg_mos": None, "grade": "none",
                               "pct_good_or_better": None}
    assert body["busiest_day"] is None and body["busiest_hour"] is None
    assert body["missed_reasons"] == []


# ---------------------------------------------------------------------------
# trend
# ---------------------------------------------------------------------------
def test_trend_day_zero_filled(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "trend", **AUG))
    assert_report_safe(body)
    assert body["bucket"] == "day"
    pts = body["points"]
    assert len(pts) == 31
    assert [p["date"] for p in pts] == [
        (date(2026, 8, 1) + timedelta(days=i)).isoformat() for i in range(31)]
    by = {p["date"]: p for p in pts}
    assert set(pts[0]) == {"date", "calls", "answered", "missed", "minutes"}
    assert by["2026-08-14"] == {"date": "2026-08-14", "calls": 3, "answered": 2,
                                "missed": 1, "minutes": 2}   # 115 s -> 2
    assert by["2026-08-15"]["calls"] == 0                    # zero-filled
    # three 20 s calls: bucket total 60 s -> 1 minute (not 3 per-call ceilings)
    assert by["2026-08-25"] == {"date": "2026-08-25", "calls": 3, "answered": 3,
                                "missed": 0, "minutes": 1}
    assert by["2026-08-31"]["calls"] == 1                    # a13 (Boise date)
    assert sum(p["calls"] for p in pts) == 14


def test_trend_week_monday_start(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "trend", bucket="week", **AUG))
    assert body["bucket"] == "week"
    # 2026-08-01 is a Saturday -> first week bucket is Monday 07-27.
    assert [p["date"] for p in body["points"]] == [
        "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]
    assert [p["calls"] for p in body["points"]] == [1, 0, 3, 6, 3, 1]


def test_trend_auto_month_zero_filled(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "trend",
                    start="2026-01-01", end="2026-08-31", tz="America/Boise"))
    assert body["bucket"] == "month"
    assert [p["date"] for p in body["points"]] == [
        f"2026-{m:02d}-01" for m in range(1, 9)]
    assert [p["calls"] for p in body["points"]] == [0, 0, 0, 0, 0, 0, 2, 14]


def test_trend_auto_week(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "trend",
                    start="2026-06-01", end="2026-08-31", tz="America/Boise"))
    assert body["bucket"] == "week"          # 92 days


def test_trend_bad_bucket_422(client, tokens):
    assert _get(client, tokens, "user_a", "trend", bucket="hour", **AUG).status_code == 422


# ---------------------------------------------------------------------------
# numbers / my-numbers
# ---------------------------------------------------------------------------
def test_numbers_per_number(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "numbers", **AUG))
    assert_report_safe(body)
    assert body == {"numbers": [
        {"number": A_MAIN, "name": "Main line", "product": "rcf",
         "forwards_to": "+17745550000", "calls": 10, "answered": 6, "missed": 4,
         "answer_rate_pct": 60.0, "minutes": 3, "avg_mos": 4.03, "grade": "good"},
        # a07 outbound caller_id '6175550202' is canonicalized onto the DID
        {"number": A_TRUNK, "name": "alpha", "product": "trunk",
         "forwards_to": None, "calls": 4, "answered": 1, "missed": 3,
         "answer_rate_pct": 25.0, "minutes": 1, "avg_mos": 3.0, "grade": "poor"},
        {"number": A_SPARE, "name": "Spare", "product": "rcf",
         "forwards_to": "+17745550001", "calls": 0, "answered": 0, "missed": 0,
         "answer_rate_pct": None, "minutes": 0, "avg_mos": None, "grade": "none"},
        # voicemail mailboxes are the customer's numbers too (suspended
        # included); never the deleted box nor the (retired) api DID
        {"number": A_VM, "name": "Voicemail", "product": "voicemail",
         "forwards_to": None, "calls": 0, "answered": 0, "missed": 0,
         "answer_rate_pct": None, "minutes": 0, "avg_mos": None, "grade": "none"},
        {"number": A_VM_OFF, "name": "After hours", "product": "voicemail",
         "forwards_to": None, "calls": 0, "answered": 0, "missed": 0,
         "answer_rate_pct": None, "minutes": 0, "avg_mos": None, "grade": "none"},
    ]}


def test_numbers_filter_narrows_only_to_owned(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "numbers",
                    numbers=f"{A_TRUNK},{B_MAIN}", **AUG))
    assert [n["number"] for n in body["numbers"]] == [A_TRUNK]
    # Filter to B's number only: nothing (never widens, never B's data).
    assert _ok(_get(client, tokens, "user_a", "numbers", numbers=B_MAIN, **AUG)) == {"numbers": []}
    ov = _ok(_get(client, tokens, "user_a", "overview", numbers=B_MAIN, **AUG))
    assert ov["totals"]["calls"] == 0
    ov = _ok(_get(client, tokens, "user_a", "overview", numbers="6175550202", **AUG))
    assert ov["totals"]["calls"] == 4            # canonicalized filter entry


def test_my_numbers(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "my-numbers"))
    assert_report_safe(body)
    assert body == {"numbers": [
        {"number": A_MAIN, "name": "Main line", "product": "rcf", "enabled": True,
         "forwards_to": "+17745550000"},
        {"number": A_TRUNK, "name": "alpha", "product": "trunk", "enabled": True,
         "forwards_to": None},
        {"number": A_SPARE, "name": "Spare", "product": "rcf", "enabled": True,
         "forwards_to": "+17745550001"},
        {"number": A_VM, "name": "Voicemail", "product": "voicemail", "enabled": True,
         "forwards_to": None},
        {"number": A_VM_OFF, "name": "After hours", "product": "voicemail", "enabled": False,
         "forwards_to": None},
    ]}
    assert A_VM_GONE not in str(body) and A_API not in str(body)
    for row in body["numbers"]:
        assert tuple(row) == ("number", "name", "product", "enabled", "forwards_to")
    assert _ok(_get(client, tokens, "user_b", "my-numbers", customer_id=CID_A)) == {
        "numbers": [{"number": B_MAIN, "name": "B line", "product": "rcf", "enabled": True,
                     "forwards_to": "+17745559999"}]}
    assert _get(client, tokens, "admin", "my-numbers").status_code == 422
    assert _ok(_get(client, tokens, "support", "my-numbers", customer_id=CID_B))["numbers"][0][
        "number"] == B_MAIN
    # staff "View as Customer" gets the tenant's exact list
    staff = _get(client, tokens, "admin", "my-numbers", customer_id=CID_A)
    assert staff.status_code == 200 and staff.json() == body


# ---------------------------------------------------------------------------
# voicemail (and every future product): plan docs/CUSTOMER_NUMBERS_HOLISTIC_PLAN.md
# ---------------------------------------------------------------------------
SEP = {"start": "2026-09-01", "end": "2026-09-30", "tz": "America/Boise"}


def test_numbers_september_voicemail(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "numbers", **SEP))
    assert_report_safe(body)
    assert [n["number"] for n in body["numbers"]] == [A_MAIN, A_VM, A_TRUNK, A_SPARE, A_VM_OFF]
    rows = {n["number"]: n for n in body["numbers"]}
    # a14 + v02 (on-net RCF -> voicemail): the call belongs to the DIALED
    # number (talk 20 s + 60 s = 80 s -> 1 minute, rounded once)
    assert rows[A_MAIN] == {
        "number": A_MAIN, "name": "Main line", "product": "rcf",
        "forwards_to": "+17745550000", "calls": 2, "answered": 2, "missed": 0,
        "answer_rate_pct": 100.0, "minutes": 1, "avg_mos": None, "grade": "none"}
    # the mailbox row counts direct dials only (v01)
    assert rows[A_VM] == {
        "number": A_VM, "name": "Voicemail", "product": "voicemail",
        "forwards_to": None, "calls": 1, "answered": 1, "missed": 0,
        "answer_rate_pct": 100.0, "minutes": 1, "avg_mos": None, "grade": "none"}
    assert rows[A_VM_OFF]["calls"] == 0
    assert A_VM_GONE not in rows and A_API not in rows


def test_overview_september_counts_every_call(client, tokens):
    ov = _ok(_get(client, tokens, "user_a", "overview", **SEP))
    assert_report_safe(ov)
    # a14 + v01 + v02 + v03 — v03 went to a since-deleted mailbox: still in
    # the totals (history), just no number row. Voicemail-answered calls
    # count as answered (owner decision O2).
    assert ov["totals"] == {
        "calls": 4, "inbound": 4, "outbound": 0, "answered": 4, "missed": 0,
        "answer_rate_pct": 100.0, "minutes": 2, "avg_minutes": 1.0}
    trend = _ok(_get(client, tokens, "user_a", "trend", **SEP))
    assert sum(p["calls"] for p in trend["points"]) == 4


def test_numbers_filter_voicemail(client, tokens):
    calls = _ok(_get(client, tokens, "user_a", "calls", numbers=A_VM, **SEP))
    assert_report_safe(calls)
    assert calls["total"] == 1 and [c["id"] for c in calls["calls"]] == [_uuid("v01")]
    assert _ok(_get(client, tokens, "user_a", "overview", numbers=A_VM, **SEP))[
        "totals"]["calls"] == 1
    assert [n["number"] for n in _ok(_get(client, tokens, "user_a", "numbers",
                                          numbers=f"{A_VM},{A_VM_OFF}", **SEP))["numbers"]] \
        == [A_VM, A_VM_OFF]
    # a released (deleted) mailbox DID / the hidden api DID are not the
    # customer's numbers: the filter narrows to nothing
    for gone in (A_VM_GONE, A_API):
        assert _ok(_get(client, tokens, "user_a", "calls", numbers=gone, **SEP)) == {
            "total": 0, "calls": []}
    # tenant B can never reach A's mailbox calls through the filter
    assert _ok(_get(client, tokens, "user_b", "calls", numbers=A_VM, **SEP)) == {
        "total": 0, "calls": []}
    assert _ok(_get(client, tokens, "user_b", "numbers", numbers=A_VM, **SEP)) == {"numbers": []}


def test_calls_voicemail_product_and_label(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "calls", **SEP))
    assert_report_safe(body)
    assert body["total"] == 4
    by = {c["id"]: c for c in body["calls"]}
    assert by[_uuid("v01")] == {
        "id": _uuid("v01"), "started_at": "2026-09-15T09:00:00-06:00",
        "direction": "inbound", "from": "+12085550101", "to": A_VM, "number": A_VM,
        "product": "voicemail", "outcome": "answered",
        "outcome_label": "Answered by voicemail", "missed_reason": None,
        "length_minutes": 1, "quality": "none"}
    v02 = by[_uuid("v02")]
    assert (v02["number"], v02["product"], v02["outcome"], v02["outcome_label"]) == (
        A_MAIN, "voicemail", "answered", "Answered by voicemail")
    assert (by[_uuid("a14")]["product"], by[_uuid("a14")]["outcome_label"]) == ("rcf", "Answered")
    assert by[_uuid("v03")]["number"] == A_VM_GONE
    # still "answered" for the outcome filter
    ans = _ok(_get(client, tokens, "user_a", "calls", outcome="answered", **SEP))
    assert ans["total"] == 4
    assert _ok(_get(client, tokens, "user_a", "calls", outcome="missed", **SEP))["total"] == 0
    # CSV: same columns; the Outcome cell carries the label
    resp = _get(client, tokens, "user_a", "calls.csv", **SEP)
    rows = _csv(resp)
    assert rows[0] == ["Date", "Time", "Direction", "From", "To", "Your number",
                       "Outcome", "Length (minutes, rounded)", "Call quality"]
    assert ["2026-09-15", "09:00", "Inbound", "+12085550101", A_VM, A_VM,
            "Answered by voicemail", "1", "Not rated"] in rows[1:]
    assert ["2026-09-15", "09:30", "Inbound", "+12085550102", A_MAIN, A_MAIN,
            "Answered by voicemail", "1", "Not rated"] in rows[1:]
    for raw in _RAW_CAUSES:
        assert raw not in resp.text
    # staff (View as Customer) get the identical redacted body
    staff = _get(client, tokens, "admin", "calls", customer_id=CID_A, **SEP)
    assert staff.content == _get(client, tokens, "user_a", "calls", **SEP).content


# ---------------------------------------------------------------------------
# calls / calls.csv
# ---------------------------------------------------------------------------
def test_calls_shape_order_and_values(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "calls", limit=500, **AUG))
    assert_report_safe(body)
    assert body["total"] == 14 and len(body["calls"]) == 14
    calls = body["calls"]
    for c in calls:
        assert set(c) == {"id", "started_at", "direction", "from", "to", "number",
                          "product", "outcome", "outcome_label", "missed_reason",
                          "length_minutes", "quality"}
    starts = [datetime.fromisoformat(c["started_at"]) for c in calls]
    assert starts == sorted(starts, reverse=True)          # newest first
    assert calls[0]["started_at"] == "2026-08-31T23:59:00-06:00"
    by = {c["id"]: c for c in calls}
    assert by[_uuid("a04")] == {
        "id": _uuid("a04"), "started_at": "2026-08-14T10:02:31-06:00",
        "direction": "inbound", "from": "+12085550100", "to": A_MAIN, "number": A_MAIN,
        "product": "rcf",
        "outcome": "answered", "outcome_label": "Answered", "missed_reason": None,
        "length_minutes": 1, "quality": "fair"}
    assert by[_uuid("a06")]["length_minutes"] == 2         # 95 s -> 2
    assert by[_uuid("a07")]["number"] == A_TRUNK
    assert by[_uuid("a07")]["from"] == "6175550202"
    assert by[_uuid("a07")]["direction"] == "outbound"
    assert by[_uuid("a08")] | {} == {
        "id": _uuid("a08"), "started_at": "2026-08-21T08:00:00-06:00",
        "direction": "inbound", "from": "+12085550008", "to": A_TRUNK, "number": A_TRUNK,
        "product": "trunk",
        "outcome": "missed", "outcome_label": "The caller hung up before it was answered",
        "missed_reason": "caller_hung_up", "length_minutes": 0, "quality": "none"}
    assert by[_uuid("a05")]["length_minutes"] == 0        # missed w/ 30 s ring -> 0


def test_calls_filters_and_pagination(client, tokens):
    missed = _ok(_get(client, tokens, "user_a", "calls", outcome="missed", **AUG))
    assert missed["total"] == 7 and all(c["outcome"] == "missed" for c in missed["calls"])
    ans = _ok(_get(client, tokens, "user_a", "calls", outcome="answered", **AUG))
    assert ans["total"] == 7 and all(c["outcome"] == "answered" for c in ans["calls"])
    out = _ok(_get(client, tokens, "user_a", "calls", direction="outbound", **AUG))
    assert out["total"] == 2 and {c["direction"] for c in out["calls"]} == {"outbound"}
    inb = _ok(_get(client, tokens, "user_a", "calls", direction="inbound", **AUG))
    assert inb["total"] == 12
    p1 = _ok(_get(client, tokens, "user_a", "calls", limit=5, **AUG))
    p3 = _ok(_get(client, tokens, "user_a", "calls", limit=5, offset=10, **AUG))
    assert p1["total"] == 14 and len(p1["calls"]) == 5 and len(p3["calls"]) == 4
    assert not ({c["id"] for c in p1["calls"]} & {c["id"] for c in p3["calls"]})
    assert _get(client, tokens, "user_a", "calls", limit=501, **AUG).status_code == 422
    assert _get(client, tokens, "user_a", "calls", outcome="bogus", **AUG).status_code == 422


def _csv(resp):
    assert resp.status_code == 200, resp.text
    return list(csv.reader(io.StringIO(resp.text)))


def test_calls_csv_header_rows_escaping(client, tokens):
    resp = _get(client, tokens, "user_a", "calls.csv", **AUG)
    rows = _csv(resp)
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.headers["content-disposition"] == \
        'attachment; filename="calls_2026-08-01_2026-08-31.csv"'
    assert resp.headers["x-report-truncated"] == "false"
    assert rows[0] == ["Date", "Time", "Direction", "From", "To", "Your number",
                       "Outcome", "Length (minutes, rounded)", "Call quality"]
    data = rows[1:]
    assert len(data) == 14
    assert data[0][:2] == ["2026-08-31", "23:59"]
    assert ["2026-08-14", "10:02", "Inbound", "+12085550100", A_MAIN, A_MAIN,
            "Answered", "1", "Fair"] in data
    # one-way audio (no_rtp): graded Poor with no MOS — never "Not rated"
    assert ["2026-08-25", "11:00", "Inbound", "+12085550015", A_MAIN, A_MAIN,
            "Answered", "1", "Poor"] in data
    # an answered call that was never graded (a16: no_media, no audio either
    # way) stays "Not rated" — never "Poor"
    assert ["2026-08-25", "11:05", "Inbound", "+12085550016", A_MAIN, A_MAIN,
            "Answered", "1", "Not rated"] in data
    assert ["2026-08-21", "08:00", "Inbound", "+12085550008", A_TRUNK, A_TRUNK,
            "The caller hung up before it was answered", "0", "Not rated"] in data
    # formula injection neutralized, embedded quotes/commas round-trip
    evil = [r for r in data if r[0] == "2026-08-23"][0]
    assert evil[3] == "'=cmd|\"x\",1"
    assert '"\'=cmd|""x"",1"' in resp.text
    # CSV text is also free of internals / exact durations / costs
    for raw in _RAW_CAUSES:
        assert raw not in resp.text
    for header in rows[0]:
        assert not any(s in header.lower() for s in ("sec", "cost", "rate", "carrier"))


def test_calls_csv_keyset_chunks_and_truncation(client, tokens, monkeypatch):
    from routers import reports
    monkeypatch.setattr(reports, "CSV_CHUNK_ROWS", 2)      # 7+ keyset pages
    full = _csv(_get(client, tokens, "user_a", "calls.csv", **AUG))[1:]
    assert len(full) == 14
    dt = [f"{r[0]} {r[1]}" for r in full]
    assert dt == sorted(dt, reverse=True)
    monkeypatch.setattr(rp, "CSV_ROW_CAP", 3)
    resp = _get(client, tokens, "user_a", "calls.csv", **AUG)
    assert resp.headers["x-report-truncated"] == "true"
    assert len(_csv(resp)) == 1 + 3
    assert full[:3] == _csv(resp)[1:]


def test_calls_csv_filters(client, tokens):
    rows = _csv(_get(client, tokens, "user_a", "calls.csv", outcome="answered",
                     direction="outbound", **AUG))
    assert rows[1:] == [["2026-08-20", "10:15", "Outbound", "6175550202",
                         "+12125551111", A_TRUNK, "Answered", "1", "Poor"]]


# ---------------------------------------------------------------------------
# scoping / validation
# ---------------------------------------------------------------------------
ENDPOINTS = ("overview", "trend", "numbers", "calls", "calls.csv")


@pytest.mark.parametrize("path", ENDPOINTS)
def test_tenant_cannot_select_other_customer(client, tokens, path):
    mine = _get(client, tokens, "user_a", path, **AUG)
    spoof = _get(client, tokens, "user_a", path, customer_id=CID_B, **AUG)
    assert mine.status_code == spoof.status_code == 200
    assert mine.content == spoof.content                     # customer_id ignored
    assert B_MAIN not in spoof.text and "+12085559998" not in spoof.text
    ro = _get(client, tokens, "readonly_a", path, customer_id=CID_B, **AUG)
    assert ro.content == mine.content


def test_tenant_b_sees_only_b(client, tokens):
    ov = _ok(_get(client, tokens, "user_b", "overview", customer_id=CID_A, **AUG))
    assert ov["totals"]["calls"] == 2
    nums = _ok(_get(client, tokens, "user_b", "numbers", numbers=A_MAIN, **AUG))
    assert nums == {"numbers": []}                          # A's number: not owned
    calls = _ok(_get(client, tokens, "user_b", "calls", numbers=A_MAIN, **AUG))
    assert calls == {"total": 0, "calls": []}


@pytest.mark.parametrize("who", ["admin", "support"])
@pytest.mark.parametrize("path", ENDPOINTS)
def test_staff_requires_customer_id(client, tokens, who, path):
    assert _get(client, tokens, who, path, **AUG).status_code == 422
    staff = _get(client, tokens, who, path, customer_id=CID_A, **AUG)
    tenant = _get(client, tokens, "user_a", path, **AUG)
    assert staff.status_code == 200
    assert staff.content == tenant.content                  # same safe shape
    if path != "calls.csv":
        assert_report_safe(staff.json())


def test_unauthenticated_401(client):
    r = _run(client.get("/v1/reports/overview", params=AUG))
    assert r.status_code == 401


def test_legacy_mount(client, tokens):
    r = _run(client.get("/reports/overview", params=AUG,
                        headers={"Authorization": f"Bearer {tokens['user_a']}"}))
    assert r.status_code == 200 and r.json()["totals"]["calls"] == 14


@pytest.mark.parametrize("params", [
    {"start": "2026-08-01", "end": "2026-08-31", "tz": "Mars/Olympus_Mons"},
    {"start": "2026-08-01", "end": "2026-08-31", "tz": "EST'; DROP TABLE cdrs;--"},
    {"start": "2026-08-01", "end": "2026-08-31", "tz": "../../etc/passwd"},
    {"start": "2026-01-01", "end": "2027-01-02"},                 # 367 days
    {"start": "2026-08-31", "end": "2026-08-01"},
    {"start": "2026-08-01"},
    {"end": "2026-08-31"},
    {"start": "08/01/2026", "end": "2026-08-31"},
])
@pytest.mark.parametrize("path", ENDPOINTS)
def test_validation_422(client, tokens, params, path):
    assert _get(client, tokens, "user_a", path, **params).status_code == 422


def test_tz_case_insensitive_and_366_ok(client, tokens):
    body = _ok(_get(client, tokens, "user_a", "overview",
                    start="2026-01-01", end="2027-01-01", tz="america/boise"))
    assert body["period"]["tz"] == "America/Boise" and body["period"]["days"] == 366
    # default tz
    body = _ok(_get(client, tokens, "user_a", "overview",
                    start="2026-08-01", end="2026-08-31"))
    assert body["period"]["tz"] == "America/New_York"


def test_statement_timeout_maps_to_503(client, tokens, monkeypatch):
    """SET LOCAL statement_timeout is honored inside the read-only txn and a
    cancellation surfaces as 503 (not a 500 / hung request)."""
    from routers import reports
    monkeypatch.setattr(reports, "REPORT_STATEMENT_TIMEOUT_MS", 1)
    slow = reports._OVERVIEW_GROUPS_SQL.replace(
        "LIMIT 2000", "LIMIT 2000 + (SELECT count(*) FROM pg_sleep(0.2))")
    monkeypatch.setattr(reports, "_OVERVIEW_GROUPS_SQL", slow)
    r = _get(client, tokens, "user_a", "overview", **AUG)
    assert r.status_code == 503
    # and the pooled connection is clean afterwards (SET LOCAL did not leak)
    monkeypatch.undo()
    assert _get(client, tokens, "user_a", "overview", **AUG).status_code == 200

    async def show():
        async with reports.db.pool.acquire() as conn:
            return await conn.fetchval("SHOW statement_timeout")
    assert _run(show()) == "0"


def test_report_scan_uses_customer_time_index(reports_db):
    """The local-date bounds (date::timestamp AT TIME ZONE tz over bind
    params) must be index-sargable on (customer_id, start_time DESC)."""
    from routers import reports
    scope = reports.ReportScope(CID_A, rp.Period(date(2026, 8, 1), date(2026, 8, 31)),
                                "America/Boise", None)

    async def plan():
        async with reports_db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL enable_seqscan = off")
                rows = await conn.fetch("EXPLAIN " + reports._OVERVIEW_GROUPS_SQL, *scope.args())
                return "\n".join(r[0] for r in rows)
    text = _run(plan())
    assert "idx_cdrs_customer_time" in text, text
    assert "start_time >=" in text and "start_time <" in text, text


def test_summary_grade_one_way_only_is_poor_not_unrated():
    """Graded calls that are ALL one-way audio (grade poor, MOS NULL) make the
    aggregate poor; nothing graded stays "none"."""
    from routers import reports
    assert reports._summary_grade(3, None) == "poor"
    assert reports._summary_grade(0, None) == "none"
    assert reports._summary_grade(2, 4.35) == "great"
    assert reports._quality(2, None, 0) == {"rated_calls": 2, "avg_mos": None,
                                            "grade": "poor", "pct_good_or_better": 0.0}


# ---------------------------------------------------------------------------
# Per-customer reports are byte-identical to RCF-V1 202f51b (before the staff
# all-customers mode): the SQL each request runs (+ its bind layout) and the
# response bytes are pinned by sha256. The all-customers SQL is built
# separately; a change here means a TENANT report changed — never update the
# pins without a deliberate per-customer contract change.
# ---------------------------------------------------------------------------
PER_CUSTOMER_REQUESTS = {
    "overview": ("overview", AUG),
    "overview_numbers": ("overview", {**AUG, "numbers": A_TRUNK}),
    "trend": ("trend", AUG),
    "trend_week": ("trend", {**AUG, "bucket": "week"}),
    "numbers": ("numbers", AUG),
    "numbers_filter": ("numbers", {**AUG, "numbers": f"{A_TRUNK},{B_MAIN}"}),
    "my_numbers": ("my-numbers", {}),
    "calls": ("calls", AUG),
    "calls_filtered": ("calls", {**AUG, "outcome": "missed", "direction": "inbound",
                                 "limit": 5, "offset": 2}),
    "calls_csv": ("calls.csv", AUG),
    "calls_csv_filtered": ("calls.csv", {**AUG, "outcome": "answered",
                                         "direction": "outbound"}),
}

#: sha256 of each request's executed SQL + bind types (captured at RCF-V1 202f51b).
PER_CUSTOMER_SQL_SHA256: dict[str, str] = {
    "overview": "f46a917bdf3a30b8d24afa0841a47bc93e5157c9f4c260e6d5399b85913a2305",
    "overview_numbers": "2b014502197cd7a91eb92070cbe78d1c3028ca85b89ff08505a3a83dcc3657ba",
    "trend": "0f5c1680e4818d5e925662364d1f38fc8603933c4ca64b24f703f0a3816a4d2c",
    "trend_week": "0f5c1680e4818d5e925662364d1f38fc8603933c4ca64b24f703f0a3816a4d2c",
    "numbers": "796126b4b6565f0d6a1ee97bd00a09a36de4eb34c7c4037d6e94feb20a856b0c",
    "numbers_filter": "fddf8c06cd75d1748701059941fcfa4e753bb76b56faed88e40693c8cad3beb6",
    "my_numbers": "6ffa56e6385d0a511ca64954a62090cc6387742cca0402087ccf0d8b605a4abf",
    "calls": "84a0e5b0a37e6787a1f909ba015d0dda3c55066d18851986ae53f18c45df6487",
    "calls_filtered": "44880dcb7fd0c1b6cd0b0fdd694df6e41b138147ce8d8e98cdc9b0be457a015c",
    "calls_csv": "7e0b26d3f72ec80520fadfaadc02cd5690e6e6dfcd9c5485aa80aab6f2a2d86c",
    "calls_csv_filtered": "0a6e736f6eab69282a1f8141df5c6edf993eb859cce1b68e10d6f05b8172100a",
}
#: sha256 of each response body (captured at RCF-V1 202f51b).
PER_CUSTOMER_BODY_SHA256: dict[str, str] = {
    "overview": "5e1cc416e924e184fe8f542bc4cae53f0c4bf5948ae1af8562f02bf8e602aec0",
    "overview_numbers": "f7d4f1be99b15a7359151d5ec333c444533b48ae57a08427d2b3c31a660506bb",
    "trend": "baeced8eb6bb89636502d094d6df82e5967d6397b85eef4873133d125e956db9",
    "trend_week": "729d5bb4bb97ba3e421eafc38e0e8fb1810bbcfa7ee317c7edac99e535f9895f",
    "numbers": "a3da4a83936e39f0010c2b7ec3e3cc2e46716ab211be2e5061851508e3bda713",
    "numbers_filter": "785e7cd70e1d570e77ccd8da32b5a0dc6026f2a1dbf2dcabb55dbd28b350fa31",
    "my_numbers": "6f3f0362426088280acf8bb58cdf72757657a0fd4d6a0729738df2838f6fde28",
    "calls": "f414b3710e247b9cc3fc77a988ff701509ab4f9d74ef8ff2851833d9ff398609",
    "calls_filtered": "f6978e9ca554b45c5acd278fcadc6d70b4211ffb8e7dccfaa72821e3257b3966",
    "calls_csv": "a4708fc3c4e8067e97895b291ca0fb4120d7c312f1ecba02b1813fe709733934",
    "calls_csv_filtered": "a1df8861aca4866d11f059776dc5778ba09f67c972a895725903e087066536ef",
}


def _sql_fingerprint(queries) -> str:
    import hashlib
    text = "\n--\n".join(
        f"{[type(a).__name__ for a in args]}|{sql}" for sql, args in queries)
    return hashlib.sha256(text.encode()).hexdigest()


def test_per_customer_sql_and_responses_unchanged(client, tokens, monkeypatch):
    import hashlib
    from routers import reports
    monkeypatch.setattr(reports, "CSV_CHUNK_ROWS", 5)       # exercise the keyset page SQL
    real_run = reports._run
    seen: list = []

    async def recording_run(queries):
        seen.extend(queries)
        return await real_run(queries)

    monkeypatch.setattr(reports, "_run", recording_run)
    got_sql, got_body = {}, {}
    for label, (path, params) in PER_CUSTOMER_REQUESTS.items():
        seen.clear()
        resp = _get(client, tokens, "user_a", path, **params)
        assert resp.status_code == 200, (label, resp.text)
        got_sql[label] = _sql_fingerprint(seen)
        got_body[label] = hashlib.sha256(resp.content).hexdigest()
        # staff choosing the customer runs the SAME SQL and gets the same bytes
        seen.clear()
        staff = _get(client, tokens, "admin", path, customer_id=CID_A, **params)
        assert staff.content == resp.content, label
        assert _sql_fingerprint(seen) == got_sql[label], label
    assert got_sql == PER_CUSTOMER_SQL_SHA256
    assert got_body == PER_CUSTOMER_BODY_SHA256


# ---------------------------------------------------------------------------
# Staff "all customers" (all_customers=true)
# ---------------------------------------------------------------------------
ALL = {**AUG, "all_customers": "true"}
_ALL_ALLOW = frozenset({"customer_id"})
_NAMES = {CID_A: "Tenant A", CID_B: "Tenant B"}


def _strip_customer(row):
    return {k: v for k, v in row.items() if k not in ("customer_id", "customer_name")}


def _assert_no_unattributed(text):
    for caller in _UNATTRIBUTED_CALLERS:
        assert caller not in text, f"unattributed call {caller} leaked"


@pytest.mark.parametrize("who", ["admin", "support"])
def test_all_customers_overview_aggregates_every_customer(client, tokens, who):
    body = _ok(_get(client, tokens, who, "overview", **ALL))
    assert_report_safe(body)
    # same shape as a one-customer overview
    assert set(body) == {"period", "data_available_from", "totals", "previous_period",
                         "quality", "busiest_day", "busiest_hour", "missed_reasons"}
    # A's 14 August calls + B's 2; the unattributed z01/z02 (customer_id 0)
    # are nobody's: not counted
    assert body["totals"] == {
        "calls": 16, "inbound": 14, "outbound": 2, "answered": 9, "missed": 7,
        "answer_rate_pct": 56.3,     # 9 / 16 = 56.25, half-up
        # answered talk: A 215 s + B 120 s = 335 s -> 5.58 -> 6 (rounded ONCE)
        "minutes": 6,
        "avg_minutes": 1.1,          # (8 + 1 + 1) / 9
    }
    # z03 (07-01, unattributed) is older than every attributed call: the
    # oldest data is still A's a01 (07-15), so the July comparison is unknown
    assert body["data_available_from"] == "2026-07-15"
    assert body["previous_period"]["calls"] is None
    # graded: A's 5 + B's 2; MOS mean over the 6 with one = 23.9 / 6
    assert body["quality"] == {"rated_calls": 7, "avg_mos": 3.98, "grade": "fair",
                               "pct_good_or_better": 57.1}
    # 08-14: A 3 + B 2 (z01 on that day too, not counted -> would be 6)
    assert body["busiest_day"] == {"date": "2026-08-14", "calls": 5}
    # hour 10: A's 4 (z01 at 10:45 not counted -> would be 5)
    assert body["busiest_hour"] == {"hour": 10, "calls": 4}
    # z02 (NO_ANSWER, unattributed) does not add a missed call
    assert body["missed_reasons"][0] == {"key": "no_answer", "label": "Nobody picked up",
                                         "calls": 2}
    assert sum(m["calls"] for m in body["missed_reasons"]) == 7


def test_all_customers_trend(client, tokens):
    body = _ok(_get(client, tokens, "admin", "trend", **ALL))
    assert_report_safe(body)
    by = {p["date"]: p for p in body["points"]}
    assert len(body["points"]) == 31
    assert by["2026-08-14"] == {"date": "2026-08-14", "calls": 5, "answered": 4,
                                "missed": 1, "minutes": 4}   # 115 s + 120 s -> 4
    assert by["2026-08-20"]["calls"] == 1                    # a07; z02 not counted
    assert sum(p["calls"] for p in body["points"]) == 16


def test_all_customers_numbers_rows_carry_the_customer(client, tokens):
    body = _ok(_get(client, tokens, "admin", "numbers", **ALL))
    assert_report_safe(body, allow=_ALL_ALLOW)
    rows = body["numbers"]
    assert [r["number"] for r in rows] == [A_MAIN, A_TRUNK, B_MAIN, A_SPARE, A_VM, A_VM_OFF]
    for r in rows:
        assert tuple(r)[-2:] == ("customer_id", "customer_name")
        assert r["customer_name"] == _NAMES[r["customer_id"]]
    by = {r["number"]: r for r in rows}
    # B's own call to its own number; b02 (B's call to A's number) counts for
    # no number row, z01 (unattributed, to A_MAIN) neither
    assert by[B_MAIN] == {
        "number": B_MAIN, "name": "B line", "product": "rcf", "forwards_to": "+17745559999",
        "calls": 1, "answered": 1, "missed": 0, "answer_rate_pct": 100.0, "minutes": 1,
        "avg_mos": 4.4, "grade": "great", "customer_id": CID_B, "customer_name": "Tenant B"}
    # every row == that customer's own one-customer row (same attribution)
    for cid in (CID_A, CID_B):
        own = _ok(_get(client, tokens, "admin", "numbers", customer_id=cid, **AUG))["numbers"]
        assert [_strip_customer(r) for r in rows if r["customer_id"] == cid] == own


def test_all_customers_calls_span_customers_and_skip_unattributed(client, tokens):
    body = _ok(_get(client, tokens, "admin", "calls", limit=500, **ALL))
    assert_report_safe(body, allow=_ALL_ALLOW)
    assert body["total"] == 16 and len(body["calls"]) == 16
    ids = {c["id"] for c in body["calls"]}
    assert {_uuid("b01"), _uuid("b02"), _uuid("a04")} <= ids
    assert not ids & {_uuid("z01"), _uuid("z02"), _uuid("z03")}
    assert {c["customer_id"] for c in body["calls"]} == {CID_A, CID_B}
    starts = [datetime.fromisoformat(c["started_at"]) for c in body["calls"]]
    assert starts == sorted(starts, reverse=True)
    for c in body["calls"]:
        assert c["customer_name"] == _NAMES[c["customer_id"]]
    # each row == the one-customer row + customer_id/customer_name
    own_a = {c["id"]: c for c in _ok(_get(client, tokens, "user_a", "calls",
                                          limit=500, **AUG))["calls"]}
    for c in body["calls"]:
        if c["customer_id"] == CID_A:
            assert _strip_customer(c) == own_a[c["id"]]
    b02 = next(c for c in body["calls"] if c["id"] == _uuid("b02"))
    assert (b02["customer_id"], b02["customer_name"], b02["number"]) == (CID_B, "Tenant B", A_MAIN)
    _assert_no_unattributed(_get(client, tokens, "admin", "calls", limit=500, **ALL).text)
    # filters + pagination work the same way
    missed = _ok(_get(client, tokens, "admin", "calls", outcome="missed", **ALL))
    assert missed["total"] == 7
    page = _ok(_get(client, tokens, "admin", "calls", limit=5, offset=5, **ALL))
    assert page["total"] == 16 and [c["id"] for c in page["calls"]] == \
        [c["id"] for c in body["calls"][5:10]]


def test_all_customers_csv_has_a_customer_column(client, tokens, monkeypatch):
    from routers import reports
    monkeypatch.setattr(reports, "CSV_CHUNK_ROWS", 3)       # several keyset pages
    resp = _get(client, tokens, "support", "calls.csv", **ALL)
    rows = _csv(resp)
    assert resp.headers["x-report-truncated"] == "false"
    assert rows[0] == ["Customer", "Date", "Time", "Direction", "From", "To", "Your number",
                       "Outcome", "Length (minutes, rounded)", "Call quality"]
    data = rows[1:]
    assert len(data) == 16
    assert {r[0] for r in data} == {"Tenant A", "Tenant B"}
    assert ["Tenant A", "2026-08-14", "10:02", "Inbound", "+12085550100", A_MAIN, A_MAIN,
            "Answered", "1", "Fair"] in data
    assert ["Tenant B", "2026-08-14", "12:05", "Inbound", "+12085559998", A_MAIN, A_MAIN,
            "Answered", "1", "Great"] in data
    # the rest of each row is exactly the one-customer CSV row
    own_a = _csv(_get(client, tokens, "user_a", "calls.csv", **AUG))[1:]
    assert [r[1:] for r in data if r[0] == "Tenant A"] == own_a
    _assert_no_unattributed(resp.text)
    for raw in _RAW_CAUSES:
        assert raw not in resp.text
    monkeypatch.setattr(rp, "CSV_ROW_CAP", 4)
    capped = _get(client, tokens, "admin", "calls.csv", **ALL)
    assert capped.headers["x-report-truncated"] == "true"
    assert _csv(capped)[1:] == data[:4]


def test_all_customers_my_numbers(client, tokens):
    body = _ok(_get(client, tokens, "admin", "my-numbers", all_customers="true"))
    assert_report_safe(body, allow=_ALL_ALLOW)
    rows = body["numbers"]
    assert [r["number"] for r in rows] == sorted(
        [A_MAIN, A_TRUNK, A_SPARE, A_VM, A_VM_OFF, B_MAIN])      # api + deleted box hidden
    for r in rows:
        assert tuple(r) == ("number", "name", "product", "enabled", "forwards_to",
                            "customer_id", "customer_name")
    for cid in (CID_A, CID_B):
        own = _ok(_get(client, tokens, "admin", "my-numbers", customer_id=cid))["numbers"]
        assert sorted((_strip_customer(r) for r in rows if r["customer_id"] == cid),
                      key=lambda r: r["number"]) == own
        assert {r["customer_name"] for r in rows if r["customer_id"] == cid} == {_NAMES[cid]}
    assert _get(client, tokens, "support", "my-numbers", all_customers="true").json() == body


@pytest.mark.parametrize("path", ENDPOINTS + ("my-numbers",))
def test_tenant_all_customers_flag_is_ignored(client, tokens, path):
    params = {} if path == "my-numbers" else AUG
    mine = _get(client, tokens, "user_a", path, **params)
    for spoof in ({"all_customers": "true"},
                  {"all_customers": "true", "customer_id": CID_B}):
        r = _get(client, tokens, "user_a", path, **params, **spoof)
        assert r.status_code == 200 and r.content == mine.content
        ro = _get(client, tokens, "readonly_a", path, **params, **spoof)
        assert ro.status_code == 200 and ro.content == mine.content
    assert B_MAIN not in mine.text
    # a tenant's own number filter keeps working with the (ignored) flag
    if path != "my-numbers":
        flt = {**params, "numbers": A_TRUNK}
        assert _get(client, tokens, "user_a", path, all_customers="true", **flt).content == \
            _get(client, tokens, "user_a", path, **flt).content


@pytest.mark.parametrize("who", ["admin", "support"])
@pytest.mark.parametrize("path", ENDPOINTS + ("my-numbers",))
def test_all_customers_and_customer_id_is_422(client, tokens, who, path):
    params = {} if path == "my-numbers" else AUG
    r = _get(client, tokens, who, path, all_customers="true", customer_id=CID_A, **params)
    assert r.status_code == 422
    assert r.json()["detail"] == "Pick one customer or all customers, not both."
    # all_customers=false is the default: still "pick a customer"
    assert _get(client, tokens, who, path, all_customers="false", **params).status_code == 422


@pytest.mark.parametrize("path", ENDPOINTS)
def test_all_customers_numbers_filter_is_422(client, tokens, path):
    r = _get(client, tokens, "admin", path, numbers=A_MAIN, **ALL)
    assert r.status_code == 422
    assert r.json()["detail"] == "Number filters need one customer."
    # even a filter that would narrow to nothing
    assert _get(client, tokens, "admin", path, numbers="junk", **ALL).status_code == 422
    # a blank numbers param is "no filter"
    assert _get(client, tokens, "admin", path, numbers=" ", **ALL).status_code == 200


def test_all_customers_sql_never_carries_a_customer_predicate():
    from routers import reports
    for name in ("_ALL_WITH", "_ALL_OVERVIEW_TOTALS_SQL", "_ALL_OVERVIEW_GROUPS_SQL",
                 "_ALL_TREND_SQL", "_ALL_NUMBERS_SQL", "_ALL_MY_NUMBERS_SQL"):
        sql = getattr(reports, name)
        assert "customer_id = $1" not in sql, name
        assert "customer_id <> 0" in sql or name == "_ALL_MY_NUMBERS_SQL", name
    with pytest.raises(RuntimeError):
        reports._variant("a b a", ("a", "c"))               # 2 matches: refused
    with pytest.raises(RuntimeError):
        reports._variant("a b", ("z", "c"))                 # 0 matches: refused


def test_all_customers_sql_fails_closed(reports_db):
    """The all-customers SQL answers ONLY when $1 (customer) and $5 (numbers)
    are NULL — a customer id or a number filter reaching it returns nothing."""
    from routers import reports
    period = rp.Period(date(2026, 8, 1), date(2026, 8, 31))
    base = reports.ReportScope(None, period, "America/Boise", None).args()

    async def total(args):
        async with reports_db.pool.acquire() as conn:
            return await conn.fetchval(
                f"{reports._ALL_WITH} SELECT count(*) FROM f", *args)
    assert _run(total(base)) == 16
    assert _run(total([CID_A] + base[1:])) == 0
    assert _run(total(base[:4] + [[A_MAIN]])) == 0


def test_all_customers_scan_uses_start_time_index(reports_db):
    """All customers has no customer predicate: the cdrs scan is the
    start_time range on the hypertable's start_time index (TimescaleDB's
    default `cdrs_start_time_idx`, created by create_hypertable in 05), never
    the (customer_id, start_time) index."""
    from routers import reports
    pg = _PG["pg"]
    period = rp.Period(date(2026, 8, 1), date(2026, 8, 31))
    args = reports.ReportScope(None, period, "America/Boise", None).args()
    n = len(args)
    queries = {
        "overview_totals": (reports._ALL_OVERVIEW_TOTALS_SQL, args + [period.start]),
        "overview_groups": (reports._ALL_OVERVIEW_GROUPS_SQL, args),
        "trend": (reports._ALL_TREND_SQL, args + ["day"]),
        "numbers": (reports._ALL_NUMBERS_SQL, args),
        "calls_page": (reports._calls_sql(
            reports.ReportScope(None, period, "America/Boise", None), "",
            f"ORDER BY start_time DESC, id DESC LIMIT ${n + 1}::int OFFSET ${n + 2}::int"),
            args + [50, 0]),
    }

    async def plans():
        conn = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                     database="postgres", statement_cache_size=0)
        try:
            out = {}
            tx = conn.transaction()
            await tx.start()
            try:
                await conn.execute("CREATE INDEX cdrs_start_time_idx ON cdrs (start_time DESC)")
                await conn.execute("ANALYZE cdrs")
                await conn.execute("SET LOCAL enable_seqscan = off")
                for label, (sql, a) in queries.items():
                    rows = await conn.fetch("EXPLAIN " + sql, *a)
                    out[label] = "\n".join(r[0] for r in rows)
            finally:
                await tx.rollback()       # the index exists only for this test
            return out
        finally:
            await conn.close()
    for label, text in _run(plans()).items():
        assert "cdrs_start_time_idx" in text, (label, text)
        assert "idx_cdrs_customer_time" not in text, (label, text)
        assert "start_time >=" in text and "start_time <" in text, (label, text)
