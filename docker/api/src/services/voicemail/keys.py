"""Per-customer KEK bookkeeping — ``voicemail_customer_keys`` (migration 54).

Contract §2: one KEK per customer, created on first use and PERSISTED (fixes
build-plan defect 11). The persisted ``key_ref`` is authoritative for every
later wrap/unwrap (a config change cannot silently re-point a customer at
another key), and ``status='destroyed'`` (crypto-erase) refuses every later
seal or open for that customer — immediately, in every API worker.

Writes a ``key_create`` row to ``voicemail_access_log`` (source ``system``) in
the same transaction as the key row. ``crypto_erase`` auditing belongs to the
caller (the admin router), which also purges rows/objects.

DB errors are translated to VoicemailCryptoUnavailable (callers -> 503).
All SQL binds carry explicit ``::type`` casts (asyncpg + PgBouncer).
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncIterator

from db import database as db

from .config import load_config
from .errors import VoicemailCryptoUnavailable, VoicemailKeyDestroyed
from .kms import get_kms_provider

logger = logging.getLogger(__name__)

_KEY_COLUMNS = "customer_id, provider, key_ref, status, created_at, destroyed_at"


@dataclass(frozen=True)
class CustomerKey:
    """A ``voicemail_customer_keys`` row."""

    customer_id: int
    provider: str          # 'gcpkms' | 'local'
    key_ref: str           # gcpkms: projects/../cryptoKeys/vm-cust-<id>; local: 'local:<id>'
    status: str            # 'active' | 'destroyed'
    created_at: datetime | None = None
    destroyed_at: datetime | None = None

    @property
    def active(self) -> bool:
        return self.status == "active"


def _check_customer_id(customer_id: Any) -> int:
    if isinstance(customer_id, bool) or not isinstance(customer_id, int) or customer_id <= 0:
        raise ValueError("customer_id must be a positive int")
    return customer_id


def _db_error(exc: BaseException) -> bool:
    """True for errors that mean 'the database is unavailable / failed'."""
    try:
        import asyncpg
    except ImportError:  # pragma: no cover
        return isinstance(exc, (OSError, TimeoutError))
    return isinstance(exc, (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError))


@asynccontextmanager
async def _connection(conn: Any = None) -> AsyncIterator[Any]:
    if conn is not None:
        yield conn
        return
    pool = db.pool
    if pool is None:
        raise VoicemailCryptoUnavailable("database pool is not initialised")
    try:
        async with pool.acquire() as acquired:
            yield acquired
    except Exception as exc:
        if _db_error(exc):
            raise VoicemailCryptoUnavailable(f"database error: {type(exc).__name__}") from exc
        raise


async def _fetch_key(conn: Any, customer_id: int) -> CustomerKey | None:
    try:
        row = await conn.fetchrow(
            f"SELECT {_KEY_COLUMNS} FROM voicemail_customer_keys WHERE customer_id = $1::int",
            customer_id)
    except Exception as exc:
        if _db_error(exc):
            raise VoicemailCryptoUnavailable(f"database error: {type(exc).__name__}") from exc
        raise
    return CustomerKey(**dict(row)) if row else None


def _require_active(key: CustomerKey) -> CustomerKey:
    if key.status != "active":
        raise VoicemailKeyDestroyed(
            f"voicemail key for customer {key.customer_id} was crypto-erased")
    return key


async def get_customer_key(customer_id: int, *, conn: Any = None) -> CustomerKey | None:
    """The customer's key row (any status), or None if never created."""
    _check_customer_id(customer_id)
    async with _connection(conn) as c:
        return await _fetch_key(c, customer_id)


