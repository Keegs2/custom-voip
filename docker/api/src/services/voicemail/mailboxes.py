"""Voicemail mailbox lifecycle — shared by routers/voicemail.py and
routers/number_inventory.py (contract §4.1, §4.4, §4.8).

* :func:`create_mailbox` — claim an inventory DID for a customer's new
  mailbox. The customer's KMS key is ensured BEFORE the claim transaction
  (KMS down => 503 and NOTHING is committed); the DID claim, the mailbox row,
  ``customers.voicemail_enabled = true`` and the ``mailbox_create`` audit row
  then commit together or not at all.
* :func:`delete_mailbox` — mark the mailbox deleted + return the DID to the
  pool + delete its transcripts + audit (one transaction; FreeSWITCH sees
  "not ours" immediately), then purge its messages/greetings (object first,
  then row -> 'purged'). Whatever cannot be purged inline (GCS down, time
  budget) is finished by the retention worker's "deleted mailbox" arm — the
  delete itself never waits on GCS.
* :func:`erase_customer` — crypto-erase (destroy every KMS key version FIRST)
  then delete every mailbox, free the DIDs, delete every transcript,
  ``voicemail_enabled = false``, audit, and purge rows/objects best-effort
  (rest: retention worker).
* Transcription settings (v1.1, docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10.1):
  ``transcription_enabled`` (default off) / ``transcription_language`` on
  every Mailbox; turning it on needs ``transcription.config.available()``.
  Transcripts are deleted with their mailbox IMMEDIATELY (plan §9), even when
  the message purge itself is deferred.
* Purge helpers — object delete first, then the guarded row UPDATE; a
  'pending' row whose deposit lease is still live is never touched (the
  deposit that owns it is mid-upload).

Every SQL bind carries an explicit ``::type`` cast (asyncpg + PgBouncer).
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Iterable
from zoneinfo import available_timezones

import asyncpg
from fastapi import HTTPException

from db import database as db
from utils import phone

from . import audit
from .crypto import delete_object, greeting_object_key, message_object_key
from .errors import VoicemailCryptoUnavailable, VoicemailKeyDestroyed
from .keys import crypto_erase_customer, ensure_customer_key
from .transcription import config as tx_config

logger = logging.getLogger(__name__)

DEFAULT_LABEL = "Voicemail"
DEFAULT_TIMEZONE = "America/New_York"
MAX_LABEL_CHARS = 120
#: Inline purge budget for mailbox delete / crypto-erase (the retention
#: worker finishes anything left).
INLINE_PURGE_BUDGET_S = 20.0
PURGE_CONCURRENCY = 8

_E164_RE = re.compile(r"\+[1-9][0-9]{1,14}", re.ASCII)
_PIN_RE = re.compile(r"[0-9]{4,10}", re.ASCII)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# ---------------------------------------------------------------------------
# User-facing messages (shown verbatim by the UI — short sentences).
# ---------------------------------------------------------------------------
MSG_MAILBOX_NOT_FOUND = "Mailbox not found."
MSG_CUSTOMER_NOT_FOUND = "Customer not found."
MSG_CUSTOMER_INACTIVE = "That customer is not active."
MSG_NUMBER_UNAVAILABLE = "That number is not available."
MSG_NUMBER_IN_USE = "That number is already in use."
MSG_KEY_ERASED = ("Voicemail for this customer was permanently erased "
                  "and can't be turned back on.")
MSG_CRYPTO_DOWN = "Voicemail is temporarily unavailable. Try again in a few minutes."
MSG_BAD_LABEL = "Name must be 1 to 120 characters."
MSG_BAD_TIMEZONE = "Choose a valid time zone."
MSG_BAD_PIN = "PIN must be 4 to 10 digits."
MSG_BAD_NUMBER = "Enter a valid phone number."
MSG_TX_UNAVAILABLE = "Transcription isn't available yet."
MSG_TX_BAD_LANGUAGE = "Choose a supported language."
MSG_TX_ADMIN_ONLY = "Only an administrator can change transcription settings."


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _timezones() -> frozenset[str]:
    return frozenset(available_timezones())


def clean_label(value: str | None, *, default: str | None = DEFAULT_LABEL) -> str:
    if value is None:
        if default is None:
            raise HTTPException(status_code=422, detail=MSG_BAD_LABEL)
        return default
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=MSG_BAD_LABEL)
    cleaned = _CONTROL_RE.sub(" ", value).strip()
    if not cleaned or len(cleaned) > MAX_LABEL_CHARS:
        raise HTTPException(status_code=422, detail=MSG_BAD_LABEL)
    return cleaned


def clean_timezone(value: str | None) -> str:
    if value is None:
        return DEFAULT_TIMEZONE
    if not isinstance(value, str) or len(value) > 64 or value not in _timezones():
        raise HTTPException(status_code=422, detail=MSG_BAD_TIMEZONE)
    return value


def clean_pin(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _PIN_RE.fullmatch(value):
        raise HTTPException(status_code=422, detail=MSG_BAD_PIN)
    return value


def canonical_did(value: str) -> str:
    try:
        e164 = phone.normalize_e164(value)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=422, detail=MSG_BAD_NUMBER)
    if not _E164_RE.fullmatch(e164):
        raise HTTPException(status_code=422, detail=MSG_BAD_NUMBER)
    return e164


def clean_transcription_language(value: Any) -> str:
    """None -> the default (en-US); anything not in SUPPORTED_LANGUAGES -> 422."""
    if value is None:
        return tx_config.DEFAULT_LANGUAGE
    if not tx_config.is_supported_language(value):
        raise HTTPException(status_code=422, detail=MSG_TX_BAD_LANGUAGE)
    return value


def require_transcription_available() -> None:
    """409 unless the platform flag is on and the STT config is valid (never
    turn a mailbox on, or queue work, while nothing could process it)."""
    if not tx_config.available():
        raise HTTPException(status_code=409, detail=MSG_TX_UNAVAILABLE)


async def hash_pin(pin: str) -> str:
    """bcrypt off the event loop (~250 ms of CPU)."""
    from auth.security import hash_password
    return await asyncio.to_thread(hash_password, pin)


def crypto_http_error(exc: BaseException) -> HTTPException:
    if isinstance(exc, VoicemailKeyDestroyed):
        return HTTPException(status_code=409, detail=MSG_KEY_ERASED)
    return HTTPException(status_code=503, detail=MSG_CRYPTO_DOWN, headers={"Retry-After": "5"})


async def _pool():
    pool = db.pool or await db.get_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail=MSG_CRYPTO_DOWN)
    return pool


# ---------------------------------------------------------------------------
# Deploy-order guard (callers outside the voicemail router: number inventory,
# customer delete) — migration 54 may not be applied yet.
# ---------------------------------------------------------------------------
_schema_seen_at: float | None = None
_schema_missing_at: float | None = None
_SCHEMA_NEGATIVE_TTL_S = 30.0


async def voicemail_schema_present(conn: Any) -> bool:
    """True once migration 54's tables exist (positive result cached for the
    process lifetime, negative for 30 s)."""
    global _schema_seen_at, _schema_missing_at
    if _schema_seen_at is not None:
        return True
    now = time.monotonic()
    if _schema_missing_at is not None and now - _schema_missing_at < _SCHEMA_NEGATIVE_TTL_S:
        return False
    present = bool(await conn.fetchval(
        "SELECT to_regclass('public.voicemail_boxes') IS NOT NULL"))
    if present:
        _schema_seen_at = now
    else:
        _schema_missing_at = now
    return present


def reset_schema_cache() -> None:
    global _schema_seen_at, _schema_missing_at
    _schema_seen_at = _schema_missing_at = None


# ---------------------------------------------------------------------------
# Mailbox reads
# ---------------------------------------------------------------------------
MAILBOX_SELECT = """
SELECT b.id, b.customer_id, c.name AS customer_name, b.did, b.label, b.status,
       b.timezone, b.greeting_mode, b.active_greeting_id,
       (b.pin_hash IS NOT NULL) AS has_pin, b.retention_days,
       b.max_message_seconds, b.max_messages, b.max_bytes, b.created_at,
       b.transcription_enabled, b.transcription_language,
       c.voicemail_enabled,
       COALESCE(s.message_count, 0)::int    AS message_count,
       COALESCE(s.unread_count, 0)::int     AS unread_count,
       COALESCE(s.bytes_used, 0)::bigint    AS bytes_used
  FROM voicemail_boxes b
  JOIN customers c ON c.id = b.customer_id
  LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE m.deleted_at IS NULL)                  AS message_count,
               count(*) FILTER (WHERE m.deleted_at IS NULL AND NOT m.is_read) AS unread_count,
               sum(m.size_bytes)                                             AS bytes_used
          FROM voicemail_messages m
         WHERE m.mailbox_id = b.id AND m.status = 'stored'
  ) s ON true
