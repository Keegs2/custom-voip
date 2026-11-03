"""Subscribers (C3) and drift (C4) — GET /v1/numbers/subscribers and
GET /v1/numbers/drift, full stack.

Real routers behind the real JWT middleware on an ephemeral PostgreSQL 16
(tests/admin_redesign_harness.py: the real chain incl. 59's number_routing
with every product arm). One subscriber/pool pair is seeded per drift kind,
plus rows that must NOT count as drift (a clean rcf, a clean voicemail box, a
release_requested subscriber, a reserved pool row with no subscriber, an
available pool row).

C4: exact summary (all seven kinds, zeros included), kind order (first match
wins), kind filter, paging, exact item shape, generated_at, 422 on a bad
kind / limit, admin only.
C3: every product arm listed with its pool row and drift, pool_* null without
a pool row, filters customer_id / product_type / q / drift_only, paging,
422s, admin only; the literal paths do not collide with /{did}/... routes.

Run:  TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python3 -m pytest tests/test_number_drift.py -q
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_redesign_harness import AdminHarness  # noqa: E402
from voicemail_api_harness import CUST_A, CUST_B  # noqa: E402

PORT = 55541  # admin-redesign range 55540-55549

T_B = 701
S_OK = "+16175558001"        # rcf A, pool assigned rcf A, same ref -> clean
S_NOPOOL = "+16175558002"    # rcf A, no pool row -> subscriber_not_in_pool
S_AVAIL = "+16175558003"     # trunk B, pool available -> subscriber_pool_not_assigned
S_RESERVED = "+16175558004"  # trunk B, pool reserved -> subscriber_pool_not_assigned
S_CUST = "+16175558005"      # rcf A, pool assigned to B -> customer_mismatch
S_PROD = "+16175558006"      # trunk B, pool says rcf -> product_mismatch
S_REF = "+16175558007"       # trunk B, pool ref NULL -> ref_mismatch
S_DUP = "+16175558008"       # rcf A AND trunk B -> duplicate_product (2 items)
S_VM = "+16175558009"        # voicemail A, pool assigned voicemail, same ref -> clean
S_RELEASE = "+16175558010"   # rcf B, pool release_requested -> clean
P_ORPHAN = "+16175558101"    # pool assigned, no subscriber -> orphan_pool_assignment
P_ORPHAN_REL = "+16175558102"  # pool release_requested, no subscriber -> orphan
P_RESERVED = "+16175558103"  # pool reserved, no subscriber -> NOT drift
P_AVAIL = "+16175558104"     # pool available -> NOT drift

EXPECTED_SUMMARY = {
    "duplicate_product": 2,
    "subscriber_not_in_pool": 1,
    "subscriber_pool_not_assigned": 2,
    "orphan_pool_assignment": 2,
    "customer_mismatch": 1,
    "product_mismatch": 1,
    "ref_mismatch": 1,
}
SUB_DRIFT = {   # (did, product_type) -> drift
    (S_OK, "rcf"): None,
    (S_NOPOOL, "rcf"): "subscriber_not_in_pool",
    (S_AVAIL, "trunk"): "subscriber_pool_not_assigned",
    (S_RESERVED, "trunk"): "subscriber_pool_not_assigned",
    (S_CUST, "rcf"): "customer_mismatch",
    (S_PROD, "trunk"): "product_mismatch",
    (S_REF, "trunk"): "ref_mismatch",
    (S_DUP, "rcf"): "duplicate_product",
    (S_DUP, "trunk"): "duplicate_product",
    (S_VM, "voicemail"): None,
    (S_RELEASE, "rcf"): None,
}
ITEM_KEYS = ["did", "product_type", "customer_id", "customer_name", "product_ref_id",
             "product_name", "product_enabled", "trunk_id", "pool_status",
             "pool_customer_id", "pool_product_type", "drift"]
DRIFT_ITEM_KEYS = ["did", "kind", "sub_product", "sub_customer_id", "sub_customer_name",
                   "product_enabled", "pool_status", "pool_product", "pool_customer_id",
                   "pool_customer_name"]


class DriftHarness(AdminHarness):
    async def _setup(self) -> None:
        await super()._setup()
        conn = await self.owner()
        try:
            await conn.execute(f"""
                UPDATE customers SET voicemail_enabled = true WHERE id = {CUST_A};
                INSERT INTO rcf_numbers (id, customer_id, did, name, forward_to) VALUES
                  (601, {CUST_A}, '{S_OK}', 'Main', '+17745550001'),
                  (602, {CUST_A}, '{S_NOPOOL}', 'No pool', '+17745550002'),
                  (605, {CUST_A}, '{S_CUST}', 'Cust', '+17745550005'),
                  (608, {CUST_A}, '{S_DUP}', 'Dup', '+17745550008'),
                  (610, {CUST_B}, '{S_RELEASE}', 'Leaving', '+17745550010');
                INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, enabled)
                VALUES ({T_B}, {CUST_B}, 'b-pbx', 10, true);
                INSERT INTO trunk_dids (id, trunk_id, did) VALUES
                  (703, {T_B}, '{S_AVAIL}'), (704, {T_B}, '{S_RESERVED}'),
                  (706, {T_B}, '{S_PROD}'), (707, {T_B}, '{S_REF}'), (708, {T_B}, '{S_DUP}');
                INSERT INTO voicemail_boxes (id, customer_id, did, label, status)
                VALUES (909, {CUST_A}, '{S_VM}', 'Front desk', 'active');
                INSERT INTO did_inventory (did, customer_id, product_type, product_ref_id, status) VALUES
                  ('{S_OK}', {CUST_A}, 'rcf', 601, 'assigned'),
                  ('{S_AVAIL}', NULL, NULL, NULL, 'available'),
                  ('{S_RESERVED}', {CUST_B}, NULL, NULL, 'reserved'),
                  ('{S_CUST}', {CUST_B}, 'rcf', 605, 'assigned'),
                  ('{S_PROD}', {CUST_B}, 'rcf', 706, 'assigned'),
                  ('{S_REF}', {CUST_B}, 'trunk', NULL, 'assigned'),
                  ('{S_DUP}', {CUST_A}, 'rcf', 608, 'assigned'),
                  ('{S_VM}', {CUST_A}, 'voicemail', 909, 'assigned'),
                  ('{S_RELEASE}', {CUST_B}, 'rcf', 610, 'release_requested'),
                  ('{P_ORPHAN}', {CUST_A}, 'rcf', 999, 'assigned'),
                  ('{P_ORPHAN_REL}', {CUST_B}, 'trunk', NULL, 'release_requested'),
                  ('{P_RESERVED}', {CUST_A}, NULL, NULL, 'reserved'),
                  ('{P_AVAIL}', NULL, NULL, NULL, 'available');
            """)
        finally:
            await conn.close()


@pytest.fixture(scope="module")
def h():
    harness = DriftHarness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# C4 — GET /v1/numbers/drift
# ---------------------------------------------------------------------------
def test_drift_summary_and_items(h):
    body = _ok(h.get("/v1/numbers/drift"))
    assert list(body) == ["summary", "items", "total", "limit", "offset", "generated_at"]
    assert body["summary"] == EXPECTED_SUMMARY
    assert list(body["summary"]) == list(EXPECTED_SUMMARY)       # contract order
    assert body["total"] == sum(EXPECTED_SUMMARY.values()) == 10
    assert (body["limit"], body["offset"]) == (200, 0)
    datetime.fromisoformat(body["generated_at"])
    got = {(i["did"], i["sub_product"]): i["kind"] for i in body["items"]}
    want = {k: v for k, v in SUB_DRIFT.items() if v is not None}
    want[(P_ORPHAN, None)] = "orphan_pool_assignment"
    want[(P_ORPHAN_REL, None)] = "orphan_pool_assignment"
    assert got == want
    # reserved-without-subscriber, available, clean subscribers: never drift
    listed = {i["did"] for i in body["items"]}
    assert not listed & {P_RESERVED, P_AVAIL, S_OK, S_VM, S_RELEASE}
    assert [i["did"] for i in body["items"]] == sorted(i["did"] for i in body["items"])


def test_drift_item_shape(h):
    body = _ok(h.get("/v1/numbers/drift", kind="customer_mismatch"))
    assert body["total"] == 1 and body["summary"] == EXPECTED_SUMMARY
    (item,) = body["items"]
    assert list(item) == DRIFT_ITEM_KEYS
    assert item == {
        "did": S_CUST, "kind": "customer_mismatch", "sub_product": "rcf",
        "sub_customer_id": CUST_A, "sub_customer_name": "Acme Voicemail",
        "product_enabled": True, "pool_status": "assigned", "pool_product": "rcf",
        "pool_customer_id": CUST_B, "pool_customer_name": "Beta Corp",
    }
    (orphan,) = _ok(h.get("/v1/numbers/drift", kind="orphan_pool_assignment",
                          limit=1, offset=1))["items"]
    assert orphan == {
        "did": P_ORPHAN_REL, "kind": "orphan_pool_assignment", "sub_product": None,
        "sub_customer_id": None, "sub_customer_name": None, "product_enabled": None,
        "pool_status": "release_requested", "pool_product": "trunk",
        "pool_customer_id": CUST_B, "pool_customer_name": "Beta Corp",
    }
    (nopool,) = _ok(h.get("/v1/numbers/drift", kind="subscriber_not_in_pool"))["items"]
    assert nopool["pool_status"] is None and nopool["pool_customer_name"] is None


def test_drift_paging_and_filters(h):
    p1 = _ok(h.get("/v1/numbers/drift", limit=4))
    p2 = _ok(h.get("/v1/numbers/drift", limit=4, offset=4))
    p3 = _ok(h.get("/v1/numbers/drift", limit=4, offset=8))
    assert [len(p["items"]) for p in (p1, p2, p3)] == [4, 4, 2]
    assert all(p["total"] == 10 for p in (p1, p2, p3))
    seen = [(i["did"], i["sub_product"]) for p in (p1, p2, p3) for i in p["items"]]
    assert len(set(seen)) == 10
    past = _ok(h.get("/v1/numbers/drift", offset=50))
    assert past["items"] == [] and past["total"] == 10
    for k, n in EXPECTED_SUMMARY.items():
        b = _ok(h.get("/v1/numbers/drift", kind=k))
        assert b["total"] == n == len(b["items"]) and {i["kind"] for i in b["items"]} == {k}


def test_drift_validation_and_roles(h):
    assert h.get("/v1/numbers/drift", kind="nope").status_code == 422
    assert h.get("/v1/numbers/drift", limit=0).status_code == 422
    assert h.get("/v1/numbers/drift", limit=1001).status_code == 422
    assert h.get("/v1/numbers/drift", offset=-1).status_code == 422
    for who in ("support", "user_a", "ro_a"):
        assert h.get("/v1/numbers/drift", who=who).status_code == 403, who


def test_drift_zero_kinds_reported(h):
    """A kind with no rows is reported as 0 (all seven keys always present)."""
    h.sql(f"UPDATE did_inventory SET product_ref_id = 707 WHERE did = '{S_REF}'")
    try:
        body = _ok(h.get("/v1/numbers/drift"))
        assert body["summary"]["ref_mismatch"] == 0
        assert set(body["summary"]) == set(EXPECTED_SUMMARY)
    finally:
        h.sql(f"UPDATE did_inventory SET product_ref_id = NULL WHERE did = '{S_REF}'")


# ---------------------------------------------------------------------------
# C3 — GET /v1/numbers/subscribers
# ---------------------------------------------------------------------------
def test_subscribers_all(h):
    body = _ok(h.get("/v1/numbers/subscribers"))
    assert list(body) == ["items", "total", "limit", "offset"]
    assert body["total"] == len(SUB_DRIFT) == 11
    assert (body["limit"], body["offset"]) == (100, 0)
    got = {(i["did"], i["product_type"]): i["drift"] for i in body["items"]}
    assert got == SUB_DRIFT
    for i in body["items"]:
        assert list(i) == ITEM_KEYS


def test_subscribers_item_values(h):
    items = {(i["did"], i["product_type"]): i
             for i in _ok(h.get("/v1/numbers/subscribers"))["items"]}
    assert items[(S_OK, "rcf")] == {
        "did": S_OK, "product_type": "rcf", "customer_id": CUST_A,
        "customer_name": "Acme Voicemail", "product_ref_id": 601, "product_name": "Main",
        "product_enabled": True, "trunk_id": None, "pool_status": "assigned",
        "pool_customer_id": CUST_A, "pool_product_type": "rcf", "drift": None,
    }
    trunk_dup = items[(S_DUP, "trunk")]
    assert (trunk_dup["customer_id"], trunk_dup["customer_name"], trunk_dup["trunk_id"],
            trunk_dup["product_ref_id"], trunk_dup["product_name"]) == \
        (CUST_B, "Beta Corp", T_B, 708, "b-pbx")
    nopool = items[(S_NOPOOL, "rcf")]
    assert (nopool["pool_status"], nopool["pool_customer_id"], nopool["pool_product_type"]) \
        == (None, None, None)
    vm = items[(S_VM, "voicemail")]
    assert (vm["product_ref_id"], vm["product_name"], vm["product_enabled"]) == \
        (909, "Front desk", True)


def test_subscribers_filters(h):
    b = _ok(h.get("/v1/numbers/subscribers", customer_id=CUST_B))
    assert {(i["did"], i["product_type"]) for i in b["items"]} == \
        {k for k in SUB_DRIFT if k[0] in (S_AVAIL, S_RESERVED, S_PROD, S_REF, S_RELEASE)
         or k == (S_DUP, "trunk")}
    b = _ok(h.get("/v1/numbers/subscribers", product_type="trunk"))
    assert b["total"] == 5 and {i["product_type"] for i in b["items"]} == {"trunk"}
    # duplicate is detected across arms even when one arm is filtered out
    dup = [i for i in b["items"] if i["did"] == S_DUP]
    assert dup and dup[0]["drift"] == "duplicate_product"
    b = _ok(h.get("/v1/numbers/subscribers", q="(617) 555-8008"))
    assert {i["did"] for i in b["items"]} == {S_DUP} and b["total"] == 2
    b = _ok(h.get("/v1/numbers/subscribers", q="800"))     # substring
    assert {i["did"] for i in b["items"]} == {S_OK, S_NOPOOL, S_AVAIL, S_RESERVED, S_CUST,
                                              S_PROD, S_REF, S_DUP, S_VM}
    b = _ok(h.get("/v1/numbers/subscribers", drift_only="true"))
    assert b["total"] == 8 and all(i["drift"] for i in b["items"])
    b = _ok(h.get("/v1/numbers/subscribers", drift_only="true", customer_id=CUST_A,
                  product_type="rcf"))
    assert {i["did"] for i in b["items"]} == {S_NOPOOL, S_CUST, S_DUP}
    assert _ok(h.get("/v1/numbers/subscribers", product_type="ivr"))["total"] == 0


def test_subscribers_paging(h):
    pages = [_ok(h.get("/v1/numbers/subscribers", limit=5, offset=o)) for o in (0, 5, 10, 20)]
    assert [len(p["items"]) for p in pages] == [5, 5, 1, 0]
    assert all(p["total"] == 11 for p in pages)
    keys = [(i["did"], i["product_type"]) for p in pages for i in p["items"]]
    assert keys == sorted(keys) and len(set(keys)) == 11


def test_subscribers_validation_and_roles(h):
    assert h.get("/v1/numbers/subscribers", product_type="ucaas").status_code == 422
    assert h.get("/v1/numbers/subscribers", q="61").status_code == 422
    assert h.get("/v1/numbers/subscribers", limit=501).status_code == 422
    assert h.get("/v1/numbers/subscribers", limit=0).status_code == 422
    assert h.get("/v1/numbers/subscribers", offset=-1).status_code == 422
    for who in ("support", "user_a", "ro_a"):
        assert h.get("/v1/numbers/subscribers", who=who).status_code == 403, who