async def ensure_customer_key(customer_id: int, *, conn: Any = None) -> CustomerKey:
    """Return the customer's ACTIVE key row, creating the KMS key + row on
    first use. Idempotent and race-safe (KMS AlreadyExists is handled; the row
    INSERT is ON CONFLICT DO NOTHING followed by a re-read).

    Raises:
      VoicemailKeyDestroyed       the customer was crypto-erased (permanent)
      VoicemailCryptoUnavailable  KMS / DB / config unavailable (nothing persisted)
      LookupError                 no such customer (no KMS key is created)
      ValueError                  customer_id is not a positive int
    """
    _check_customer_id(customer_id)
    async with _connection(conn) as c:
        existing = await _fetch_key(c, customer_id)
        if existing is not None:
            return _require_active(existing)

        provider = get_kms_provider()  # the configured provider (gcpkms in production)
        try:
            customer_exists = await c.fetchval(
                "SELECT 1 FROM customers WHERE id = $1::int", customer_id)
        except Exception as exc:
            if _db_error(exc):
                raise VoicemailCryptoUnavailable(f"database error: {type(exc).__name__}") from exc
            raise
        if not customer_exists:
            raise LookupError(f"customer {customer_id} does not exist")

        key_ref = await provider.ensure_key(customer_id)

        try:
            async with c.transaction():
                row = await c.fetchrow(
                    "INSERT INTO voicemail_customer_keys (customer_id, provider, key_ref) "
                    "VALUES ($1::int, $2::varchar, $3::text) "
                    f"ON CONFLICT (customer_id) DO NOTHING RETURNING {_KEY_COLUMNS}",
                    customer_id, provider.name, key_ref)
                if row is not None:
                    await c.execute(
                        "INSERT INTO voicemail_access_log (customer_id, action, source, detail) "
                        "VALUES ($1::int, $2::varchar, $3::varchar, $4::jsonb)",
                        customer_id, "key_create", "system",
                        json.dumps({"provider": provider.name, "key_ref": key_ref}))
        except Exception as exc:
            if _db_error(exc):
                raise VoicemailCryptoUnavailable(f"database error: {type(exc).__name__}") from exc
            raise

        if row is not None:
            logger.info("voicemail: key row created for customer %s (%s)", customer_id, provider.name)
            return _require_active(CustomerKey(**dict(row)))
        # Lost a creation race — the winner's row is authoritative.
        raced = await _fetch_key(c, customer_id)
        if raced is None:  # pragma: no cover - would need a concurrent DELETE (RESTRICT FK)
            raise VoicemailCryptoUnavailable("voicemail key row vanished during creation")
        return _require_active(raced)


async def crypto_erase_customer(customer_id: int, *, conn: Any = None) -> dict:
    """Crypto-erase a customer: mark the key row destroyed FIRST (every API
    worker refuses new seals/opens at once), then destroy every usable KMS key
    version and clear the key's rotation schedule (warning-only).

    Idempotent and resumable: re-running after a partial failure re-lists and
    destroys whatever is still usable. Never deletes the key row.

    Returns ``{customer_id, provider, key_ref, status, already_destroyed,
    versions_destroyed}`` where ``status`` is ``'destroyed'`` or ``'no_key'``
    (the customer never had a key) and ``versions_destroyed`` lists the
    CryptoKeyVersion names this call scheduled for destruction (KMS keeps them
    DESTROY_SCHEDULED for 24 h — unusable for decrypt — then DESTROYED).

    Raises VoicemailCryptoUnavailable if the DB or KMS fails part-way; the row
    is then already 'destroyed' and the erase must be re-run to finish.
    """
    _check_customer_id(customer_id)
    cfg = load_config()
    async with _connection(conn) as c:
        key = await _fetch_key(c, customer_id)
        already = bool(key is not None and key.status == "destroyed")
        if key is not None and not already:
            try:
                await c.execute(
                    "UPDATE voicemail_customer_keys "
                    "SET status = 'destroyed', destroyed_at = COALESCE(destroyed_at, now()) "
                    "WHERE customer_id = $1::int",
                    customer_id)
            except Exception as exc:
                if _db_error(exc):
                    raise VoicemailCryptoUnavailable(
                        f"database error: {type(exc).__name__}") from exc
                raise

        provider_name = key.provider if key is not None else cfg.kms_provider
        versions: list[str] = []
        key_ref = key.key_ref if key is not None else None
        if provider_name == "gcpkms":
            provider = get_kms_provider("gcpkms")
            versions = await provider.destroy_key(customer_id=customer_id, key_ref=key_ref)
            if key is None and versions:
                # An orphan KMS key (created, row never persisted): record it
                # as destroyed so it can never be used again.
                key_ref = cfg.crypto_key_name(customer_id)
                try:
                    await c.execute(
                        "INSERT INTO voicemail_customer_keys "
                        "(customer_id, provider, key_ref, status, destroyed_at) "
                        "VALUES ($1::int, 'gcpkms', $2::text, 'destroyed', now()) "
                        "ON CONFLICT (customer_id) DO UPDATE "
                        "SET status = 'destroyed', "
                        "destroyed_at = COALESCE(voicemail_customer_keys.destroyed_at, now())",
                        customer_id, key_ref)
                except Exception as exc:
                    if _db_error(exc):
                        raise VoicemailCryptoUnavailable(
                            f"database error: {type(exc).__name__}") from exc
                    raise
        # provider 'local': the row status IS the erase (dev/CI only).

        found = key is not None or bool(versions)
        logger.warning("voicemail crypto-erase customer=%s provider=%s versions_destroyed=%d%s",
                       customer_id, provider_name, len(versions),
                       " (already destroyed)" if already else "")
        return {
            "customer_id": customer_id,
            "provider": provider_name if found else None,
            "key_ref": key_ref if found else None,
            "status": "destroyed" if found else "no_key",
            "already_destroyed": already,
            "versions_destroyed": versions,
        }
