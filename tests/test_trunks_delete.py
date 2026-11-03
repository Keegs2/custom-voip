"""SIP trunk delete (contract C1) and trunk DID delete (C2) — full stack.

Real routers behind the real JWT middleware on an ephemeral PostgreSQL 16
(tests/admin_redesign_harness.py: the real init chain incl. 26
live_trunk_stats, 41 did_inventory.source and 59's number_routing).

C1  DELETE /v1/trunks/{id}
    * 404 {"detail":"Trunk not found"} unknown; 409 while enabled (two-step: disable first); 403 for
      support / tenant users.
    * one transaction: trunk, trunk_dids, trunk_auth_ips and live_trunk_stats
      rows gone; CDR history (plain trunk_id) untouched; the DIDs vanish from
      number_routing.
    * every former DID's pool row -> reserved for the trunk's customer with
      the exact contract fields (status, customer_id, product_type /
      product_ref_id / assigned_at NULL, notes 'reserved: trunk <id> deleted');
      a DID with no pool row gets one (source='manual'); a pool row that names
      ANOTHER product, or is porting/suspended, is left alone.
    * the exact 200 body.
C2  DELETE /v1/trunks/{id}/dids/{trunk_did_id}
    * 404 {"detail":"Trunk DID not found"} when the row is on another trunk /
      unknown, 404 {"detail":"Trunk not found"} for an unknown trunk (never
      the bare "Not Found" TED reads as "not deployed"); one row removed, pool
      reserved exactly as C1, with or without an existing pool row; works on
      an enabled trunk; exact 200 body; 403 for support.

Run:  TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python3 -m pytest tests/test_trunks_delete.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_redesign_harness import AdminHarness  # noqa: E402
from voicemail_api_harness import CUST_A, CUST_B  # noqa: E402

PORT = 55540  # admin-redesign range 55540-55549

T_OFF, T_ON, T_OTHER = 801, 802, 803
D_POOL = "+16175557001"        # pool assigned/trunk -> reserved
D_NOPOOL = "+16175557002"      # no pool row -> inserted reserved, source manual
D_OTHER_PRODUCT = "+16175557003"   # pool names rcf -> kept
D_PORTING = "+16175557004"     # pool porting_out -> kept
D_MISMATCH = "+16175557005"    # pool assigned/trunk to another customer -> reserved for B
E_POOL = "+16175557011"        # on the enabled trunk, pool assigned
E_NOPOOL = "+16175557012"      # on the enabled trunk, no pool row
F_OTHER = "+16175557021"       # on T_OTHER (customer A)


class TrunkHarness(AdminHarness):
    EXTRA_MIGRATIONS = ("63_admin_redesign.sql",)    # GRANT DELETE live_trunk_stats

    async def _setup(self) -> None:
        await super()._setup()
        conn = await self.owner()
        try:
            await conn.execute(f"""
                INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, cps_limit, enabled)
                VALUES ({T_OFF}, {CUST_B}, 'pbx-old', 10, 5, false),
                       ({T_ON}, {CUST_B}, 'pbx-live', 20, 10, true),
                       ({T_OTHER}, {CUST_A}, 'a-pbx', 5, 2, false);
                INSERT INTO trunk_auth_ips (trunk_id, ip_address, description) VALUES
                  ({T_OFF}, '203.0.113.10', 'pbx 1'), ({T_OFF}, '203.0.113.11', 'pbx 2'),
                  ({T_ON}, '203.0.113.20', NULL);
                INSERT INTO trunk_dids (id, trunk_id, did) VALUES
                  (9001, {T_OFF}, '{D_POOL}'), (9002, {T_OFF}, '{D_NOPOOL}'),
                  (9003, {T_OFF}, '{D_OTHER_PRODUCT}'), (9004, {T_OFF}, '{D_PORTING}'),
                  (9005, {T_OFF}, '{D_MISMATCH}'),
                  (9011, {T_ON}, '{E_POOL}'), (9012, {T_ON}, '{E_NOPOOL}'),
                  (9021, {T_OTHER}, '{F_OTHER}');
                INSERT INTO did_inventory (did, customer_id, product_type, status, assigned_at,
                                           notes, city, state, source) VALUES
                  ('{D_POOL}', {CUST_B}, 'trunk', 'assigned', '2026-10-01T00:00:00Z', 'x', 'Boston', 'MA', 'bandwidth_sync'),
                  ('{D_OTHER_PRODUCT}', {CUST_A}, 'rcf', 'assigned', '2026-10-01T00:00:00Z', 'rcf row', NULL, NULL, 'bandwidth_sync'),
                  ('{D_PORTING}', {CUST_B}, 'trunk', 'porting_out', NULL, 'porting', NULL, NULL, 'bandwidth_sync'),
                  ('{D_MISMATCH}', {CUST_A}, 'trunk', 'assigned', NULL, NULL, NULL, NULL, 'bandwidth_sync'),
                  ('{E_POOL}', {CUST_B}, 'trunk', 'assigned', '2026-10-02T00:00:00Z', NULL, NULL, NULL, 'bandwidth_sync');
                INSERT INTO live_trunk_stats (customer_id, trunk_id, sbc_id, trunk_name)
                VALUES ({CUST_B}, {T_OFF}, 'east-sbc-1', 'pbx-old'),
                       ({CUST_B}, {T_ON}, 'east-sbc-1', 'pbx-live');
                INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id, direction, destination, start_time, end_time)
                VALUES ('cdr-old-trunk', {CUST_B}, 'trunk', {T_OFF}, 'outbound', '+17745550100', NOW(), NOW());
            """)
        finally:
            await conn.close()


@pytest.fixture(scope="module")
def h():
    harness = TrunkHarness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


def _pool(h, did):
    rows = h.rows(
        "SELECT did, customer_id, product_type, product_ref_id, status, assigned_at, "
        "assigned_by, notes, source FROM did_inventory WHERE did = $1", did)
    return rows[0] if rows else None


def _reserved_for(row, customer_id, note):
    return (row is not None and row["status"] == "reserved"
            and row["customer_id"] == customer_id and row["product_type"] is None
            and row["product_ref_id"] is None and row["assigned_at"] is None
            and row["assigned_by"] is None and row["notes"] == note)


# ---------------------------------------------------------------------------
# C1 — DELETE /v1/trunks/{id}
# ---------------------------------------------------------------------------
def test_delete_trunk_guards(h):
    r = h.delete("/v1/trunks/999999")
    assert r.status_code == 404 and r.json() == {"detail": "Trunk not found"}
    r = h.delete(f"/v1/trunks/{T_ON}")
    assert r.status_code == 409
    assert r.json() == {"detail": "Disable the trunk before deleting it"}
    for who in ("support", "user_b", "ro_a"):
        assert h.delete(f"/v1/trunks/{T_OFF}", who=who).status_code == 403, who
    # nothing changed by the refused calls
    assert h.val(f"SELECT count(*) FROM trunk_dids WHERE trunk_id = {T_OFF}") == 5
    assert h.val(f"SELECT count(*) FROM sip_trunks WHERE id = {T_ON}") == 1


def test_delete_disabled_trunk(h):
    before_routing = h.val(
        f"SELECT count(*) FROM number_routing WHERE trunk_id = {T_OFF}")
    assert before_routing == 5
    r = h.delete(f"/v1/trunks/{T_OFF}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "status": "deleted",
        "trunk_id": T_OFF,
        "customer_id": CUST_B,
        "reserved_dids": sorted([D_POOL, D_NOPOOL, D_MISMATCH]),
        "removed_ips": ["203.0.113.10", "203.0.113.11"],
    }

    # rows gone (and only this trunk's)
    assert h.val(f"SELECT count(*) FROM sip_trunks WHERE id = {T_OFF}") == 0
    assert h.val(f"SELECT count(*) FROM trunk_dids WHERE trunk_id = {T_OFF}") == 0
    assert h.val(f"SELECT count(*) FROM trunk_auth_ips WHERE trunk_id = {T_OFF}") == 0
    assert h.val(f"SELECT count(*) FROM live_trunk_stats WHERE trunk_id = {T_OFF}") == 0
    assert h.val(f"SELECT count(*) FROM live_trunk_stats WHERE trunk_id = {T_ON}") == 1
    assert h.val(f"SELECT count(*) FROM trunk_dids WHERE trunk_id = {T_ON}") == 2
    assert h.val("SELECT count(*) FROM number_routing WHERE did = ANY($1::varchar[])",
                 [D_POOL, D_NOPOOL, D_OTHER_PRODUCT, D_PORTING, D_MISMATCH]) == 0
    # CDR history keeps the plain trunk_id
    assert h.val("SELECT trunk_id FROM cdrs WHERE uuid = 'cdr-old-trunk'") == T_OFF

    note = f"reserved: trunk {T_OFF} deleted"
    p = _pool(h, D_POOL)
    assert _reserved_for(p, CUST_B, note), p
    assert p["source"] == "bandwidth_sync"          # attribution untouched
    p = _pool(h, D_NOPOOL)
    assert _reserved_for(p, CUST_B, note), p
    assert p["source"] == "manual"
    p = _pool(h, D_MISMATCH)
    assert _reserved_for(p, CUST_B, note), p        # the trunk's customer wins
    # another product's pool row and a porting row are left exactly as they were
    p = _pool(h, D_OTHER_PRODUCT)
    assert (p["status"], p["customer_id"], p["product_type"], p["notes"]) == \
        ("assigned", CUST_A, "rcf", "rcf row")
    p = _pool(h, D_PORTING)
    assert (p["status"], p["product_type"], p["notes"]) == ("porting_out", "trunk", "porting")

    # gone means gone
    assert h.delete(f"/v1/trunks/{T_OFF}").status_code == 404


def test_delete_without_live_stats_grant(h):
    """Before 63 the api role cannot DELETE live_trunk_stats: the trunk delete
    still succeeds and the stats row is left to go stale."""
    h.sql(f"""
        INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, enabled)
        VALUES (804, {CUST_B}, 'pre-63', 1, false);
        INSERT INTO live_trunk_stats (customer_id, trunk_id, sbc_id) VALUES ({CUST_B}, 804, 'x');
        REVOKE DELETE ON live_trunk_stats FROM api;""")
    try:
        r = h.delete("/v1/trunks/804")
        assert r.status_code == 200, r.text
        assert r.json()["reserved_dids"] == [] and r.json()["removed_ips"] == []
        assert h.val("SELECT count(*) FROM sip_trunks WHERE id = 804") == 0
        assert h.val("SELECT count(*) FROM live_trunk_stats WHERE trunk_id = 804") == 1
    finally:
        h.sql("GRANT DELETE ON live_trunk_stats TO api")


def test_reserved_dids_show_in_the_customers_numbers(h):
    """The reserved DIDs are still the customer's in the pool listing."""
    r = h.get("/v1/numbers/inventory", status="reserved", customer_id=CUST_B)
    assert r.status_code == 200, r.text
    dids = {i["did"] for i in r.json()["items"]}
    assert {D_POOL, D_NOPOOL, D_MISMATCH} <= dids


