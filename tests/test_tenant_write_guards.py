"""Tenant write guards + the JWT user-status check, over the REAL routers.

Covers the 2026-10 tenant-API hardening (docs audit):

  1. ``readonly`` (and ``support``) can no longer write. The tenant-reachable
     mutations that only checked ownership now carry
     ``auth.dependencies.require_writer`` (admin + user write; the voicemail
     ``vm_writer`` semantics): PUT/PATCH /v1/rcf/{identifier},
     POST/DELETE /v1/trunks/{id}/ips[/{ip_id}],
     POST /v1/numbers/{did}/request-release and /cancel-release. Every refusal
     is a 403 before any write; the row is untouched. Writers keep working and
     cross-tenant stays a 404.
  3. POST /v1/trunks/{id}/ips validates the body: a bad IP, a range, or a
     description over 100 characters is a 422 with a sentence — never the
     ::inet / VARCHAR(100) error as a 500.
  +. POST /v1/numbers/{did}/request accepts no body / ``{}`` / ``{notes}``
     (the deployed portal) and requests an ``rcf`` number; a supplied
     ``product_type: "api"`` is still a 422 while API Calling is retired;
     readonly is still a 403.
  6. JWTAuthMiddleware re-checks ``users.status`` against a REAL users table
     (09 + 39): disabled, deleted and missing users get 401 once the
     per-process TTL lapses (hermetic TTL / fail-open cases:
     tests/test_user_status.py).
  +. POST /v1/auth/login no longer enumerates accounts: the password is
     checked first; unknown email / wrong password (any status) -> the same
     401; only the right password on a disabled account -> 403.
  +. A TENANT may not point forward_to at a 3-6 digit local extension (the
     internal directory, ``user/<ext>@domain``) -> 422 "Use a 10-digit US
     number or E.164."; admins keep today's behaviour; existing rows are
     untouched.

Harness: ephemeral PostgreSQL from the REAL init chain (tests/voicemail_db.py
prerequisites: 02 03 09 17 20 22 24 31 34 39), the routers behind the REAL
JWT middleware, REAL minted JWTs for seeded users.

Run:  JWT_SECRET_KEY=x TEST_PG_BIN=... python -m pytest tests/test_tenant_write_guards.py -q
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required")
httpx = pytest.importorskip("httpx", reason="httpx required")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from voicemail_db import EphemeralPG, apply_prerequisites, find_pg_bin  # noqa: E402

PG_BIN = find_pg_bin()
PORT = 55500  # tenant-hardening range 55500-55509

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


CID_A, CID_B = 101, 202
TRUNK_A, TRUNK_B = 71, 72
DID_A = "+16175550101"          # A's RCF number
DID_B = "+16175550202"          # B's RCF number
INV_A = "+16175550111"          # A's assigned inventory number (release flow)
IP_A = "198.51.100.10"          # A's trunk auth IP
AVAILABLE = [f"+1617555030{i}" for i in range(1, 8)]   # free inventory (request flow)

MSG_RO = "Read-only accounts can't change this."
MSG_SUPPORT = "Support accounts can't change this."
MSG_EXTENSION = "Use a 10-digit US number or E.164."

LOGIN_PASSWORD = "Correct-Horse-Battery-9"
#: (users.id, email, status) — real bcrypt hashes (cost 4: fast, same check)
LOGIN_USERS = ((40, "login-active@test.local", "active"),
               (41, "login-disabled@test.local", "disabled"))

#: (token name, users.id, role, customer_id, status)
USERS = (
    ("user_a", 10, "user", CID_A, "active"),
    ("readonly_a", 11, "readonly", CID_A, "active"),
    ("user_b", 12, "user", CID_B, "active"),
    ("support", 13, "support", None, "active"),
    ("disabled_a", 14, "user", CID_A, "disabled"),
    # support staff whose row carries a customer: before require_writer the
    # release routes' get_customer_filter would have let it write A's DIDs.
    ("support_a", 15, "support", CID_A, "active"),
    ("user_noscope", 16, "user", None, "active"),
    ("churn_a", 17, "user", CID_A, "active"),     # status flipped by one test
)

SEED_SQL = f"""
INSERT INTO customers (id, name, account_type) VALUES
  ({CID_A}, 'Tenant A', 'hybrid'), ({CID_B}, 'Tenant B', 'hybrid');
