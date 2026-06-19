"""Multi-tenant authorization (IDOR) isolation tests — Phase 4 (CRITICAL).

Creates two customers + one user each, plus a full set of per-tenant resources
(conference, voicemail, chat conversation, document, extension, API DID, IVR
flow) owned by customer B. It then drives the LIVE API with customer A's token
and asserts A can never read or modify B's resources (must get 403/404), while
A CAN reach its own resources (positive control — proves the deny isn't a blanket
404).

This is the regression gate for the IDOR fixes in api_dids.py and ivr.py (which
previously had no auth/customer scoping at all) and the existing tenant scoping
in conference/voicemail/chat/documents/extensions.

Setup writes fixtures into the container's Postgres (via `docker exec psql`,
which avoids any host-local Postgres shadowing the published port) and mints
HS256 JWTs with the API's own secret (read from the running container), then
talks HTTP to the API. Skips cleanly if the live stack is not up.

Run:  python3 -m pytest tests/test_multitenant_isolation.py -v
"""
import os
import time
import uuid
import shutil
import subprocess

import pytest

requests = pytest.importorskip("requests")
jose_jwt = pytest.importorskip("jose.jwt", reason="python-jose required to mint test JWTs")

API_BASE = os.getenv("API_BASE", "http://localhost:8088")
API_CONTAINER = "voip-api"
PG_CONTAINER = os.getenv("PG_CONTAINER", "voip-postgres")
PG_DB = os.getenv("POSTGRES_DB", "voip")
PG_USER = os.getenv("POSTGRES_USER", "voip")

# Statuses that all count as "access denied" for a cross-tenant attempt.
DENIED = {401, 403, 404}


def _psql(sql: str) -> str:
    """Run a single SQL statement inside the Postgres container and return the
    first scalar of output (tuples-only, unaligned)."""
    r = subprocess.run(
        ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB,
         "-tAqc", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()}\nSQL: {sql}")
    return r.stdout.strip()