# ---------------------------------------------------------------------------
# C2 — DELETE /v1/trunks/{id}/dids/{trunk_did_id}
# ---------------------------------------------------------------------------
def test_delete_trunk_did_guards(h):
    # CRAG's own 404s are never FastAPI's bare "Not Found" (TED reads that
    # as "route not deployed yet").
    for path in (f"/v1/trunks/{T_ON}/dids/9021",      # row is on another trunk
                 f"/v1/trunks/{T_ON}/dids/424242"):   # no such row
        r = h.delete(path)
        assert r.status_code == 404 and r.json() == {"detail": "Trunk DID not found"}, path
    r = h.delete("/v1/trunks/999999/dids/9011")
    assert r.status_code == 404 and r.json() == {"detail": "Trunk not found"}
    for who in ("support", "user_b"):
        assert h.delete(f"/v1/trunks/{T_ON}/dids/9011", who=who).status_code == 403
    assert h.val("SELECT count(*) FROM trunk_dids WHERE id IN (9011, 9021)") == 2


def test_delete_trunk_did_with_pool_row(h):
    r = h.delete(f"/v1/trunks/{T_ON}/dids/9011")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "deleted", "trunk_id": T_ON, "did": E_POOL}
    assert h.val("SELECT count(*) FROM trunk_dids WHERE id = 9011") == 0
    assert h.val(f"SELECT count(*) FROM trunk_dids WHERE trunk_id = {T_ON}") == 1
    assert _reserved_for(_pool(h, E_POOL), CUST_B, f"reserved: removed from trunk {T_ON}")
    # the trunk itself is untouched (still enabled, still has its IP)
    assert h.val(f"SELECT enabled FROM sip_trunks WHERE id = {T_ON}") is True
    assert h.val(f"SELECT count(*) FROM trunk_auth_ips WHERE trunk_id = {T_ON}") == 1
    assert h.delete(f"/v1/trunks/{T_ON}/dids/9011").status_code == 404


def test_delete_trunk_did_without_pool_row(h):
    assert _pool(h, E_NOPOOL) is None
    r = h.delete(f"/v1/trunks/{T_ON}/dids/9012")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "deleted", "trunk_id": T_ON, "did": E_NOPOOL}
    p = _pool(h, E_NOPOOL)
    assert _reserved_for(p, CUST_B, f"reserved: removed from trunk {T_ON}"), p
    assert p["source"] == "manual"
