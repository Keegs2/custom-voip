"""Free-form number search on POST /v1/homer/search — normalization + LogQL.

The pinned contract (UI is built against this):
  * `number` (free-form) joins from_user/to_user/call_id. Server-side
    normalization (normalize_number_needle): strip every non-digit; exactly
    11 digits with leading 1 -> drop the 1 (NANP national core); <3 digits
    -> 422 "need at least 3 digits". The needle is a digits-only UNANCHORED
    substring regex against the raw SIP payload (containment semantics).
  * from_user/to_user keep working but pass through the SAME normalization.
  * number and from/to may combine — AND semantics (one LogQL line filter
    each, same composition as before).
  * Response shape unchanged. require_support_or_admin gate unchanged.

Two layers:

  1) PURE normalizer unit tests — homer_pipeline.py is loaded directly by
     file path (stdlib-only), exactly like tests/test_homer_pipeline.py, so
     these run without fastapi/httpx/auth installed.

  2) ENDPOINT tests — the REAL homer router mounted behind the REAL
     JWTAuthMiddleware (mirrors tests/test_support_role_authz.py), driven
     with REAL minted JWTs. ONLY the qryn/ClickHouse HTTP hop is mocked via
     httpx.MockTransport so the exact LogQL the router ships upstream is
     captured and asserted. No PostgreSQL is needed: the attestation join is
     failure-isolated by design and yields attestation=null when the DB pool
     is absent — which these tests also prove.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_homer_number_search.py -q
"""
import asyncio
import importlib.util
import os
import pathlib
import sys
from datetime import datetime, timezone

import pytest

# Env BEFORE any app-module import (auth.security reads JWT_SECRET_KEY at
# import; homer reads QRYN_URL at import — a dead local port makes any request
# that escapes the mock fail fast and loudly instead of hitting a real host).
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")
os.environ.setdefault("QRYN_URL", "http://127.0.0.1:1")

REPO = pathlib.Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

# ---------------------------------------------------------------------------
# Layer 1 — pure normalizer, loaded by file path (no fastapi required)
# ---------------------------------------------------------------------------

_PIPELINE_PATH = API_SRC / "routers" / "homer_pipeline.py"
_spec = importlib.util.spec_from_file_location("homer_pipeline", _PIPELINE_PATH)
hp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hp)


# Every user-facing format from the product requirement, plus the usual
# punctuation/junk variants, all reduce to the same 10-digit needle.
@pytest.mark.parametrize("raw", [
    "+1 (617) 454-4217",
    "617.454.4217",
    "16174544217",
    "6174544217",
    "+16174544217",
    "1-617-454-4217",
    "(617)454-4217",
    "+1.617.454.4217",
    "  617 454 4217  ",
    "tel:+16174544217",
])
def test_normalizer_all_formats_one_needle(raw):
    assert hp.normalize_number_needle(raw) == "6174544217"


@pytest.mark.parametrize("raw,expected", [
    # Partials (>=3 digits) pass through digits-only, unanchored by contract.
    ("454", "454"),
    ("4217", "4217"),
    ("617", "617"),
    ("0117", "0117"),               # leading zero preserved
    (" 45-4 ", "454"),
    ("ext. 4544217 (desk)", "4544217"),
    ("+1 (61", "161"),              # 3 digits survive -> valid partial
    # Exactly-11-with-leading-1 is the ONLY digit-dropping case.
    ("12345678901", "2345678901"),
    ("11234567890", "1234567890"),
    ("1617454421", "1617454421"),   # 10 digits starting with 1: untouched
    ("111", "111"),
    # Non-NANP / international: 11 digits not leading 1, or 12+ digits,
    # pass through unchanged.
    ("+44 20 7946 0958", "442079460958"),
    ("27123456789", "27123456789"),
    ("121234567890", "121234567890"),
    ("+1234567890123", "1234567890123"),
])
def test_normalizer_partials_nanp_and_international(raw, expected):
    assert hp.normalize_number_needle(raw) == expected


@pytest.mark.parametrize("raw", [
    None, "", "   ", "ab", "61", "+1", "1", "()-. ", "z9",
    "٦١٧",        # Unicode digits are formatting, not digits: stripped -> 0
    "+1 (6",      # only 2 digits survive
])
def test_normalizer_rejects_fewer_than_3_digits(raw):
    with pytest.raises(ValueError) as ei:
        hp.normalize_number_needle(raw)
    assert "need at least 3 digits" in str(ei.value)


