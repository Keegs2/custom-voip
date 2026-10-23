"""Encrypted voicemail product API (contract docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4, §5).

Mounted at ``/v1/voicemail`` and ``/voicemail`` (main.py). The UI calls
``/api/v1/voicemail/...`` (nginx strips ``/api``).

Scope rule (§4):
  * admin   — ``customer_id`` query param picks the customer (required on
              create; optional on list = all customers). Per-id routes are
              unscoped.
  * user    — scoped to the JWT ``customer_id``; another customer's
              ``customer_id`` param or object => 404 (no existence leak). A
              customer with voicemail disabled sees no mailboxes ([] / 404).
  * readonly — the same reads + playback tokens; every mutation => 403.
  * support — 403 everywhere (no customer).
FreeSWITCH-facing routes (``/fs/*``) are JWT-exempt (middleware) and depend on
``require_ingest_secret``; ``GET/HEAD .../audio`` are JWT-exempt and verify
the ``?t=`` playback token.

Business logic lives in ``services/voicemail/`` (mailboxes, deposit,
greetings, audio, retention, transcripts); this module is the HTTP surface +
scoping. User-facing 4xx ``detail`` strings are short sentences (the UI shows
them).

Transcription v1.1 (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10; owner decision
O2 overrides its writer rule): every Message carries ``transcript`` {status,
confidence} (LEFT JOIN, nothing decrypted); the transcript and snippet reads
use the normal scope (readonly included) and answer ``Cache-Control:
no-store``; ONLY an admin may change ``transcription_enabled`` /
``transcription_language`` (PATCH, 403 for everyone else — other PATCH fields
keep the writer rule), backfill a mailbox, force a re-run, or use the ops
status / requeue routes. A plain retry stays a writer action.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Literal, Optional

import asyncpg
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

from auth.dependencies import get_current_user
from auth.ingest import require_ingest_secret
from auth.playback import (
    PLAYBACK_TTL_SECONDS,
    PlaybackNotConfigured,
    PlaybackTokenError,
    mint_playback_token,
    verify_playback_token,
)
from db import database as db
from services.voicemail import audio as vm_audio
from services.voicemail import audit as vm_audit
from services.voicemail import deposit as vm_deposit
from services.voicemail import greetings as vm_greetings
from services.voicemail import mailboxes as mbx
from services.voicemail import transcripts as vmt
from services.voicemail.errors import (
    VoicemailCryptoUnavailable,
    VoicemailIntegrityError,
)
from services.voicemail.transcription import config as tx_config

logger = logging.getLogger(__name__)

router = APIRouter()

INT32_MAX = 2_147_483_647
INT64_MAX = 9_223_372_036_854_775_807
URL_PREFIX = "/api/v1/voicemail"

MSG_NOT_FOUND = "Not found."
MSG_MESSAGE_NOT_FOUND = "Message not found."
MSG_GREETING_NOT_FOUND = "Greeting not found."
MSG_READONLY = "Read-only accounts can't change voicemail."
MSG_ADMIN_ONLY = "Only an administrator can do that."
MSG_SUPPORT = "Voicemail is not available to support accounts."
MSG_NO_CUSTOMER = "Your account is not linked to a customer."
MSG_GREETING_UNUSABLE = "That greeting can't be used for this mailbox."
MSG_NEED_GREETING = "Upload or choose a greeting before switching to a custom greeting."
MSG_TENANT_STATUS = "Only an administrator can suspend or resume a mailbox."
MSG_BAD_FOLDER = "Folder must be inbox, saved or trash."
MSG_CONFIRM = "Type ERASE {customer_id} to confirm."
MSG_AUDIO_UNAVAILABLE = "Audio is temporarily unavailable. Try again in a few minutes."
MSG_AUDIO_DAMAGED = "This recording could not be verified and was not played."


# ===========================================================================
# Scope
# ===========================================================================
@dataclass(frozen=True)
class VmScope:
    role: str
    user_id: int | None
    customer_id: int | None  # the tenant's own customer; None for admin

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def info(self, request: Request) -> vm_audit.RequestInfo:
        return vm_audit.RequestInfo.from_request(request, self.user_id)

    @property
    def source(self) -> str:
        return "admin" if self.is_admin else "ui"


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) < 12:
        return int(value)
    return None


async def vm_scope(request: Request) -> VmScope:
    user = await get_current_user(request)
    role = user.get("role")
    user_id = _int_or_none(user.get("sub"))
    if role == "admin":
        return VmScope("admin", user_id, None)
    if role == "support":
        raise HTTPException(status_code=403, detail=MSG_SUPPORT)
    if role in ("user", "readonly"):
        cid = _int_or_none(user.get("customer_id"))
        if cid is None or cid <= 0:
            raise HTTPException(status_code=403, detail=MSG_NO_CUSTOMER)
        return VmScope(role, user_id, cid)
    raise HTTPException(status_code=403, detail="Not allowed.")


async def vm_writer(scope: VmScope = Depends(vm_scope)) -> VmScope:
    if scope.role == "readonly":
        raise HTTPException(status_code=403, detail=MSG_READONLY)
    return scope


async def vm_admin(scope: VmScope = Depends(vm_scope)) -> VmScope:
    if not scope.is_admin:
        raise HTTPException(status_code=403, detail=MSG_ADMIN_ONLY)
    return scope


def _list_customer(scope: VmScope, customer_id: int | None) -> int | None:
    """Admin: the param (None = all). Tenant: own id; another id => 404."""
    if scope.is_admin:
        return customer_id
    if customer_id is not None and customer_id != scope.customer_id:
        raise HTTPException(status_code=404, detail=MSG_NOT_FOUND)
    return scope.customer_id


def _id32(value: int, detail: str) -> int:
    if not 1 <= value <= INT32_MAX:
        raise HTTPException(status_code=404, detail=detail)
    return value


def _id64(value: int, detail: str) -> int:
    if not 1 <= value <= INT64_MAX:
        raise HTTPException(status_code=404, detail=detail)
    return value


async def _pool():
    pool = db.pool or await db.get_pool()
    if pool is None:
        raise HTTPException(status_code=503, detail=mbx.MSG_CRYPTO_DOWN)
    return pool


async def _scoped_box(conn: Any, scope: VmScope, mailbox_id: int) -> Any:
    _id32(mailbox_id, mbx.MSG_MAILBOX_NOT_FOUND)
    row = await mbx.fetch_mailbox(conn, mailbox_id, customer_id=scope.customer_id,
                                  require_enabled=not scope.is_admin)
    if row is None:
        raise HTTPException(status_code=404, detail=mbx.MSG_MAILBOX_NOT_FOUND)
    return row


# ===========================================================================
# Messages: shared SQL / shapes
# ===========================================================================
MESSAGE_FIELDS = ("id", "mailbox_id", "caller_id_number", "caller_id_name", "duration_ms",
                  "size_bytes", "is_read", "is_saved", "deleted_at", "created_at", "expires_at")
_MESSAGE_COLS = ", ".join(f"m.{f}" for f in MESSAGE_FIELDS)

_FOLDERS = {
    "inbox": "m.deleted_at IS NULL AND NOT m.is_saved",
    "saved": "m.deleted_at IS NULL AND m.is_saved",
    "trash": "m.deleted_at IS NOT NULL",
}


def message_out(row: Any, *, transcription_enabled: bool | None = None) -> dict:
    """A Message (contract §4.2) + its ``transcript`` summary (plan §10.1).
    ``row`` carries the SUMMARY_COLUMNS of the LEFT JOIN; the mailbox's
    ``transcription_enabled`` (for a message with no transcript row yet)
    comes from the row or, for a list, the already-scoped mailbox."""
    out = {k: row[k] for k in MESSAGE_FIELDS}
    enabled = row["transcription_enabled"] if transcription_enabled is None \
        else transcription_enabled
    out["transcript"] = vmt.summary(row["transcript_status"], row["transcript_confidence"],
                                    enabled)
    return out


async def _scoped_message(conn: Any, scope: VmScope, message_id: int, *,
                          for_update: bool = False) -> Any:
    _id64(message_id, MSG_MESSAGE_NOT_FOUND)
    sql = (f"SELECT {_MESSAGE_COLS}, m.customer_id, m.msg_uuid, b.timezone, "
           f"       b.transcription_enabled, b.transcription_language, {vmt.SUMMARY_COLUMNS} "
           "FROM voicemail_messages m "
           "JOIN voicemail_boxes b ON b.id = m.mailbox_id "
           "JOIN customers c ON c.id = b.customer_id"
           f"{vmt.SUMMARY_JOIN}"
           "WHERE m.id = $1::bigint AND m.status = 'stored' AND b.status <> 'deleted'")
    args: list[Any] = [message_id]
    if not scope.is_admin:
        sql += " AND m.customer_id = $2::int AND c.voicemail_enabled"
        args.append(scope.customer_id)
    if for_update:
        sql += " FOR UPDATE OF m"
    row = await conn.fetchrow(sql, *args)
    if row is None:
        raise HTTPException(status_code=404, detail=MSG_MESSAGE_NOT_FOUND)
    return row


async def _scoped_greeting(conn: Any, scope: VmScope, greeting_id: int) -> Any:
    _id32(greeting_id, MSG_GREETING_NOT_FOUND)
    sql = ("SELECT g.id, g.mailbox_id, g.customer_id, g.greeting_uuid, "
           "       (b.active_greeting_id IS NOT DISTINCT FROM g.id) AS is_active "
           "  FROM voicemail_greetings g "
           "  JOIN voicemail_boxes b ON b.id = g.mailbox_id "
           "  JOIN customers c ON c.id = b.customer_id "
           " WHERE g.id = $1::int AND g.status = 'stored' AND b.status <> 'deleted'")
    args: list[Any] = [greeting_id]
    if not scope.is_admin:
        sql += " AND g.customer_id = $2::int AND c.voicemail_enabled"
        args.append(scope.customer_id)
    row = await conn.fetchrow(sql, *args)
    if row is None:
        raise HTTPException(status_code=404, detail=MSG_GREETING_NOT_FOUND)
    return row


# ===========================================================================
# 4.1 Summary + mailboxes
# ===========================================================================
@router.get("/summary")
async def summary(customer_id: Optional[int] = Query(None),
                  scope: VmScope = Depends(vm_scope)):
    cid = _list_customer(scope, customer_id)
    # Platform-level (flag on AND STT config valid) — the same for every caller.
    tx = {"transcription_available": tx_config.available()}
    pool = await _pool()
    async with pool.acquire() as conn:
        if cid is None:  # admin, all customers
            row = await conn.fetchrow(
                "SELECT (SELECT count(*) FROM voicemail_boxes WHERE status <> 'deleted')::int "
                "         AS mailbox_count, "
                "       (SELECT count(*) FROM voicemail_messages m "
                "          JOIN voicemail_boxes b ON b.id = m.mailbox_id "
                "         WHERE m.status = 'stored' AND m.deleted_at IS NULL AND NOT m.is_read "
                "           AND b.status <> 'deleted')::int AS unread_count")
            return {"enabled": True, "mailbox_count": row["mailbox_count"],
                    "unread_count": row["unread_count"], "can_manage": True, **tx}
        row = await conn.fetchrow(
            "SELECT c.voicemail_enabled, "
            "       (SELECT count(*) FROM voicemail_boxes b "
            "         WHERE b.customer_id = c.id AND b.status <> 'deleted')::int AS mailbox_count, "
            "       (SELECT count(*) FROM voicemail_boxes b "
            "          JOIN voicemail_messages m ON m.mailbox_id = b.id AND m.status = 'stored' "
            "         WHERE b.customer_id = c.id AND b.status <> 'deleted' "
            "           AND m.deleted_at IS NULL AND NOT m.is_read)::int AS unread_count "
            "  FROM customers c WHERE c.id = $1::int", cid)
    if row is None:
        if scope.is_admin:
            raise HTTPException(status_code=404, detail=mbx.MSG_CUSTOMER_NOT_FOUND)
        return {"enabled": False, "mailbox_count": 0, "unread_count": 0, "can_manage": False,
                **tx}
    enabled = bool(row["voicemail_enabled"])
    if not scope.is_admin and not enabled:
        return {"enabled": False, "mailbox_count": 0, "unread_count": 0, "can_manage": False,
                **tx}
    return {"enabled": enabled, "mailbox_count": row["mailbox_count"],
            "unread_count": row["unread_count"], "can_manage": scope.is_admin, **tx}


@router.get("/mailboxes")
async def list_mailboxes(customer_id: Optional[int] = Query(None),
                         scope: VmScope = Depends(vm_scope)):
    cid = _list_customer(scope, customer_id)
    sql = mbx.MAILBOX_SELECT + " WHERE b.status <> 'deleted'"
    args: list[Any] = []
    if cid is not None:
        sql += " AND b.customer_id = $1::int"
        args.append(cid)
    if not scope.is_admin:
        sql += " AND c.voicemail_enabled"
    pool = await _pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql + mbx.MAILBOX_ORDER, *args)
    return [mbx.mailbox_out(r) for r in rows]


class MailboxCreate(BaseModel):
    customer_id: int
    did: str
    label: Optional[str] = None
    timezone: Optional[str] = None
    pin: Optional[str] = None
    transcription_enabled: Optional[bool] = None   # default off (owner decision O1)
    transcription_language: Any = None             # validated: 422 sentence, not pydantic's


@router.post("/mailboxes", status_code=201)
async def create_mailbox(body: MailboxCreate, request: Request,
                         scope: VmScope = Depends(vm_admin)):
    box_id = await mbx.create_mailbox(
        customer_id=body.customer_id, did=body.did, label=body.label, timezone=body.timezone,
        pin=body.pin, info=scope.info(request), source="admin",
        transcription_enabled=bool(body.transcription_enabled),
        transcription_language=body.transcription_language)
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await mbx.fetch_mailbox(conn, box_id)
    return mbx.mailbox_out(row)


@router.get("/mailboxes/{mailbox_id}")
async def get_mailbox(mailbox_id: int, scope: VmScope = Depends(vm_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        return mbx.mailbox_out(await _scoped_box(conn, scope, mailbox_id))


class MailboxPatch(BaseModel):
    label: Optional[str] = None
    timezone: Optional[str] = None
    greeting_mode: Optional[Literal["standard", "custom"]] = None
    active_greeting_id: Optional[int] = None
    status: Optional[Literal["active", "suspended"]] = None
    transcription_enabled: Optional[bool] = None   # ADMIN only (owner decision O2)
    transcription_language: Any = None             # ADMIN only; "en-US" | "es-US" | "fr-CA"


@router.patch("/mailboxes/{mailbox_id}")
async def update_mailbox(mailbox_id: int, body: MailboxPatch, request: Request,
                         scope: VmScope = Depends(vm_writer)):
    fields = body.model_fields_set
    if "status" in fields and body.status is not None and not scope.is_admin:
        raise HTTPException(status_code=403, detail=MSG_TENANT_STATUS)
    # O2: present with a value -> admin only (even if it equals the current one).
    tx_fields = {f for f in ("transcription_enabled", "transcription_language")
                 if f in fields and getattr(body, f) is not None}
    if tx_fields and not scope.is_admin:
        raise HTTPException(status_code=403, detail=mbx.MSG_TX_ADMIN_ONLY)
    tx_language = (mbx.clean_transcription_language(body.transcription_language)
                   if "transcription_language" in tx_fields else None)
    sets: list[str] = []
    args: list[Any] = []

    def add(column: str, cast: str, value: Any) -> None:
        args.append(value)
        sets.append(f"{column} = ${len(args) + 1}::{cast}")

    if "label" in fields and body.label is not None:
        add("label", "varchar", mbx.clean_label(body.label, default=None))
    if "timezone" in fields and body.timezone is not None:
        add("timezone", "varchar", mbx.clean_timezone(body.timezone))
    if "status" in fields and body.status is not None:
        add("status", "varchar", body.status)

    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            box = await _scoped_box(conn, scope, mailbox_id)
            await conn.execute("SELECT 1 FROM voicemail_boxes WHERE id = $1::int FOR UPDATE",
                               mailbox_id)
            current = await conn.fetchrow(
                "SELECT greeting_mode, active_greeting_id, transcription_enabled "
                "FROM voicemail_boxes WHERE id = $1::int", mailbox_id)
            if "transcription_enabled" in tx_fields:
                # Turning it ON needs the platform; re-asserting the current
                # value (e.g. a language change while paused) does not.
                if body.transcription_enabled and not current["transcription_enabled"]:
                    mbx.require_transcription_available()
                add("transcription_enabled", "boolean", body.transcription_enabled)
            if tx_language is not None:
                add("transcription_language", "varchar", tx_language)
            new_active = current["active_greeting_id"]
            if "active_greeting_id" in fields:
                new_active = body.active_greeting_id
                if new_active is not None:
                    ok = await conn.fetchval(
                        "SELECT 1 FROM voicemail_greetings WHERE id = $1::int "
                        "AND mailbox_id = $2::int AND status = 'stored'",
                        _int_in_range(new_active), mailbox_id)
                    if not ok:
                        raise HTTPException(status_code=422, detail=MSG_GREETING_UNUSABLE)
                add("active_greeting_id", "int", new_active)
            new_mode = current["greeting_mode"]
            if "greeting_mode" in fields and body.greeting_mode is not None:
                new_mode = body.greeting_mode
                add("greeting_mode", "varchar", new_mode)
            if new_mode == "custom" and ("greeting_mode" in fields
                                         or "active_greeting_id" in fields):
                usable = new_active is not None and await conn.fetchval(
                    "SELECT 1 FROM voicemail_greetings WHERE id = $1::int "
                    "AND mailbox_id = $2::int AND status = 'stored'", new_active, mailbox_id)
                if not usable:
                    raise HTTPException(status_code=422, detail=MSG_NEED_GREETING)
            if sets:
                try:
                    await conn.execute(
                        f"UPDATE voicemail_boxes SET {', '.join(sets)}, updated_at = now() "
                        "WHERE id = $1::int", mailbox_id, *args)
                except asyncpg.ForeignKeyViolationError:
                    raise HTTPException(status_code=422, detail=MSG_GREETING_UNUSABLE)
                except asyncpg.CheckViolationError:
                    raise HTTPException(status_code=422, detail="That change is not allowed.")
                if body.transcription_enabled is False and "transcription_enabled" in tx_fields:
                    await vmt.disable_pending(conn, mailbox_id)  # plan §9, same transaction
                changed = sorted(f for f in fields if getattr(body, f) is not None
                                 or f == "active_greeting_id")
                detail: dict[str, Any] = {"fields": changed}
                if "status" in changed:
                    detail["status"] = body.status
                # The STT opt-in/out is on record (values only, never content).
                if "transcription_enabled" in tx_fields:
                    detail["transcription_enabled"] = body.transcription_enabled
                if tx_language is not None:
                    detail["transcription_language"] = tx_language
                await vm_audit.write_audit(
                    conn, action="mailbox_update", source=scope.source,
                    customer_id=box["customer_id"], mailbox_id=mailbox_id,
                    info=scope.info(request), detail=detail)
        row = await mbx.fetch_mailbox(conn, mailbox_id)
    return mbx.mailbox_out(row)


def _int_in_range(value: int) -> int:
    if not 1 <= value <= INT32_MAX:
        raise HTTPException(status_code=422, detail=MSG_GREETING_UNUSABLE)
    return value


class PinBody(BaseModel):
    pin: Any = None


@router.put("/mailboxes/{mailbox_id}/pin", status_code=204)
async def set_pin(mailbox_id: int, body: PinBody, request: Request,
                  scope: VmScope = Depends(vm_writer)):
    pin = mbx.clean_pin(body.pin if isinstance(body.pin, str) else "x")
    pin_hash = await mbx.hash_pin(pin)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            box = await _scoped_box(conn, scope, mailbox_id)
            await conn.execute(
                "UPDATE voicemail_boxes SET pin_hash = $2::varchar, pin_failed_count = 0, "
                "pin_locked_until = NULL, updated_at = now() WHERE id = $1::int",
                mailbox_id, pin_hash)
            await vm_audit.write_audit(
                conn, action="pin_set", source=scope.source, customer_id=box["customer_id"],
                mailbox_id=mailbox_id, info=scope.info(request))
    return Response(status_code=204)


@router.delete("/mailboxes/{mailbox_id}", status_code=204)
async def delete_mailbox(mailbox_id: int, request: Request, scope: VmScope = Depends(vm_admin)):
    _id32(mailbox_id, mbx.MSG_MAILBOX_NOT_FOUND)
    await mbx.delete_mailbox(mailbox_id, info=scope.info(request), source="admin")
    return Response(status_code=204)


@router.get("/available-numbers")
async def available_numbers(q: Optional[str] = Query(None, max_length=32),
                            limit: int = Query(50, ge=1, le=50),
                            scope: VmScope = Depends(vm_admin)):
    digits = "".join(ch for ch in (q or "") if ch.isascii() and ch.isdigit())
    pool = await _pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT d.did, d.city, d.state FROM did_inventory d "
            " WHERE d.status = 'available' "
            "   AND ($1::text = '' OR d.did LIKE '%' || $1::text || '%') "
            "   AND NOT EXISTS (SELECT 1 FROM number_routing nr WHERE nr.did = d.did) "
            " ORDER BY d.did LIMIT $2::int", digits, limit)
    return [{"did": r["did"], "city": r["city"], "state": r["state"]} for r in rows]


# ===========================================================================
# 4.2 Messages
# ===========================================================================
@router.get("/mailboxes/{mailbox_id}/messages")
async def list_messages(mailbox_id: int, folder: str = Query("inbox"),
                        limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                        scope: VmScope = Depends(vm_scope)):
    pred = _FOLDERS.get(folder)
    if pred is None:
        raise HTTPException(status_code=422, detail=MSG_BAD_FOLDER)
    pool = await _pool()
    async with pool.acquire() as conn:
        box = await _scoped_box(conn, scope, mailbox_id)
        where = f"m.mailbox_id = $1::int AND m.status = 'stored' AND {pred}"
        # ONE query: the transcript summary is a LEFT JOIN PK probe per row —
        # nothing is decrypted, KMS is never touched (plan §10.1).
        rows = await conn.fetch(
            f"SELECT {_MESSAGE_COLS}, {vmt.SUMMARY_COLUMNS} "
            f"FROM voicemail_messages m{vmt.SUMMARY_JOIN}WHERE {where} "
            "ORDER BY m.created_at DESC, m.id DESC LIMIT $2::int OFFSET $3::bigint",
            mailbox_id, limit, offset)
        counts = await conn.fetchrow(
            "SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT m.is_read)::int AS unread "
            f"FROM voicemail_messages m WHERE {where}", mailbox_id)
    enabled = bool(box["transcription_enabled"])
    return {"items": [message_out(r, transcription_enabled=enabled) for r in rows],
            "total": counts["total"], "unread": counts["unread"]}


class MessagePatch(BaseModel):
    is_read: Optional[bool] = None
    is_saved: Optional[bool] = None


@router.patch("/messages/{message_id}")
async def update_message(message_id: int, body: MessagePatch,
                         scope: VmScope = Depends(vm_writer)):
    sets, args = [], []
    for col in ("is_read", "is_saved"):
        value = getattr(body, col)
        if value is not None:
            args.append(value)
            sets.append(f"{col} = ${len(args) + 1}::boolean")
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _scoped_message(conn, scope, message_id, for_update=True)
            if sets:
                await conn.execute(
                    f"UPDATE voicemail_messages SET {', '.join(sets)} WHERE id = $1::bigint",
                    message_id, *args)
            row = await _scoped_message(conn, scope, message_id)
    return message_out(row)


@router.delete("/messages/{message_id}")
async def trash_message(message_id: int, request: Request, scope: VmScope = Depends(vm_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await _scoped_message(conn, scope, message_id, for_update=True)
            if row["deleted_at"] is None:
                await conn.execute(
                    "UPDATE voicemail_messages SET deleted_at = now() WHERE id = $1::bigint",
                    message_id)
                await vm_audit.write_audit(
                    conn, action="message_delete", source=scope.source,
                    customer_id=row["customer_id"], mailbox_id=row["mailbox_id"],
                    message_id=message_id, info=scope.info(request))
            row = await _scoped_message(conn, scope, message_id)
    return message_out(row)


@router.post("/messages/{message_id}/restore")
async def restore_message(message_id: int, scope: VmScope = Depends(vm_writer)):
    """Clears deleted_at only — is_saved is NOT changed (contract §4.2)."""
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _scoped_message(conn, scope, message_id, for_update=True)
            await conn.execute(
                "UPDATE voicemail_messages SET deleted_at = NULL WHERE id = $1::bigint",
                message_id)
            row = await _scoped_message(conn, scope, message_id)
    return message_out(row)


@router.delete("/messages/{message_id}/purge", status_code=204)
async def purge_message(message_id: int, request: Request, scope: VmScope = Depends(vm_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await _scoped_message(conn, scope, message_id)
    try:
        await mbx.delete_object(mbx.message_key_of(row))
    except VoicemailCryptoUnavailable:
        raise HTTPException(status_code=503, detail=mbx.MSG_CRYPTO_DOWN,
                            headers={"Retry-After": "5"})
    async with pool.acquire() as conn:
        async with conn.transaction():
            updated = await mbx.mark_purged(conn, "message", [message_id])
            if updated:
                await vm_audit.write_audit(
                    conn, action="message_purge", source=scope.source,
                    customer_id=row["customer_id"], mailbox_id=row["mailbox_id"],
                    message_id=message_id, info=scope.info(request),
                    detail={"reason": "user"})
    vm_audio.evict_object("message", message_id)
    return Response(status_code=204)


class PlaybackRequest(BaseModel):
    download: bool = False


def _playback_url(kind: str, obj_id: int, token: str) -> str:
    return f"{URL_PREFIX}/{kind}s/{obj_id}/audio?t={token}"


def _mint(kind: str, obj_id: int, customer_id: int, scope: VmScope, download: bool) -> str:
    try:
        return mint_playback_token(kind, obj_id, customer_id,
                                   scope.user_id if scope.user_id is not None else "unknown",
                                   download=download)
    except PlaybackNotConfigured:
        logger.error("voicemail playback: VOICEMAIL_PLAYBACK_SECRET is not usable — 503")
        raise HTTPException(status_code=503, detail=MSG_AUDIO_UNAVAILABLE)


@router.post("/messages/{message_id}/playback-token")
async def message_playback_token(message_id: int,
                                 body: Optional[PlaybackRequest] = Body(None),
                                 scope: VmScope = Depends(vm_scope)):
    download = bool(body.download) if body is not None else False
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await _scoped_message(conn, scope, message_id)
        token = _mint("message", message_id, row["customer_id"], scope, download)
        if not row["is_read"]:
            await conn.execute(
                "UPDATE voicemail_messages SET is_read = true "
                "WHERE id = $1::bigint AND NOT is_read", message_id)
    return {"url": _playback_url("message", message_id, token),
            "expires_in": PLAYBACK_TTL_SECONDS}


def _verify(kind: str, obj_id: int, token: Optional[str]) -> dict:
    try:
        return verify_playback_token(token or "", kind, obj_id)
    except PlaybackTokenError:
        raise HTTPException(status_code=401, detail="Playback link expired or invalid.")
    except PlaybackNotConfigured:
        raise HTTPException(status_code=503, detail=MSG_AUDIO_UNAVAILABLE)


def _remaining_ttl(claims: dict) -> float:
    return max(0.0, float(claims["exp"]) - time.time())


async def _serve_audio(request: Request, *, kind: str, row: Any, claims: dict,
                       decrypt, audit_action: str, filename_caller: str | None,
                       audit_ids: dict) -> Response:
    disposition = vm_audio.disposition_for(
        download=bool(claims.get("dl")), created_at=row["created_at"],
        timezone=row["timezone"], caller=filename_caller,
        prefix="voicemail" if kind == "message" else "greeting")
    range_header = request.headers.get("range")
    if request.method == "HEAD":
        return vm_audio.audio_response(None, size=row["size_bytes"], range_header=range_header,
                                       disposition=disposition, head=True)
    info = vm_audit.RequestInfo.from_request(request, _int_or_none(claims.get("sub")))
    pool = await _pool()

    async def loader() -> bytes:
        data = await decrypt(row)
        async with pool.acquire() as conn:
            await vm_audit.write_audit_once_per_token(
                conn, action=audit_action, jti=claims["jti"], customer_id=row["customer_id"],
                info=info, **audit_ids)
        return data

    try:
        data, _ = await vm_audio.PLAYBACK_CACHE.get_or_load(
            (kind, claims["jti"]), loader, ttl_s=_remaining_ttl(claims), tag=(kind, row["id"]))
    except VoicemailIntegrityError as exc:
        logger.error("voicemail %s %s: integrity failure — NOT served: %s", kind, row["id"], exc)
        raise HTTPException(status_code=500, detail=MSG_AUDIO_DAMAGED)
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail %s %s: decrypt unavailable: %s", kind, row["id"], exc)
        raise HTTPException(status_code=503, detail=MSG_AUDIO_UNAVAILABLE,
                            headers={"Retry-After": "5"})
    except Exception as exc:  # noqa: BLE001 — audit/DB failure: fail closed, no audio
        logger.error("voicemail %s %s: audit/DB failure — audio withheld: %s: %s", kind,
                     row["id"], type(exc).__name__, exc)
        raise HTTPException(status_code=503, detail=MSG_AUDIO_UNAVAILABLE,
                            headers={"Retry-After": "5"})
    return vm_audio.audio_response(data, size=len(data), range_header=range_header,
                                   disposition=disposition)


@router.api_route("/messages/{message_id}/audio", methods=["GET", "HEAD"])
async def message_audio(message_id: int, request: Request, t: Optional[str] = Query(None)):
    claims = _verify("message", message_id, t)
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT m.id, m.customer_id, m.mailbox_id, m.msg_uuid, m.object_key, m.wrapped_dek, "
            "       m.iv, m.ciphertext_crc32c, m.size_bytes, m.created_at, m.caller_id_number, "
            "       b.timezone "
            "  FROM voicemail_messages m JOIN voicemail_boxes b ON b.id = m.mailbox_id "
            " WHERE m.id = $1::bigint AND m.status = 'stored' AND b.status <> 'deleted'",
            _id64(message_id, MSG_MESSAGE_NOT_FOUND))
    if row is None or row["customer_id"] != claims["cid"]:
        raise HTTPException(status_code=404, detail=MSG_MESSAGE_NOT_FOUND)
    return await _serve_audio(
        request, kind="message", row=row, claims=claims, decrypt=vm_audio.decrypt_message,
        audit_action="download" if claims.get("dl") else "play",
        filename_caller=row["caller_id_number"],
        audit_ids={"mailbox_id": row["mailbox_id"], "message_id": row["id"]})


# ===========================================================================
# 4.3 Greetings
# ===========================================================================
@router.get("/mailboxes/{mailbox_id}/greetings")
async def list_greetings(mailbox_id: int, scope: VmScope = Depends(vm_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        await _scoped_box(conn, scope, mailbox_id)
        rows = await conn.fetch(
            vm_greetings.GREETING_SELECT
            + " WHERE g.mailbox_id = $1::int AND g.status = 'stored' "
              "ORDER BY g.created_at DESC, g.id DESC", mailbox_id)
    return [vm_greetings.greeting_out(r) for r in rows]


@router.post("/mailboxes/{mailbox_id}/greetings", status_code=201)
async def upload_greeting(mailbox_id: int, request: Request,
                          label: Optional[str] = Query(None, max_length=200),
                          activate: bool = Query(False),
                          scope: VmScope = Depends(vm_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        box = await _scoped_box(conn, scope, mailbox_id)
    clean = mbx.clean_label(label if (label or "").strip() else None, default="Greeting")
    return await vm_greetings.upload_greeting(request, box=box, label=clean, activate=activate,
                                              info=scope.info(request))


@router.delete("/greetings/{greeting_id}", status_code=204)
async def delete_greeting(greeting_id: int, request: Request,
                          scope: VmScope = Depends(vm_writer)):
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await _scoped_greeting(conn, scope, greeting_id)
    try:
        await mbx.delete_object(mbx.greeting_key_of(row))
    except VoicemailCryptoUnavailable:
        raise HTTPException(status_code=503, detail=mbx.MSG_CRYPTO_DOWN,
                            headers={"Retry-After": "5"})
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE voicemail_boxes SET active_greeting_id = NULL, greeting_mode = 'standard', "
                "updated_at = now() WHERE id = $1::int AND active_greeting_id = $2::int",
                row["mailbox_id"], greeting_id)
            updated = await mbx.mark_purged(conn, "greeting", [greeting_id])
            if updated:
                await vm_audit.write_audit(
                    conn, action="greeting_delete", source=scope.source,
                    customer_id=row["customer_id"], mailbox_id=row["mailbox_id"],
                    greeting_id=greeting_id, info=scope.info(request),
                    detail={"reason": "user", "was_active": bool(row["is_active"])})
    vm_audio.evict_object("greeting", greeting_id)
    return Response(status_code=204)


@router.post("/greetings/{greeting_id}/playback-token")
async def greeting_playback_token(greeting_id: int,
                                  body: Optional[dict] = Body(None),
                                  scope: VmScope = Depends(vm_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await _scoped_greeting(conn, scope, greeting_id)
    token = _mint("greeting", greeting_id, row["customer_id"], scope, False)
    return {"url": _playback_url("greeting", row["id"], token),
            "expires_in": PLAYBACK_TTL_SECONDS}


_GREETING_CRYPTO_SQL = (
    "SELECT g.id, g.customer_id, g.mailbox_id, g.greeting_uuid, g.object_key, g.wrapped_dek, "
    "       g.iv, g.ciphertext_crc32c, g.size_bytes, g.created_at, g.label, b.timezone "
    "  FROM voicemail_greetings g JOIN voicemail_boxes b ON b.id = g.mailbox_id "
    " WHERE g.id = $1::int AND g.status = 'stored' AND b.status <> 'deleted'")


@router.api_route("/greetings/{greeting_id}/audio", methods=["GET", "HEAD"])
async def greeting_audio(greeting_id: int, request: Request, t: Optional[str] = Query(None)):
    claims = _verify("greeting", greeting_id, t)
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_GREETING_CRYPTO_SQL,
                                  _id32(greeting_id, MSG_GREETING_NOT_FOUND))
    if row is None or row["customer_id"] != claims["cid"]:
        raise HTTPException(status_code=404, detail=MSG_GREETING_NOT_FOUND)
    return await _serve_audio(
        request, kind="greeting", row=row, claims=claims, decrypt=vm_audio.decrypt_greeting,
        audit_action="greeting_play", filename_caller=None,
        audit_ids={"mailbox_id": row["mailbox_id"], "greeting_id": row["id"]})


# ===========================================================================
# 4.4 Admin
# ===========================================================================
class EraseBody(BaseModel):
    confirm: Any = None


@router.post("/customers/{customer_id}/crypto-erase")
async def crypto_erase(customer_id: int, body: EraseBody, request: Request,
                       scope: VmScope = Depends(vm_admin)):
    _id32(customer_id, mbx.MSG_CUSTOMER_NOT_FOUND)
    if body.confirm != f"ERASE {customer_id}":
        raise HTTPException(status_code=422, detail=MSG_CONFIRM.format(customer_id=customer_id))
    return await mbx.erase_customer(customer_id, info=scope.info(request))


# ===========================================================================
# Transcription v1.1 (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10.2, §10.3, §13)
# ===========================================================================
@router.get("/messages/{message_id}/transcript")
async def get_transcript(message_id: int, request: Request, response: Response,
                         scope: VmScope = Depends(vm_scope)):
    """Text only when done, after its transcript_view audit committed. Does
    NOT mark the message read (the UI does, plan §11.4)."""
    pool = await _pool()
    async with pool.acquire() as conn:
        msg = await _scoped_message(conn, scope, message_id)
    response.headers["Cache-Control"] = "no-store"
    return await vmt.read_transcript(msg, writer=scope.role != "readonly", admin=scope.is_admin,
                                     source=scope.source, info=scope.info(request))


class RetryBody(BaseModel):
    force: bool = False


@router.post("/messages/{message_id}/transcript/retry", status_code=202)
async def retry_transcript(message_id: int, request: Request,
                           body: Optional[RetryBody] = Body(None),
                           scope: VmScope = Depends(vm_writer)):
    force = bool(body.force) if body is not None else False
    if force and not scope.is_admin:
        raise HTTPException(status_code=403, detail=MSG_ADMIN_ONLY)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            msg = await _scoped_message(conn, scope, message_id, for_update=True)
            return await vmt.request_retry(conn, msg, force=force, source=scope.source,
                                           info=scope.info(request))


@router.get("/mailboxes/{mailbox_id}/transcript-snippets")
async def transcript_snippets(mailbox_id: int, request: Request, response: Response,
                              ids: Optional[str] = Query(None),
                              scope: VmScope = Depends(vm_scope)):
    pool = await _pool()
    async with pool.acquire() as conn:
        box = await _scoped_box(conn, scope, mailbox_id)
    wanted = vmt.parse_snippet_ids(ids)
    response.headers["Cache-Control"] = "no-store"
    return await vmt.snippets(box, wanted, source=scope.source, info=scope.info(request))


@router.post("/mailboxes/{mailbox_id}/transcripts/backfill", status_code=202)
async def backfill_transcripts(mailbox_id: int, request: Request,
                               scope: VmScope = Depends(vm_admin)):
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            box = await _scoped_box(conn, scope, mailbox_id)
            return await vmt.backfill(conn, box, source=scope.source, info=scope.info(request))


@router.get("/transcription/status")
async def transcription_status(scope: VmScope = Depends(vm_admin)):
    return await vmt.ops_status()


class RequeueBody(BaseModel):
    error_code: Any = None   # validated by the service: 422 sentences
    limit: Any = None


@router.post("/transcription/requeue")
async def transcription_requeue(request: Request, body: Optional[RequeueBody] = Body(None),
                                scope: VmScope = Depends(vm_admin)):
    body = body or RequeueBody()
    return await vmt.requeue(body.error_code, body.limit, info=scope.info(request))


# ===========================================================================
# 4.5 FreeSWITCH-facing (X-Ingest-Secret; JWT-exempt)
# ===========================================================================
@router.get("/fs/mailbox/{mailbox_id}", dependencies=[Depends(require_ingest_secret)])
async def fs_mailbox(mailbox_id: int):
    _id32(mailbox_id, mbx.MSG_MAILBOX_NOT_FOUND)
    pool = await _pool()
    async with pool.acquire() as conn:
        box = await mbx.fetch_mailbox(conn, mailbox_id)
        if box is None:
            raise HTTPException(status_code=404, detail=mbx.MSG_MAILBOX_NOT_FOUND)
        greeting = None
        if box["greeting_mode"] == "custom" and box["active_greeting_id"] is not None:
            g = await conn.fetchrow(
                "SELECT id, duration_ms FROM voicemail_greetings WHERE id = $1::int "
                "AND mailbox_id = $2::int AND status = 'stored'",
                box["active_greeting_id"], mailbox_id)
            if g is not None:
                greeting = {"greeting_id": g["id"], "duration_ms": g["duration_ms"]}
    accepting, reason = mbx.accepting_state(box)
    return {"mailbox_id": box["id"], "customer_id": box["customer_id"], "did": box["did"],
            "status": box["status"], "accepting": accepting, "reason": reason,
            "max_message_seconds": box["max_message_seconds"], "greeting": greeting}


@router.get("/fs/greetings/{greeting_id}/audio", dependencies=[Depends(require_ingest_secret)])
async def fs_greeting_audio(greeting_id: int, request: Request):
    _id32(greeting_id, MSG_GREETING_NOT_FOUND)
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_GREETING_CRYPTO_SQL, greeting_id)
    if row is None:
        raise HTTPException(status_code=404, detail=MSG_GREETING_NOT_FOUND)
    try:
        data, _ = await vm_audio.FS_GREETING_CACHE.get_or_load(
            ("fsg", row["id"], row["ciphertext_crc32c"]),
            lambda: vm_audio.decrypt_greeting(row),
            ttl_s=vm_audio.FS_GREETING_TTL_S, tag=("greeting", row["id"]))
    except VoicemailIntegrityError as exc:
        logger.error("voicemail FS greeting %s: integrity failure — NOT served: %s",
                     greeting_id, exc)
        raise HTTPException(status_code=500, detail="greeting failed verification")
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail FS greeting %s: decrypt unavailable: %s", greeting_id, exc)
        raise HTTPException(status_code=503, detail="greeting temporarily unavailable")
    try:
        async with pool.acquire() as conn:
            await vm_audit.write_audit(
                conn, action="greeting_fs_fetch", source="freeswitch",
                customer_id=row["customer_id"], mailbox_id=row["mailbox_id"],
                greeting_id=row["id"], info=vm_audit.RequestInfo.from_request(request))
    except Exception as exc:  # noqa: BLE001 — fail closed: no audit, no audio
        logger.error("voicemail FS greeting %s: audit failed — withheld: %s", greeting_id, exc)
        raise HTTPException(status_code=503, detail="greeting temporarily unavailable")
    return Response(content=data, media_type="audio/wav",
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/fs/deposit", dependencies=[Depends(require_ingest_secret)])
async def fs_deposit(request: Request):
    return await vm_deposit.handle_deposit(request)