"""

MAILBOX_ORDER = " ORDER BY c.name, b.label, b.id"

MAILBOX_FIELDS = ("id", "customer_id", "customer_name", "did", "label", "status", "timezone",
                  "greeting_mode", "active_greeting_id", "has_pin", "retention_days",
                  "max_message_seconds", "max_messages", "max_bytes", "message_count",
                  "unread_count", "bytes_used", "created_at",
                  "transcription_enabled", "transcription_language")


def mailbox_out(row: Any) -> dict:
    return {k: row[k] for k in MAILBOX_FIELDS}


def accepting_state(row: Any) -> tuple[bool, str | None]:
    """Contract §4.5: not accepting when inactive (status != active or
    voicemail disabled) or full (live messages >= max_messages, or stored
    bytes incl. trash >= max_bytes). Inactive wins over full."""
    if row["status"] != "active" or not row["voicemail_enabled"]:
        return False, "inactive"
    if row["message_count"] >= row["max_messages"] or row["bytes_used"] >= row["max_bytes"]:
        return False, "full"
    return True, None


async def fetch_mailbox(conn: Any, mailbox_id: int, *, customer_id: int | None = None,
                        require_enabled: bool = False) -> Any:
    """One live (status <> 'deleted') mailbox, optionally scoped to a customer
    (and to an entitled customer). None when not visible."""
    sql = MAILBOX_SELECT + " WHERE b.id = $1::int AND b.status <> 'deleted'"
    args: list[Any] = [mailbox_id]
    if customer_id is not None:
        sql += " AND b.customer_id = $2::int"
        args.append(customer_id)
    if require_enabled:
        sql += " AND c.voicemail_enabled"
    return await conn.fetchrow(sql, *args)


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------
async def _check_did_free(conn: Any, did: str, allowed_statuses: tuple[str, ...],
                          *, lock: bool) -> None:
    inv = await conn.fetchrow(
        "SELECT status FROM did_inventory WHERE did = $1::varchar"
        + (" FOR UPDATE" if lock else ""), did)
    if inv is None or inv["status"] not in allowed_statuses:
        raise HTTPException(status_code=409, detail=MSG_NUMBER_UNAVAILABLE)
    # Drift guard: inventory says free but a product table still routes it —
    # a second number_routing row for the DID would make routing ambiguous.
    if await conn.fetchval("SELECT 1 FROM number_routing WHERE did = $1::varchar LIMIT 1", did):
        raise HTTPException(status_code=409, detail=MSG_NUMBER_IN_USE)


async def create_mailbox(*, customer_id: int, did: str, label: str | None = None,
                         timezone: str | None = None, pin: str | None = None,
                         info: audit.RequestInfo | None = None, source: str = "admin",
                         notes: str | None = None,
                         allowed_statuses: tuple[str, ...] = ("available",),
                         require_active_customer: bool = True,
                         transcription_enabled: bool = False,
                         transcription_language: Any = None) -> int:
    """Create a mailbox on ``did`` for ``customer_id``; return its id.
    Transcription is off unless ``transcription_enabled`` (the number-inventory
    assign path keeps the defaults).

    Raises HTTPException: 422 (bad input), 404 (customer), 409 (DID not in
    ``allowed_statuses`` / already routed / customer inactive / key erased /
    transcription requested while unavailable), 503 (KMS or DB unavailable —
    nothing committed).
    """
    e164 = canonical_did(did)
    label_v = clean_label(label)
    tz_v = clean_timezone(timezone)
    pin_v = clean_pin(pin)
    tx_language = clean_transcription_language(transcription_language)
    tx_enabled = bool(transcription_enabled)
    if tx_enabled:
        require_transcription_available()
    pin_hash = await hash_pin(pin_v) if pin_v else None
    actor = info.actor_user_id if info else None
    pool = await _pool()

    async with pool.acquire() as conn:
        customer = await conn.fetchrow(
            "SELECT id, name, status FROM customers WHERE id = $1::int", customer_id)
        if customer is None:
            raise HTTPException(status_code=404, detail=MSG_CUSTOMER_NOT_FOUND)
        if require_active_customer and customer["status"] != "active":
            raise HTTPException(status_code=409, detail=MSG_CUSTOMER_INACTIVE)
        # Cheap pre-check so a bad request never creates a KMS key.
        await _check_did_free(conn, e164, allowed_statuses, lock=False)

    # KMS key BEFORE the claim: KMS down => 503 and nothing is committed. The
    # key row (if created) is harmless on its own — the next attempt reuses it.
    try:
        await ensure_customer_key(customer_id)
    except LookupError:
        raise HTTPException(status_code=404, detail=MSG_CUSTOMER_NOT_FOUND)
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail: mailbox create for customer %s refused — key unavailable: %s",
                     customer_id, exc)
        raise crypto_http_error(exc)

    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                await _check_did_free(conn, e164, allowed_statuses, lock=True)
                box_id = await conn.fetchval(
                    """
                    INSERT INTO voicemail_boxes (customer_id, did, label, timezone, pin_hash, created_by,
                                                 transcription_enabled, transcription_language)
                    VALUES ($1::int, $2::varchar, $3::varchar, $4::varchar, $5::varchar,
                            (SELECT id FROM users WHERE id = $6::int), $7::boolean, $8::varchar)
                    RETURNING id
                    """,
                    customer_id, e164, label_v, tz_v, pin_hash, actor, tx_enabled, tx_language)
                await conn.execute(
                    """
                    UPDATE did_inventory
                       SET customer_id = $1::int, product_type = 'voicemail',
                           product_ref_id = $2::int, status = 'assigned',
                           assigned_at = now(),
                           assigned_by = (SELECT id FROM users WHERE id = $3::int),
                           notes = COALESCE($4::text, notes), updated_at = now()
                     WHERE did = $5::varchar
                    """,
                    customer_id, box_id, actor, notes, e164)
                await conn.execute(
                    "UPDATE customers SET voicemail_enabled = true "
                    "WHERE id = $1::int AND NOT voicemail_enabled", customer_id)
                create_detail: dict[str, Any] = {"did": e164}
                if tx_enabled:  # the opt-in to the STT subprocessor is on record
                    create_detail.update(transcription_enabled=True,
                                         transcription_language=tx_language)
                await audit.write_audit(
                    conn, action="mailbox_create", source=source, customer_id=customer_id,
                    mailbox_id=box_id, info=info, detail=create_detail)
                if pin_hash:
                    await audit.write_audit(
                        conn, action="pin_set", source=source, customer_id=customer_id,
                        mailbox_id=box_id, info=info)
        except asyncpg.UniqueViolationError:
            raise HTTPException(status_code=409, detail=MSG_NUMBER_IN_USE)
        except asyncpg.CheckViolationError:
            raise HTTPException(status_code=422, detail=MSG_BAD_NUMBER)

    logger.info("voicemail: mailbox %s created on %s for customer %s by user %s",
                box_id, e164, customer_id, actor)
    return box_id


# ---------------------------------------------------------------------------
# Purge (object first, then row)
# ---------------------------------------------------------------------------
_LEASE_LIVE = ("(status = 'pending' AND deposit_lease_until IS NOT NULL "
               "AND deposit_lease_until > now())")

MESSAGE_PURGE_SQL = f"""
UPDATE voicemail_messages
   SET status = 'purged', purged_at = now(), object_key = NULL,
       ciphertext_crc32c = NULL, wrapped_dek = NULL, kek_version = NULL, iv = NULL,
       deposit_attempt_id = NULL, deposit_lease_until = NULL
 WHERE id = ANY($1::bigint[]) AND status <> 'purged' AND NOT {_LEASE_LIVE}