def test_normalizer_output_is_ascii_digits_and_idempotent():
    for raw in ("+1 (617) 454-4217", "454", "+44 20 7946 0958", "16174544217"):
        needle = hp.normalize_number_needle(raw)
        assert needle and all(c in "0123456789" for c in needle)
        # Idempotent: normalizing a needle returns the needle (a bare
        # 10-digit NANP core is never 11 digits, so nothing more is dropped).
        assert hp.normalize_number_needle(needle) == needle


# ---------------------------------------------------------------------------
# Layer 2 — endpoint tests over the REAL router + REAL JWT middleware
# ---------------------------------------------------------------------------

try:
    import fastapi  # noqa: F401
    import httpx
    _WEB = True
except ImportError:  # pragma: no cover - dev envs have these installed
    httpx = None
    _WEB = False

needs_web = pytest.mark.skipif(not _WEB, reason="fastapi/httpx required")

# Captured BEFORE any monkeypatching so the mock factory can build real
# clients without recursing into itself.
_REAL_ASYNC_CLIENT = httpx.AsyncClient if _WEB else None

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


START = "2026-08-26T00:00:00Z"
END = "2026-08-26T01:00:00Z"
START_NS = int(datetime(2026, 8, 26, 0, 0, 0, tzinfo=timezone.utc).timestamp()) * 10**9
END_NS = int(datetime(2026, 8, 26, 1, 0, 0, tzinfo=timezone.utc).timestamp()) * 10**9

CALLID = "test-call-1@67.231.13.185"

_RAW_INVITE = (
    "INVITE sip:+17744045256@34.24.133.82 SIP/2.0\r\n"
    "Via: SIP/2.0/UDP 67.231.13.185:5060;branch=z9hG4bKtest1\r\n"
    "From: <sip:+16174544217@67.231.13.185>;tag=abc\r\n"
    "To: <sip:+17744045256@34.24.133.82>\r\n"
    f"Call-ID: {CALLID}\r\n"
    "CSeq: 102 INVITE\r\n"
    "Content-Length: 0\r\n\r\n"
)


def _loki_one_invite():
    """A minimal, realistic qryn query_range payload: one captured INVITE."""
    return {
        "data": {
            "result": [
                {
                    "stream": {
                        "type": "sip",
                        "method": "INVITE",
                        "call_id": CALLID,
                        "from": "<sip:+16174544217@67.231.13.185>;tag=abc",
                        "to": "<sip:+17744045256@34.24.133.82>",
                        "src_ip": "67.231.13.185",
                        "dst_ip": "34.24.133.82",
                        "node": "100",
                    },
                    "values": [["1781107707709698000", _RAW_INVITE]],
                }
            ]
        }
    }


class _UpstreamMock:
    """MockTransport for the qryn (and, defensively, ClickHouse) HTTP hop.

    Records every outbound request so tests can assert the EXACT LogQL and
    limit/start/end params the router shipped upstream.
    """

    def __init__(self, loki_json=None):
        self.requests = []
        self.loki_json = loki_json if loki_json is not None else {"data": {"result": []}}

    def _handle(self, request):
        self.requests.append(request)
        if "/loki/api/v1/query_range" in request.url.path:
            return httpx.Response(200, json=self.loki_json)
        return httpx.Response(200, text="")  # ClickHouse JSONEachRow: empty

    def factory(self, *args, **kwargs):
        # Signature-compatible stand-in for httpx.AsyncClient(timeout=...).
        return _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(self._handle))

    def logql(self, i=0):
        return self.requests[i].url.params["query"]


@pytest.fixture(scope="module")
def api():
    """Real homer router behind the real JWT middleware + real minted JWTs."""
    if not _WEB:
        pytest.skip("fastapi/httpx required")
    try:
        from fastapi import FastAPI
        from middleware.auth import JWTAuthMiddleware
        from auth.security import create_access_token
        from routers import homer as homer_mod
    except ImportError as exc:  # pragma: no cover
        pytest.skip(f"API deps missing: {exc}")

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(homer_mod.router, prefix="/v1/homer")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")

    def mint(sub, email, role, customer_id):
        return create_access_token(
            {"sub": sub, "email": email, "role": role, "customer_id": customer_id})

    ctx = {
        "client": client,
        "homer": homer_mod,
        "tokens": {
            "admin": mint("1", "admin@test.local", "admin", None),
            "support": mint("2", "support@test.local", "support", None),
            "user": mint("3", "tenant@test.local", "user", 42),
            "readonly": mint("4", "tenant-ro@test.local", "readonly", 42),
        },
    }
    try:
        yield ctx
    finally:
        _run(client.aclose())


