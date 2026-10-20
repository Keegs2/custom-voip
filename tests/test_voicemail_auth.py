"""Auth for encrypted voicemail (contract §3) through the REAL JWTAuthMiddleware.

  * session tokens carry typ="session" and authenticate; legacy tokens with no
    typ still authenticate (they expire within JWT_EXPIRE_MINUTES);
  * any other typ — including typ="vm-playback" signed with the SESSION key,
    and a JSON-null typ — is rejected as a Bearer;
  * a real playback token is rejected as a Bearer (different key + aud + typ);
  * playback tokens: 120 s, bound to kind + object id, random jti, refused when
    the secret is unset / short / equal to JWT_SECRET_KEY (503-class error),
    expired / tampered / wrong object / over-long lifetime -> PlaybackTokenError;
  * ingest secret: unset or short -> 503 (fail closed), missing/wrong header ->
    401, correct -> through; a non-ASCII header is a clean 401, not a 500;
  * middleware exemptions match ONLY the intended voicemail paths/methods, and
    every pre-existing exemption still works.

No database needed. Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_auth.py -q
"""
import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

httpx = pytest.importorskip("httpx", reason="httpx required for auth tests")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))

from fastapi import Depends, FastAPI, HTTPException, Request  # noqa: E402
from jose import jwt  # noqa: E402

from auth import playback  # noqa: E402
from auth.ingest import require_ingest_secret  # noqa: E402
from auth.security import (  # noqa: E402
    JWT_ALGORITHM,
    JWT_SECRET,
    create_access_token,
    decode_access_token,
)
from middleware.auth import JWTAuthMiddleware, is_voicemail_exempt  # noqa: E402

PLAYBACK_SECRET = "p" * 48
INGEST_SECRET = "i" * 40

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


@pytest.fixture(autouse=True)
def _secrets(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_PLAYBACK_SECRET", PLAYBACK_SECRET)
    monkeypatch.setenv("INGEST_SHARED_SECRET", INGEST_SECRET)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)

    @app.post("/v1/voicemail/fs/deposit", dependencies=[Depends(require_ingest_secret)])
    async def deposit():
        return {"status": "stored"}

    @app.api_route("/v1/voicemail/messages/{message_id}/audio", methods=["GET", "HEAD"],
                   include_in_schema=False)
    async def audio(message_id: int, t: str = ""):
        try:
            claims = playback.verify_playback_token(t, "message", message_id)
        except playback.PlaybackTokenError:
            raise HTTPException(status_code=401, detail="bad token")
        return {"jti": claims["jti"]}

    @app.get("/v1/voicemail/mailboxes")
    async def mailboxes(request: Request):
        return {"user": request.state.user}

    # Catch-all: anything that gets PAST the middleware answers 200 (no
    # newline in `.*`, so a path ending in "\n" that slips through 404s).
    @app.api_route("/{rest:path}", methods=["GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS"],
                   include_in_schema=False)
    async def catch_all(rest: str):
        return {"reached": rest}

    return app