RETURNING id, mailbox_id, customer_id
"""

GREETING_PURGE_SQL = """
UPDATE voicemail_greetings
   SET status = 'purged', object_key = NULL, ciphertext_crc32c = NULL,
       wrapped_dek = NULL, kek_version = NULL, iv = NULL
 WHERE id = ANY($1::int[]) AND status <> 'purged'
RETURNING id, mailbox_id, customer_id
"""

#: Rows of a mailbox that still have (or may have) an object.
MESSAGE_LIVE_ROWS_SQL = f"""
SELECT id, msg_uuid, mailbox_id, customer_id, status FROM voicemail_messages
 WHERE mailbox_id = ANY($1::int[]) AND status <> 'purged' AND NOT {_LEASE_LIVE}
 ORDER BY id LIMIT $2::int
"""
GREETING_LIVE_ROWS_SQL = """
SELECT id, greeting_uuid, mailbox_id, customer_id, status FROM voicemail_greetings
 WHERE mailbox_id = ANY($1::int[]) AND status <> 'purged'
 ORDER BY id LIMIT $2::int
"""


def message_key_of(row: Any) -> str:
    return message_object_key(row["customer_id"], row["mailbox_id"], row["msg_uuid"])


def greeting_key_of(row: Any) -> str:
    return greeting_object_key(row["customer_id"], row["mailbox_id"], row["greeting_uuid"])


@dataclass
class DeleteResult:
    done: list[int]          # ids whose object is gone (deleted or never existed)
    failed: int              # deletes that failed or were not started (budget)
    store_down: bool         # at least one failure was VoicemailCryptoUnavailable


async def delete_objects(items: Iterable[tuple[int, str]], *,
                         budget_s: float | None = None) -> DeleteResult:
    """Delete ciphertext objects (idempotent). Bounded concurrency; once
    ``budget_s`` has elapsed no NEW delete is started."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget_s if budget_s is not None else None
    sem = asyncio.Semaphore(PURGE_CONCURRENCY)
    items = list(items)
    store_down = False

    async def one(obj_id: int, key: str) -> int | None:
        nonlocal store_down
        async with sem:
            if deadline is not None and loop.time() > deadline:
                return None
            try:
                await delete_object(key)
                return obj_id
            except VoicemailCryptoUnavailable as exc:
                store_down = True
                logger.warning("voicemail: object store unavailable for delete: %s", exc)
                return None
            except Exception as exc:  # noqa: BLE001 — reported, row left for the sweep
                logger.warning("voicemail: object delete failed (%s): %s",
                               type(exc).__name__, exc)
                return None

    results = await asyncio.gather(*(one(i, k) for i, k in items))
    done = [r for r in results if r is not None]
    return DeleteResult(done=done, failed=len(items) - len(done), store_down=store_down)