def _stack_up() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        r = requests.get(f"{API_BASE}/health", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def _jwt_secret() -> str:
    """Read JWT_SECRET_KEY from the running API container so minted tokens verify."""
    r = subprocess.run(
        ["docker", "exec", API_CONTAINER, "printenv", "JWT_SECRET_KEY"],
        capture_output=True, text=True,
    )
    secret = r.stdout.strip()
    if not secret:
        pytest.skip("could not read JWT_SECRET_KEY from api container")
    return secret


def _token(secret: str, user_id: int, customer_id: int, email: str) -> str:
    claims = {
        "sub": str(user_id),
        "email": email,
        "role": "user",
        "customer_id": customer_id,
        "exp": int(time.time()) + 3600,
    }
    return jose_jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture(scope="module")
def env():
    if not _stack_up():
        pytest.skip("live API stack not reachable; multi-tenant isolation needs it up")

    secret = _jwt_secret()

    # ivr_flows is created lazily by the API; ensure it exists for direct insert.
    _psql(
        "CREATE TABLE IF NOT EXISTS ivr_flows ("
        " id SERIAL PRIMARY KEY,"
        " customer_id INT NOT NULL REFERENCES customers(id),"
        " did VARCHAR(20), name VARCHAR(100) NOT NULL, flow_config JSONB NOT NULL,"
        " is_active BOOLEAN DEFAULT true,"
        " created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())"
    )

    # recordings table guard (Phase 6) — present via 25_schema_recordings.sql on a
    # fresh init; create-if-missing keeps this suite runnable against older DBs.
    _psql(
        "CREATE TABLE IF NOT EXISTS recordings ("
        " id SERIAL PRIMARY KEY,"
        " customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,"
        " call_uuid VARCHAR(64), recording_uuid VARCHAR(64) NOT NULL UNIQUE,"
        " object_key TEXT, bucket VARCHAR(100), duration_ms INT,"
        " kind VARCHAR(20) NOT NULL DEFAULT 'call',"
        " created_at TIMESTAMPTZ DEFAULT NOW())"
    )

    tag = uuid.uuid4().hex[:8]
    created = {"customers": [], "users": [], "extensions": [], "ivr_flows": [],
               "api_dids": [], "conferences": [], "documents": [],
               "conversations": [], "voicemails": [], "recordings": []}

    def mk_customer(name):
        cid = int(_psql(
            "INSERT INTO customers (name, account_type, ucaas_enabled, status) "
            f"VALUES ('{name}','ucaas',true,'active') RETURNING id"
        ))
        created["customers"].append(cid)
        return cid

    def mk_user(cid, email):
        uid = int(_psql(
            "INSERT INTO users (email, password_hash, customer_id, role, name, status) "
            f"VALUES ('{email}','x',{cid},'user','{email.split('@')[0]}','active') RETURNING id"
        ))
        created["users"].append(uid)
        return uid

    def mk_extension(cid, uid, ext):
        eid = int(_psql(
            "INSERT INTO extensions (extension, user_id, customer_id, display_name, "
            "voicemail_enabled, voicemail_pin, status) "
            f"VALUES ('{ext}',{uid},{cid},'ext{ext}',true,'1234','active') RETURNING id"
        ))
        created["extensions"].append(eid)
        return eid

    # --- Customer A + user A ---
    cidA = mk_customer(f"TenantA-{tag}")
    uidA = mk_user(cidA, f"a-{tag}@example.com")
    extA = mk_extension(cidA, uidA, "8001")
    # A's own conference (positive control)
    confA = int(_psql(
        "INSERT INTO conferences (customer_id, name, room_number, created_by) "
        f"VALUES ({cidA},'A-conf-{tag}','700',{uidA}) RETURNING id"
    ))
    created["conferences"].append(confA)

    # --- Customer B + user B + all resources owned by B ---
    cidB = mk_customer(f"TenantB-{tag}")
    uidB = mk_user(cidB, f"b-{tag}@example.com")
    extB = mk_extension(cidB, uidB, "9001")

    confB = int(_psql(
        "INSERT INTO conferences (customer_id, name, room_number, created_by) "
        f"VALUES ({cidB},'B-conf-{tag}','800',{uidB}) RETURNING id"
    ))
    created["conferences"].append(confB)

    vmB = int(_psql(
        "INSERT INTO voicemails (extension_id, caller_id, storage_path) "
        f"VALUES ({extB},'+15551112222','customer_{cidB}/voicemail/ext_{extB}/{tag}.wav') RETURNING id"
    ))
    created["voicemails"].append(vmB)

    convB = int(_psql(
        "INSERT INTO chat_conversations (customer_id, type, name, created_by) "
        f"VALUES ({cidB},'group','B-chat-{tag}',{uidB}) RETURNING id"
    ))
    created["conversations"].append(convB)
    _psql(
        "INSERT INTO chat_participants (conversation_id, user_id, role) "
        f"VALUES ({convB},{uidB},'owner')"
    )

    docB = int(_psql(
        "INSERT INTO shared_documents (customer_id, uploaded_by, filename, "
        "original_filename, file_size, storage_path) "
        f"VALUES ({cidB},{uidB},'{tag}.pdf','secret.pdf',1234,"
        f"'customer_{cidB}/documents/{tag}_secret.pdf') RETURNING id"
    ))
    created["documents"].append(docB)

    didB = f"+1617{uuid.uuid4().int % 10_000_000:07d}"
    created["api_dids"].append(int(_psql(
        "INSERT INTO api_dids (customer_id, did, voice_url) "
        f"VALUES ({cidB},'{didB}','https://b.example.com/voice') RETURNING id"
    )))

    flowB = int(_psql(
        "INSERT INTO ivr_flows (customer_id, name, flow_config) "
        f"VALUES ({cidB},'B-ivr-{tag}','{{\"nodes\": []}}'::jsonb) RETURNING id"
    ))
    created["ivr_flows"].append(flowB)

    recB = int(_psql(
        "INSERT INTO recordings (customer_id, call_uuid, recording_uuid, "
        "object_key, bucket, kind) "
        f"VALUES ({cidB},'callB-{tag}','rec-{tag}',"
        f"'customer_{cidB}/recordings/{tag}.wav','voip-recordings','call') RETURNING id"
    ))
    created["recordings"].append(recB)

    data = {
        "tokenA": _token(secret, uidA, cidA, f"a-{tag}@example.com"),
        "tokenB": _token(secret, uidB, cidB, f"b-{tag}@example.com"),
        "cidA": cidA, "cidB": cidB,
        "confA": confA, "confB": confB,
        "vmB": vmB, "convB": convB, "docB": docB, "didB": didB, "flowB": flowB,
        "recB": recB,
        "extA": extA, "extB": extB,
    }

    yield data

    # --- teardown (best-effort, FK-safe order) ---
    def _csv(ids):
        return ",".join(str(i) for i in ids)

    for tbl, col, ids in [
        ("voicemails", "id", created["voicemails"]),
        ("chat_participants", "conversation_id", created["conversations"]),
        ("chat_conversations", "id", created["conversations"]),
        ("conference_participants", "conference_id", created["conferences"]),
        ("conference_sessions", "conference_id", created["conferences"]),
        ("conferences", "id", created["conferences"]),
        ("shared_documents", "id", created["documents"]),
        ("api_dids", "id", created["api_dids"]),
        ("ivr_flows", "id", created["ivr_flows"]),
        ("recordings", "id", created["recordings"]),
        ("extensions", "id", created["extensions"]),
        ("users", "id", created["users"]),
        ("customers", "id", created["customers"]),
    ]:
        try:
            if ids:
                _psql(f"DELETE FROM {tbl} WHERE {col} IN ({_csv(ids)})")
        except Exception:
            pass


def _hA(env):
    return {"Authorization": f"Bearer {env['tokenA']}"}


# ---------------------------------------------------------------------------
# Positive control — A reaches its OWN resources (the deny isn't blanket-404)
# ---------------------------------------------------------------------------
def test_user_a_can_read_own_conference(env):
    r = requests.get(f"{API_BASE}/v1/conferences/{env['confA']}", headers=_hA(env))
    assert r.status_code == 200, r.text


def test_user_a_can_read_own_extension(env):
    r = requests.get(f"{API_BASE}/v1/extensions/{env['extA']}", headers=_hA(env))
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Cross-tenant denial — A may not touch B's resources
# ---------------------------------------------------------------------------
def test_cross_tenant_conference_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/conferences/{env['confB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_conference_update_denied(env):
    r = requests.put(
        f"{API_BASE}/v1/conferences/{env['confB']}",
        headers=_hA(env), json={"name": "hijacked"},
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_conference_delete_denied(env):
    r = requests.delete(f"{API_BASE}/v1/conferences/{env['confB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


# The conference_id-keyed live controls derive the FS room from a DB conference
# scoped by customer_id (_get_conference_active), so a cross-tenant id is denied
# BEFORE any ESL call — same room-ownership guarantee as the room-name controls.
def test_cross_tenant_conference_kick_denied(env):
    r = requests.post(
        f"{API_BASE}/v1/conferences/{env['confB']}/kick/1", headers=_hA(env)
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_conference_mute_denied(env):
    r = requests.post(
        f"{API_BASE}/v1/conferences/{env['confB']}/mute/1",
        headers=_hA(env), json={"mute": True},
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_conference_record_denied(env):
    r = requests.post(
        f"{API_BASE}/v1/conferences/{env['confB']}/record/start", headers=_hA(env)
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_voicemail_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/voicemail/{env['vmB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_voicemail_delete_denied(env):
    r = requests.delete(f"{API_BASE}/v1/voicemail/{env['vmB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_chat_read_denied(env):
    r = requests.get(
        f"{API_BASE}/v1/chat/conversations/{env['convB']}", headers=_hA(env)
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_chat_send_denied(env):
    r = requests.post(
        f"{API_BASE}/v1/chat/conversations/{env['convB']}/messages",
        headers=_hA(env), json={"content": "leak"},
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_document_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/documents/{env['docB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_document_download_denied(env):
    r = requests.get(
        f"{API_BASE}/v1/documents/{env['docB']}/download",
        headers=_hA(env), allow_redirects=False,
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_document_delete_denied(env):
    r = requests.delete(f"{API_BASE}/v1/documents/{env['docB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_extension_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/extensions/{env['extB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_extension_update_denied(env):
    r = requests.put(
        f"{API_BASE}/v1/extensions/{env['extB']}",
        headers=_hA(env), json={"display_name": "hijacked"},
    )
    assert r.status_code in DENIED, r.text


# --- IDOR fixes: api_dids + ivr previously had NO auth/scoping ---
def test_cross_tenant_api_did_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/api-dids/{env['didB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_api_did_update_denied(env):
    r = requests.put(
        f"{API_BASE}/v1/api-dids/{env['didB']}",
        headers=_hA(env), json={"voice_url": "https://evil.example.com"},
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_api_did_delete_denied(env):
    r = requests.delete(f"{API_BASE}/v1/api-dids/{env['didB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_ivr_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/ivr/{env['flowB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_ivr_update_denied(env):
    r = requests.put(
        f"{API_BASE}/v1/ivr/{env['flowB']}",
        headers=_hA(env), json={"name": "hijacked"},
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_ivr_delete_denied(env):
    r = requests.delete(f"{API_BASE}/v1/ivr/{env['flowB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_api_did_list_excludes_other_tenant(env):
    """A's API-DID list must not contain B's DID."""
    r = requests.get(f"{API_BASE}/v1/api-dids", headers=_hA(env))
    assert r.status_code == 200, r.text
    dids = {row.get("did") for row in r.json()}
    assert env["didB"] not in dids


def test_ivr_list_excludes_other_tenant(env):
    """A's IVR list must not contain B's flow."""
    r = requests.get(f"{API_BASE}/v1/ivr", headers=_hA(env))
    assert r.status_code == 200, r.text
    ids = {row.get("id") for row in r.json()}
    assert env["flowB"] not in ids


# --- Recordings (Phase 6 media plane) — tenant scoping / IDOR ---
def test_cross_tenant_recording_read_denied(env):
    r = requests.get(f"{API_BASE}/v1/recordings/{env['recB']}", headers=_hA(env))
    assert r.status_code in DENIED, r.text


def test_cross_tenant_recording_audio_denied(env):
    r = requests.get(
        f"{API_BASE}/v1/recordings/{env['recB']}/audio",
        headers=_hA(env), allow_redirects=False,
    )
    assert r.status_code in DENIED, r.text


def test_recording_list_excludes_other_tenant(env):
    """A's recordings list must not contain B's recording."""
    r = requests.get(f"{API_BASE}/v1/recordings", headers=_hA(env))
    assert r.status_code == 200, r.text
    ids = {row.get("id") for row in r.json()}
    assert env["recB"] not in ids


# --- Live FreeSWITCH conferences (Phase 7) — programmatic conf_<C>_* rooms ---
# These rooms (TwiML <Conference>) have NO row in the conferences table; tenant
# ownership is enforced purely from the room-name prefix conf_<customer_id>_.
# A must not VIEW or CONTROL a conf_<B>_* room. The tenant gate runs before any
# ESL call, so these deny correctly even though FreeSWITCH ESL is unreachable on
# Docker Desktop (synthetic/named room — no live conference required locally).
def _conf_b_room(env) -> str:
    return f"conf_{env['cidB']}_sales"


def test_cross_tenant_live_conference_view_denied(env):
    r = requests.get(
        f"{API_BASE}/v1/conferences/live/{_conf_b_room(env)}", headers=_hA(env)
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_live_conference_kick_denied(env):
    r = requests.post(
        f"{API_BASE}/v1/conferences/live/{_conf_b_room(env)}/kick/3", headers=_hA(env)
    )
    assert r.status_code in DENIED, r.text


def test_cross_tenant_live_conference_mute_denied(env):
    r = requests.post(
        f"{API_BASE}/v1/conferences/live/{_conf_b_room(env)}/mute/3",
        headers=_hA(env), json={"mute": True},
    )
    assert r.status_code in DENIED, r.text


def test_live_conference_list_scoped_to_tenant(env):
    """A's live list must be a clean 200 (degraded-empty when ESL is down on
    Docker Desktop, NOT a 500) and must never expose B's room — every visible
    room must belong to A."""
    r = requests.get(f"{API_BASE}/v1/conferences/live", headers=_hA(env))
    assert r.status_code == 200, r.text
    body = r.json()
    rooms = body.get("conferences", [])
    names = {c.get("fs_room_name") for c in rooms}
    assert _conf_b_room(env) not in names
    for c in rooms:
        assert c.get("customer_id") == env["cidA"], c


def test_own_live_conference_control_passes_tenant_gate(env):
    """Positive control: A controlling its OWN conf_<A>_* room passes the tenant
    gate (proves the cross-tenant deny isn't a blanket 404). With ESL unreachable
    locally it degrades to 400 — never a 403/404 ownership denial, never a 500."""
    room = f"conf_{env['cidA']}_sales"
    r = requests.post(
        f"{API_BASE}/v1/conferences/live/{room}/kick/3", headers=_hA(env)
    )
    assert r.status_code not in (403, 404), r.text
    assert r.status_code != 500, r.text


# --- Live calls (Phase 8) — ESL in-memory live-call registry, tenant-scoped ---
# The registry tags each LiveCall with the customer_id from the channel vars.
# A's /v1/calls/live must be a clean 200 (degraded-empty when ESL is down on
# Docker Desktop, NOT a 500) and must never expose a call owned by B — every
# visible call must belong to A.
def test_live_calls_list_scoped_to_tenant(env):
    r = requests.get(f"{API_BASE}/v1/calls/live", headers=_hA(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "esl_connected" in body
    for c in body.get("calls", []):
        assert c.get("customer_id") == env["cidA"], c


# --- Live mod_fifo queues (Phase 8) — tenant-scoped purely by fifo_<C>_ prefix.
# These queues have NO DB row; ownership is the name prefix. The tenant gate runs
# before any ESL call, so cross-tenant denies correctly even though FreeSWITCH
# ESL is unreachable on Docker Desktop (synthetic/named queue — no live queue
# required locally).
def _queue_b_name(env) -> str:
    return f"fifo_{env['cidB']}_support"


def test_live_queue_list_scoped_to_tenant(env):
    """A's queue list must be a clean 200 (degraded-empty when ESL is down) and
    must never expose B's queue — every visible queue must belong to A."""
    r = requests.get(f"{API_BASE}/v1/queues", headers=_hA(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "esl_connected" in body
    fs_names = {q.get("fs_name") for q in body.get("queues", [])}
    assert _queue_b_name(env) not in fs_names
    for q in body.get("queues", []):
        assert q.get("customer_id") == env["cidA"], q


def test_cross_tenant_live_queue_view_denied(env):
    r = requests.get(
        f"{API_BASE}/v1/queues/{_queue_b_name(env)}", headers=_hA(env)
    )
    assert r.status_code in DENIED, r.text


def test_own_live_queue_view_passes_tenant_gate(env):
    """Positive control: A viewing its OWN fifo_<A>_* queue passes the tenant
    gate (proves the cross-tenant deny isn't a blanket 404). With ESL unreachable
    locally it degrades to a clean 200 depth=0/members=[] — never 403/404/500."""
    r = requests.get(
        f"{API_BASE}/v1/queues/fifo_{env['cidA']}_support", headers=_hA(env)
    )
    assert r.status_code == 200, r.text
    assert r.status_code not in (403, 404, 500)