@pytest.fixture(scope="module")
def client():
    transport = httpx.ASGITransport(app=_build_app(), raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


CLAIMS = {"sub": "7", "email": "u@test.local", "role": "user", "customer_id": 42}


# ---------------------------------------------------------------------------
# Session tokens
# ---------------------------------------------------------------------------
def test_session_token_has_typ_and_is_accepted(client):
    token = create_access_token(dict(CLAIMS, typ="something-else"))
    claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    assert claims["typ"] == "session", "callers cannot override typ"

    async def go():
        r = await client.get("/v1/voicemail/mailboxes", headers=_bearer(token))
        assert r.status_code == 200, r.text
        assert r.json()["user"]["customer_id"] == 42

    _run(go())


def test_legacy_token_without_typ_still_accepted(client):
    legacy = jwt.encode(dict(CLAIMS, exp=int(time.time()) + 600), JWT_SECRET, algorithm=JWT_ALGORITHM)
    assert "typ" not in jwt.get_unverified_claims(legacy)

    async def go():
        r = await client.get("/v1/voicemail/mailboxes", headers=_bearer(legacy))
        assert r.status_code == 200, r.text

    _run(go())


@pytest.mark.parametrize("typ", ["vm-playback", "refresh", "", None, "SESSION"])
def test_non_session_typ_rejected_even_with_session_key(client, typ):
    forged = jwt.encode(dict(CLAIMS, typ=typ, exp=int(time.time()) + 600),
                        JWT_SECRET, algorithm=JWT_ALGORITHM)

    async def go():
        r = await client.get("/v1/voicemail/mailboxes", headers=_bearer(forged))
        assert r.status_code == 401
        r = await client.get("/v1/customers", headers=_bearer(forged))
        assert r.status_code == 401

    _run(go())


def test_session_key_token_with_audience_rejected():
    forged = jwt.encode(dict(CLAIMS, aud="vm-playback", exp=int(time.time()) + 600),
                        JWT_SECRET, algorithm=JWT_ALGORITHM)
    with pytest.raises(Exception):
        decode_access_token(forged)


def test_playback_token_rejected_as_bearer(client):
    token = playback.mint_playback_token("message", 5, 42, 7)

    async def go():
        for path in ("/v1/voicemail/mailboxes", "/v1/customers", "/v1/cdrs"):
            r = await client.get(path, headers=_bearer(token))
            assert r.status_code == 401, path

    _run(go())


# ---------------------------------------------------------------------------
# Playback tokens
# ---------------------------------------------------------------------------
def test_playback_token_round_trip_and_claims():
    token = playback.mint_playback_token("greeting", 9, 42, 7, download=True)
    claims = playback.verify_playback_token(token, "greeting", 9)
    assert claims["aud"] == "vm-playback" and claims["typ"] == "vm-playback"
    assert claims["k"] == "greeting" and claims["oid"] == 9 and claims["cid"] == 42
    assert claims["sub"] == "7" and claims["dl"] is True
    assert claims["exp"] - claims["iat"] == 120
    other = playback.verify_playback_token(playback.mint_playback_token("greeting", 9, 42, 7),
                                           "greeting", 9)
    assert other["jti"] != claims["jti"] and other["dl"] is False


def test_playback_token_bound_to_object():
    token = playback.mint_playback_token("message", 5, 42, 7)
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token(token, "message", 6)
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token(token, "greeting", 5)
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token(token + "x", "message", 5)
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token("", "message", 5)


def test_playback_token_expiry():
    now = int(time.time())
    expired = _forge(iat=now - 200, exp=now - 80)
    with pytest.raises(playback.PlaybackTokenError, match="expired"):
        playback.verify_playback_token(expired, "message", 5)
    assert playback.verify_playback_token(_forge(iat=now - 100, exp=now + 20), "message", 5)


def test_session_token_is_not_a_playback_token():
    session = create_access_token(CLAIMS)
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token(session, "message", 5)
    # Even a session-shaped token signed with the PLAYBACK key fails (aud/typ/k).
    forged = jwt.encode(dict(CLAIMS, typ="session", exp=int(time.time()) + 60),
                        PLAYBACK_SECRET, algorithm="HS256")
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token(forged, "message", 5)


def _forge(**overrides):
    now = int(time.time())
    claims = {"aud": "vm-playback", "typ": "vm-playback", "k": "message", "oid": 5, "cid": 42,
              "sub": "7", "dl": False, "jti": "abc", "iat": now, "exp": now + 120}
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not ...}
    return jwt.encode(claims, PLAYBACK_SECRET, algorithm="HS256")


@pytest.mark.parametrize("overrides", [
    {"exp": int(time.time()) + 3600},     # lifetime > 120 s
    {"jti": ...},                         # no jti
    {"typ": "session"},
    {"aud": "other"},
    {"oid": True},                        # bool is not an id
    {"cid": 0},
    {"dl": "yes"},
    {"iat": ...},
])
def test_playback_token_shape_enforced(overrides):
    with pytest.raises(playback.PlaybackTokenError):
        playback.verify_playback_token(_forge(**overrides), "message", 5)
    assert playback.verify_playback_token(_forge(), "message", 5)["oid"] == 5


