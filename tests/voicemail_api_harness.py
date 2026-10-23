"""Shared harness for the voicemail API test modules.

An ephemeral PostgreSQL 16 built from the REAL init scripts (voicemail_db:
02/03/09/17/20/22/24/31/34 + every voicemail migration: 54, 56), the API
pool connected as the runtime ``api`` role, and an httpx client over the
REAL routers (voicemail at ``/v1/voicemail`` + ``/voicemail``, number
inventory, customers) behind the REAL ``JWTAuthMiddleware`` — the same shape
as tests/test_carrier_trunks.py.

Crypto runs on the dev/CI backends only (``VOICEMAIL_ALLOW_LOCAL_KMS=true``,
``VOICEMAIL_KMS_PROVIDER=local``, ``VOICEMAIL_STORAGE=memory``): nothing here
contacts Google Cloud.

Each test module owns ONE event loop (asyncpg pools are loop-bound) and a
distinct PostgreSQL port.
"""
from __future__ import annotations

import asyncio
import base64
import os
import struct
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for voicemail API tests")
httpx = pytest.importorskip("httpx", reason="httpx required for voicemail API tests")
pytest.importorskip("cryptography", reason="cryptography required")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from voicemail_db import (  # noqa: E402
    EphemeralPG,
    apply_prerequisites,
    apply_voicemail_schema,
    find_pg_bin,
)

PG_BIN = find_pg_bin()

MASTER_KEY_B64 = base64.b64encode(bytes(range(32))).decode()
PLAYBACK_SECRET = "playback-secret-" + "p" * 32
INGEST_SECRET = "ingest-secret-" + "i" * 32
VM_ENV = {
    "VOICEMAIL_KMS_PROVIDER": "local",
    "VOICEMAIL_ALLOW_LOCAL_KMS": "true",
    "VOICEMAIL_STORAGE": "memory",
    "VOICEMAIL_LOCAL_MASTER_KEY": MASTER_KEY_B64,
    "VOICEMAIL_PLAYBACK_SECRET": PLAYBACK_SECRET,
    "INGEST_SHARED_SECRET": INGEST_SECRET,
    "VOICEMAIL_RETENTION_ENABLED": "false",
}
_CLEARED_ENV = ("ENV", "ENVIRONMENT", "VOICEMAIL_KMS_PROJECT", "VOICEMAIL_IMPERSONATE_SA",
                "VOICEMAIL_BUCKET")

# Customers seeded by every module (ids fixed).
CUST_A = 101
CUST_B = 102
CUST_INACTIVE = 103


def pcm_tone(seconds: float, rate: int = 8000) -> bytes:
    n = int(seconds * rate)
    return b"".join(struct.pack("<h", (i * 37) % 2000 - 1000) for i in range(n))


def make_wav(seconds: float = 2.0, rate: int = 8000) -> bytes:
    from services.voicemail.wav import build_wav
    return build_wav(pcm_tone(seconds, rate), rate)


