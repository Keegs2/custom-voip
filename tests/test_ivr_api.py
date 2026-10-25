"""Visual IVR API (routers/ivr.py, contract §8.2/§8.3) on an ephemeral PostgreSQL 16.

The voicemail harness (tests/voicemail_api_harness.py: real init scripts,
54 + 56, the api pool as the runtime ``api`` role, the REAL JWT middleware)
plus the real 05 ``cdrs`` table + every cdrs column migration and 59 + 60.
Routers mounted: ivr, number_inventory, cdrs, onboarding — with main.py's
IvrApiError handler. The Piper sidecar is replaced by an in-process fake
(``tts.list_voices`` / ``tts.synthesize``) that renders a 22.05 kHz WAV, so
the real canonicalisation runs.

Covers: tenancy / IDOR (another tenant's flow, number, prompt; readonly
writes; admin with customer_id null; support), the entitlement gate, the
revision lock (409), publish atomicity (a failure after the version INSERT
leaves nothing), prompt-in-use 409 + soft delete + audio GC, upload
canonicalisation, the preview rate limit, playback tokens, number binding
(cross-tenant 404, self-transfer 422), assign/unassign side effects, the
admin API, the FreeSWITCH read path as the ``freeswitch`` role, and CDR
ingest of the ivr_* variables.
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from voicemail_api_harness import CUST_A, CUST_B, Harness, asyncpg  # noqa: E402

np = pytest.importorskip("numpy")

REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "docker" / "postgres" / "init"
PORT = 55521  # IVR range 55520-55529
CUST_OFF = 104   # never entitled

A_RCF = "+16175550111"
A_VM = "+16175550112"
A_IVR = "+16175550113"
A_IVR2 = "+16175550114"
B_IVR = "+16175550121"
VOICES = [{"id": "en_US-ljspeech-medium", "label": "Linda", "gender": "female",
           "license": "public domain", "version": "piper-test/1"},
          {"id": "en_US-norman-medium", "label": "Norman", "gender": "male",
           "license": "public domain", "version": "piper-test/2"}]


def wav_bytes(rate: int, seconds: float, freq: float = 440.0, channels: int = 1) -> bytes:
    n = int(rate * seconds)
    s = (np.sin(2 * np.pi * freq * np.arange(n) / rate) * 9000).astype("<i2")
    if channels == 2:
        s = np.stack([s, s], 1).reshape(-1)
    pcm = s.tobytes()
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE" + b"fmt "
            + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * 2 * channels, 2 * channels, 16)
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


def _cdrs_ddl() -> str:
    sql = (INIT / "05_schema_cdr.sql").read_text()
    start = sql.index("CREATE TABLE cdrs (")
    end = sql.index("\n);", start) + 3
    return (sql[start:end] + "\nALTER TABLE cdrs ADD COLUMN IF NOT EXISTS sbc_id VARCHAR(30),"
            " ADD COLUMN IF NOT EXISTS inbound_carrier VARCHAR(20),"
            " ADD COLUMN IF NOT EXISTS inbound_carrier_pop VARCHAR(50);")


class IvrHarness(Harness):
    async def _setup(self) -> None:
        await super()._setup()
        from cdr_schema import apply_cdr_column_migrations
        conn = await self.owner()
        try:
            await conn.execute(_cdrs_ddl())
            await apply_cdr_column_migrations(conn, times=1)
            await conn.execute("GRANT ALL ON cdrs TO api; GRANT USAGE, SELECT ON cdrs_id_seq TO api;")
            for _ in range(2):
                await conn.execute((INIT / "59_ivr.sql").read_text())
                await conn.execute((INIT / "60_cdr_ivr.sql").read_text())
            await conn.execute(
                f"""
                INSERT INTO customers (id, name, account_type, status) VALUES
                  ({CUST_OFF}, 'Off Co', 'rcf', 'active');
                INSERT INTO users (id, email, password_hash, customer_id, role, name) VALUES
                  (54, 'off-user@test', 'x', {CUST_OFF}, 'user', 'Off User');
                INSERT INTO rcf_numbers (customer_id, did, name, forward_to)
                  VALUES ({CUST_A}, '{A_RCF}', 'Front desk', '+17744045256');
                UPDATE customers SET voicemail_enabled = true WHERE id = {CUST_A};
                INSERT INTO voicemail_boxes (customer_id, did, label)
                  VALUES ({CUST_A}, '{A_VM}', 'Main box');
                INSERT INTO did_inventory (did, status) VALUES
                  ('{A_IVR}', 'available'), ('{A_IVR2}', 'available'), ('{B_IVR}', 'available'),
                  ('{A_RCF}', 'available'), ('+16175550199', 'available');
                """)
        finally:
            await conn.close()

    @staticmethod
    def build_app():
        from fastapi import FastAPI
        from fastapi.responses import ORJSONResponse
        from middleware.auth import JWTAuthMiddleware
        from routers import cdrs, ivr, number_inventory, onboarding
        app = FastAPI(default_response_class=ORJSONResponse)
        app.add_middleware(JWTAuthMiddleware)
        app.include_router(ivr.router, prefix="/v1/ivr")
        app.include_router(ivr.router, prefix="/ivr")
        app.add_exception_handler(ivr.IvrApiError, ivr.ivr_error_handler)
        app.include_router(number_inventory.router, prefix="/v1/numbers")
        app.include_router(cdrs.router, prefix="/v1/cdrs")
        app.include_router(onboarding.router, prefix="/v1/onboarding")
        return app

    def _mint_tokens(self):
        tokens = super()._mint_tokens()
        from auth.security import create_access_token
        tokens["user_off"] = create_access_token({"sub": "54", "email": "o@t", "role": "user",
                                                  "customer_id": CUST_OFF})
        tokens["admin_with_cid"] = create_access_token({"sub": "1", "email": "a@t",
                                                        "role": "admin", "customer_id": CUST_A})
        return tokens


@pytest.fixture(scope="module")
def h():
    harness = IvrHarness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


@pytest.fixture(autouse=True)
def fake_tts(monkeypatch):
    from services.ivr import audio, tts
    tts.reset_caches()
    calls = {"synthesize": 0}

    async def list_voices(*, force=False):
        return VOICES

    async def synthesize(text, voice):
        calls["synthesize"] += 1
        freq = 200 + int(hashlib.sha256(f"{voice}|{text}".encode()).hexdigest()[:4], 16) % 1500
        return audio.canonicalize(wav_bytes(22050, 1.0, freq))

    monkeypatch.setattr(tts, "list_voices", list_voices)
    monkeypatch.setattr(tts, "synthesize", synthesize)
    yield calls
    tts.reset_caches()


def run(h, coro):
    return h.run(coro)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def api(h, method, path, who="user_a", **kw):
    headers = {**h.auth(who), **kw.pop("headers", {})} if who else kw.pop("headers", {})
    return run(h, h.client.request(method, path, headers=headers, **kw))


def assign_ivr(h, did, customer_id, name=None):
    r = api(h, "POST", f"/v1/numbers/{did}/assign", "admin",
            json={"customer_id": customer_id, "product_type": "ivr", "name": name})
    assert r.status_code == 200, r.text
    return r.json()


def tts_prompt(h, name="Welcome", text="Thanks for calling Acme.", who="user_a", cid=None):
    path = "/v1/ivr/prompts/tts" + (f"?customer_id={cid}" if cid else "")
    r = api(h, "POST", path, who, json={"name": name, "text": text,
                                         "voice": "en_US-ljspeech-medium"})
    assert r.status_code == 201, r.text
    return r.json()


def new_flow(h, name="Main", graph=None, who="user_a"):
    body = {"name": name}
    if graph is not None:
        body["draft_graph"] = graph
    r = api(h, "POST", "/v1/ivr/flows", who, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def simple_graph(prompt_id, *, dial=None, menu=False):
    nodes = [{"id": "n_start", "type": "entry", "position": {"x": 0, "y": 0},
              "data": {"label": "Start", "config": {}}},
             {"id": "n_hello", "type": "play", "position": {"x": 0, "y": 100},
              "data": {"label": "Hello there", "config": {"prompts": [prompt_id]}},
              "ui": {"color": "teal"}}]
    edges = [{"id": "e1", "source": "n_start", "sourceHandle": "next", "target": "n_hello"}]
    if dial is not None:
        nodes.append({"id": "n_x", "type": "dial", "data": {"config": {"target": dial}}})
        edges.append({"id": "e2", "source": "n_hello", "sourceHandle": "next", "target": "n_x"})
    if menu:
        nodes.append({"id": "n_m", "type": "menu", "data": {"config": {
            "prompts": [prompt_id], "digits": ["1", "2"]}}})
        nodes.append({"id": "n_vm", "type": "voicemail", "data": {"config": {"did": A_VM}}})
        edges.append({"id": "e3", "source": "n_hello", "sourceHandle": "next", "target": "n_m"})
        edges.append({"id": "e4", "source": "n_m", "sourceHandle": "d:2", "target": "n_vm"})
    return {"schemaVersion": 1, "nodes": nodes, "edges": edges, "futureField": {"keep": True}}


def put_graph(h, flow, graph, who="user_a"):
    r = api(h, "PUT", f"/v1/ivr/flows/{flow['id']}", who,
            json={"draft_graph": graph, "revision": flow["revision"]})
    assert r.status_code == 200, r.text
    return r.json()


def publish(h, flow, who="user_a"):
    return api(h, "POST", f"/v1/ivr/flows/{flow['id']}/publish", who,
               json={"revision": flow["revision"]})


# ---------------------------------------------------------------------------
# 1. Inventory assign -> entitlement + number (contract §8.3) — runs first
# ---------------------------------------------------------------------------
def test_assign_ivr_number_side_effects(h):
    assert run(h, h.fetchval(f"SELECT ivr_enabled FROM customers WHERE id = {CUST_A}")) is False
    out = assign_ivr(h, A_IVR, CUST_A, name="Main line")
    assert out["product_type"] == "ivr" and out["did"] == A_IVR
    row = run(h, h.fetch("SELECT * FROM ivr_numbers WHERE did = $1", A_IVR))[0]
    assert row["id"] == out["product_ref_id"] and row["name"] == "Main line"
    assert row["customer_id"] == CUST_A and row["enabled"] and row["max_channels"] == 10
    inv = run(h, h.fetch("SELECT * FROM did_inventory WHERE did = $1", A_IVR))[0]
    assert (inv["status"], inv["product_type"], inv["customer_id"], inv["product_ref_id"]) == \
        ("assigned", "ivr", CUST_A, row["id"])
    assert run(h, h.fetchval(f"SELECT ivr_enabled FROM customers WHERE id = {CUST_A}")) is True
    nr = run(h, h.fetch("SELECT * FROM number_routing WHERE did = $1", A_IVR))
    assert len(nr) == 1 and nr[0]["product_type"] == "ivr" and nr[0]["product_enabled"] is False
    assign_ivr(h, A_IVR2, CUST_A)
    assign_ivr(h, B_IVR, CUST_B, name="Beta line")
    # again -> 409; a DID another product already routes -> 409 (drift guard)
    r = api(h, "POST", f"/v1/numbers/{A_IVR}/assign", "admin",
            json={"customer_id": CUST_A, "product_type": "ivr"})
    assert r.status_code == 409
    r = api(h, "POST", f"/v1/numbers/{A_RCF}/assign", "admin",
            json={"customer_id": CUST_A, "product_type": "ivr"})
    assert r.status_code == 409
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_numbers WHERE did = $1", A_RCF)) == 0
    # non-admin can't assign
    r = api(h, "POST", "/v1/numbers/+16175550199/assign", "user_a",
            json={"customer_id": CUST_A, "product_type": "ivr"})
    assert r.status_code == 403


def test_unassign_ivr_number_frees_the_did_and_keeps_flows(h):
    assign_ivr(h, "+16175550199", CUST_A)
    flow = new_flow(h, "Temp")
    nid = run(h, h.fetchval("SELECT id FROM ivr_numbers WHERE did = '+16175550199'"))
    r = api(h, "PUT", f"/v1/ivr/numbers/{nid}", json={"flow_id": flow["id"]})
    assert r.status_code == 200, r.text
    r = api(h, "POST", "/v1/numbers/+16175550199/unassign", "admin", json={})
    assert r.status_code == 200 and r.json()["previous_product_type"] == "ivr"
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_numbers WHERE did = '+16175550199'")) == 0
    inv = run(h, h.fetch("SELECT status, product_type FROM did_inventory "
                         "WHERE did = '+16175550199'"))[0]
    assert inv == {"status": "available", "product_type": None}
    assert run(h, h.fetchval("SELECT count(*) FROM call_flows WHERE id = $1", flow["id"])) == 1
    assert api(h, "DELETE", f"/v1/ivr/flows/{flow['id']}").status_code == 204


def test_reconcile_counts_ivr(h):
    r = api(h, "POST", "/v1/numbers/reconcile", "admin")
    assert r.status_code == 200 and r.json()["by_product"]["ivr"] >= 3


# ---------------------------------------------------------------------------
# 2. Scope / entitlement
# ---------------------------------------------------------------------------
def test_admin_with_null_customer_needs_customer_id(h):
    r = api(h, "GET", "/v1/ivr/flows", "admin")
    assert r.status_code == 400 and r.json() == {"detail": "customer_id required"}
    assert api(h, "GET", "/v1/ivr/summary", "admin").status_code == 400
    assert api(h, "GET", f"/v1/ivr/flows?customer_id={CUST_A}", "admin").status_code == 200
    # an admin JWT that carries a customer_id uses it
    assert api(h, "GET", "/v1/ivr/flows", "admin_with_cid").status_code == 200
    assert api(h, "GET", "/v1/ivr/flows?customer_id=999999", "admin").status_code == 404


def test_support_and_anonymous(h):
    assert api(h, "GET", "/v1/ivr/flows", "support").status_code == 403
    assert api(h, "GET", "/v1/ivr/flows", None).status_code == 401


def test_entitlement_gate(h):
    s = api(h, "GET", "/v1/ivr/summary", "user_off")
    assert s.status_code == 200 and s.json()["enabled"] is False
    assert s.json()["limits"]["max_prompts"] == 100
    for method, path, body in [("GET", "/v1/ivr/flows", None), ("GET", "/v1/ivr/numbers", None),
                               ("GET", "/v1/ivr/prompts", None), ("GET", "/v1/ivr/voices", None),
                               ("GET", "/v1/ivr/destinations", None),
                               ("POST", "/v1/ivr/flows", {"name": "x"}),
                               ("POST", "/v1/ivr/prompts/tts-preview",
                                {"text": "hi", "voice": "en_US-ljspeech-medium"})]:
        r = api(h, method, path, "user_off", json=body)
        assert r.status_code == 403 and r.json()["detail"] == "ivr_not_enabled", (path, r.text)
    summary = api(h, "GET", "/v1/ivr/summary").json()
    assert summary["enabled"] is True
    assert {n["did"] for n in summary["numbers"]} == {A_IVR, A_IVR2}


def test_tenant_customer_param_mismatch_is_404(h):
    assert api(h, "GET", f"/v1/ivr/flows?customer_id={CUST_B}").status_code == 404
    assert api(h, "GET", f"/v1/ivr/numbers?customer_id={CUST_A}", "user_b").status_code == 404


# ---------------------------------------------------------------------------
# 3. Flows: CRUD, revision lock, IDOR
# ---------------------------------------------------------------------------
def test_flow_crud_and_revision_lock(h):
    f = new_flow(h, "Lobby")
    assert f["revision"] == 1 and f["published_version"] is None and f["numbers"] == []
    assert [n["type"] for n in f["draft_graph"]["nodes"]] == ["entry"]
    g = dict(f["draft_graph"])
    g["somethingNew"] = [1, 2]
    r = api(h, "PUT", f"/v1/ivr/flows/{f['id']}", json={"draft_graph": g, "revision": 1,
                                                         "name": "  Lobby   main "})
    assert r.status_code == 200
    body = r.json()
    assert body["revision"] == 2 and body["name"] == "Lobby main"
    assert body["draft_graph"]["somethingNew"] == [1, 2]          # unknown fields round-trip
    stale = api(h, "PUT", f"/v1/ivr/flows/{f['id']}", json={"name": "x", "revision": 1})
    assert stale.status_code == 409
    assert stale.json() == {"detail": "stale_revision", "current_revision": 2}
    # a draft can never lose its Start block
    bad = api(h, "PUT", f"/v1/ivr/flows/{f['id']}",
              json={"draft_graph": {"schemaVersion": 1, "nodes": [], "edges": []},
                    "revision": 2})
    assert bad.status_code == 422 and bad.json()["detail"] == "invalid_graph"
    assert bad.json()["errors"][0]["code"] == "start_missing"
    assert api(h, "PUT", f"/v1/ivr/flows/{f['id']}",
               json={"draft_graph": None, "revision": 2}).status_code == 422
    listed = api(h, "GET", "/v1/ivr/flows").json()
    assert any(x["id"] == f["id"] and "draft_graph" not in x for x in listed)
    assert api(h, "DELETE", f"/v1/ivr/flows/{f['id']}").status_code == 204
    assert api(h, "GET", f"/v1/ivr/flows/{f['id']}").status_code == 404


def test_flow_idor_and_readonly(h):
    fa = new_flow(h, "A private")
    for method, suffix, body in [("GET", "", None), ("PUT", "", {"name": "pwn", "revision": 1}),
                                 ("DELETE", "", None), ("POST", "/validate", {}),
                                 ("POST", "/publish", {"revision": 1}),
                                 ("GET", "/versions", None),
                                 ("POST", "/simulate", {"caller": "anonymous",
                                                        "at": "2026-10-26T15:00:00Z"})]:
        r = api(h, method, f"/v1/ivr/flows/{fa['id']}{suffix}", "user_b", json=body)
        assert r.status_code == 404, (method, suffix, r.text)
        r = api(h, method, f"/v1/ivr/flows/{fa['id']}{suffix}?customer_id={CUST_A}", "user_b",
                json=body)
        assert r.status_code == 404, (method, suffix, r.text)
    for method, suffix, body in [("PUT", "", {"name": "ro", "revision": 1}), ("DELETE", "", None),
                                 ("POST", "/publish", {"revision": 1})]:
        r = api(h, method, f"/v1/ivr/flows/{fa['id']}{suffix}", "ro_a", json=body)
        assert r.status_code == 403, (method, suffix)
    assert api(h, "POST", "/v1/ivr/flows", "ro_a", json={"name": "x"}).status_code == 403
    # readonly reads + the read-only POSTs
    assert api(h, "GET", f"/v1/ivr/flows/{fa['id']}", "ro_a").status_code == 200
    assert api(h, "POST", f"/v1/ivr/flows/{fa['id']}/validate", "ro_a", json={}).status_code == 200
    # admin may act on the customer's flow with ?customer_id=
    r = api(h, "GET", f"/v1/ivr/flows/{fa['id']}?customer_id={CUST_A}", "admin")
    assert r.status_code == 200
    assert api(h, "GET", f"/v1/ivr/flows/{fa['id']}?customer_id={CUST_B}", "admin").status_code \
        == 404
    api(h, "DELETE", f"/v1/ivr/flows/{fa['id']}")


# ---------------------------------------------------------------------------
# 4. Prompts
# ---------------------------------------------------------------------------
def test_tts_prompt_create_cache_and_validation(h, fake_tts):
    p = tts_prompt(h, "Greeting", "Hello   from\nAcme")
    assert p["kind"] == "tts" and p["tts_text"] == "Hello from Acme"
    assert p["tts_voice"] == "en_US-ljspeech-medium" and p["duration_ms"] == 1000
    assert p["bytes"] == 44 + 16000
    calls = fake_tts["synthesize"]
    p2 = tts_prompt(h, "Greeting again", "Hello from Acme")         # render cache hit
    assert fake_tts["synthesize"] == calls
    shas = run(h, h.fetch("SELECT sha256 FROM ivr_prompts WHERE id = ANY($1::bigint[])",
                          [p["id"], p2["id"]]))
    assert shas[0]["sha256"] == shas[1]["sha256"]
    for body, code in [({"name": "", "text": "x", "voice": "en_US-ljspeech-medium"}, 422),
                       ({"name": "x", "text": "   ", "voice": "en_US-ljspeech-medium"}, 422),
                       ({"name": "x", "text": "a" * 1001, "voice": "en_US-ljspeech-medium"}, 422),
                       ({"name": "x", "text": "hi", "voice": "en_GB-evil"}, 422),
                       ({"name": "x" * 101, "text": "hi", "voice": "en_US-ljspeech-medium"}, 422)]:
        assert api(h, "POST", "/v1/ivr/prompts/tts", json=body).status_code == code, body
    assert api(h, "POST", "/v1/ivr/prompts/tts", "ro_a",
               json={"name": "x", "text": "hi", "voice": "en_US-ljspeech-medium"}).status_code == 403
    voices = api(h, "GET", "/v1/ivr/voices").json()
    assert voices == [{k: v[k] for k in ("id", "label", "gender", "license")} for v in VOICES]


def test_tts_unavailable_is_503(h, monkeypatch):
    from services.ivr import tts

    async def down(text, voice):
        raise tts.TtsUnavailable("connect refused")

    monkeypatch.setattr(tts, "synthesize", down)
    r = api(h, "POST", "/v1/ivr/prompts/tts",
            json={"name": "x", "text": "never cached text", "voice": "en_US-ljspeech-medium"})
    assert r.status_code == 503 and r.headers.get("retry-after")


def test_upload_canonicalises_and_rejects_bad_audio(h):
    src = wav_bytes(16000, 1.5, channels=2)
    r = api(h, "POST", "/v1/ivr/prompts/upload", files={"file": ("x.wav", src, "audio/wav")},
            data={"name": "Uploaded", "kind": "recording"})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["kind"] == "recording" and p["duration_ms"] == 1500 and p["bytes"] == 44 + 24000
    assert "tts_text" not in p
    stored = run(h, h.fetch("SELECT a.wav, a.sha256 FROM ivr_prompts p JOIN ivr_prompt_audio a "
                            "ON a.sha256 = p.sha256 WHERE p.id = $1", p["id"]))[0]
    from services.ivr import audio
    assert audio.is_canonical(bytes(stored["wav"]))
    assert stored["sha256"] == hashlib.sha256(bytes(stored["wav"])).hexdigest()
    assert audio.canonicalize(src).sha256 == stored["sha256"]       # deterministic
    for files, data, code in [
        ({"file": ("x.mp3", b"ID3\x03not a wav", "audio/mpeg")}, {"name": "x"}, 422),
        ({"file": ("x.wav", wav_bytes(8000, 0.02), "audio/wav")}, {"name": "x"}, 422),
        ({"file": ("x.wav", src, "audio/wav")}, {"name": ""}, 422),
        ({"file": ("x.wav", src, "audio/wav")}, {"name": "x", "kind": "tts"}, 422),
        ({}, {"name": "x"}, 422),
    ]:
        assert api(h, "POST", "/v1/ivr/prompts/upload", files=files or None,
                   data=data).status_code == code, data
    assert api(h, "POST", "/v1/ivr/prompts/upload", "ro_a",
               files={"file": ("x.wav", src, "audio/wav")}, data={"name": "x"}).status_code == 403


def test_prompt_playback_token(h):
    p = tts_prompt(h, "Play me", "Play me back")
    r = api(h, "POST", f"/v1/ivr/prompts/{p['id']}/playback-token", "ro_a")
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith(f"/api/v1/ivr/prompts/{p['id']}/audio?t=")
    path = url[len("/api"):]
    audio_r = run(h, h.client.get(path))                       # no Authorization header
    assert audio_r.status_code == 200 and audio_r.headers["content-type"] == "audio/wav"
    assert audio_r.headers["cache-control"] == "no-store"
    assert audio_r.content[:4] == b"RIFF" and len(audio_r.content) == p["bytes"]
    head = run(h, h.client.head(path))
    assert head.status_code == 200 and head.headers["content-length"] == str(p["bytes"])
    other = tts_prompt(h, "Other", "Another prompt")
    token = url.split("t=", 1)[1]
    r = run(h, h.client.get(f"/v1/ivr/prompts/{other['id']}/audio?t={token}"))
    assert r.status_code == 401                                 # token bound to one prompt
    assert run(h, h.client.get(f"/v1/ivr/prompts/{p['id']}/audio")).status_code == 401
    # a voicemail playback route never accepts an IVR token
    r = run(h, h.client.get(f"/v1/voicemail/greetings/{p['id']}/audio?t={token}"))
    assert r.status_code in (401, 404)
    # another tenant can't mint one
    assert api(h, "POST", f"/v1/ivr/prompts/{p['id']}/playback-token", "user_b").status_code == 404


def test_tts_preview_rate_limit(h):
    for i in range(30):
        r = api(h, "POST", "/v1/ivr/prompts/tts-preview",
                json={"text": f"Preview {i % 3}", "voice": "en_US-norman-medium"})
        assert r.status_code == 200, (i, r.text)
        assert r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    r = api(h, "POST", "/v1/ivr/prompts/tts-preview",
            json={"text": "one more", "voice": "en_US-norman-medium"})
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    # previews are never stored
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_prompts WHERE tts_text LIKE 'Preview%'")) == 0
    assert api(h, "POST", "/v1/ivr/prompts/tts-preview", "ro_a",
               json={"text": "x", "voice": "en_US-norman-medium"}).status_code == 403


def test_prompt_rename_and_idor(h):
    p = tts_prompt(h, "Renamable", "Rename me")
    r = api(h, "PATCH", f"/v1/ivr/prompts/{p['id']}", json={"name": "Renamed"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed"
    assert api(h, "PATCH", f"/v1/ivr/prompts/{p['id']}", "user_b",
               json={"name": "pwn"}).status_code == 404
    assert api(h, "DELETE", f"/v1/ivr/prompts/{p['id']}", "user_b").status_code == 404
    assert api(h, "PATCH", f"/v1/ivr/prompts/{p['id']}", "ro_a",
               json={"name": "ro"}).status_code == 403
    assert all(x["id"] != p["id"] for x in api(h, "GET", "/v1/ivr/prompts", "user_b").json())


def test_prompt_limit(h, monkeypatch):
    from services.ivr import limits
    live = run(h, h.fetchval(f"SELECT count(*) FROM ivr_prompts WHERE customer_id = {CUST_A} "
                             "AND deleted_at IS NULL"))
    monkeypatch.setattr(limits, "MAX_PROMPTS_PER_CUSTOMER", live)
    r = api(h, "POST", "/v1/ivr/prompts/tts",
            json={"name": "too many", "text": "over the limit", "voice": "en_US-ljspeech-medium"})
    assert r.status_code == 409 and "at most" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 5. Validate / publish / FS read path
# ---------------------------------------------------------------------------
def test_validate_publish_and_freeswitch_read_path(h):
    p = tts_prompt(h, "Main greeting", "Welcome to Acme. Press 2 for voicemail.")
    f = new_flow(h, "Published flow")
    f = put_graph(h, f, simple_graph(p["id"], menu=True))
    v = api(h, "POST", f"/v1/ivr/flows/{f['id']}/validate", json={}).json()
    assert v["ok"] is True and v["errors"] == []
    assert {"exit_unconnected"} <= {w["code"] for w in v["warnings"]}
    r = publish(h, f)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["version"] == 1 and out["plan_summary"]["destinations"] == [A_VM]
    nid = run(h, h.fetchval("SELECT id FROM ivr_numbers WHERE did = $1", A_IVR))
    r = api(h, "PUT", f"/v1/ivr/numbers/{nid}", json={"flow_id": f["id"]})
    assert r.status_code == 200 and r.json()["published"] is True
    assert r.json()["flow_name"] == "Published flow"

    async def as_freeswitch():
        conn = await asyncpg.connect(host=h.pg.sock, port=h.pg.port, user="freeswitch",
                                     password="fs_secret", database="postgres",
                                     statement_cache_size=0)
        try:
            row = await conn.fetchrow("SELECT * FROM ivr_fs_number WHERE did = $1", A_IVR)
            plan = json.loads(row["plan_json"])
            hexes = {}
            for sha in plan["prompts"]:
                hx = await conn.fetchval("SELECT encode(wav, 'hex') FROM ivr_prompt_audio "
                                         "WHERE sha256 = $1", sha)
                hexes[sha] = bytes.fromhex(hx)
            nr = await conn.fetchrow("SELECT * FROM number_routing WHERE did = $1", A_IVR)
            return row, plan, hexes, nr
        finally:
            await conn.close()

    row, plan, audio_by_sha, nr = run(h, as_freeswitch())
    assert row["enabled"] is True and row["flow_id"] == f["id"] and row["flow_version"] == 1
    assert row["customer_id"] == CUST_A and row["max_channels"] == 10
    assert plan["customer_id"] == CUST_A and plan["flow_id"] == f["id"] and plan["version"] == 1
    assert plan["start"] == "n_hello"
    for sha, wav in audio_by_sha.items():
        assert hashlib.sha256(wav).hexdigest() == sha and wav[:4] == b"RIFF"
    assert nr["product_type"] == "ivr" and nr["product_enabled"] is True
    # no customer free text in the stored plan
    stored = json.dumps(plan)
    for s in ("Main greeting", "Welcome to Acme", "Hello there", "Published flow", "Main line"):
        assert s not in stored
    # versions + the graph that was published (unknown fields kept)
    versions = api(h, "GET", f"/v1/ivr/flows/{f['id']}/versions").json()
    assert [x["version"] for x in versions] == [1]
    assert versions[0]["published_by_email"] == "a-user@test"
    ver = api(h, "GET", f"/v1/ivr/flows/{f['id']}/versions/1").json()
    assert ver["graph"]["futureField"] == {"keep": True}
    assert api(h, "GET", f"/v1/ivr/flows/{f['id']}/versions/2").status_code == 404
    h.published = {"flow": f, "prompt": p, "number_id": nid}


def test_publish_rejects_invalid_and_stale(h):
    f = new_flow(h, "Broken")
    r = publish(h, f)
    assert r.status_code == 422
    body = r.json()
    assert body["detail"] == "invalid_flow"
    assert body["errors"][0]["code"] == "start_unconnected"
    assert body["errors"][0]["node_id"] == "n_start"
    assert api(h, "POST", f"/v1/ivr/flows/{f['id']}/publish",
               json={"revision": 99}).json() == {"detail": "stale_revision", "current_revision": 1}
    p = tts_prompt(h, "x900", "Calling a premium line")
    f = put_graph(h, f, simple_graph(p["id"], dial={"kind": "external",
                                                    "number": "+19005550123"}))
    r = publish(h, f)
    assert r.status_code == 422 and r.json()["errors"][0]["code"] == "premium"
    f = put_graph(h, f, simple_graph(p["id"], dial={"kind": "external",
                                                    "number": "+14165550123"}))
    assert publish(h, f).json()["errors"][0]["code"] == "not_us"
    # B's prompt / number can't be used from A's flow
    pb = tts_prompt(h, "B prompt", "Beta prompt text", who="user_b")
    f = put_graph(h, f, simple_graph(pb["id"]))
    assert publish(h, f).json()["errors"][0]["code"] == "prompt_missing"
    f = put_graph(h, f, simple_graph(p["id"], dial={"kind": "own", "did": B_IVR}))
    assert publish(h, f).json()["errors"][0]["code"] == "not_own_number"
    assert run(h, h.fetchval("SELECT count(*) FROM call_flow_versions WHERE flow_id = $1",
                             f["id"])) == 0


def test_publish_is_atomic(h):
    """A failure AFTER the version INSERT (here: the published_version_id flip)
    rolls everything back — no version row, the live version unchanged."""
    f = h.published["flow"]
    flow = api(h, "GET", f"/v1/ivr/flows/{f['id']}").json()
    before = run(h, h.fetch("SELECT id, version FROM call_flow_versions WHERE flow_id = $1",
                            f["id"]))
    live = run(h, h.fetchval("SELECT published_version_id FROM call_flows WHERE id = $1",
                             f["id"]))
    run(h, h.execute("""
        CREATE FUNCTION ivr_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected publish failure'; END $$;
        CREATE TRIGGER ivr_test_fail BEFORE UPDATE OF published_version_id ON call_flows
        FOR EACH ROW EXECUTE FUNCTION ivr_test_fail();"""))
    try:
        r = api(h, "POST", f"/v1/ivr/flows/{f['id']}/publish",
                json={"revision": flow["revision"]})
        assert r.status_code == 500
    finally:
        run(h, h.execute("DROP TRIGGER ivr_test_fail ON call_flows; "
                         "DROP FUNCTION ivr_test_fail();"))
    after = run(h, h.fetch("SELECT id, version FROM call_flow_versions WHERE flow_id = $1",
                           f["id"]))
    assert after == before
    assert run(h, h.fetchval("SELECT published_version_id FROM call_flows WHERE id = $1",
                             f["id"])) == live
    # and it works again once the fault is gone
    r = api(h, "POST", f"/v1/ivr/flows/{f['id']}/publish", json={"revision": flow["revision"]})
    assert r.status_code == 200 and r.json()["version"] == 2


def test_restore_version_into_draft(h):
    f = h.published["flow"]
    flow = api(h, "GET", f"/v1/ivr/flows/{f['id']}").json()
    put_graph(h, flow, {"schemaVersion": 1, "nodes": [{"id": "n_start", "type": "entry"}],
                        "edges": []})
    flow = api(h, "GET", f"/v1/ivr/flows/{f['id']}").json()
    assert api(h, "POST", f"/v1/ivr/flows/{f['id']}/versions/1/restore",
               json={"revision": flow["revision"] - 1}).status_code == 409
    r = api(h, "POST", f"/v1/ivr/flows/{f['id']}/versions/1/restore",
            json={"revision": flow["revision"]})
    assert r.status_code == 200
    restored = r.json()
    assert restored["revision"] == flow["revision"] + 1
    assert restored["draft_graph"]["futureField"] == {"keep": True}
    assert restored["published_version"] == 2      # restore never publishes


def test_simulate(h):
    f = h.published["flow"]
    r = api(h, "POST", f"/v1/ivr/flows/{f['id']}/simulate", "ro_a",
            json={"caller": "+12125550123", "at": "2026-10-26T15:00:00Z", "digits": ["2"]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["outcome"] == "voicemail"
    assert [s["node_id"] for s in out["steps"]] == ["n_hello", "n_m", "n_vm"]
    assert out["steps"][0]["says"] == ["Main greeting"]
    # simulate an unsaved draft
    p = h.published["prompt"]
    r = api(h, "POST", f"/v1/ivr/flows/{f['id']}/simulate",
            json={"caller": "anonymous", "at": "2026-10-26T15:00:00", "digits": [],
                  "draft_graph": simple_graph(p["id"], dial={"kind": "own", "did": A_RCF})})
    assert r.json()["outcome"] == "transfer"
    for bad in ({"caller": "nope", "at": "2026-10-26T15:00:00Z"},
                {"caller": "anonymous", "at": "2026-10-26T15:00:00Z", "digits": ["x"]},
                {"caller": "anonymous", "at": "not a date"}):
        assert api(h, "POST", f"/v1/ivr/flows/{f['id']}/simulate", json=bad).status_code == 422


# ---------------------------------------------------------------------------
# 6. Numbers: binding rules
# ---------------------------------------------------------------------------
def test_number_binding_rules(h):
    nid_a = h.published["number_id"]
    nid_b = run(h, h.fetchval("SELECT id FROM ivr_numbers WHERE did = $1", B_IVR))
    fb = new_flow(h, "Beta flow", who="user_b")
    # A can't bind B's flow; B can't touch A's number
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a}", json={"flow_id": fb["id"]}).status_code == 404
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a}", "user_b",
               json={"name": "pwn"}).status_code == 404
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_b}", json={"name": "pwn"}).status_code == 404
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a}", "ro_a", json={"name": "x"}).status_code == 403
    # name: absent = unchanged, null = cleared
    r = api(h, "PUT", f"/v1/ivr/numbers/{nid_a}", json={"name": "Lobby line"})
    assert r.json()["name"] == "Lobby line"
    r = api(h, "PUT", f"/v1/ivr/numbers/{nid_a}", json={})
    assert r.json()["name"] == "Lobby line" and r.json()["flow_id"] is not None
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a}", json={"name": None}).json()["name"] is None
    # a published flow that transfers to the number itself can't be bound to it
    p = h.published["prompt"]
    f = new_flow(h, "Loops to A2")
    f = put_graph(h, f, simple_graph(p["id"], dial={"kind": "own", "did": A_IVR2}))
    assert publish(h, f).status_code == 200
    nid_a2 = run(h, h.fetchval("SELECT id FROM ivr_numbers WHERE did = $1", A_IVR2))
    r = api(h, "PUT", f"/v1/ivr/numbers/{nid_a2}", json={"flow_id": f["id"]})
    assert r.status_code == 422 and "loop" in r.json()["detail"]
    # ...and binding first then validating flags self_transfer
    # (the check reads the PUBLISHED plan: fixing only the draft is not enough)
    g = put_graph(h, api(h, "GET", f"/v1/ivr/flows/{f['id']}").json(), simple_graph(p["id"]))
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a2}", json={"flow_id": f["id"]}).status_code == 422
    assert publish(h, g).status_code == 200
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a2}", json={"flow_id": f["id"]}).status_code == 200
    v = api(h, "POST", f"/v1/ivr/flows/{f['id']}/validate",
            json={"draft_graph": simple_graph(p["id"], dial={"kind": "own", "did": A_IVR2})}).json()
    assert v["ok"] is False and v["errors"][0]["code"] == "self_transfer"
    # unbind; flow delete blocked while bound
    assert api(h, "DELETE", f"/v1/ivr/flows/{f['id']}").json() == \
        {"detail": "flow_in_use", "numbers": [A_IVR2]}
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid_a2}", json={"flow_id": None}).json()["flow_id"] \
        is None
    assert api(h, "DELETE", f"/v1/ivr/flows/{f['id']}").status_code == 204


def test_destinations(h):
    body = api(h, "GET", "/v1/ivr/destinations").json()
    groups = {g["product"]: g for g in body["groups"]}
    assert [g["product"] for g in body["groups"]] == ["rcf", "voicemail", "ivr"]
    assert groups["rcf"]["numbers"] == [{"did": A_RCF, "name": "Front desk", "enabled": True,
                                         "detail": "Forwards to +1 774-404-5256"}]
    assert groups["voicemail"]["numbers"][0]["detail"] == "Mailbox: Main box"
    ivr = {n["did"]: n for n in groups["ivr"]["numbers"]}
    assert ivr[A_IVR]["detail"] == "IVR: Published flow"
    assert B_IVR not in ivr


# ---------------------------------------------------------------------------
# 7. Prompt delete: in use / soft / GC
# ---------------------------------------------------------------------------
def test_prompt_delete_in_use_soft_and_gc(h):
    p = h.published["prompt"]
    r = api(h, "DELETE", f"/v1/ivr/prompts/{p['id']}")
    assert r.status_code == 409 and r.json()["detail"] == "prompt_in_use"
    assert {"id": h.published["flow"]["id"], "name": "Published flow"} in r.json()["flows"]
    # remove it from every draft that uses it -> only published versions keep it
    for fl in api(h, "GET", "/v1/ivr/flows").json():
        full = api(h, "GET", f"/v1/ivr/flows/{fl['id']}").json()
        from services.ivr import store
        if p["id"] in store.prompt_ids_in_graph(full["draft_graph"]):
            put_graph(h, full, {"schemaVersion": 1, "nodes": [{"id": "n_start",
                                                                "type": "entry"}], "edges": []})
    sha = run(h, h.fetchval("SELECT sha256 FROM ivr_prompts WHERE id = $1", p["id"]))
    assert api(h, "DELETE", f"/v1/ivr/prompts/{p['id']}").status_code == 204
    row = run(h, h.fetch("SELECT deleted_at FROM ivr_prompts WHERE id = $1", p["id"]))
    assert row and row[0]["deleted_at"] is not None                  # soft
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_prompt_audio WHERE sha256 = $1", sha)) == 1
    assert all(x["id"] != p["id"] for x in api(h, "GET", "/v1/ivr/prompts").json())
    assert api(h, "DELETE", f"/v1/ivr/prompts/{p['id']}").status_code == 404
    # an unused prompt is deleted for real and its unshared audio is collected
    q = tts_prompt(h, "Throwaway", "A message nobody uses")
    qsha = run(h, h.fetchval("SELECT sha256 FROM ivr_prompts WHERE id = $1", q["id"]))
    assert api(h, "DELETE", f"/v1/ivr/prompts/{q['id']}").status_code == 204
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_prompts WHERE id = $1", q["id"])) == 0
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_prompt_audio WHERE sha256 = $1", qsha)) == 0
    # shared audio survives while another prompt (another tenant) still uses it
    a1 = tts_prompt(h, "Shared A", "Shared words")
    b1 = tts_prompt(h, "Shared B", "Shared words", who="user_b")
    ssha = run(h, h.fetchval("SELECT sha256 FROM ivr_prompts WHERE id = $1", a1["id"]))
    assert run(h, h.fetchval("SELECT sha256 FROM ivr_prompts WHERE id = $1", b1["id"])) == ssha
    assert api(h, "DELETE", f"/v1/ivr/prompts/{a1['id']}").status_code == 204
    assert run(h, h.fetchval("SELECT count(*) FROM ivr_prompt_audio WHERE sha256 = $1", ssha)) == 1


def test_publish_fails_cleanly_if_a_prompt_was_soft_deleted(h):
    p = tts_prompt(h, "Soon gone", "This prompt will be soft deleted")
    f = new_flow(h, "Uses soon gone")
    run(h, h.execute("UPDATE ivr_prompts SET deleted_at = now() WHERE id = $1", p["id"]))
    f = put_graph(h, f, simple_graph(p["id"]))
    r = publish(h, f)
    assert r.status_code == 422 and r.json()["errors"][0]["code"] == "prompt_missing"


# ---------------------------------------------------------------------------
# 8. Admin API (TED)
# ---------------------------------------------------------------------------
def test_admin_api(h):
    for who in ("user_a", "ro_a", "support"):
        assert api(h, "GET", f"/v1/ivr/admin/customers/{CUST_A}", who).status_code == 403
    r = api(h, "GET", f"/v1/ivr/admin/customers/{CUST_A}", "admin")
    assert r.status_code == 200
    body = r.json()
    assert body["ivr_enabled"] is True and {n["did"] for n in body["numbers"]} >= {A_IVR}
    assert api(h, "GET", "/v1/ivr/admin/customers/999999", "admin").status_code == 404
    nid = h.published["number_id"]
    r = api(h, "PUT", f"/v1/ivr/admin/numbers/{nid}", "admin",
            json={"enabled": False, "max_channels": 3, "name": "Admin named"})
    assert r.status_code == 200
    assert (r.json()["enabled"], r.json()["max_channels"], r.json()["name"]) == \
        (False, 3, "Admin named")
    assert run(h, h.fetchval("SELECT product_enabled FROM number_routing WHERE did = $1",
                             A_IVR)) is False
    r = api(h, "PUT", f"/v1/ivr/admin/numbers/{nid}", "admin", json={"name": None})
    assert r.json()["name"] is None and r.json()["max_channels"] == 3      # null clears only
    assert api(h, "PUT", f"/v1/ivr/admin/numbers/{nid}", "admin",
               json={"max_channels": 501}).status_code == 422
    assert api(h, "PUT", f"/v1/ivr/admin/numbers/{nid}", "admin",
               json={"enabled": None}).status_code == 422
    r = api(h, "PUT", f"/v1/ivr/admin/numbers/{nid}", "admin", json={"enabled": True})
    assert r.json()["enabled"] is True
    fid = h.published["flow"]["id"]
    versions = api(h, "GET", f"/v1/ivr/admin/flows/{fid}/versions", "admin").json()
    assert [v["version"] for v in versions] == [2, 1]
    assert api(h, "GET", f"/v1/ivr/admin/flows/{fid}/versions/1", "admin").json()["version"] == 1
    assert api(h, "GET", "/v1/ivr/admin/flows/99999999/versions", "admin").status_code == 404
    # entitlement off -> every number off at FS, data kept
    r = api(h, "PUT", f"/v1/ivr/admin/customers/{CUST_A}/entitlement", "admin",
            json={"enabled": False})
    assert r.json() == {"ivr_enabled": False}
    assert run(h, h.fetchval("SELECT enabled FROM ivr_fs_number WHERE did = $1", A_IVR)) is False
    assert api(h, "GET", "/v1/ivr/flows").json()["detail"] == "ivr_not_enabled"
    assert api(h, "PUT", f"/v1/ivr/admin/customers/{CUST_A}/entitlement", "admin",
               json={"enabled": True}).json() == {"ivr_enabled": True}
    assert api(h, "PUT", "/v1/ivr/admin/customers/999999/entitlement", "admin",
               json={"enabled": True}).status_code == 404


def test_tenant_does_not_see_staff_publisher_email(h):
    f = h.published["flow"]
    flow = api(h, "GET", f"/v1/ivr/flows/{f['id']}").json()
    p = h.published["prompt"]
    q = tts_prompt(h, "Admin-made", "Published by an admin", who="admin", cid=CUST_A)
    put_graph(h, flow, simple_graph(q["id"]))
    flow = api(h, "GET", f"/v1/ivr/flows/{f['id']}").json()
    r = api(h, "POST", f"/v1/ivr/flows/{f['id']}/publish?customer_id={CUST_A}", "admin",
            json={"revision": flow["revision"]})
    assert r.status_code == 200
    tenant = api(h, "GET", f"/v1/ivr/flows/{f['id']}/versions").json()
    assert tenant[0]["published_by_email"] is None
    staff = api(h, "GET", f"/v1/ivr/admin/flows/{f['id']}/versions", "admin").json()
    assert staff[0]["published_by_email"] == "admin@customvoip.com"   # users.id 1 (09 seed)
    assert p["id"] != q["id"]


# ---------------------------------------------------------------------------
# 9. CDR ingest — ivr_* channel variables onto the A-leg row (migration 60)
# ---------------------------------------------------------------------------
def _cdr(uuid, product_type, **extra):
    v = {"uuid": uuid, "direction": "inbound", "product_type": product_type,
         "destination_number": A_IVR, "caller_id_number": "+15085551212",
         "start_uepoch": "1793000000000000", "answer_uepoch": "1793000001000000",
         "end_uepoch": "1793000041000000", "customer_id": str(CUST_A),
         "hangup_cause": "NORMAL_CLEARING"}
    v.update(extra)
    return {"variables": v}


def test_cdr_ingest_maps_ivr_variables(h):
    body = _cdr("ivr-cdr-1", "ivr", ivr_flow_id="12", ivr_flow_version="3",
                ivr_exit="transfer", ivr_path="n_a1>n_m1:1>n_x", ivr_transfer_to="+17744045256",
                ivr_seconds="17")
    r = run(h, h.client.post("/v1/cdrs/ingest", json=body))
    assert r.status_code == 200 and r.json()["status"] == "ok", r.text
    row = run(h, h.fetch("SELECT product_type, ivr_flow_id, ivr_flow_version, ivr_exit, "
                         "ivr_path, ivr_transfer_to, ivr_seconds, leg FROM cdrs "
                         "WHERE uuid = 'ivr-cdr-1'"))[0]
    assert row == {"product_type": "ivr", "ivr_flow_id": 12, "ivr_flow_version": 3,
                   "ivr_exit": "transfer", "ivr_path": "n_a1>n_m1:1>n_x",
                   "ivr_transfer_to": "+17744045256", "ivr_seconds": 17, "leg": "A"}
    # re-delivery is idempotent; junk values become NULL; long paths truncate
    r = run(h, h.client.post("/v1/cdrs/ingest", json=body))
    assert r.json()["status"] == "duplicate"
    body2 = _cdr("ivr-cdr-2", "ivr", ivr_exit="BAD EXIT!", ivr_transfer_to="sip:x@y",
                 ivr_flow_id="abc", ivr_seconds="-5", ivr_path="n>" * 400)
    assert run(h, h.client.post("/v1/cdrs/ingest", json=body2)).json()["status"] == "ok"
    row = run(h, h.fetch("SELECT ivr_flow_id, ivr_exit, ivr_transfer_to, ivr_seconds, ivr_path "
                         "FROM cdrs WHERE uuid = 'ivr-cdr-2'"))[0]
    assert row["ivr_flow_id"] is None and row["ivr_exit"] is None
    assert row["ivr_transfer_to"] is None and row["ivr_seconds"] == 0
    assert len(row["ivr_path"]) == 512 and row["ivr_path"].endswith("…")


def test_cdr_ingest_other_products_unchanged(h, monkeypatch):
    from db import database as db
    from routers import cdrs
    seen = []
    real = db.execute

    async def spy(sql, *args):
        seen.append(sql)
        return await real(sql, *args)

    monkeypatch.setattr(db, "execute", spy)
    r = run(h, h.client.post("/v1/cdrs/ingest", json=_cdr("rcf-cdr-1", "rcf")))
    assert r.json()["status"] == "ok"
    assert not any("ivr_flow_id" in s for s in seen)                # no extra statement
    assert cdrs._ivr_columns({"product_type": "rcf"}) is None
    row = run(h, h.fetch("SELECT ivr_flow_id, ivr_exit, ivr_path FROM cdrs "
                         "WHERE uuid = 'rcf-cdr-1'"))[0]
    assert all(v is None for v in row.values())


# ---------------------------------------------------------------------------
# 10. Onboarding: products-v2 'ivr' (v1 still accepted)
# ---------------------------------------------------------------------------
def test_onboarding_products_ivr():
    from pydantic import ValidationError
    from routers.onboarding import PRODUCTS_FORM_VERSION, ProductsPayload
    assert PRODUCTS_FORM_VERSION == "products-v2"
    ok = ProductsPayload.model_validate({"selected": ["ivr"], "ivr": {"number_count": 2,
                                                                       "notes": " main "}})
    assert ok.ivr.number_count == 2 and ok.ivr.notes == "main"
    ProductsPayload.model_validate({"selected": ["voicemail"], "voicemail": {
        "mailbox_count": 1, "attach_to": "unsure"}, "form_version": "products-v1"})
    for bad in ({"selected": ["ivr"]},
                {"selected": ["voicemail"], "voicemail": {"mailbox_count": 1,
                                                          "attach_to": "unsure"},
                 "ivr": {"number_count": 1}},
                {"selected": ["ivr"], "ivr": {"number_count": 0}},
                {"selected": ["ivr"], "ivr": {"number_count": 21}},
                {"selected": ["ivr"], "ivr": {"number_count": 1}, "form_version": "products-v1"},
                {"selected": ["ivr"], "ivr": {"number_count": 1}, "form_version": "products-v3"}):
        with pytest.raises(ValidationError):
            ProductsPayload.model_validate(bad)


def test_middleware_exempts_only_the_ivr_audio_route():
    from middleware.auth import is_ivr_exempt
    assert is_ivr_exempt("/v1/ivr/prompts/12/audio", "GET")
    assert is_ivr_exempt("/ivr/prompts/12/audio", "HEAD")
    assert not is_ivr_exempt("/v1/ivr/prompts/12/audio", "POST")
    assert not is_ivr_exempt("/v1/ivr/prompts/12/audio/", "GET")
    assert not is_ivr_exempt("/v1/ivr/prompts/x/audio", "GET")
    assert not is_ivr_exempt("/v1/ivr/prompts/12/audio\n", "GET")
    assert not is_ivr_exempt("/v1/ivr/prompts/12/playback-token", "GET")
    assert not is_ivr_exempt("/v1/ivr/flows", "GET")