def _auth(api, role):
    return {"Authorization": f"Bearer {api['tokens'][role]}"}


def _body(**kw):
    b = {"start_time": START, "end_time": END, "correlate": False}
    b.update(kw)
    return b


def _search(api, monkeypatch, role="support", loki_json=None, **fields):
    """POST /v1/homer/search with the upstream HTTP hop mocked; returns
    (response, mock) so callers can assert both sides of the seam."""
    mock = _UpstreamMock(loki_json)
    monkeypatch.setattr(api["homer"].httpx, "AsyncClient", mock.factory)
    r = _run(api["client"].post(
        "/v1/homer/search", headers=_auth(api, role), json=_body(**fields)))
    return r, mock


# ---- auth gate (unchanged) -------------------------------------------------

@needs_web
def test_search_no_token_is_401(api):
    r = _run(api["client"].post("/v1/homer/search", json=_body(number="617454")))
    assert r.status_code == 401, r.text


@needs_web
@pytest.mark.parametrize("role", ["user", "readonly"])
def test_search_tenant_roles_403(api, monkeypatch, role):
    r, mock = _search(api, monkeypatch, role=role, number="6174544217")
    assert r.status_code == 403, r.text
    assert mock.requests == []  # rejected before any upstream I/O


@needs_web
@pytest.mark.parametrize("role", ["support", "admin"])
def test_search_support_and_admin_pass_gate(api, monkeypatch, role):
    r, _mock = _search(api, monkeypatch, role=role, number="6174544217")
    assert r.status_code == 200, r.text


# ---- number: free-form normalization into the LogQL needle -----------------

@needs_web
@pytest.mark.parametrize("raw", [
    "+1 (617) 454-4217", "617.454.4217", "16174544217", "6174544217",
])
def test_number_any_form_builds_same_needle(api, monkeypatch, raw):
    r, mock = _search(api, monkeypatch, number=raw)
    assert r.status_code == 200, r.text
    assert mock.logql() == '{type="sip"} |~ "6174544217"'


@needs_web
def test_number_partial_needle_and_window_params(api, monkeypatch):
    r, mock = _search(api, monkeypatch, number="454")
    assert r.status_code == 200, r.text
    assert mock.logql() == '{type="sip"} |~ "454"'
    # Guardrails pinned: Step-1 limit 500 and the exact ns window.
    params = mock.requests[0].url.params
    assert params["limit"] == "500"
    assert params["start"] == str(START_NS)
    assert params["end"] == str(END_NS)


@needs_web
def test_number_non_nanp_passthrough(api, monkeypatch):
    r, mock = _search(api, monkeypatch, number="+44 20 7946 0958")
    assert r.status_code == 200, r.text
    assert mock.logql() == '{type="sip"} |~ "442079460958"'


# ---- from_user / to_user: same normalization, back-compat ------------------

@needs_web
def test_from_to_normalized_and_anded(api, monkeypatch):
    # The exact inputs that matched NOTHING on the legacy path (literal
    # parens/spaces; "+1"/11-digit forms missing bare payload occurrences).
    r, mock = _search(
        api, monkeypatch,
        from_user="(617) 454-4217", to_user="+1 774 404 5256")
    assert r.status_code == 200, r.text
    assert mock.logql() == '{type="sip"} |~ "6174544217" |~ "7744045256"'


@needs_web
def test_number_and_from_to_combine_with_and_semantics(api, monkeypatch):
    r, mock = _search(
        api, monkeypatch,
        from_user="617.454.4217", to_user="1.774.404.5256", number="978 555")
    assert r.status_code == 200, r.text
    # Stable filter order: from, to, number — all ANDed by LogQL.
    assert mock.logql() == (
        '{type="sip"} |~ "6174544217" |~ "7744045256" |~ "978555"'
    )


# ---- call_id: exact label match, AND-composed with number ------------------

@needs_web
def test_call_id_label_plus_number_filter(api, monkeypatch):
    r, mock = _search(
        api, monkeypatch, call_id="abc-123@host.example", number="617")
    assert r.status_code == 200, r.text
    assert mock.logql() == '{type="sip", call_id="abc-123@host.example"} |~ "617"'


