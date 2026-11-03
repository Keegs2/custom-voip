"""Migrations 63_admin_redesign.sql + 64_carrier_tier1.sql and the API fields
they back — full stack.

Real chain (tests/admin_redesign_harness.py) with customers seeded BEFORE 63
in every pre-63 traffic_grade value, then 63 applied TWICE (idempotency).

C5 traffic pattern (customers.traffic_grade):
  * standard / economy / NULL -> enterprise, premium stays; DEFAULT
    enterprise; exactly one CHECK on traffic_grade, allowing only
    enterprise | premium (a direct 'standard' INSERT is refused);
  * POST /v1/customers without traffic_grade stores enterprise and takes
    premium; create and PUT accept ONLY enterprise | premium — anything else
    (incl. the old standard / economy) is a 422, never the CHECK's 500; list /
    get return it; the tenant view still hides it.
C6 Tier 1 carriers (carrier_trunks.tier1, 64):
  * Bandwidth rows seeded true, every other row false; a re-run never
    clobbers an edit; the freeswitch role can read it;
  * /v1/carrier-trunks list / get / create / update return and accept it
    (default false, explicit null -> 422).
check_migrations.sql reports 63 and 64 MISSING before and applied after.

Run:  TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python3 -m pytest tests/test_admin_redesign_63.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_redesign_harness import AdminHarness, asyncpg  # noqa: E402
from voicemail_api_harness import CUST_A  # noqa: E402
from voicemail_db import CHECK_MIGRATIONS, INIT  # noqa: E402

PORT = 55542  # admin-redesign range 55540-55549

PRE = {201: "standard", 202: "economy", 203: "premium", 204: None}


class MigrationHarness(AdminHarness):
    EXTRA_MIGRATIONS = ("63_admin_redesign.sql", "64_carrier_tier1.sql")

    async def before_extra(self, conn) -> None:
        for cid, grade in PRE.items():
            await conn.execute(
                "INSERT INTO customers (id, name, account_type, traffic_grade) "
                "VALUES ($1::int, $2::varchar, 'trunk', $3::varchar)",
                cid, f"Pre-63 {cid}", grade)
        self.check_before = {r["migration"]: r["status"]
                             for r in await conn.fetch(CHECK_MIGRATIONS.read_text())}


@pytest.fixture(scope="module")
def h():
    harness = MigrationHarness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------
def test_check_migrations_row(h):
    after = {r["migration"]: r["status"] for r in h.rows(CHECK_MIGRATIONS.read_text())}
    for m in ("63_admin_redesign", "64_carrier_tier1"):
        assert h.check_before[m] == "*** MISSING ***", m
        assert after[m] == "applied", m


def test_traffic_grade_values_mapped(h):
    got = {r["id"]: r["traffic_grade"] for r in h.rows(
        "SELECT id, traffic_grade FROM customers WHERE id = ANY($1::int[])", list(PRE))}
    assert got == {201: "enterprise", 202: "enterprise", 203: "premium", 204: "enterprise"}
    # the harness's own customers (02's default 'standard') too
    assert h.val(f"SELECT traffic_grade FROM customers WHERE id = {CUST_A}") == "enterprise"


def test_traffic_grade_default_and_check(h):
    assert h.val("SELECT column_default FROM information_schema.columns "
                 "WHERE table_name = 'customers' AND column_name = 'traffic_grade'") \
        == "'enterprise'::character varying"
    defs = h.rows(
        "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint "
        "WHERE conrelid = 'customers'::regclass AND contype = 'c' "
        "AND pg_get_constraintdef(oid) LIKE '%traffic_grade%'")
    assert len(defs) == 1 and defs[0]["conname"] == "customers_traffic_grade_check"
    assert "'enterprise'" in defs[0]["def"] and "'premium'" in defs[0]["def"]
    assert "standard" not in defs[0]["def"]
    new_id = h.val("INSERT INTO customers (name, account_type) VALUES ('d', 'rcf') RETURNING id")
    assert h.val(f"SELECT traffic_grade FROM customers WHERE id = {new_id}") == "enterprise"
    with pytest.raises(asyncpg.exceptions.CheckViolationError):
        h.sql("INSERT INTO customers (name, account_type, traffic_grade) "
              "VALUES ('x', 'rcf', 'standard')")


# ---------------------------------------------------------------------------
# Customer API (C5)
# ---------------------------------------------------------------------------
def test_create_customer_traffic_grade(h):
    c = _ok(h.post("/v1/customers", {"name": "New Ent", "account_type": "trunk"}))
    assert c["traffic_grade"] == "enterprise"
    c = _ok(h.post("/v1/customers", {"name": "New Prem", "account_type": "trunk",
                                     "traffic_grade": "premium"}))
    assert c["traffic_grade"] == "premium"
    assert h.val("SELECT traffic_grade FROM customers WHERE name = 'New Ent'") == "enterprise"
    for bad in ("standard", "economy", "gold", None):
        r = h.post("/v1/customers", {"name": "Bad", "account_type": "rcf", "traffic_grade": bad})
        assert r.status_code == 422, (bad, r.text)
    assert h.val("SELECT count(*) FROM customers WHERE name = 'Bad'") == 0


def test_update_customer_traffic_grade(h):
    assert _ok(h.put(f"/v1/customers/{CUST_A}", {"traffic_grade": "premium"}))[
        "traffic_grade"] == "premium"
    assert _ok(h.get(f"/v1/customers/{CUST_A}"))["traffic_grade"] == "premium"
    listed = {c["id"]: c["traffic_grade"] for c in _ok(h.get("/v1/customers"))}
    assert listed[CUST_A] == "premium" and listed[201] == "enterprise"
    support = {c["id"]: c["traffic_grade"] for c in _ok(h.get("/v1/customers", who="support"))}
    assert support[CUST_A] == "premium"
    # tenants never see it
    mine = _ok(h.get("/v1/customers", who="user_a"))
    assert mine and all("traffic_grade" not in c for c in mine)
    assert _ok(h.put(f"/v1/customers/{CUST_A}", {"traffic_grade": "enterprise"}))[
        "traffic_grade"] == "enterprise"
    for bad in ("standard", "economy", "Premium", "gold", "", 3):
        r = h.put(f"/v1/customers/{CUST_A}", {"traffic_grade": bad})
        assert r.status_code == 422, (bad, r.text)
    # other fields still update without touching the grade
    body = _ok(h.put(f"/v1/customers/{CUST_A}", {"name": "Acme Voicemail"}))
    assert body["traffic_grade"] == "enterprise"
    assert h.put(f"/v1/customers/{CUST_A}", {"traffic_grade": "premium"},
                 who="support").status_code == 403


# ---------------------------------------------------------------------------
# Tier 1 carriers (C6)
# ---------------------------------------------------------------------------
def test_tier1_seed_and_rerun(h):
    rows = {(r["carrier"], r["pop"]): r["tier1"] for r in h.rows(
        "SELECT carrier, pop, tier1 FROM carrier_trunks")}
    assert rows[("bandwidth", "dallas")] is True and rows[("bandwidth", "la")] is True
    others = {k: v for k, v in rows.items() if k[0] != "bandwidth"}
    assert others and not any(others.values())
    h.sql("UPDATE carrier_trunks SET tier1 = false WHERE carrier = 'bandwidth' AND pop = 'la'")
    h.sql((INIT / "64_carrier_tier1.sql").read_text())
    try:
        assert h.val("SELECT tier1 FROM carrier_trunks WHERE carrier = 'bandwidth' "
                     "AND pop = 'la'") is False
    finally:
        h.sql("UPDATE carrier_trunks SET tier1 = true WHERE carrier = 'bandwidth' AND pop = 'la'")
    col = h.rows("SELECT data_type, is_nullable, column_default FROM information_schema.columns "
                 "WHERE table_name = 'carrier_trunks' AND column_name = 'tier1'")
    assert col == [{"data_type": "boolean", "is_nullable": "NO", "column_default": "false"}]


def test_tier1_readable_by_freeswitch(h):
    async def go():
        conn = await asyncpg.connect(host=h.pg.sock, port=h.pg.port, user="freeswitch",
                                     password="fs_secret", database="postgres",
                                     statement_cache_size=0)
        try:
            return await conn.fetch(
                "SELECT carrier, pop, tier1 FROM carrier_trunks "
                "WHERE direction IN ('outbound','both') AND enabled = true")
        finally:
            await conn.close()
    rows = h.run(go())
    assert {(r["carrier"], r["tier1"]) for r in rows} >= {("bandwidth", True), ("sinch", False)}


def test_carrier_trunks_api_tier1(h):
    listed = _ok(h.get("/v1/carrier-trunks"))["trunks"]
    assert listed and all(isinstance(t["tier1"], bool) for t in listed)
    dallas = next(t for t in listed if (t["carrier"], t["pop"]) == ("bandwidth", "dallas"))
    assert dallas["tier1"] is True
    assert _ok(h.get(f"/v1/carrier-trunks/{dallas['id']}"))["tier1"] is True
    made = _ok(h.post("/v1/carrier-trunks", {
        "carrier": "acme", "pop": "nyc", "source_ip": "198.51.100.77",
        "direction": "outbound", "traffic_class": "ld"}))
    assert made["tier1"] is False
    premium = _ok(h.post("/v1/carrier-trunks", {
        "carrier": "acme", "pop": "chi", "source_ip": "198.51.100.78",
        "direction": "outbound", "traffic_class": "ld", "tier1": True}))
    assert premium["tier1"] is True
    assert _ok(h.put(f"/v1/carrier-trunks/{made['id']}", {"tier1": True}))["tier1"] is True
    upd = _ok(h.put(f"/v1/carrier-trunks/{made['id']}", {"tier1": False, "cps_limit": 7}))
    assert (upd["tier1"], upd["cps_limit"]) == (False, 7)
    r = h.put(f"/v1/carrier-trunks/{made['id']}", {"tier1": None})
    assert r.status_code == 422, r.text
    assert h.put(f"/v1/carrier-trunks/{made['id']}", {"tier1": True},
                 who="support").status_code == 403
    for t in (made, premium):
        assert _ok(h.delete(f"/v1/carrier-trunks/{t['id']}"))["status"] == "deleted"