async def mark_purged(conn: Any, kind: str, ids: list[int]) -> list[Any]:
    sql = MESSAGE_PURGE_SQL if kind == "message" else GREETING_PURGE_SQL
    return list(await conn.fetch(sql, ids)) if ids else []


@dataclass
class PurgeResult:
    messages: int = 0
    greetings: int = 0
    deferred: int = 0
    purged_message_ids: list[int] = field(default_factory=list)
    purged_greeting_ids: list[int] = field(default_factory=list)


async def purge_mailbox_contents(mailbox_ids: list[int], *, reason: str, source: str = "admin",
                                 info: audit.RequestInfo | None = None,
                                 budget_s: float = INLINE_PURGE_BUDGET_S,
                                 batch: int = 200) -> PurgeResult:
    """Purge every message + greeting of ``mailbox_ids`` (object, then row),
    best effort within ``budget_s``. Leftovers stay for the retention worker.
    One ``message_purge`` / ``greeting_delete`` audit row per mailbox per batch."""
    result = PurgeResult()
    if not mailbox_ids:
        return result
    pool = await _pool()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget_s
    for kind in ("message", "greeting"):
        live_sql = MESSAGE_LIVE_ROWS_SQL if kind == "message" else GREETING_LIVE_ROWS_SQL
        key_of = message_key_of if kind == "message" else greeting_key_of
        seen: set[int] = set()
        while loop.time() < deadline:
            async with pool.acquire() as conn:
                rows = [r for r in await conn.fetch(live_sql, mailbox_ids, batch)
                        if r["id"] not in seen]
            if not rows:
                break
            seen.update(r["id"] for r in rows)
            deleted = await delete_objects(
                ((r["id"], key_of(r)) for r in rows),
                budget_s=max(0.0, deadline - loop.time()))
            gone, failed = deleted.done, deleted.failed
            if gone:
                async with pool.acquire() as conn:
                    async with conn.transaction():
                        updated = await mark_purged(conn, kind, gone)
                        await _audit_purged(conn, kind, updated, reason=reason,
                                            source=source, info=info)
                n = len(updated)
                if kind == "message":
                    result.messages += n
                    result.purged_message_ids += [r["id"] for r in updated]
                else:
                    result.greetings += n
                    result.purged_greeting_ids += [r["id"] for r in updated]
            if failed:
                break  # GCS trouble or budget spent: the retention worker finishes
    async with pool.acquire() as conn:
        result.deferred = int(await conn.fetchval(
            "SELECT (SELECT count(*) FROM voicemail_messages WHERE mailbox_id = ANY($1::int[]) "
            "        AND status <> 'purged') + "
            "       (SELECT count(*) FROM voicemail_greetings WHERE mailbox_id = ANY($1::int[]) "
            "        AND status <> 'purged')", mailbox_ids))
    return result


