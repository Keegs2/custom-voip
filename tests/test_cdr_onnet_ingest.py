"""Unit tests for on-net CDR field extraction in routers/cdrs.py::_process_cdr_body.

Runnable WITHOUT a live DB: `db.execute` is faked to capture the positional
params. Mirrors the sys.path pattern of tests/test_cdr_export.py (put
docker/api/src on the path so `from db import database` / `routers.cdrs`
resolve exactly as they do inside the API container, WORKDIR /app == src/).

Run:
    python3 -m pytest tests/test_cdr_onnet_ingest.py -v

Focus: the four additive on-net columns (origin_customer_id,
terminating_customer_id, on_net, on_net_hops) are extracted from FreeSWITCH
`variables`, bound as $50-$53, the two inbound-carrier attribution columns
(inbound_carrier, inbound_carrier_pop — migration 40) as $54-$55, and that the
always-return-200 ingest contract and off-net backward-compatibility
(on_net=false) are intact.
"""
import sys
import pathlib
import asyncio

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from db import database as db  # noqa: E402
from routers import cdrs  # noqa: E402


# ---------------------------------------------------------------------------
# Fake db.execute: capture the SQL + positional params of the CDR INSERT.
# ---------------------------------------------------------------------------
class _Capture:
    def __init__(self):
        self.sql = None
        self.params = None

    async def execute(self, sql, *params):
        self.sql = sql
        self.params = params
        return "INSERT 0 1"


@pytest.fixture
def cap(monkeypatch):
    c = _Capture()
    monkeypatch.setattr(db, "execute", c.execute)
    return c


def _base_variables(**overrides):
    """A minimal-but-valid FreeSWITCH variables dict that passes the required-
    field gates in _process_cdr_body (uuid, destination, start/end epoch)."""
    v = {
        "uuid": "abc-123",
        "direction": "inbound",
        "product_type": "rcf",
        "destination_number": "+17744045256",
        "caller_id_number": "+15087282017",
        "start_epoch": "1700000000",
        "end_epoch": "1700000030",
        "answer_epoch": "1700000005",
        "duration": "30",
        "billsec": "25",
        "hangup_cause": "NORMAL_CLEARING",
        "customer_id": "20",
    }
    v.update(overrides)
    return v


# Column order in the INSERT (must match cdrs.py). The tail is: the four
# on-net columns ($50..$53) then the two inbound-carrier columns ($54..$55),
# so negative indices from the end are -6..-1.
IDX_ORIGIN = -6
IDX_TERMINATING = -5
IDX_ON_NET = -4
IDX_ON_NET_HOPS = -3
IDX_INBOUND_CARRIER = -2
IDX_INBOUND_CARRIER_POP = -1

PARAM_COUNT = 55


def _run(body):
    return asyncio.run(cdrs._process_cdr_body(body))


def test_onnet_fields_extracted(cap):
    """On-net call: all four fields populated and bound correctly."""
    body = {"variables": _base_variables(
        customer_id="20",            # terminal customer
        origin_customer_id="10",
        terminating_customer_id="20",
        on_net="true",
        on_net_hops="2",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p is not None, "INSERT was not executed"
    assert len(p) == PARAM_COUNT, f"expected {PARAM_COUNT} bind params, got {len(p)}"
    # customer_id is the terminal customer (param $2, index 1)
    assert p[1] == 20
    assert p[IDX_ORIGIN] == 10
    assert p[IDX_TERMINATING] == 20
    assert p[IDX_ON_NET] is True
    assert p[IDX_ON_NET_HOPS] == 2


def test_offnet_backward_compatible(cap):
    """Off-net call (FS sets on_net=false, origin==terminating==customer)."""
    body = {"variables": _base_variables(
        customer_id="10",
        origin_customer_id="10",
        terminating_customer_id="10",
        on_net="false",
        on_net_hops="0",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p[IDX_ORIGIN] == 10
    assert p[IDX_TERMINATING] == 10
    assert p[IDX_ON_NET] is False
    assert p[IDX_ON_NET_HOPS] == 0


def test_missing_onnet_fields_are_none(cap):
    """A CDR with no on-net variables (e.g. a call from before this change)
    binds NULL for all four columns and still ingests 200/ok."""
    body = {"variables": _base_variables()}  # no on-net vars at all
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p[IDX_ORIGIN] is None
    assert p[IDX_TERMINATING] is None
    assert p[IDX_ON_NET] is None
    assert p[IDX_ON_NET_HOPS] is None


def test_on_net_string_variants(cap):
    """on_net accepts the FS channel-var string forms."""
    for raw, expected in (("true", True), ("True", True), ("1", True),
                          ("t", True), ("yes", True),
                          ("false", False), ("0", False), ("", False),
                          ("no", False)):
        body = {"variables": _base_variables(on_net=raw)}
        result = _run(body)
        assert result["status"] == "ok"
        assert cap.params[IDX_ON_NET] is expected, f"on_net={raw!r}"


def test_insert_param_count_matches_placeholders(cap):
    """Guardrail: the number of $N placeholders in the SQL equals the number of
    bind params (catches a future column/param drift)."""
    import re
    body = {"variables": _base_variables(
        origin_customer_id="10", terminating_customer_id="20",
        on_net="true", on_net_hops="1",
    )}
    _run(body)
    placeholders = set(re.findall(r"\$(\d+)", cap.sql))
    # highest placeholder index must equal the param count (55)
    assert max(int(x) for x in placeholders) == len(cap.params) == PARAM_COUNT


def test_ingest_always_returns_ok_dict_on_bad_body(cap):
    """Contract: processing never raises; a malformed body returns an error
    dict (the HTTP layer still returns 200)."""
    result = _run({"variables": {}})  # missing everything
    assert result["status"] == "error"


# ---------------------------------------------------------------------------
# Inbound-carrier attribution ($54/$55 — migration 40).
# ---------------------------------------------------------------------------

def test_inbound_carrier_fields_extracted(cap):
    """FS channel vars inbound_carrier / inbound_carrier_pop bind as $54/$55."""
    body = {"variables": _base_variables(
        inbound_carrier="sinch",
        inbound_carrier_pop="denver",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert len(p) == PARAM_COUNT
    assert p[IDX_INBOUND_CARRIER] == "sinch"
    assert p[IDX_INBOUND_CARRIER_POP] == "denver"


def test_missing_inbound_carrier_fields_are_none(cap):
    """Absent inbound-carrier vars (legacy calls / customer-trunk sources)
    bind NULL for both columns and still ingest ok."""
    body = {"variables": _base_variables()}  # no inbound-carrier vars
    result = _run(body)
    assert result["status"] == "ok"
    assert cap.params[IDX_INBOUND_CARRIER] is None
    assert cap.params[IDX_INBOUND_CARRIER_POP] is None


def test_empty_inbound_carrier_vars_are_none(cap):
    """FS emits unset channel vars as "" in some paths — store NULL, not ''."""
    body = {"variables": _base_variables(
        inbound_carrier="", inbound_carrier_pop="",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    assert cap.params[IDX_INBOUND_CARRIER] is None
    assert cap.params[IDX_INBOUND_CARRIER_POP] is None


def test_inbound_carrier_truncated_to_column_width(cap):
    """Values longer than the column widths (20/50) are truncated, not erred."""
    body = {"variables": _base_variables(
        inbound_carrier="x" * 40, inbound_carrier_pop="y" * 80,
    )}
    result = _run(body)
    assert result["status"] == "ok"
    assert cap.params[IDX_INBOUND_CARRIER] == "x" * 20
    assert cap.params[IDX_INBOUND_CARRIER_POP] == "y" * 50