class Harness:
    """One PG + pool + app + client for a test module."""

    def __init__(self, port: int):
        self.port = port
        self.loop = asyncio.new_event_loop()
        self.pg: EphemeralPG | None = None
        self.client: Any = None
        self.app: Any = None
        self._saved_env: dict[str, str | None] = {}
        self.tokens: dict[str, str] = {}

    # -- lifecycle ------------------------------------------------------------
    def run(self, coro):
        return self.loop.run_until_complete(coro)

    def start(self) -> "Harness":
        if PG_BIN is None:
            pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run voicemail tests")
        for k in list(VM_ENV) + list(_CLEARED_ENV):
            self._saved_env[k] = os.environ.get(k)
        for k in _CLEARED_ENV:
            os.environ.pop(k, None)
        os.environ.update(VM_ENV)
        self.pg = EphemeralPG(PG_BIN, self.port)
        try:
            self.pg.start()
        except Exception as e:  # noqa: BLE001
            self.pg.stop()
            self._restore_env()
            pytest.skip(f"could not start throwaway PostgreSQL: {e}")
        self.run(self._setup())
        self.reset_caches()
        self.app = self.build_app()
        transport = httpx.ASGITransport(app=self.app, raise_app_exceptions=False)
        self.client = httpx.AsyncClient(transport=transport, base_url="http://test")
        self.tokens = self._mint_tokens()
        return self

    def stop(self) -> None:
        try:
            if self.client is not None:
                self.run(self.client.aclose())
            self.run(self._teardown())
        finally:
            if self.pg is not None:
                self.pg.stop()
            self.reset_caches()
            self._restore_env()
            self.loop.close()

    def _restore_env(self) -> None:
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    @staticmethod
    def reset_caches() -> None:
        from services.voicemail import audio, deposit, greetings, kms, mailboxes, storage
        kms.reset_kms_providers()
        storage.reset_object_stores()
        mailboxes.reset_schema_cache()
        audio.PLAYBACK_CACHE.clear()
        audio.FS_GREETING_CACHE.clear()
        deposit.deposit_limiter.in_use = 0
        deposit.deposit_limiter.limit = deposit.DEPOSIT_CONCURRENCY
        greetings.greeting_limiter.in_use = 0
        audio.decrypt_limiter.in_use = 0
        audio.decrypt_limiter.limit = audio.DECRYPT_CONCURRENCY

    async def owner(self):
        return await asyncpg.connect(host=self.pg.sock, port=self.pg.port, user="postgres",
                                     database="postgres", statement_cache_size=0)

    async def _setup(self) -> None:
        from db import database as db
        conn = await self.owner()
        try:
            await apply_prerequisites(conn)
            await apply_voicemail_schema(conn)
            await conn.execute(
                """
                INSERT INTO customers (id, name, account_type, status) VALUES
                  (101, 'Acme Voicemail', 'rcf', 'active'),
                  (102, 'Beta Corp', 'trunk', 'active'),
                  (103, 'Closed Co', 'rcf', 'suspended');
                SELECT setval('customers_id_seq', 1000);
                INSERT INTO users (id, email, password_hash, customer_id, role, name) VALUES
                  (50, 'a-user@test', 'x', 101, 'user', 'A User'),
                  (51, 'a-ro@test', 'x', 101, 'readonly', 'A Readonly'),
                  (52, 'b-user@test', 'x', 102, 'user', 'B User');
                SELECT setval('users_id_seq', 1000);
                """)
        finally:
            await conn.close()
        db.pool = await asyncpg.create_pool(
            host=self.pg.sock, port=self.pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=8, statement_cache_size=0)

    async def _teardown(self) -> None:
        from db import database as db
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    @staticmethod
    def build_app():
        from fastapi import FastAPI
        from fastapi.responses import ORJSONResponse
        from middleware.auth import JWTAuthMiddleware
        from routers import customers, number_inventory, voicemail
        app = FastAPI(default_response_class=ORJSONResponse)
        app.add_middleware(JWTAuthMiddleware)
        app.include_router(voicemail.router, prefix="/v1/voicemail")
        app.include_router(voicemail.router, prefix="/voicemail")
        app.include_router(number_inventory.router, prefix="/v1/numbers")
        app.include_router(customers.router, prefix="/v1/customers")
        return app

    @staticmethod
    def _mint_tokens() -> dict[str, str]:
        from auth.security import create_access_token

        def mint(sub, role, customer_id):
            return create_access_token({"sub": str(sub), "email": f"{sub}@t", "role": role,
                                        "customer_id": customer_id})

        return {
            "admin": mint(1, "admin", None),
            "user_a": mint(50, "user", CUST_A),
            "ro_a": mint(51, "readonly", CUST_A),
            "user_b": mint(52, "user", CUST_B),
            "support": mint(53, "support", None),
        }

    def auth(self, who: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tokens[who]}"}

    # -- seeding helpers -------------------------------------------------------
    async def add_did(self, did: str, status: str = "available", city: str = "Boston",
                      state: str = "MA") -> None:
        conn = await self.owner()
        try:
            await conn.execute(
                "INSERT INTO did_inventory (did, status, city, state) "
                "VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar) "
                "ON CONFLICT (did) DO UPDATE SET status = EXCLUDED.status, customer_id = NULL, "
                "product_type = NULL, product_ref_id = NULL", did, status, city, state)
        finally:
            await conn.close()

    async def create_mailbox(self, customer_id: int, did: str, **extra) -> dict:
        await self.add_did(did)
        r = await self.client.post("/v1/voicemail/mailboxes", headers=self.auth("admin"),
                                   json={"customer_id": customer_id, "did": did, **extra})
        assert r.status_code == 201, r.text
        return r.json()

    async def fetchval(self, sql: str, *args):
        conn = await self.owner()
        try:
            return await conn.fetchval(sql, *args)
        finally:
            await conn.close()

    async def fetch(self, sql: str, *args):
        conn = await self.owner()
        try:
            return [dict(r) for r in await conn.fetch(sql, *args)]
        finally:
            await conn.close()

    async def execute(self, sql: str, *args):
        conn = await self.owner()
        try:
            return await conn.execute(sql, *args)
        finally:
            await conn.close()

    # -- deposit ----------------------------------------------------------------
    @staticmethod
    def meta(mailbox_id: int, msg_uuid: str | None = None, **overrides) -> dict:
        m = {"v": 1, "msg_uuid": msg_uuid or str(uuid.uuid4()), "mailbox_id": mailbox_id,
             "did": "+16175550000", "caller_id_number": "+15085551212",
             "caller_id_name": "Jane Caller", "duration_ms": 2000,
             "call_uuid": str(uuid.uuid4()), "fs_node": "east-fs-1", "zone": "east"}
        m.update(overrides)
        return m

    async def deposit(self, meta: dict | None = None, body: bytes | None = None, *,
                      raw_meta: str | None = None, secret: str | None = INGEST_SECRET,
                      content_type: str = "audio/wav", extra_headers: dict | None = None):
        from services.voicemail.meta import encode_meta
        headers = {"Content-Type": content_type}
        if secret is not None:
            headers["X-Ingest-Secret"] = secret
        if raw_meta is not None:
            headers["X-VM-Meta"] = raw_meta
        elif meta is not None:
            headers["X-VM-Meta"] = encode_meta(meta)
        headers.update(extra_headers or {})
        return await self.client.post("/v1/voicemail/fs/deposit", headers=headers,
                                      content=make_wav() if body is None else body)

    async def deposit_ok(self, mailbox_id: int, seconds: float = 2.0, **meta_overrides) -> int:
        r = await self.deposit(self.meta(mailbox_id, **meta_overrides),
                               body=make_wav(seconds))
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "stored"
        return r.json()["message_id"]

    # -- transcripts (v1.1) -----------------------------------------------------
    async def seed_transcript(self, message_id: int, status: str = "done", *,
                              text: str = "This is a test transcript.",
                              segments: tuple | None = None, confidence: float | None = 0.912,
                              language: str = "en-US", model: str | None = "telephony",
                              error_code: str | None = None, attempts: int = 0,
                              billed_ms: int | None = None,
                              plaintext: bytes | None = None) -> None:
        """Upsert the voicemail_transcripts row of a stored message the way the
        worker leaves it. ``done`` seals a real transcript document with the
        REAL ``seal_transcript`` (local KMS, AAD ``vmt:``) — or ``plaintext``
        verbatim (malformed-document tests); every other status carries no
        crypto (the table's CHECKs). ``processing`` gets a live lease. ``empty``
        defaults to the worker's all-silent shape: provider/model set,
        chunk_count = audio_ms = billed_ms = 0 (no API call)."""
        from services.voicemail import seal_transcript
        from services.voicemail.transcription import document
        msg = (await self.fetch("SELECT mailbox_id, customer_id, msg_uuid FROM voicemail_messages "
                                "WHERE id = $1", message_id))[0]
        crypto: tuple = (None, None, None, None)
        if status == "done":
            if plaintext is None:
                segs = segments if segments is not None else (
                    document.Segment(start_ms=300, end_ms=5120, text=text, confidence=0.94),)
                plaintext = document.encode(document.TranscriptDoc(
                    language=language, model=model or "telephony", text=text,
                    segments=tuple(segs)))
            blob = await seal_transcript(customer_id=msg["customer_id"],
                                         mailbox_id=msg["mailbox_id"],
                                         msg_uuid=msg["msg_uuid"], plaintext=plaintext)
            crypto = (blob.ciphertext, blob.wrapped_dek, blob.kek_version, blob.iv)
        finished = status in ("done", "empty")
        sent_ms, chunks = {"done": (4000, 1), "empty": (0, 0)}.get(status, (None, None))
        if billed_ms is None:
            billed_ms = sent_ms
        await self.execute(
            """
            INSERT INTO voicemail_transcripts AS t
                   (message_id, mailbox_id, customer_id, status, language, model, provider,
                    confidence, error_code, attempts, ciphertext, wrapped_dek, kek_version, iv,
                    lease_until, attempt_id, completed_at, audio_ms, billed_ms, chunk_count)
            VALUES ($1::bigint, $2::int, $3::int, $4::varchar, $5::varchar, $6::varchar,
                    CASE WHEN $6::varchar IS NULL THEN NULL ELSE 'fake' END,
                    $7::real, $8::varchar, $9::smallint, $10::bytea, $11::bytea, $12::text,
                    $13::bytea,
                    CASE WHEN $4::varchar = 'processing' THEN now() + interval '10 minutes' END,
                    CASE WHEN $4::varchar = 'processing' THEN gen_random_uuid() END,
                    CASE WHEN $14::boolean THEN now() END, $16::int, $15::int, $17::smallint)
            ON CONFLICT (message_id) DO UPDATE SET
                status = EXCLUDED.status, language = EXCLUDED.language, model = EXCLUDED.model,
                provider = EXCLUDED.provider, confidence = EXCLUDED.confidence,
                error_code = EXCLUDED.error_code, attempts = EXCLUDED.attempts,
                ciphertext = EXCLUDED.ciphertext, wrapped_dek = EXCLUDED.wrapped_dek,
                kek_version = EXCLUDED.kek_version, iv = EXCLUDED.iv,
                lease_until = EXCLUDED.lease_until, attempt_id = EXCLUDED.attempt_id,
                completed_at = EXCLUDED.completed_at, audio_ms = EXCLUDED.audio_ms,
                billed_ms = EXCLUDED.billed_ms, chunk_count = EXCLUDED.chunk_count,
                updated_at = now()
            """,
            message_id, msg["mailbox_id"], msg["customer_id"], status, language,
            model if finished else None, confidence if status == "done" else None, error_code,
            attempts, *crypto, finished, billed_ms, sent_ms, chunks)


def memory_store():
    from services.voicemail import get_object_store
    from services.voicemail.storage import MemoryObjectStore
    store = get_object_store()
    assert isinstance(store, MemoryObjectStore)
    return store
