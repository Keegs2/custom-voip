"""JWT middleware re-checks users.status (auth/user_status.py) — hermetic.

A session JWT lives up to 8 h; before this check a disabled or deleted user
kept working until it expired. The middleware now refuses (401) a token whose
user is not ``active`` within ``STATUS_TTL_S`` (per-process cache), fails
OPEN — logged at WARNING — when the database cannot answer, still enforces
the JWT signature / expiry / ``typ`` itself, and never runs the check on the
machine-authenticated and exempt paths.

No database here: ``user_status._lookup`` (the one PK read) is replaced per
test and ``user_status._clock`` drives the TTLs. The same rules against a
REAL users table are in tests/test_tenant_write_guards.py.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_user_status.py -q
"""
import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

httpx = pytest.importorskip("httpx", reason="httpx required")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))

from auth import user_status  # noqa: E402

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    monkeypatch.setattr(user_status, "_clock", c)
    user_status.reset()
    return c


class FakeUsers:
    """Stands in for ``SELECT status FROM users WHERE id = $1`` (counts calls)."""

    def __init__(self, statuses=None):
        self.statuses = dict(statuses or {})
        self.calls: list[int] = []
        self.error: BaseException | None = None
        self.delay = 0.0

    async def __call__(self, uid):
        self.calls.append(uid)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return self.statuses.get(uid)


@pytest.fixture
def users(monkeypatch, clock):
    fake = FakeUsers({1: "active", 2: "disabled", 3: "active"})
    monkeypatch.setattr(user_status, "_lookup", fake)
    return fake


def _token(sub="1", role="user", customer_id=7, **extra):
    from auth.security import create_access_token
    claims = {"email": "u@test", "role": role, "customer_id": customer_id, **extra}
    if sub is not None:
        claims["sub"] = sub
    return create_access_token(claims)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


#: Machine-authenticated / exempt paths (middleware/auth.py): they must never
#: reach the status check, token or not.
EXEMPT = [
    ("POST", "/freeswitch/directory"),
    ("POST", "/v1/cdrs/ingest"),
    ("POST", "/v1/cdrs/ingest/bulk"),
    ("GET", "/v1/voicemail/fs/mailbox/5"),
    ("POST", "/voicemail/fs/deposit"),
    ("GET", "/v1/voicemail/messages/5/audio"),
    ("HEAD", "/v1/voicemail/greetings/5/audio"),
    ("GET", "/v1/ivr/prompts/5/audio"),
    ("POST", "/v1/carrier-status/report"),
    ("POST", "/v1/live-trunk-stats/report"),
    ("POST", "/v1/auth/login"),
    ("POST", "/v1/onboarding"),
    ("GET", "/health"),
]


@pytest.fixture
def client():
    from fastapi import FastAPI, Request
    from middleware.auth import JWTAuthMiddleware

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)

    @app.get("/v1/ping")
    async def ping(request: Request):
        return {"sub": request.state.user["sub"]}

    async def _open():
        return {"ok": True}

    for method, path in EXEMPT:
        app.add_api_route(path, _open, methods=[method])

    c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    yield c
    _run(c.aclose())


def _get(client, token):
    return _run(client.get("/v1/ping", headers=_h(token)))


# ---------------------------------------------------------------------------
def test_active_user_passes_and_one_lookup_per_ttl(client, users, clock):
    tok = _token("1")
    for _ in range(5):
        r = _get(client, tok)
        assert r.status_code == 200, r.text
        assert r.json() == {"sub": "1"}
    assert users.calls == [1]                    # cached: one PK read per TTL
    clock.now += user_status.STATUS_TTL_S - 0.5
    assert _get(client, tok).status_code == 200
    assert users.calls == [1]
    clock.now += 1.0                             # past the TTL -> re-read
    assert _get(client, tok).status_code == 200
    assert users.calls == [1, 1]


@pytest.mark.parametrize("sub", ["2", "404"], ids=["disabled", "missing-or-deleted"])
def test_disabled_or_missing_user_401(client, users, sub):
    r = _get(client, _token(sub))
    assert r.status_code == 401, r.text
    assert r.json() == {"detail": "Not authenticated"}   # same body as a bad token


def test_status_change_applies_within_ttl(client, users, clock):
    tok = _token("3")
    assert _get(client, tok).status_code == 200
    users.statuses[3] = "disabled"               # admin disables the account
    assert _get(client, tok).status_code == 200  # still cached in THIS process...
    clock.now += user_status.STATUS_TTL_S + 0.1
    assert _get(client, tok).status_code == 401  # ...refused once the TTL lapses
    del users.statuses[3]                        # deleted outright
    clock.now += user_status.STATUS_TTL_S + 0.1
    assert _get(client, tok).status_code == 401
    users.statuses[3] = "active"                 # re-created / re-enabled
    clock.now += user_status.STATUS_TTL_S + 0.1
    assert _get(client, tok).status_code == 200
    assert user_status.STATUS_TTL_S <= 60