async def _purge_best_effort(mailbox_ids: list[int], *, reason: str, source: str,
                             info: audit.RequestInfo | None, budget_s: float) -> PurgeResult:
    """purge_mailbox_contents for callers whose main change is ALREADY
    committed (mailbox delete, crypto-erase): a purge failure (DB/audit
    trouble) is logged, never surfaced — the retention worker finishes it."""
    try:
        return await purge_mailbox_contents(mailbox_ids, reason=reason, source=source,
                                            info=info, budget_s=budget_s)
    except Exception as exc:  # noqa: BLE001
        logger.error("voicemail: inline purge of mailboxes %s failed (%s: %s) — left for the "
                     "retention worker", mailbox_ids, type(exc).__name__, exc)
        return PurgeResult(deferred=-1)


async def _audit_purged(conn: Any, kind: str, updated: list[Any], *, reason: str,
                        source: str, info: audit.RequestInfo | None) -> None:
    by_box: dict[tuple[int, int], list[int]] = {}
    for r in updated:
        by_box.setdefault((r["customer_id"], r["mailbox_id"]), []).append(r["id"])
    action = "message_purge" if kind == "message" else "greeting_delete"
    if reason == "retention":
        action = "retention_purge"
    for (cust, box), ids in by_box.items():
        await audit.write_audit(
            conn, action=action, source=source, customer_id=cust, mailbox_id=box, info=info,
            detail={"reason": reason, "kind": kind, "ids": ids})


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------
_FREE_DID_SQL = """
UPDATE did_inventory
   SET customer_id = NULL, product_type = NULL, product_ref_id = NULL,
       status = 'available', assigned_at = NULL, assigned_by = NULL,
       notes = $2::text, updated_at = now()
 WHERE did = ANY($1::varchar[]) AND product_type = 'voicemail'
"""

