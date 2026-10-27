"""Visual IVR admin "All customers" overview: GET /v1/ivr/admin/overview.

The IVR harness (tests/test_ivr_api.py: real init scripts + 59/60/61, the api
pool as the runtime ``api`` role, the REAL JWT middleware, main.py's IvrApiError
handler) with flows / versions / IVR numbers seeded directly so every count is
known exactly.

Covers: the exact rows (who is listed, counts, ``last_published_at``,
case-insensitive name order), consistency with the per-customer admin shape
(``GET /admin/customers/{id}``), both mounts, and roles (support / tenants 403,
anonymous 401).

Counts (services/ivr/store.py ADMIN_OVERVIEW_SQL):
  flows_total       call_flows rows of the customer
  flows_published   flows with published_version_id set (a live version)
  numbers_bound     ivr_numbers rows with flow_id set (any state)
  last_published_at newest published_at of the customer's live versions
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_ivr_api import IvrHarness  # noqa: E402
from voicemail_api_harness import CUST_A, CUST_B  # noqa: E402

PORT = 55525  # IVR range 55520-55529

CUST_CLOSED = 103     # harness: 'Closed Co', suspended
CUST_OFF = 104        # IvrHarness: 'Off Co' — never entitled, no flows
CUST_LOWER = 105      # 'aardvark Inc' — lowercase name, entitled, no flows
CUST_NUM_ONLY = 106   # IVR number but IVR off and no flow -> not listed


class OverviewHarness(IvrHarness):
    async def _setup(self) -> None:
        await super()._setup()
        conn = await self.owner()
        try:
            await conn.execute(
                f"""
                INSERT INTO customers (id, name, account_type, status, ivr_enabled) VALUES
                  ({CUST_LOWER}, 'aardvark Inc', 'rcf', 'active', true),
                  ({CUST_NUM_ONLY}, 'Zeta LLC', 'rcf', 'active', false);
                UPDATE customers SET ivr_enabled = true WHERE id IN ({CUST_A}, {CUST_CLOSED});
                -- A: 3 flows — Main (v1, v2 live), Draft (never published),
                --    Holiday (v1 live)
                INSERT INTO call_flows (id, customer_id, name, draft_graph) VALUES
                  (9001, {CUST_A}, 'Main', '{{}}'),
                  (9002, {CUST_A}, 'Draft', '{{}}'),
                  (9003, {CUST_A}, 'Holiday', '{{}}'),
                  (9004, {CUST_B}, 'Beta draft', '{{}}');
                INSERT INTO call_flow_versions
                  (id, flow_id, version, graph, plan, compiler_version, published_at) VALUES
                  (9101, 9001, 1, '{{}}', '{{}}', 'test', '2026-10-01T12:00:00Z'),
                  (9102, 9001, 2, '{{}}', '{{}}', 'test', '2026-10-20T09:30:00Z'),
                  (9103, 9003, 1, '{{}}', '{{}}', 'test', '2026-10-10T08:00:00Z');
                UPDATE call_flows SET published_version_id = 9102 WHERE id = 9001;
                UPDATE call_flows SET published_version_id = 9103 WHERE id = 9003;
                -- A: 4 IVR numbers — bound to Main, bound to the unpublished
                --    Draft, unbound, bound to Holiday but switched off
                INSERT INTO ivr_numbers (customer_id, did, name, flow_id, enabled) VALUES
                  ({CUST_A}, '+16175550301', 'Main line', 9001, true),
                  ({CUST_A}, '+16175550302', 'Test line', 9002, true),
                  ({CUST_A}, '+16175550303', 'Spare', NULL, true),
                  ({CUST_A}, '+16175550304', 'Holiday line', 9003, false),
                  ({CUST_NUM_ONLY}, '+16175550601', NULL, NULL, true);
                """)
        finally:
            await conn.close()


@pytest.fixture(scope="module")
def h():
    harness = OverviewHarness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


def get(h, path, who="admin"):
    headers = h.auth(who) if who else {}
    return h.run(h.client.get(path, headers=headers))


EXPECTED = [
    {"customer_id": CUST_LOWER, "name": "aardvark Inc", "status": "active",
     "ivr_enabled": True, "flows_total": 0, "flows_published": 0, "numbers_bound": 0,
     "last_published_at": None},
    {"customer_id": CUST_A, "name": "Acme Voicemail", "status": "active",
     "ivr_enabled": True, "flows_total": 3, "flows_published": 2, "numbers_bound": 3,
     "last_published_at": "2026-10-20T09:30:00+00:00"},
    # IVR off but it has a flow -> listed
    {"customer_id": CUST_B, "name": "Beta Corp", "status": "active",
     "ivr_enabled": False, "flows_total": 1, "flows_published": 0, "numbers_bound": 0,
     "last_published_at": None},
    {"customer_id": CUST_CLOSED, "name": "Closed Co", "status": "suspended",
     "ivr_enabled": True, "flows_total": 0, "flows_published": 0, "numbers_bound": 0,
     "last_published_at": None},
]


def test_admin_overview_rows(h):
    r = get(h, "/v1/ivr/admin/overview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"customers": EXPECTED}
    listed = {c["customer_id"] for c in body["customers"]}
    # neither entitled nor any flow -> not listed (an IVR number alone is not enough)
    assert CUST_OFF not in listed and CUST_NUM_ONLY not in listed
    # name order is case-insensitive ('aardvark' before 'Acme')
    assert [c["name"].lower() for c in body["customers"]] == \
        sorted(c["name"].lower() for c in body["customers"])


def test_admin_overview_both_mounts_and_admin_with_customer(h):
    v1 = get(h, "/v1/ivr/admin/overview")
    assert get(h, "/ivr/admin/overview").json() == v1.json()
    # an admin JWT that carries its own customer_id still sees every customer
    assert get(h, "/v1/ivr/admin/overview", "admin_with_cid").json() == v1.json()


def test_admin_overview_matches_the_per_customer_admin_shape(h):
    for row in get(h, "/v1/ivr/admin/overview").json()["customers"]:
        one = get(h, f"/v1/ivr/admin/customers/{row['customer_id']}").json()
        flows, numbers = one["flows"], one["numbers"]
        assert row["ivr_enabled"] == one["ivr_enabled"]
        assert row["flows_total"] == len(flows)
        assert row["flows_published"] == sum(f["published_version"] is not None for f in flows)
        assert row["numbers_bound"] == sum(n["flow_id"] is not None for n in numbers)
        times = [f["published_at"] for f in flows if f["published_at"]]
        assert (row["last_published_at"] is None) == (not times)


@pytest.mark.parametrize("who", ["support", "user_a", "ro_a", "user_b", "user_off"])
def test_admin_overview_is_admin_only(h, who):
    r = get(h, "/v1/ivr/admin/overview", who)
    assert r.status_code == 403
    assert r.json()["detail"] == "Admin access required"
    assert get(h, "/ivr/admin/overview", who).status_code == 403


def test_admin_overview_requires_auth(h):
    assert get(h, "/v1/ivr/admin/overview", None).status_code == 401