@needs_web
def test_call_id_label_value_is_escaped(api):
    # Direct builder check: quote/backslash can never terminate the label
    # string (LogQL matcher injection). No-op for real word@host Call-IDs.
    q = api["homer"]._build_logql_query(None, None, 'bad"cid\\one')
    assert q == '{type="sip", call_id="bad\\"cid\\\\one"}'


# ---- 422 on <3 digits, field-named, before any upstream I/O ----------------

@needs_web
@pytest.mark.parametrize("field,raw", [
    ("number", "61"),
    ("number", "() -."),
    ("number", "abc"),
    ("from_user", "+1"),
    ("to_user", "zz"),
])
def test_422_under_three_digits_names_field(api, monkeypatch, field, raw):
    r, mock = _search(api, monkeypatch, **{field: raw})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == f"{field}: need at least 3 digits"
    assert mock.requests == []  # validation precedes any qryn query


@needs_web
def test_400_when_no_search_field_given(api, monkeypatch):
    r, mock = _search(api, monkeypatch)
    assert r.status_code == 400, r.text
    assert "number" in r.json()["detail"]
    assert mock.requests == []


# ---- response shape unchanged (incl. DB-less attestation isolation) --------

@needs_web
def test_response_shape_unchanged_with_results(api, monkeypatch):
    r, mock = _search(
        api, monkeypatch, number="+1 (617) 454-4217",
        loki_json=_loki_one_invite())
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == {"data", "correlations", "pipeline_warnings"}
    assert body["correlations"] == {}
    assert body["pipeline_warnings"] == []
    assert len(body["data"]) == 1
    m = body["data"][0]
    assert m["callid"] == CALLID
    assert m["method"] == "INVITE"
    assert m["status"] is None
    assert m["from_user"] == "+16174544217"
    assert m["to_user"] == "+17744045256"
    assert m["cseq"] == "102 INVITE"
    assert m["via_branch"] == "z9hG4bKtest1"
    assert m["seq"] == 0
    assert m["hairpin"] is False
    assert m["ts_corrected"] is False
    assert m["node"] == "100"
    # No PG in this harness: the batched attestation join is failure-isolated
    # and must stamp null, never raise.
    assert m["attestation"] is None


@needs_web
def test_correlate_step2_query_is_not_polluted_by_needles(api, monkeypatch):
    r, mock = _search(
        api, monkeypatch, number="6174544217", correlate=True,
        loki_json=_loki_one_invite())
    assert r.status_code == 200, r.text
    # Step 1 (needle) + Step 2 (X-CID discovery) — and the X-CID query must
    # NOT carry the number filters (it fetches every X-CID in the window and
    # filters by Call-ID in Python).
    assert len(mock.requests) == 2
    assert mock.logql(0) == '{type="sip"} |~ "6174544217"'
    assert mock.logql(1) == '{type="sip"} |~ "X-CID:"'
    assert mock.requests[1].url.params["limit"] == "1000"
    # Single-leg call, no X-CID found: self-group correlation only.
    assert r.json()["correlations"] == {CALLID: [CALLID]}


# ---- defense-in-depth: builder refuses un-normalized needles ---------------

@needs_web
@pytest.mark.parametrize("kwargs", [
    {"from_user": "617)evil"},
    {"to_user": "+16174544217"},        # raw "+" must never reach the builder
    {"number": "617 454"},
    {"number": "٦١٧٤"},                 # non-ASCII digits refused too
])
def test_build_logql_rejects_unnormalized_needle(api, kwargs):
    args = {"from_user": None, "to_user": None, "call_id": None}
    args.update(kwargs)
    with pytest.raises(ValueError, match="digits-only"):
        api["homer"]._build_logql_query(**args)


# ---------------------------------------------------------------------------
# Plain runner for the pure layer (no pytest required)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import traceback

    failures = 0
    checks = [
        lambda: [hp.normalize_number_needle(x) == "6174544217" for x in (
            "+1 (617) 454-4217", "617.454.4217", "16174544217", "6174544217")],
        lambda: hp.normalize_number_needle("454") == "454",
    ]
    for fn in checks:
        try:
            assert fn()
            print("PASS")
        except Exception:
            failures += 1
            traceback.print_exc()
    sys.exit(1 if failures else 0)