_MARK_DELETED_SQL = """
UPDATE voicemail_boxes
   SET status = 'deleted', deleted_at = now(), updated_at = now(),
       active_greeting_id = NULL, greeting_mode = 'standard'
"""

#: Plan §9: a deleted mailbox's transcripts go IMMEDIATELY (the message purge
#: may be deferred to the retention worker; the purge trigger would otherwise
#: only take them then). idx_vm_transcripts_mailbox, <= ~100 + trash rows.
_DELETE_TRANSCRIPTS_SQL = "DELETE FROM voicemail_transcripts WHERE mailbox_id = ANY($1::int[])"


async def delete_mailbox(mailbox_id: int, *, info: audit.RequestInfo | None = None,
                         source: str = "admin", notes: str | None = None,
                         purge_budget_s: float = INLINE_PURGE_BUDGET_S) -> dict:
    """Delete a live mailbox (404 if unknown/already deleted). Does NOT touch
    ``customers.voicemail_enabled`` (only crypto-erase clears it)."""
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            box = await conn.fetchrow(
                "SELECT id, customer_id, did, status FROM voicemail_boxes "
                "WHERE id = $1::int FOR UPDATE", mailbox_id)
            if box is None or box["status"] == "deleted":
                raise HTTPException(status_code=404, detail=MSG_MAILBOX_NOT_FOUND)
            await conn.execute(_MARK_DELETED_SQL + " WHERE id = $1::int", mailbox_id)
            await conn.execute(_FREE_DID_SQL, [box["did"]], notes)
            await conn.execute(_DELETE_TRANSCRIPTS_SQL, [mailbox_id])
            await audit.write_audit(
                conn, action="mailbox_delete", source=source, customer_id=box["customer_id"],
                mailbox_id=mailbox_id, info=info, detail={"did": box["did"]})

    purge = await _purge_best_effort([mailbox_id], reason="mailbox_delete", source=source,
                                     info=info, budget_s=purge_budget_s)
    logger.info("voicemail: mailbox %s (%s) deleted; purged %d messages / %d greetings, "
                "%d left for the retention worker", mailbox_id, box["did"], purge.messages,
                purge.greetings, purge.deferred)
    return {"mailbox_id": mailbox_id, "customer_id": box["customer_id"], "did": box["did"],
            "messages": purge.messages, "greetings": purge.greetings, "deferred": purge.deferred}