INSERT INTO rcf_numbers (customer_id, did, name, forward_to) VALUES
  ({CID_A}, '{DID_A}', 'Front desk', '+17745550000'),
  ({CID_B}, '{DID_B}', 'B line', '+17745550001');
INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels) VALUES
  ({TRUNK_A}, {CID_A}, 'pbx-a', 10), ({TRUNK_B}, {CID_B}, 'pbx-b', 10);
INSERT INTO trunk_auth_ips (trunk_id, ip_address, description) VALUES
  ({TRUNK_A}, '{IP_A}', 'office'), ({TRUNK_B}, '198.51.100.20', 'b office');
INSERT INTO did_inventory (did, customer_id, product_type, status) VALUES
  ('{INV_A}', {CID_A}, 'rcf', 'assigned');
"""
AVAILABLE_SQL = "INSERT INTO did_inventory (did, status) SELECT unnest($1::varchar[]), 'available'"


@pytest.fixture(scope="module")
def guard_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = EphemeralPG(PG_BIN, PORT)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db
    state = {"db": db, "pg": pg}

    async def _setup():
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres", statement_cache_size=0)
        try:
            await apply_prerequisites(owner)
            await owner.execute(SEED_SQL)
            await owner.execute(AVAILABLE_SQL, AVAILABLE)
            for _name, uid, role, cid, status in USERS:
                await owner.execute(
                    "INSERT INTO users (id, email, password_hash, customer_id, role, name, status) "
                    "VALUES ($1::int, $2::varchar, 'x', $3::int, $4::varchar, $5::varchar, "
                    "$6::varchar)", uid, f"u{uid}@test.local", cid, role, f"User {uid}", status)
            import bcrypt
            pw_hash = bcrypt.hashpw(LOGIN_PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()
            for uid, email, status in LOGIN_USERS:
                await owner.execute(
                    "INSERT INTO users (id, email, password_hash, customer_id, role, name, status) "
                    "VALUES ($1::int, $2::varchar, $3::varchar, $4::int, 'user', 'Login', "
                    "$5::varchar)", uid, email, pw_hash, CID_A, status)
            await owner.execute("SELECT setval('users_id_seq', 1000)")
        finally:
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
        yield state
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(scope="module")
def client(guard_db):
    from fastapi import FastAPI
    from fastapi.responses import ORJSONResponse
    from middleware.auth import JWTAuthMiddleware
    from routers import auth as auth_router
    from routers import number_inventory, rcf, trunks

    app = FastAPI(default_response_class=ORJSONResponse)
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(auth_router.router, prefix="/v1/auth")
    app.include_router(rcf.router, prefix="/v1/rcf")
    app.include_router(trunks.router, prefix="/v1/trunks")
    app.include_router(number_inventory.router, prefix="/v1/numbers")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(guard_db):
    from auth.security import create_access_token

    def mint(sub, role, cid):
        return create_access_token(
            {"sub": str(sub), "email": f"u{sub}@test.local", "role": role, "customer_id": cid})

    out = {name: mint(uid, role, cid) for name, uid, role, cid, _ in USERS}
    out["admin"] = mint(1, "admin", None)               # 09's seeded admin (id 1)
    out["ghost"] = mint(999, "user", CID_A)             # no such user
    return out


def _call(client, tokens, who, method, path, **kw):
    headers = {"Authorization": f"Bearer {tokens[who]}"} if who else {}
    headers.update(kw.pop("headers", {}))
    return _run(client.request(method, path, headers=headers, **kw))


async def _fetch(guard_db, sql, *args):
    async with guard_db["db"].pool.acquire() as conn:
        return [dict(r) for r in await conn.fetch(sql, *args)]


def _q(guard_db, sql, *args):
    return _run(_fetch(guard_db, sql, *args))


def _snapshot(guard_db):
    """Everything the guarded routes could change for tenant A."""
    return (
        _q(guard_db, "SELECT * FROM rcf_numbers WHERE customer_id = $1::int ORDER BY id", CID_A),
        _q(guard_db, "SELECT id, host(ip_address) AS ip, description FROM trunk_auth_ips "
                     "ORDER BY id"),
        _q(guard_db, "SELECT did, status, customer_id, product_type, notes FROM did_inventory "
                     "ORDER BY did"),
    )


def _ip_id(guard_db, trunk_id, ip):
    rows = _q(guard_db, "SELECT id FROM trunk_auth_ips WHERE trunk_id = $1::int "
                        "AND host(ip_address) = $2::text", trunk_id, ip)
    return rows[0]["id"] if rows else None


def _writes(guard_db):
    """Every tenant-reachable mutation this module mounts (defect 1 list)."""
    ip_a = _ip_id(guard_db, TRUNK_A, IP_A)
    return [
        ("PUT", f"/v1/rcf/{DID_A}", {"json": {"name": "hijack"}}),
        ("PATCH", f"/v1/rcf/{DID_A}", {"json": {"forward_to": "+17745559999"}}),
        ("POST", f"/v1/trunks/{TRUNK_A}/ips", {"json": {"ip_address": "203.0.113.77"}}),
        ("DELETE", f"/v1/trunks/{TRUNK_A}/ips/{ip_a}", {}),
        ("POST", f"/v1/numbers/{INV_A}/request-release", {"json": {"notes": "bye"}}),
        ("POST", f"/v1/numbers/{INV_A}/cancel-release", {}),
    ]


# ---------------------------------------------------------------------------
# 1) readonly / support never write
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("who,detail", [
    ("readonly_a", MSG_RO),
    ("support", MSG_SUPPORT),
    ("support_a", MSG_SUPPORT),
])
def test_non_writers_403_on_every_tenant_write(guard_db, client, tokens, who, detail):
    before = _snapshot(guard_db)
    for method, path, kw in _writes(guard_db):
        r = _call(client, tokens, who, method, path, **kw)
        assert r.status_code == 403, (who, method, path, r.text)
        assert r.json()["detail"] == detail, (method, path)
    # The release routes too, from the state a refusal would have changed.
    _q(guard_db, "UPDATE did_inventory SET status = 'release_requested' WHERE did = $1::varchar",
       INV_A)
    try:
        r = _call(client, tokens, who, "POST", f"/v1/numbers/{INV_A}/cancel-release")
        assert r.status_code == 403, r.text
    finally:
        _q(guard_db, "UPDATE did_inventory SET status = 'assigned' WHERE did = $1::varchar", INV_A)
    assert _snapshot(guard_db) == before          # nothing was written


def test_readonly_403_before_body_validation(client, tokens):
    """The role gate runs before the body is parsed: a readonly login never
    learns which inputs would have been accepted."""
    r = _call(client, tokens, "readonly_a", "PUT", f"/v1/rcf/{DID_A}",
              json={"ring_timeout": 9999})
    assert r.status_code == 403 and r.json()["detail"] == MSG_RO
    r = _call(client, tokens, "readonly_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": "not-an-ip"})
    assert r.status_code == 403 and r.json()["detail"] == MSG_RO


def test_writers_still_write_their_own(guard_db, client, tokens):
    # RCF: PUT + PATCH by the owner.
    r = _call(client, tokens, "user_a", "PUT", f"/v1/rcf/{DID_A}", json={"name": "Lobby"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Lobby"
    r = _call(client, tokens, "user_a", "PATCH", f"/v1/rcf/{DID_A}",
              json={"forward_to": "+17745550000", "name": "Front desk"})
    assert r.status_code == 200, r.text
    # max_channels stays admin-only for a writer tenant.
    r = _call(client, tokens, "user_a", "PATCH", f"/v1/rcf/{DID_A}", json={"max_channels": 5})
    assert r.status_code == 403, r.text

    # Trunk auth IPs: add then remove.
    r = _call(client, tokens, "user_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": "203.0.113.5", "description": "backup SBC"})
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]
    r = _call(client, tokens, "user_a", "DELETE", f"/v1/trunks/{TRUNK_A}/ips/{new_id}")
    assert r.status_code == 200, r.text

    # Release request + withdraw (customer), then request + admin DENY.
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{INV_A}/request-release")
    assert r.status_code == 200 and r.json()["status"] == "release_requested", r.text
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{INV_A}/cancel-release")
    assert r.status_code == 200 and r.json()["status"] == "assigned", r.text
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{INV_A}/request-release")
    assert r.status_code == 200, r.text
    r = _call(client, tokens, "admin", "POST", f"/v1/numbers/{INV_A}/cancel-release")
    assert r.status_code == 200 and r.json()["status"] == "assigned", r.text


def test_cross_tenant_writer_still_404(guard_db, client, tokens):
    before = _snapshot(guard_db)
    for method, path, kw in _writes(guard_db):
        r = _call(client, tokens, "user_b", method, path, **kw)
        assert r.status_code == 404, (method, path, r.text)
    assert _snapshot(guard_db) == before


def test_customerless_writer_still_fails_closed(client, tokens):
    r = _call(client, tokens, "user_noscope", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": "203.0.113.6"})
    assert r.status_code == 403 and r.json()["detail"] == "No customer scope"
    r = _call(client, tokens, "user_noscope", "PUT", f"/v1/rcf/{DID_A}", json={"name": "x"})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# 3) POST /trunks/{id}/ips validates in the request model -> 422, never 500
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("ip,needle", [
    ("not-an-ip", "not a valid IP address"),
    ("999.1.1.1", "not a valid IP address"),
    ("10.0.0.0/24", "single IP address, not a range"),
    ("2001:db8::/64", "single IP address, not a range"),
    ("203.0.113.10/32", "single IP address, not a range"),
    ("", "Enter an IP address"),
    ("   ", "Enter an IP address"),
    ("fe80::1%eth0", "zone"),
    ("010.1.1.1", "not a valid IP address"),
])
def test_add_ip_rejects_bad_address_422(guard_db, client, tokens, ip, needle):
    before = _snapshot(guard_db)
    r = _call(client, tokens, "user_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": ip})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail[0]["loc"] == ["body", "ip_address"]
    assert needle in detail[0]["msg"], detail
    assert _snapshot(guard_db) == before


def test_add_ip_description_length(guard_db, client, tokens):
    r = _call(client, tokens, "user_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": "203.0.113.30", "description": "x" * 101})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"][0]
    assert detail["loc"] == ["body", "description"]
    assert "100 characters or fewer" in detail["msg"]
    assert _ip_id(guard_db, TRUNK_A, "203.0.113.30") is None

    r = _call(client, tokens, "user_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": " 203.0.113.30 ", "description": "y" * 100})
    assert r.status_code == 200, r.text
    assert r.json()["description"] == "y" * 100
    ip_id = _ip_id(guard_db, TRUNK_A, "203.0.113.30")             # stored trimmed
    assert ip_id == r.json()["id"]
    # same address again -> the existing 409, not a 500
    r = _call(client, tokens, "user_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": "203.0.113.30"})
    assert r.status_code == 409, r.text
    _call(client, tokens, "user_a", "DELETE", f"/v1/trunks/{TRUNK_A}/ips/{ip_id}")


def test_add_ip_ipv6_canonical(guard_db, client, tokens):
    r = _call(client, tokens, "user_a", "POST", f"/v1/trunks/{TRUNK_A}/ips",
              json={"ip_address": "2001:0DB8:0000:0000:0000:0000:0000:0010"})
    assert r.status_code == 200, r.text
    ip_id = _ip_id(guard_db, TRUNK_A, "2001:db8::10")
    assert ip_id == r.json()["id"]
    _call(client, tokens, "user_a", "DELETE", f"/v1/trunks/{TRUNK_A}/ips/{ip_id}")


def test_trunk_ip_model_pure():
    from pydantic import ValidationError
    from routers.trunks import TrunkIP
    assert TrunkIP(ip_address="192.0.2.1").ip_address == "192.0.2.1"
    assert TrunkIP(ip_address="2001:DB8:0:0::1").ip_address == "2001:db8::1"
    assert TrunkIP(ip_address="192.0.2.1", description=None).description is None
    for bad in ("192.0.2.0/24", "192.0.2", "1.2.3.4.5", "localhost"):
        with pytest.raises(ValidationError):
            TrunkIP(ip_address=bad)


# ---------------------------------------------------------------------------
# +) POST /numbers/{did}/request — the deployed portal's body (none / {notes})
# ---------------------------------------------------------------------------
def _inv(guard_db, did):
    return _q(guard_db, "SELECT status, customer_id, product_type, notes, assigned_by "
                        "FROM did_inventory WHERE did = $1::varchar", did)[0]


def test_request_without_body_is_an_rcf_request(guard_db, client, tokens):
    did = AVAILABLE[0]
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{did}/request")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["status"], body["did"], body["customer_id"], body["product_type"]) == \
        ("reserved", did, CID_A, "rcf")
    row = _inv(guard_db, did)
    assert (row["status"], row["customer_id"], row["product_type"], row["assigned_by"]) == \
        ("reserved", CID_A, "rcf", 10)
    assert row["notes"] == "Requested by user u10@test.local"


def test_request_with_empty_or_null_body(guard_db, client, tokens):
    as_json = {"Content-Type": "application/json"}
    for did, kw in ((AVAILABLE[1], {"json": {}}),
                    (AVAILABLE[2], {"content": b"null", "headers": as_json}),
                    (AVAILABLE[3], {"content": b"", "headers": as_json})):
        r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{did}/request", **kw)
        assert r.status_code == 200, (kw, r.text)
        assert r.json()["product_type"] == "rcf"
        assert _inv(guard_db, did)["product_type"] == "rcf"


def test_request_with_notes_only(guard_db, client, tokens):
    did = AVAILABLE[4]
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{did}/request",
              json={"notes": "Second line for the Boston office"})
    assert r.status_code == 200, r.text
    row = _inv(guard_db, did)
    assert (row["status"], row["product_type"], row["notes"]) == \
        ("reserved", "rcf", "Second line for the Boston office")


def test_request_supplied_product_type_still_validated(guard_db, client, tokens, monkeypatch):
    monkeypatch.delenv("API_CALLING_ENABLED", raising=False)
    did = AVAILABLE[5]
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{did}/request",
              json={"product_type": "api"})
    assert r.status_code == 422, r.text
    assert "API Calling is retired" in r.text
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{did}/request",
              json={"product_type": "voicemail"})
    assert r.status_code == 422, r.text
    assert _inv(guard_db, did)["status"] == "available"
    r = _call(client, tokens, "user_a", "POST", f"/v1/numbers/{did}/request",
              json={"product_type": "trunk"})
    assert r.status_code == 200 and r.json()["product_type"] == "trunk", r.text


@pytest.mark.parametrize("kw", [{}, {"json": {"notes": "please"}}], ids=["no-body", "notes"])
def test_request_readonly_still_403(guard_db, client, tokens, kw):
    did = AVAILABLE[6]
    r = _call(client, tokens, "readonly_a", "POST", f"/v1/numbers/{did}/request", **kw)
    assert r.status_code == 403, r.text
    assert "Read-only" in r.json()["detail"]
    assert _inv(guard_db, did)["status"] == "available"


# ---------------------------------------------------------------------------
# 6) users.status re-checked by the middleware (real users table)
# ---------------------------------------------------------------------------
def test_disabled_and_missing_users_401(client, tokens):
    for who in ("disabled_a", "ghost"):
        r = _call(client, tokens, who, "GET", "/v1/rcf")
        assert r.status_code == 401, (who, r.text)
        assert r.json() == {"detail": "Not authenticated"}
    assert _call(client, tokens, "user_a", "GET", "/v1/rcf").status_code == 200


def test_status_changes_apply_after_the_ttl(guard_db, client, tokens, monkeypatch):
    from auth import user_status

    now = [5000.0]
    monkeypatch.setattr(user_status, "_clock", lambda: now[0])
    user_status.reset()
    ttl = user_status.STATUS_TTL_S
    assert 30 <= ttl <= 60

    def status():
        return _call(client, tokens, "churn_a", "GET", "/v1/rcf").status_code

    try:
        assert status() == 200
        _q(guard_db, "UPDATE users SET status = 'disabled' WHERE id = 17")
        assert status() == 200                    # cached in this process
        now[0] += ttl + 1
        assert status() == 401                    # disabled -> out within the TTL
        _q(guard_db, "UPDATE users SET status = 'active' WHERE id = 17")
        now[0] += ttl + 1
        assert status() == 200                    # re-enabled -> back in
        _q(guard_db, "DELETE FROM users WHERE id = 17")
        now[0] += ttl + 1
        assert status() == 401                    # deleted -> out
    finally:
        _q(guard_db, "INSERT INTO users (id, email, password_hash, customer_id, role, name) "
                     "VALUES (17, 'u17@test.local', 'x', $1::int, 'user', 'User 17') "
                     "ON CONFLICT (id) DO UPDATE SET status = 'active'", CID_A)


# ---------------------------------------------------------------------------
# +) POST /v1/auth/login — no account enumeration
# ---------------------------------------------------------------------------
def _login(client, email, password):
    return _run(client.post("/v1/auth/login", json={"email": email, "password": password}))


def test_login_does_not_reveal_disabled_accounts(client):
    active, disabled = LOGIN_USERS[0][1], LOGIN_USERS[1][1]
    unknown = _login(client, "nobody@test.local", LOGIN_PASSWORD)
    wrong_active = _login(client, active, "not-the-password")
    wrong_disabled = _login(client, disabled, "not-the-password")
    for r in (unknown, wrong_active, wrong_disabled):
        assert r.status_code == 401, r.text
    # byte-identical: a wrong password says nothing about the account
    assert unknown.content == wrong_active.content == wrong_disabled.content
    assert unknown.json() == {"detail": "Invalid email or password"}

    # Only the RIGHT password learns that the account is disabled.
    r = _login(client, disabled, LOGIN_PASSWORD)
    assert r.status_code == 403 and r.json() == {"detail": "Account is disabled"}

    r = _login(client, active, LOGIN_PASSWORD)
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    assert r.json()["user"]["customer_id"] == CID_A
    r = _run(client.get("/v1/rcf", headers={"Authorization": f"Bearer {token}"}))
    assert r.status_code == 200, r.text


def test_login_unknown_email_still_pays_for_a_bcrypt_check(client, monkeypatch):
    from routers import auth as auth_router
    seen = []
    real = auth_router.verify_password

    def counting(plain, hashed):
        seen.append(hashed)
        return real(plain, hashed)

    monkeypatch.setattr(auth_router, "verify_password", counting)
    assert _login(client, "nobody@test.local", "whatever").status_code == 401
    assert seen == [auth_router._TIMING_EQUALISER_HASH]
    assert seen[0].startswith("$2b$12$")            # same cost as hash_password()
    seen.clear()
    assert _login(client, LOGIN_USERS[1][1], "whatever").status_code == 401
    assert len(seen) == 1 and seen[0] != auth_router._TIMING_EQUALISER_HASH


def test_login_unusable_stored_hash_is_401_not_500(client):
    r = _login(client, "u10@test.local", "anything")   # seeded with hash 'x'
    assert r.status_code == 401 and r.json() == {"detail": "Invalid email or password"}


# ---------------------------------------------------------------------------
# +) forward_to: no local extensions from tenants
# ---------------------------------------------------------------------------
def _forward(guard_db, did):
    return _q(guard_db, "SELECT forward_to FROM rcf_numbers WHERE did = $1::varchar",
              did)[0]["forward_to"]


@pytest.mark.parametrize("method", ["PUT", "PATCH"])
@pytest.mark.parametrize("ext", ["1001", "100", "123456", " 2002 "])
def test_tenant_forward_to_extension_422(guard_db, client, tokens, method, ext):
    before = _forward(guard_db, DID_A)
    r = _call(client, tokens, "user_a", method, f"/v1/rcf/{DID_A}", json={"forward_to": ext})
    assert r.status_code == 422, r.text
    assert r.json() == {"detail": MSG_EXTENSION}
    assert _forward(guard_db, DID_A) == before


def test_tenant_forward_to_phone_numbers_still_accepted(guard_db, client, tokens):
    before = _forward(guard_db, DID_A)
    try:
        for raw, stored in (("(774) 555-0123", "+17745550123"), ("+447911123456", "+447911123456"),
                            ("17745550124", "+17745550124")):
            r = _call(client, tokens, "user_a", "PATCH", f"/v1/rcf/{DID_A}",
                      json={"forward_to": raw})
            assert r.status_code == 200, (raw, r.text)
            assert _forward(guard_db, DID_A) == stored
    finally:
        _q(guard_db, "UPDATE rcf_numbers SET forward_to = $1::varchar WHERE did = $2::varchar",
           before, DID_A)


def test_admin_may_still_set_an_extension(guard_db, client, tokens):
    before = _forward(guard_db, DID_A)
    try:
        r = _call(client, tokens, "admin", "PATCH", f"/v1/rcf/{DID_A}", json={"forward_to": "1001"})
        assert r.status_code == 200, r.text
        assert _forward(guard_db, DID_A) == "1001"
        # An existing extension row is untouched by a tenant edit of OTHER
        # fields — the rule only refuses a tenant setting forward_to.
        r = _call(client, tokens, "user_a", "PATCH", f"/v1/rcf/{DID_A}",
                  json={"name": "Desk phone", "ring_timeout": 25})
        assert r.status_code == 200, r.text
        assert _forward(guard_db, DID_A) == "1001"
        # ... and re-sending the same extension is still a tenant change.
        r = _call(client, tokens, "user_a", "PUT", f"/v1/rcf/{DID_A}", json={"forward_to": "1001"})
        assert r.status_code == 422 and r.json() == {"detail": MSG_EXTENSION}
    finally:
        _q(guard_db, "UPDATE rcf_numbers SET forward_to = $1::varchar, name = 'Front desk', "
                     "ring_timeout = 30 WHERE did = $2::varchar", before, DID_A)


def test_is_local_extension_pure():
    from utils import phone
    for v in ("100", "1001", "123456"):
        assert phone.is_local_extension(v), v
    for v in ("10", "1234567", "+17745550000", "7745550000", "", None, " 1001", "1001\n",
              "١٠٠١"):
        assert not phone.is_local_extension(v), v
    # ASCII digits only (the TS / Lua twins never accepted other digits): a
    # non-ASCII "extension" is not stored verbatim any more, for anyone.
    with pytest.raises(ValueError):
        phone.normalize_forward_destination("١٠٠١")
    assert phone.normalize_forward_destination("1001") == "1001"