@pytest.mark.parametrize("sub", [None, "", "abc", "0", "-1", "1.5", "99999999999",
                                 "2147483648", "١"])
def test_sub_that_is_not_a_user_id_401_without_lookup(client, users, sub):
    r = _get(client, _token(sub))
    assert r.status_code == 401, r.text
    assert users.calls == []


def test_user_id_parsing():
    uid = user_status._user_id
    assert uid({"sub": "42"}) == 42 and uid({"sub": 42}) == 42
    assert uid({"sub": "2147483647"}) == 2147483647
    for bad in (True, False, None, 0, -3, 2147483648, "0042x", " 4", "4\n", 4.0):
        assert uid({"sub": bad}) is None, bad
    assert uid({}) is None


# -- fail behaviour when the database cannot answer ---------------------------
def test_db_error_fails_open_with_one_warning(client, users, clock, caplog):
    users.error = ConnectionRefusedError("pgbouncer down")
    caplog.set_level(logging.WARNING, logger="auth.user_status")
    tok = _token("2")                            # even a DISABLED user: status unknown
    r = _get(client, tok)
    assert r.status_code == 200, r.text          # fail open for the status check only
    warnings = [rec for rec in caplog.records if rec.name == "auth.user_status"]
    assert len(warnings) == 1 and warnings[0].levelno == logging.WARNING
    assert "fail open" in warnings[0].getMessage()
    assert "ConnectionRefusedError" in warnings[0].getMessage()
    assert "pgbouncer down" not in warnings[0].getMessage()   # class name only

    # The open answer is reused briefly (no retry per request) ...
    assert _get(client, tok).status_code == 200
    assert users.calls == [2]
    # ... then re-tried; still down -> still open, but no second warning yet.
    clock.now += user_status.FAIL_OPEN_TTL_S + 0.1
    assert _get(client, tok).status_code == 200
    assert users.calls == [2, 2]
    assert len([r for r in caplog.records if r.name == "auth.user_status"]) == 1
    # The database answers again -> the real status wins on the next re-read.
    users.error = None
    clock.now += user_status.FAIL_OPEN_TTL_S + 0.1
    assert _get(client, tok).status_code == 401
    # The warning is rate-limited per process, not suppressed forever.
    users.error = OSError("again")
    clock.now += user_status.WARN_INTERVAL_S + user_status.STATUS_TTL_S
    assert _get(client, _token("1")).status_code == 200
    assert len([r for r in caplog.records if r.name == "auth.user_status"]) == 2


def test_db_slow_fails_open_within_the_timeout(client, users, monkeypatch):
    monkeypatch.setattr(user_status, "LOOKUP_TIMEOUT_S", 0.05)
    users.delay = 5.0

    async def go():
        return await asyncio.wait_for(client.get("/v1/ping", headers=_h(_token("1"))), 2.0)

    assert _run(go()).status_code == 200


def test_no_pool_fails_open(client, clock, monkeypatch):
    from db import database as db
    monkeypatch.setattr(db, "pool", None)        # the REAL _lookup, no database
    assert _get(client, _token("1")).status_code == 200


def test_jwt_still_enforced_when_db_is_down(client, users):
    """Fail-open is for the status check only: signature, expiry and typ are
    checked first, and a bad token never reaches the lookup."""
    from jose import jwt
    users.error = ConnectionRefusedError()
    secret = os.environ["JWT_SECRET_KEY"]
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    expired = jwt.encode({"sub": "1", "role": "user", "typ": "session", "exp": past},
                         secret, algorithm="HS256")
    forged = jwt.encode({"sub": "1", "role": "admin", "typ": "session"},
                        "not-the-secret", algorithm="HS256")
    playback = jwt.encode({"sub": "1", "role": "user", "typ": "vm-playback"},
                          secret, algorithm="HS256")
    for tok in (expired, forged, playback, "garbage"):
        assert _get(client, tok).status_code == 401
    assert _run(client.get("/v1/ping")).status_code == 401      # no token at all
    assert users.calls == []


@pytest.mark.parametrize("method,path", EXEMPT)
def test_exempt_paths_never_check_status(client, monkeypatch, method, path):
    async def _boom(_claims):
        raise AssertionError("status check ran on an exempt path")

    monkeypatch.setattr(user_status, "session_user_active", _boom)
    # Even with a DISABLED user's session token attached: these paths are
    # authenticated by other means (or are public) and never consult users.
    r = _run(client.request(method, path, headers=_h(_token("2"))))
    assert r.status_code == 200, (method, path, r.text)