# ---------------------------------------------------------------------------
# Crypto-erase
# ---------------------------------------------------------------------------
async def erase_customer(customer_id: int, *, info: audit.RequestInfo | None = None,
                         purge_budget_s: float = INLINE_PURGE_BUDGET_S) -> dict:
    """Contract §4.4. The key is destroyed FIRST (irreversible; every worker
    refuses seal/open at once), then boxes/DIDs/flag + audit in one
    transaction, then a best-effort purge. Idempotent: re-running finishes a
    partial erase."""
    pool = await _pool()
    async with pool.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM customers WHERE id = $1::int", customer_id):
            raise HTTPException(status_code=404, detail=MSG_CUSTOMER_NOT_FOUND)

    try:
        key_result = await crypto_erase_customer(customer_id)
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail: crypto-erase of customer %s incomplete: %s", customer_id, exc)
        raise HTTPException(status_code=503, detail=MSG_CRYPTO_DOWN, headers={"Retry-After": "5"})

    async with pool.acquire() as conn:
        async with conn.transaction():
            boxes = await conn.fetch(
                _MARK_DELETED_SQL + " WHERE customer_id = $1::int AND status <> 'deleted' "
                "RETURNING id, did", customer_id)
            if boxes:
                await conn.execute(_FREE_DID_SQL, [b["did"] for b in boxes],
                                   "voicemail crypto-erased")
            await conn.execute(
                "UPDATE customers SET voicemail_enabled = false WHERE id = $1::int", customer_id)
            all_boxes = [r["id"] for r in await conn.fetch(
                "SELECT id FROM voicemail_boxes WHERE customer_id = $1::int", customer_id)]
            # The key is already destroyed (unreadable at once); the rows go too.
            await conn.execute(_DELETE_TRANSCRIPTS_SQL, all_boxes)
            await audit.write_audit(
                conn, action="crypto_erase", source="admin", customer_id=customer_id, info=info,
                detail={"key_status": key_result.get("status"),
                        "already_destroyed": key_result.get("already_destroyed"),
                        "versions_destroyed": len(key_result.get("versions_destroyed") or []),
                        "mailboxes": [b["id"] for b in boxes]})

    purge = await _purge_best_effort(all_boxes, reason="crypto_erase", source="admin",
                                     info=info, budget_s=purge_budget_s)
    logger.warning("voicemail: customer %s crypto-erased (key %s, %d versions destroyed); "
                   "%d mailboxes deleted, %d messages / %d greetings purged, %d deferred",
                   customer_id, key_result.get("status"),
                   len(key_result.get("versions_destroyed") or []), len(boxes),
                   purge.messages, purge.greetings, purge.deferred)
    return {"customer_id": customer_id, "mailboxes": len(boxes), "messages": purge.messages,
            "greetings": purge.greetings, "deferred": purge.deferred,
            "key_status": key_result.get("status"),
            "versions_destroyed": len(key_result.get("versions_destroyed") or [])}