@pytest.mark.parametrize("value", [None, "short", "JWT"])
def test_playback_secret_fail_closed(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("VOICEMAIL_PLAYBACK_SECRET")
    elif value == "JWT":
        monkeypatch.setenv("VOICEMAIL_PLAYBACK_SECRET", "j" * 40)
        monkeypatch.setenv("JWT_SECRET_KEY", "j" * 40)
    else:
        monkeypatch.setenv("VOICEMAIL_PLAYBACK_SECRET", value)
    with pytest.raises(playback.PlaybackNotConfigured):
        playback.mint_playback_token("message", 1, 1, 1)
    with pytest.raises(playback.PlaybackNotConfigured):
        playback.verify_playback_token("x.y.z", "message", 1)
    from services.voicemail import VoicemailCryptoUnavailable
    assert issubclass(playback.PlaybackNotConfigured, VoicemailCryptoUnavailable)


def test_mint_argument_validation():
    for args in (("voicemail", 1, 1, 1), ("message", 0, 1, 1), ("message", 1, None, 1),
                 ("message", True, 1, 1), ("message", 1, 1, "")):
        with pytest.raises(ValueError):
            playback.mint_playback_token(*args)


def test_audio_route_with_playback_token(client):
    async def go():
        token = playback.mint_playback_token("message", 12, 42, 7)
        r = await client.get(f"/v1/voicemail/messages/12/audio?t={token}")
        assert r.status_code == 200, r.text
        r = await client.head(f"/v1/voicemail/messages/12/audio?t={token}")
        assert r.status_code == 200
        r = await client.get(f"/v1/voicemail/messages/13/audio?t={token}")
        assert r.status_code == 401
        r = await client.get("/v1/voicemail/messages/12/audio")
        assert r.status_code == 401
        # A session JWT in the query string is not a playback token either.
        r = await client.get(f"/v1/voicemail/messages/12/audio?t={create_access_token(CLAIMS)}")
        assert r.status_code == 401

    _run(go())


# ---------------------------------------------------------------------------
# Ingest secret
# ---------------------------------------------------------------------------
def test_ingest_secret(client, monkeypatch):
    async def go():
        ok = await client.post("/v1/voicemail/fs/deposit", headers={"X-Ingest-Secret": INGEST_SECRET})
        assert ok.status_code == 200, ok.text
        assert (await client.post("/v1/voicemail/fs/deposit")).status_code == 401
        wrong = await client.post("/v1/voicemail/fs/deposit",
                                  headers={"X-Ingest-Secret": INGEST_SECRET[:-1] + "x"})
        assert wrong.status_code == 401
        weird = await client.post("/v1/voicemail/fs/deposit",
                                  headers={"X-Ingest-Secret": ("caf\xe9" * 10).encode("latin-1")})
        assert weird.status_code == 401
        # A session JWT does not substitute for the ingest secret.
        jwt_only = await client.post("/v1/voicemail/fs/deposit",
                                     headers=_bearer(create_access_token(CLAIMS)))
        assert jwt_only.status_code == 401

    _run(go())


@pytest.mark.parametrize("value", [None, "", "s" * 31])
def test_ingest_secret_unset_or_short_fails_closed(client, monkeypatch, caplog, value):
    if value is None:
        monkeypatch.delenv("INGEST_SHARED_SECRET")
    else:
        monkeypatch.setenv("INGEST_SHARED_SECRET", value)

    async def go():
        # Even a caller that "guesses" the (short/empty) value is refused.
        r = await client.post("/v1/voicemail/fs/deposit",
                              headers={"X-Ingest-Secret": value or ""})
        assert r.status_code == 503
        r = await client.post("/v1/voicemail/fs/deposit")
        assert r.status_code == 503

    _run(go())
    assert any("INGEST_SHARED_SECRET" in rec.getMessage() and rec.levelname == "ERROR"
               for rec in caplog.records)
    assert not any((value or "\x00") in rec.getMessage() for rec in caplog.records if value)


# ---------------------------------------------------------------------------
# Middleware exemptions
# ---------------------------------------------------------------------------
EXEMPT = [
    ("GET", "/v1/voicemail/messages/12/audio"),
    ("HEAD", "/v1/voicemail/messages/12/audio"),
    ("GET", "/voicemail/messages/12/audio"),
    ("GET", "/v1/voicemail/greetings/3/audio"),
    ("HEAD", "/voicemail/greetings/3/audio"),
    ("POST", "/v1/voicemail/fs/deposit"),
    ("GET", "/v1/voicemail/fs/mailbox/9"),
    ("GET", "/voicemail/fs/greetings/4/audio"),
    ("POST", "/voicemail/fs/deposit"),
    # Pre-existing exemptions — must be unchanged.
    ("POST", "/v1/auth/login"),
    ("POST", "/auth/login"),
    ("GET", "/health"),
    ("GET", "/health/detailed"),
    ("GET", "/"),
    ("GET", "/openapi.json"),
    ("GET", "/freeswitch/directory"),
    ("POST", "/v1/onboarding"),
    ("POST", "/onboarding"),
    ("POST", "/v1/cdrs/ingest"),
    ("POST", "/cdrs/ingest/bulk"),
    ("POST", "/v1/carrier-status/report"),
    ("POST", "/v1/live-trunk-stats/report"),
    ("GET", "/ws/calls"),
    ("OPTIONS", "/v1/voicemail/mailboxes"),
]

NOT_EXEMPT = [
    ("POST", "/v1/voicemail/messages/12/audio"),
    ("PUT", "/v1/voicemail/messages/12/audio"),
    ("DELETE", "/v1/voicemail/greetings/3/audio"),
    ("GET", "/v1/voicemail/messages/12/audio/extra"),
    ("GET", "/v1/voicemail/messages/12/audiox"),
    ("GET", "/v1/voicemail/messages/abc/audio"),
    ("GET", "/v1/voicemail/messages//audio"),
    ("GET", "/v1/voicemail/messages/-1/audio"),
    ("GET", "/v1/voicemail/messages/12/audio%0A"),
    ("GET", "/v1/voicemail/messages/12/aud%09io"),
    ("POST", "/v1/voicemail/f%0As/deposit"),
    ("GET", "/v1/voicemail/messages/%D9%A1%D9%A2/audio"),   # Arabic-Indic digits
    ("GET", "/v2/voicemail/messages/12/audio"),
    ("GET", "/api/v1/voicemail/messages/12/audio"),
    ("GET", "/v1/voicemail/mailboxes/12/audio"),
    ("GET", "/v1/voicemail/messages/12/playback-token"),
    ("POST", "/v1/voicemail/messages/12/playback-token"),
    ("GET", "/v1/voicemail/mailboxes"),
    ("POST", "/v1/voicemail/mailboxes"),
    ("GET", "/v1/voicemail/summary"),
    ("POST", "/v1/voicemail/fsx/deposit"),
    ("POST", "/v1/voicemail/fs"),
    ("GET", "/v1/voicemail/fs/../mailboxes"),
    ("GET", "/v1/voicemail/fs/%2E%2E/mailboxes"),
    ("POST", "/x/v1/voicemail/fs/deposit"),
    ("GET", "/v1/customers"),
    ("GET", "/v1/onboarding"),
    ("GET", "/v1/carrier-status/report"),
]


@pytest.mark.parametrize("method,path", EXEMPT)
def test_exempt_paths_skip_jwt(client, method, path):
    async def go():
        r = await client.request(method, path)
        # The middleware's own rejection is exactly 401 {"detail": "Not authenticated"};
        # a route-level 401 (bad playback token / ingest secret) proves we got past it.
        middleware_rejected = (r.status_code == 401 and r.content
                               and r.json() == {"detail": "Not authenticated"})
        assert not middleware_rejected, (method, path, r.status_code, r.text)
        if "/audio" not in path and "/fs/deposit" not in path:
            assert r.status_code == 200, (method, path, r.status_code)

    _run(go())


@pytest.mark.parametrize("method,path", NOT_EXEMPT)
def test_non_exempt_paths_need_jwt(client, method, path):
    async def go():
        r = await client.request(method, path)
        assert r.status_code == 401, (method, path, r.status_code, r.text)
        assert r.json() == {"detail": "Not authenticated"}, "rejected by the middleware itself"

    _run(go())


def test_is_voicemail_exempt_unit():
    assert is_voicemail_exempt("/v1/voicemail/messages/1/audio", "GET")
    assert is_voicemail_exempt("/voicemail/greetings/22/audio", "HEAD")
    assert not is_voicemail_exempt("/v1/voicemail/messages/1/audio\n", "GET")
    assert not is_voicemail_exempt("/v1/voicemail/messages/١/audio", "GET")
    assert not is_voicemail_exempt("/v1/voicemail/messages/1/audio", "POST")
    assert is_voicemail_exempt("/v1/voicemail/fs/deposit", "POST")
    assert is_voicemail_exempt("/voicemail/fs/mailbox/1", "GET")
    assert not is_voicemail_exempt("/v1/voicemail/fs/../x", "GET")
    assert not is_voicemail_exempt("/v1/voicemail/fs/./x", "GET")
    assert not is_voicemail_exempt("/v1/voicemail/fs", "GET")
    assert not is_voicemail_exempt("/v1/voicemail/fs/dep\nosit", "POST")
    assert not is_voicemail_exempt("/v1/voicemail/fs/\tdeposit", "POST")
    assert not is_voicemail_exempt("/v1/voicemail/mailboxes", "GET")
