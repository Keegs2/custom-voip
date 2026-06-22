"""Visual Voicemail — encrypted-at-rest, mailbox-centric API (Phase 1).

This router carries two surfaces:

1. **Legacy extension-bound endpoints** (``GET /count``, ``GET ""``,
   ``GET /{id}``, ``GET /{id}/audio``, ``PUT /{id}/read``, ``DELETE /{id}``) —
   kept working for the existing UCaaS voicemail UI. They serve LEGACY plaintext
   rows (``wrapped_dek IS NULL``) via the presigned/proxy path; an encrypted row
   reached through the legacy ``/audio`` returns 409 pointing at the new
   token→stream flow.

2. **Mailbox-centric product surface** (the standalone Visual Voicemail product,
   VISUAL_VOICEMAIL_PRODUCT_PLAN.md §3/§5). The mailbox (``voicemail_boxes``) is
   the unit of ownership. Deposits are encrypted ON WRITE by the API
   (``POST /voicemail/ingest``); playback is a two-step decrypt-stream
   (``playback-token`` → ``stream?t=``) that decrypts in memory and serves the
   plaintext WAV with HTTP Range/206. Plaintext never persists.

Mailbox resolution (v1, deterministic by dialed DID — §0/§3.1):
  * ``dedicated_did`` — ``voicemail_box_bindings.did = to_did``
  * ``attached``      — ``(attach_product, attach_ref)`` of the originating line

Per-tenant isolation everywhere: ``get_customer_filter`` + ``_get_owned_*``
404-no-leak (mirrors ``api_dids.py``). PINs/tokens/DEKs are never logged.
"""
import os
import json
import uuid
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request, Query
from fastapi.responses import Response, RedirectResponse
from pydantic import BaseModel, field_validator
from jose import jwt, JWTError

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter
from auth.security import hash_password, verify_password, JWT_SECRET, JWT_ALGORITHM
from auth.ingest import ingest_secret_ok, ingest_auth_error
from services import storage
from services import voicemail_crypto as vmc

logger = logging.getLogger(__name__)

router = APIRouter()

# Legacy presigned-audio TTL (seconds) — used only for legacy plaintext rows.
VOICEMAIL_URL_TTL = int(os.getenv("VOICEMAIL_URL_TTL", "3600"))
# Scoped playback-token lifetime (seconds). Short by design (§3.4).
PLAYBACK_TOKEN_TTL = int(os.getenv("VOICEMAIL_PLAYBACK_TTL", "120"))


# ===========================================================================
# Pydantic models (inline, Pydantic V2)
# ===========================================================================
class MailboxCreate(BaseModel):
    label: Optional[str] = None
    customer_id: Optional[int] = None      # admin-only target; ignored for tenants
    user_id: Optional[int] = None
    extension_id: Optional[int] = None
    timezone: str = "America/New_York"
    retention_days: int = 0
    plan_sku: Optional[str] = None


class MailboxUpdate(BaseModel):
    label: Optional[str] = None
    timezone: Optional[str] = None
    retention_days: Optional[int] = None
    status: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _status_ok(cls, v):
        if v is not None and v not in ("active", "suspended", "deleted"):
            raise ValueError("invalid status")
        return v


class BindingCreate(BaseModel):
    binding_type: str
    did: Optional[str] = None
    attach_product: Optional[str] = None
    attach_ref: Optional[str] = None

    @field_validator("binding_type")
    @classmethod
    def _type_ok(cls, v):
        # v1 code paths only handle these two; others are schema-reserved.
        if v not in ("dedicated_did", "attached"):
            raise ValueError("binding_type must be 'dedicated_did' or 'attached' in v1")
        return v


class GreetingUpdate(BaseModel):
    is_active: Optional[bool] = None
    schedule_kind: Optional[str] = None
    schedule_json: Optional[dict] = None


class SettingsUpdate(BaseModel):
    notify_email: Optional[bool] = None
    notify_email_address: Optional[str] = None
    attach_audio_to_email: Optional[bool] = None
    notify_sms: Optional[bool] = None
    notify_sms_number: Optional[str] = None
    transcription_enabled: Optional[bool] = None
    transcription_language: Optional[str] = None
    greeting_mode: Optional[str] = None


class PinSet(BaseModel):
    pin: str

    @field_validator("pin")
    @classmethod
    def _pin_ok(cls, v):
        if not (v.isdigit() and 4 <= len(v) <= 10):
            raise ValueError("PIN must be 4–10 digits")
        return v


class PinVerify(BaseModel):
    pin: str
    mailbox_id: Optional[int] = None
    to_did: Optional[str] = None


# ===========================================================================
# Helpers — ownership (404-no-leak), serialization, audit, crypto, Range
# ===========================================================================
async def _get_owned_mailbox(mailbox_id: int, customer_filter: int | None) -> dict:
    """Fetch a mailbox enforcing tenant isolation. 404 if missing OR cross-tenant."""
    row = await db.fetch_one("SELECT * FROM voicemail_boxes WHERE id = $1", mailbox_id)
    if not row:
        raise HTTPException(status_code=404, detail="Mailbox not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="Mailbox not found")
    return dict(row)


async def _get_owned_message(message_id: int, customer_filter: int | None) -> dict:
    """Fetch a message + its mailbox crypto context, tenant-scoped (404-no-leak)."""
    row = await db.fetch_one(
        """
        SELECT v.*, b.customer_id AS box_customer_id, b.kek_provider AS box_kek_provider,
               b.legal_hold AS box_legal_hold
        FROM voicemails v
        JOIN voicemail_boxes b ON v.mailbox_id = b.id
        WHERE v.id = $1
        """,
        message_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Voicemail not found")
    if customer_filter is not None and row["box_customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="Voicemail not found")
    return dict(row)


def _mailbox_public(row: dict) -> dict:
    """Serialize a mailbox for API responses (no pin_hash / kek_key_ref leak)."""
    return {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "user_id": row.get("user_id"),
        "extension_id": row.get("extension_id"),
        "label": row.get("label"),
        "status": row.get("status"),
        "timezone": row.get("timezone"),
        "retention_days": row.get("retention_days"),
        "kek_provider": row.get("kek_provider"),
        "encryption_status": row.get("encryption_status"),
        "plan_sku": row.get("plan_sku"),
        "legal_hold": row.get("legal_hold"),
        "has_pin": bool(row.get("pin_hash")),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _message_public(row: dict) -> dict:
    """List/detail shape for a message (§3.5 — frontend depends on these keys)."""
    return {
        "id": row["id"],
        "mailbox_id": row.get("mailbox_id"),
        "caller_id": row.get("caller_id"),
        "caller_name": row.get("caller_name"),
        "duration_ms": row.get("duration_ms"),
        "is_read": row.get("is_read"),
        "is_saved": row.get("is_saved"),
        "transcript_status": row.get("transcript_status"),
        "encrypted": row.get("wrapped_dek") is not None,
        "deleted_at": row.get("deleted_at"),
        "created_at": row.get("created_at"),
    }


def _message_detail(row: dict) -> dict:
    """Detail shape adds the transcript object (§3.5)."""
    out = _message_public(row)
    out["transcript"] = {
        "status": row.get("transcript_status") or "skipped",
        "text": row.get("transcription"),
        "language": None,
        "confidence": None,
        "words": None,
    }
    return out


async def _audit(action: str, *, mailbox_id=None, message_id=None, user=None,
                 customer_id=None, source="ui", request: Request | None = None,
                 detail: dict | None = None) -> None:
    """Best-effort write to voicemail_access_log. Never raises into the request."""
    try:
        ip = request.client.host if (request and request.client) else None
        ua = (request.headers.get("user-agent") if request else None) or None
        actor = int(user["sub"]) if user else None
        await db.execute(
            """
            INSERT INTO voicemail_access_log
                (mailbox_id, message_id, action, actor_user_id, actor_customer_id,
                 source, ip_address, user_agent, detail)
            VALUES ($1::int, $2::int, $3::text, $4::int, $5::int, $6::text,
                    $7::text, $8::text, $9::jsonb)
            """,
            mailbox_id, message_id, action, actor, customer_id, source, ip, ua,
            json.dumps(detail) if detail else None,
        )
    except Exception:
        logger.debug("voicemail audit log write failed", exc_info=True)


def _mint_playback_token(kind: str, obj_id: int, mailbox_id: int, user: dict) -> str:
    """Mint a 120s scoped HS256 token for a single object's decrypt-stream."""
    now = datetime.now(timezone.utc)
    claims = {
        "typ": "vm_play",
        "kind": kind,            # 'message' | 'greeting'
        "id": obj_id,
        "mailbox_id": mailbox_id,
        "sub": str(user["sub"]),
        "customer_id": user.get("customer_id"),
        "iat": now,
        "exp": now + timedelta(seconds=PLAYBACK_TOKEN_TTL),
    }
    return jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _verify_playback_token(token: str, kind: str, obj_id: int) -> dict:
    """Validate a vm_play token for ``kind``/``obj_id``. Raises 401 on any fault."""
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired playback token")
    if claims.get("typ") != "vm_play":
        raise HTTPException(status_code=401, detail="Invalid playback token type")
    if claims.get("kind") != kind or int(claims.get("id", -1)) != int(obj_id):
        raise HTTPException(status_code=401, detail="Playback token does not match resource")
    return claims


def _compute_range(size: int, range_header: Optional[str]):
    """Parse a single-range ``Range`` header against ``size``.

    Returns ``(start, end)`` inclusive, ``None`` to serve the whole body, or the
    sentinel string ``"unsatisfiable"`` for a syntactically-valid out-of-bounds
    range (→ HTTP 416). Multi-range and malformed headers fall back to full body.
    """
    if not range_header or not range_header.startswith("bytes="):
        return None
    spec = range_header[len("bytes="):].split(",")[0].strip()
    if "-" not in spec:
        return None
    start_s, _, end_s = spec.partition("-")
    try:
        if start_s == "":
            n = int(end_s)
            if n <= 0:
                return None
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        return "unsatisfiable"
    return (start, min(end, size - 1))


def _audio_response(data: bytes, range_header: Optional[str],
                    download_name: Optional[str] = None) -> Response:
    """Serve a decrypted WAV buffer with Range/206 + no-store. Range is sliced
    from the in-memory buffer (messages are small — see §2.4)."""
    size = len(data)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    if download_name:
        headers["Content-Disposition"] = f'attachment; filename="{download_name}"'

    rng = _compute_range(size, range_header)
    if rng == "unsatisfiable":
        headers["Content-Range"] = f"bytes */{size}"
        return Response(status_code=416, headers=headers)
    if rng is None:
        headers["Content-Length"] = str(size)
        return Response(content=data, media_type="audio/wav", headers=headers)

    start, end = rng
    chunk = data[start : end + 1]
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(len(chunk))
    return Response(content=chunk, status_code=206, media_type="audio/wav", headers=headers)


async def _encrypt_and_store(customer_id: int, mailbox_id: int, kek_provider: str,
                             kek_key_ref: Optional[str], plaintext: bytes,
                             subkey: str):
    """Envelope-encrypt ``plaintext`` and upload the ciphertext.

    Returns ``(bucket, object_key, wrapped_dek, iv, kek_key_ref, enc_algo)``.
    Refuses (raises) when the KEK provider is unconfigured — never plaintext.
    """
    provider = vmc.get_kms_provider(kek_provider)
    if not provider.configured():
        raise RuntimeError("voicemail encryption is not configured (no KEK)")
    if not kek_key_ref:
        kek_key_ref = await provider.create_customer_kek(customer_id, mailbox_id=mailbox_id)

    ciphertext, iv, dek = vmc.encrypt_blob(plaintext)
    try:
        wrapped_dek = await provider.wrap_dek(dek, kek_key_ref)
    finally:
        dek = b"\x00" * len(dek)  # best-effort scrub

    object_key = storage.tenant_key(
        customer_id, "voicemail", f"mb_{mailbox_id}", f"{uuid.uuid4().hex}_{subkey}.enc"
    )
    await asyncio.to_thread(
        storage.put_file, storage.BUCKET_VOICEMAIL, object_key, ciphertext,
        "application/octet-stream",
    )
    return storage.BUCKET_VOICEMAIL, object_key, wrapped_dek, iv, kek_key_ref, vmc.ENC_ALGO


async def _decrypt_object(bucket: str, object_key: str, wrapped_dek: bytes,
                          iv: bytes, kek_provider: str, kek_key_ref: str) -> bytes:
    """Download ciphertext, KMS-unwrap the DEK, AES-GCM decrypt → plaintext."""
    ciphertext = await asyncio.to_thread(storage.get_bytes, bucket, object_key)
    provider = vmc.get_kms_provider(kek_provider)
    dek = await provider.unwrap_dek(bytes(wrapped_dek), kek_key_ref)
    try:
        return vmc.decrypt_blob(ciphertext, bytes(iv), dek)
    finally:
        dek = b"\x00" * len(dek)


# ===========================================================================
# FreeSWITCH ↔ API: ingest / resolve / pin verify (ingest-secret; JWT-exempt)
# ===========================================================================
@router.post("/ingest")
async def ingest_voicemail(request: Request):
    """Encrypt-on-write deposit from FreeSWITCH (§3.2).

    Multipart ``file`` (raw WAV) + fields ``to_did``, ``caller_id``,
    ``caller_name``, ``duration_ms``, ``greeting_type?``, ``source_model?``,
    ``attach_product?``/``attach_ref?`` (attached model). Legacy
    ``extension``+``customer_id`` accepted as a fallback. The API resolves the
    mailbox via ``voicemail_box_bindings`` and inserts the ENCRYPTED row — FS
    never inserts plaintext. ALWAYS returns 200 (rule #11).
    """
    if not ingest_secret_ok(request):
        return ingest_auth_error()

    file_bytes: Optional[bytes] = None
    body: dict = {}
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/form-data"):
            form = await request.form()
            for k in ("to_did", "caller_id", "caller_name", "duration_ms",
                      "greeting_type", "source_model", "attach_product",
                      "attach_ref", "extension", "customer_id"):
                body[k] = form.get(k)
            upload = form.get("file")
            if upload is not None and hasattr(upload, "read"):
                file_bytes = await upload.read()
        else:
            body = await request.json()
    except Exception as e:
        logger.warning("Voicemail ingest: failed to parse body: %s", e)
        return {"status": "error", "detail": "invalid body"}

    try:
        if not file_bytes:
            return {"status": "error", "detail": "no audio file provided"}

        mailbox = await _resolve_mailbox_for_ingest(body)
        if not mailbox:
            logger.warning("Voicemail ingest: could not resolve mailbox (to_did=%s)",
                           body.get("to_did"))
            return {"status": "error", "detail": "no mailbox for this destination"}

        if mailbox["encryption_status"] == "crypto_erased":
            return {"status": "error", "detail": "mailbox crypto-erased"}

        provider = vmc.get_kms_provider(mailbox["kek_provider"])
        if not provider.configured():
            # Durability vs confidentiality (§7.1): drop rather than persist
            # plaintext. Still 200 so FS does not retry-storm.
            logger.error("Voicemail ingest: encryption not configured for provider %s "
                         "— dropping deposit for mailbox %s", mailbox["kek_provider"],
                         mailbox["id"])
            return {"status": "error", "detail": "encryption not configured"}

        bucket, object_key, wrapped_dek, iv, kek_key_ref, enc_algo = await _encrypt_and_store(
            mailbox["customer_id"], mailbox["id"], mailbox["kek_provider"],
            mailbox.get("kek_key_ref"), file_bytes, "audio",
        )

        duration_ms = body.get("duration_ms")
        try:
            duration_ms = int(duration_ms) if duration_ms is not None else None
        except (TypeError, ValueError):
            duration_ms = None

        row = await db.fetch_one(
            """
            INSERT INTO voicemails
                (mailbox_id, extension_id, caller_id, caller_name, duration_ms,
                 bucket, object_key, wrapped_dek, audio_iv, kek_key_ref, enc_algo,
                 transcript_status)
            VALUES ($1::int, $2::int, $3::text, $4::text, $5::int, $6::text,
                    $7::text, $8::bytea, $9::bytea, $10::text, $11::text, 'skipped')
            RETURNING id
            """,
            mailbox["id"], mailbox.get("extension_id"), body.get("caller_id"),
            body.get("caller_name"), duration_ms, bucket, object_key,
            wrapped_dek, iv, kek_key_ref, enc_algo,
        )

        await _audit("deposit", mailbox_id=mailbox["id"], message_id=row["id"],
                     customer_id=mailbox["customer_id"], source="freeswitch",
                     request=request,
                     detail={"source_model": body.get("source_model")})
        logger.info("Voicemail ingest: encrypted deposit id=%s mailbox=%s",
                    row["id"], mailbox["id"])
        return {"status": "ok", "voicemail_id": row["id"], "mailbox_id": mailbox["id"]}

    except Exception:
        logger.exception("Voicemail ingest: unexpected error")
        return {"status": "error", "detail": "internal processing error"}


async def _resolve_mailbox_for_ingest(body: dict) -> Optional[dict]:
    """Deterministic v1 mailbox resolution (§3.1). Returns the mailbox row dict."""
    to_did = (body.get("to_did") or "").strip()
    # 1) dedicated_did — To = the mailbox's own access DID.
    if to_did:
        row = await db.fetch_one(
            """
            SELECT b.* FROM voicemail_boxes b
            JOIN voicemail_box_bindings bd ON bd.mailbox_id = b.id
            WHERE bd.binding_type = 'dedicated_did' AND bd.did = $1
              AND b.status = 'active'
            LIMIT 1
            """,
            to_did,
        )
        if row:
            return dict(row)

    # 2) attached — originating revup product/line is the no-answer fallback.
    attach_product = (body.get("attach_product") or "").strip() or None
    attach_ref = (body.get("attach_ref") or "").strip() or None
    if attach_product and attach_ref:
        row = await db.fetch_one(
            """
            SELECT b.* FROM voicemail_boxes b
            JOIN voicemail_box_bindings bd ON bd.mailbox_id = b.id
            WHERE bd.binding_type = 'attached' AND bd.attach_product = $1
              AND bd.attach_ref = $2 AND b.status = 'active'
            LIMIT 1
            """,
            attach_product, attach_ref,
        )
        if row:
            return dict(row)

    # 3) Legacy fallback — extension + customer_id → the back-filled mailbox.
    extension = body.get("extension")
    customer_id = body.get("customer_id")
    if extension and customer_id:
        try:
            customer_id = int(customer_id)
        except (TypeError, ValueError):
            return None
        row = await db.fetch_one(
            """
            SELECT b.* FROM voicemail_boxes b
            JOIN extensions e ON b.extension_id = e.id
            WHERE e.extension = $1 AND e.customer_id = $2 AND b.status = 'active'
            LIMIT 1
            """,
            str(extension), customer_id,
        )
        if row:
            return dict(row)
    return None


@router.get("/resolve")
async def resolve_mailbox(request: Request, to_did: str = Query(...)):
    """FS greeting/mailbox lookup (§3.3). ingest-secret; returns
    ``{mailbox_id, exists, active_greeting}``."""
    if not ingest_secret_ok(request):
        return ingest_auth_error()

    mailbox = await _resolve_mailbox_for_ingest({"to_did": to_did})
    if not mailbox:
        return {"mailbox_id": None, "exists": False, "active_greeting": None}

    greeting = await db.fetch_one(
        """
        SELECT id, greeting_type, schedule_kind, schedule_json,
               (object_key IS NOT NULL) AS has_audio
        FROM voicemail_greetings
        WHERE mailbox_id = $1 AND is_active = true
        ORDER BY created_at DESC LIMIT 1
        """,
        mailbox["id"],
    )
    active_greeting = None
    if greeting:
        active_greeting = {
            "greeting_id": greeting["id"],
            "greeting_type": greeting["greeting_type"],
            "schedule_kind": greeting["schedule_kind"],
            "schedule_json": greeting["schedule_json"],
            "has_audio": greeting["has_audio"],
        }
    return {"mailbox_id": mailbox["id"], "exists": True, "active_greeting": active_greeting}


@router.post("/pin/verify")
async def verify_pin(request: Request, body: PinVerify):
    """FS PIN check (ingest-secret). Returns ``{valid}``; never logs the PIN."""
    if not ingest_secret_ok(request):
        return ingest_auth_error()

    mailbox = None
    if body.mailbox_id is not None:
        mailbox = await db.fetch_one(
            "SELECT id, pin_hash FROM voicemail_boxes WHERE id = $1", body.mailbox_id
        )
    elif body.to_did:
        mailbox = await db.fetch_one(
            """
            SELECT b.id, b.pin_hash FROM voicemail_boxes b
            JOIN voicemail_box_bindings bd ON bd.mailbox_id = b.id
            WHERE bd.binding_type = 'dedicated_did' AND bd.did = $1
            LIMIT 1
            """,
            body.to_did,
        )
    if not mailbox or not mailbox["pin_hash"]:
        return {"valid": False}
    valid = False
    try:
        valid = verify_password(body.pin, mailbox["pin_hash"])
    except Exception:
        valid = False
    await _audit("pin_verify", mailbox_id=mailbox["id"], source="freeswitch",
                 request=request, detail={"valid": valid})
    return {"valid": valid}


# ===========================================================================
# Decrypt-stream playback (the load-bearing piece — §2.4/§3.4)
# ===========================================================================
@router.post("/messages/{message_id}/playback-token")
async def message_playback_token(
    message_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Mint a 120s scoped stream token for an owned message (§3.4)."""
    msg = await _get_owned_message(message_id, customer_filter)
    token = _mint_playback_token("message", message_id, msg["mailbox_id"], user)
    return {
        "stream_url": f"/v1/voicemail/messages/{message_id}/stream?t={token}",
        "expires_in": PLAYBACK_TOKEN_TTL,
    }


@router.get("/messages/{message_id}/stream")
async def message_stream(
    message_id: int,
    request: Request,
    t: str = Query(...),
    download: int = 0,
):
    """Decrypt-stream playback (JWT-exempt; query-token carve-out in middleware).

    Validates the scoped token, loads the row, downloads ciphertext, KMS-unwraps
    the DEK, AES-GCM decrypts in memory, and serves the plaintext WAV with
    Range/206 + ``Cache-Control: no-store``. Legacy plaintext rows
    (``wrapped_dek IS NULL``) redirect to a presigned object URL.
    """
    claims = _verify_playback_token(t, "message", message_id)

    row = await db.fetch_one(
        """
        SELECT v.*, b.customer_id AS box_customer_id, b.kek_provider AS box_kek_provider
        FROM voicemails v JOIN voicemail_boxes b ON v.mailbox_id = b.id
        WHERE v.id = $1
        """,
        message_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Voicemail not found")
    row = dict(row)
    # Defense in depth: the token's mailbox/customer must match the row.
    if int(claims.get("mailbox_id", -1)) != int(row["mailbox_id"]):
        raise HTTPException(status_code=401, detail="Playback token mailbox mismatch")

    await _audit("download" if download else "play", mailbox_id=row["mailbox_id"],
                 message_id=message_id, customer_id=row["box_customer_id"],
                 source="ui", request=request)

    # Legacy plaintext row → presigned/proxy path (no envelope).
    if row.get("wrapped_dek") is None:
        return _serve_legacy(row)

    try:
        plaintext = await _decrypt_object(
            row["bucket"], row["object_key"], row["wrapped_dek"], row["audio_iv"],
            row["box_kek_provider"], row["kek_key_ref"],
        )
    except storage.StorageError:
        logger.exception("Voicemail stream: storage error for message %s", message_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    except Exception:
        logger.exception("Voicemail stream: decrypt failed for message %s", message_id)
        raise HTTPException(status_code=500, detail="Could not decrypt voicemail")

    dl_name = f"voicemail_{message_id}.wav" if download else None
    return _audio_response(plaintext, request.headers.get("range"), dl_name)


def _serve_legacy(row: dict) -> Response:
    """302 to a presigned URL for a legacy plaintext row, or 409 for a non-object
    (local path) row that cannot be presigned."""
    key = row.get("object_key") or row.get("storage_path")
    bucket = row.get("bucket") or storage.BUCKET_VOICEMAIL
    if not key:
        raise HTTPException(status_code=404, detail="No audio for this voicemail")
    if str(key).startswith("/"):
        raise HTTPException(status_code=409,
                            detail="Legacy voicemail audio is not in object storage")
    try:
        url = storage.presigned_get_url(bucket, key, ttl=VOICEMAIL_URL_TTL)
    except storage.StorageError:
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    return RedirectResponse(url=url, status_code=302)


# ===========================================================================
# Mailbox CRUD
# ===========================================================================
@router.get("/mailboxes")
async def list_mailboxes(
    customer_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List mailboxes; non-admins scoped to their own customer."""
    query = "SELECT * FROM voicemail_boxes WHERE 1=1"
    values: list = []
    idx = 1
    if customer_filter is not None:
        query += f" AND customer_id = ${idx}"; values.append(customer_filter); idx += 1
    elif customer_id is not None:
        query += f" AND customer_id = ${idx}"; values.append(customer_id); idx += 1
    if status is not None:
        query += f" AND status = ${idx}"; values.append(status); idx += 1
    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])
    rows = await db.fetch_all(query, *values)
    return [_mailbox_public(dict(r)) for r in rows]


@router.post("/mailboxes")
async def create_mailbox(
    body: MailboxCreate,
    request: Request,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create a mailbox (provisions a KEK). Gated on customers.voicemail_enabled."""
    customer_id = body.customer_id if customer_filter is None else customer_filter
    if customer_id is None:
        raise HTTPException(status_code=400, detail="customer_id is required")

    cust = await db.fetch_one(
        "SELECT id, status, voicemail_enabled FROM customers WHERE id = $1", customer_id
    )
    if not cust:
        raise HTTPException(status_code=404, detail="Customer not found")
    if not cust["voicemail_enabled"]:
        raise HTTPException(status_code=403, detail="Voicemail is not enabled for this customer")

    provider = vmc.get_kms_provider()
    if not provider.configured():
        raise HTTPException(status_code=503, detail="Voicemail encryption is not configured")

    # Insert first to get the mailbox id, then bind its KEK ref.
    row = await db.fetch_one(
        """
        INSERT INTO voicemail_boxes
            (customer_id, user_id, extension_id, label, timezone, retention_days,
             kek_provider, encryption_status, plan_sku)
        VALUES ($1::int, $2::int, $3::int, $4::text, $5::text, $6::int,
                $7::text, 'active', $8::text)
        RETURNING *
        """,
        customer_id, body.user_id, body.extension_id, body.label, body.timezone,
        body.retention_days, provider.name, body.plan_sku,
    )
    mailbox = dict(row)
    try:
        kek_ref = await provider.create_customer_kek(customer_id, mailbox_id=mailbox["id"])
        updated = await db.fetch_one(
            "UPDATE voicemail_boxes SET kek_key_ref = $1::text, updated_at = NOW() "
            "WHERE id = $2 RETURNING *",
            kek_ref, mailbox["id"],
        )
        mailbox = dict(updated)
    except Exception:
        logger.exception("Mailbox %s: KEK provisioning failed", mailbox["id"])
        raise HTTPException(status_code=503, detail="Could not provision encryption key")

    await _audit("key_create", mailbox_id=mailbox["id"], user=user,
                 customer_id=customer_id, request=request)
    return _mailbox_public(mailbox)


@router.get("/mailboxes/{mailbox_id}")
async def get_mailbox(
    mailbox_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    return _mailbox_public(await _get_owned_mailbox(mailbox_id, customer_filter))


@router.put("/mailboxes/{mailbox_id}")
async def update_mailbox(
    mailbox_id: int,
    body: MailboxUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    updates, values, idx = [], [], 1
    for field, value in body.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ${idx}"); values.append(value); idx += 1
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates.append("updated_at = NOW()")
    values.append(mailbox_id)
    row = await db.fetch_one(
        f"UPDATE voicemail_boxes SET {', '.join(updates)} WHERE id = ${idx} RETURNING *",
        *values,
    )
    return _mailbox_public(dict(row))


@router.delete("/mailboxes/{mailbox_id}")
async def delete_mailbox(
    mailbox_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Soft-delete a mailbox (status='deleted'). Blocked by legal hold (423)."""
    mb = await _get_owned_mailbox(mailbox_id, customer_filter)
    if mb.get("legal_hold"):
        raise HTTPException(status_code=423, detail="Mailbox is under legal hold")
    await db.execute(
        "UPDATE voicemail_boxes SET status = 'deleted', updated_at = NOW() WHERE id = $1",
        mailbox_id,
    )
    await _audit("mailbox_delete", mailbox_id=mailbox_id, user=user,
                 customer_id=mb["customer_id"], request=request)
    return {"status": "deleted", "mailbox_id": mailbox_id}


# ===========================================================================
# Messages (scoped to a mailbox / by id)
# ===========================================================================
@router.get("/mailboxes/{mailbox_id}/messages/count")
async def mailbox_message_count(
    mailbox_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    row = await db.fetch_one(
        """
        SELECT COUNT(*) FILTER (WHERE is_read = false) AS unread,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE is_saved = true) AS saved
        FROM voicemails WHERE mailbox_id = $1 AND deleted_at IS NULL
        """,
        mailbox_id,
    )
    return dict(row)


@router.get("/mailboxes/{mailbox_id}/messages")
async def list_mailbox_messages(
    mailbox_id: int,
    folder: Optional[str] = Query(
        None, description="inbox | saved | trash — one-query folder filter"),
    is_read: Optional[bool] = None,
    is_saved: Optional[bool] = None,
    include_deleted: bool = False,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List messages. ``folder`` gives the frontend Trash/Saved/Inbox in ONE
    query (no client-side diffing):
      * inbox  — not deleted AND not saved
      * saved  — saved AND not deleted
      * trash  — soft-deleted (deleted_at IS NOT NULL)
    When ``folder`` is omitted the legacy is_read/is_saved/include_deleted
    filters apply (default excludes trashed). ``is_read`` may be combined with
    any folder."""
    await _get_owned_mailbox(mailbox_id, customer_filter)
    query = "SELECT * FROM voicemails WHERE mailbox_id = $1"
    values: list = [mailbox_id]
    idx = 2
    if folder is not None:
        if folder == "inbox":
            query += " AND deleted_at IS NULL AND is_saved = false"
        elif folder == "saved":
            query += " AND deleted_at IS NULL AND is_saved = true"
        elif folder == "trash":
            query += " AND deleted_at IS NOT NULL"
        else:
            raise HTTPException(status_code=400,
                                detail="folder must be 'inbox', 'saved', or 'trash'")
    else:
        if not include_deleted:
            query += " AND deleted_at IS NULL"
        if is_saved is not None:
            query += f" AND is_saved = ${idx}"; values.append(is_saved); idx += 1
    if is_read is not None:
        query += f" AND is_read = ${idx}"; values.append(is_read); idx += 1
    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])
    rows = await db.fetch_all(query, *values)
    return [_message_public(dict(r)) for r in rows]


@router.get("/messages/{message_id}")
async def get_message(
    message_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    return _message_detail(await _get_owned_message(message_id, customer_filter))


@router.put("/messages/{message_id}/read")
async def mark_message_read(
    message_id: int,
    is_read: bool = True,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_message(message_id, customer_filter)
    await db.execute("UPDATE voicemails SET is_read = $1 WHERE id = $2", is_read, message_id)
    return {"status": "ok", "message_id": message_id, "is_read": is_read}


@router.put("/messages/{message_id}/save")
async def mark_message_saved(
    message_id: int,
    is_saved: bool = True,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_message(message_id, customer_filter)
    await db.execute("UPDATE voicemails SET is_saved = $1 WHERE id = $2", is_saved, message_id)
    return {"status": "ok", "message_id": message_id, "is_saved": is_saved}


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Soft-delete a message. Blocked by message- or mailbox-level legal hold (423)."""
    msg = await _get_owned_message(message_id, customer_filter)
    if msg.get("legal_hold") or msg.get("box_legal_hold"):
        raise HTTPException(status_code=423, detail="Message is under legal hold")
    await db.execute(
        "UPDATE voicemails SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
        message_id,
    )
    await _audit("message_delete", mailbox_id=msg["mailbox_id"], message_id=message_id,
                 user=user, customer_id=msg["box_customer_id"], request=request)
    return {"status": "deleted", "message_id": message_id}


@router.put("/messages/{message_id}/restore")
async def restore_message(
    message_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Restore a soft-deleted (trashed) message — clears deleted_at. Idempotent;
    restoring a non-trashed message is a no-op. Tenant-scoped via _get_owned_message."""
    msg = await _get_owned_message(message_id, customer_filter)
    await db.execute(
        "UPDATE voicemails SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL",
        message_id,
    )
    await _audit("message_restore", mailbox_id=msg["mailbox_id"], message_id=message_id,
                 user=user, customer_id=msg["box_customer_id"], request=request)
    return {"status": "restored", "message_id": message_id}


@router.delete("/messages/{message_id}/purge")
async def purge_message(
    message_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Hard-purge a TRASHED message: delete the encrypted object + the DB row.
    Only messages already in Trash (deleted_at set) may be purged (empty-trash
    semantics). Legal hold → 423. Tenant-scoped (owner or admin via
    _get_owned_message)."""
    msg = await _get_owned_message(message_id, customer_filter)
    if msg.get("deleted_at") is None:
        raise HTTPException(status_code=409,
                            detail="Message must be in Trash before it can be purged")
    if msg.get("legal_hold") or msg.get("box_legal_hold"):
        raise HTTPException(status_code=423, detail="Message is under legal hold")
    # Best-effort object delete first; the row is the source of truth so we
    # remove it regardless of an object-store hiccup (orphan sweeper can reap).
    bucket, key = msg.get("bucket"), msg.get("object_key")
    if bucket and key and not str(key).startswith("/"):
        try:
            await asyncio.to_thread(storage.delete, bucket, key)
        except Exception:
            logger.warning("purge: object delete failed for message %s", message_id,
                           exc_info=True)
    await db.execute("DELETE FROM voicemails WHERE id = $1", message_id)
    await _audit("message_purge", mailbox_id=msg["mailbox_id"], message_id=message_id,
                 user=user, customer_id=msg["box_customer_id"], request=request)
    return {"status": "purged", "message_id": message_id}


# ===========================================================================
# Bindings (mailbox resolution map)
# ===========================================================================
@router.get("/mailboxes/{mailbox_id}/bindings")
async def list_bindings(
    mailbox_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    rows = await db.fetch_all(
        "SELECT * FROM voicemail_box_bindings WHERE mailbox_id = $1 ORDER BY created_at",
        mailbox_id,
    )
    return [dict(r) for r in rows]


@router.post("/mailboxes/{mailbox_id}/bindings")
async def create_binding(
    mailbox_id: int,
    body: BindingCreate,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Bind a dedicated DID or attach to an existing line (v1 types only).

    dedicated_did supports SELF-SERVE claiming: an entitled customer (or an
    admin) may claim an AVAILABLE/unassigned inventory DID and have it assigned
    to their own customer atomically with the binding. SEC-3 still holds — a DID
    assigned to a DIFFERENT customer is never claimable (403).
    """
    mb = await _get_owned_mailbox(mailbox_id, customer_filter)
    is_admin = customer_filter is None
    target_customer = mb["customer_id"]

    if body.binding_type == "dedicated_did":
        if not body.did:
            raise HTTPException(status_code=400, detail="did is required for dedicated_did")
        # Inventory ownership decision (SEC-3 DID-claim IDOR). did_inventory.did
        # is stored E.164 (matches what FS sends as to_did on resolve/ingest).
        inv = await db.fetch_one(
            "SELECT id, status, customer_id FROM did_inventory WHERE did = $1", body.did
        )
        claim_available = False
        if inv is None:
            # Not tracked in inventory. Admins may bind an un-inventoried DID
            # (e.g. ported/manual); non-admins may not claim one (mirrors
            # api_dids.create).
            if not is_admin:
                raise HTTPException(status_code=403, detail="DID is not assigned to your account")
        elif inv["customer_id"] is None:
            # Unassigned inventory DID → eligible for self-serve claim. Only
            # 'available' is claimable (reserved/porting/suspended are not).
            if inv["status"] != "available":
                raise HTTPException(
                    status_code=409,
                    detail=f"DID is not available to claim (status: {inv['status']})",
                )
            claim_available = True
        elif inv["customer_id"] != target_customer:
            # SEC-3: never claim another tenant's number.
            raise HTTPException(status_code=403, detail="DID is not assigned to this customer")
        # else: already owned by this customer → just create the binding.

        # Entitlement gate applies ONLY to the self-claim path; admins are
        # unrestricted. (Binding an already-owned DID needs no re-gate — the
        # mailbox itself was created behind the same voicemail_enabled gate.)
        if claim_available and not is_admin:
            cust = await db.fetch_one(
                "SELECT voicemail_enabled FROM customers WHERE id = $1", target_customer
            )
            if not cust or not cust["voicemail_enabled"]:
                raise HTTPException(
                    status_code=403, detail="Voicemail is not enabled for this customer"
                )

        if claim_available:
            # Atomic claim + bind: assign the inventory DID to this customer AND
            # create the binding in one transaction (reuses number_inventory
            # assign semantics — status='assigned', product_type/ref set). A
            # FOR UPDATE re-check closes the race where two callers claim the
            # same DID concurrently.
            actor_id = int(user["sub"])
            pool = await db.get_pool()
            async with pool.acquire() as conn:
                async with conn.transaction():
                    locked = await conn.fetchrow(
                        "SELECT status, customer_id FROM did_inventory WHERE did = $1 FOR UPDATE",
                        body.did,
                    )
                    if (locked is None or locked["customer_id"] is not None
                            or locked["status"] != "available"):
                        raise HTTPException(status_code=409, detail="DID is no longer available")
                    try:
                        row = await conn.fetchrow(
                            """
                            INSERT INTO voicemail_box_bindings (mailbox_id, binding_type, did)
                            VALUES ($1::int, 'dedicated_did', $2::text) RETURNING *
                            """,
                            mailbox_id, body.did,
                        )
                    except Exception as e:
                        if "unique" in str(e).lower():
                            raise HTTPException(status_code=409, detail="DID already bound to a mailbox")
                        raise
                    # The voicemail binding IS the product record; point
                    # did_inventory at it (product_ref_id = binding id).
                    await conn.execute(
                        """
                        UPDATE did_inventory
                           SET customer_id = $1::int,
                               product_type = 'voicemail',
                               product_ref_id = $2::int,
                               status = 'assigned',
                               assigned_at = NOW(),
                               assigned_by = $3::int,
                               updated_at = NOW()
                         WHERE did = $4::text
                        """,
                        target_customer, row["id"], actor_id, body.did,
                    )
                    # ---- BILLING SEAM (Phase 2 billing) -------------------------------
                    # A per-mailbox / per-DID rental charge will hook in HERE, inside
                    # this same transaction (or as a post-commit BackgroundTasks fee
                    # mirroring calls.py), against the mailbox's plan_sku /
                    # voicemail_plans + customer balance. No charge is applied today —
                    # this is only the seam.
                    # -------------------------------------------------------------------
            logger.info(
                "Voicemail dedicated_did self-claim: did=%s customer=%s mailbox=%s by_user=%s",
                body.did, target_customer, mailbox_id, actor_id,
            )
            return dict(row)

        # Already-owned (or admin un-inventoried) DID → bind only.
        try:
            row = await db.fetch_one(
                """
                INSERT INTO voicemail_box_bindings (mailbox_id, binding_type, did)
                VALUES ($1::int, 'dedicated_did', $2::text) RETURNING *
                """,
                mailbox_id, body.did,
            )
        except Exception as e:
            if "unique" in str(e).lower():
                raise HTTPException(status_code=409, detail="DID already bound to a mailbox")
            raise
        return dict(row)

    # attached
    if not body.attach_product or not body.attach_ref:
        raise HTTPException(status_code=400,
                            detail="attach_product and attach_ref are required for attached")
    if body.attach_product not in ("rcf", "trunk", "ucaas", "api"):
        raise HTTPException(status_code=400, detail="invalid attach_product")
    row = await db.fetch_one(
        """
        INSERT INTO voicemail_box_bindings (mailbox_id, binding_type, attach_product, attach_ref)
        VALUES ($1::int, 'attached', $2::text, $3::text) RETURNING *
        """,
        mailbox_id, body.attach_product, body.attach_ref,
    )
    return dict(row)


@router.delete("/mailboxes/{mailbox_id}/bindings/{binding_id}")
async def delete_binding(
    mailbox_id: int,
    binding_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    result = await db.execute(
        "DELETE FROM voicemail_box_bindings WHERE id = $1 AND mailbox_id = $2",
        binding_id, mailbox_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Binding not found")
    return {"status": "deleted", "binding_id": binding_id}


# ===========================================================================
# Attachable numbers (attach-to-existing-line picker)
# ===========================================================================
@router.get("/attachable-numbers")
async def attachable_numbers(
    customer_id: Optional[int] = None,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Numbers a customer owns across products, shaped for the
    attach-to-existing-line binding picker (frontend + admin attach-on-behalf).

    Scope: non-admins are forced to their own customer; admins may target a
    customer via ``?customer_id=``. Reuses the search.py cross-product union
    shape (RCF dids ∪ trunk dids ∪ UCaaS extensions).

    Row shape — the frontend maps ``product → attach_product`` and
    ``ref → attach_ref`` directly into a ``binding_type='attached'`` create:
      ``{ product: 'rcf'|'trunk', ref, label, current_routing }``
    attach_ref convention (must match telephony lookup_attached_mailbox, which is
    DID-keyed for both): ``ref`` = normalized E.164 DID as stored in the product
    table.

    Phase 1 = RCF + Trunk only (both DID-keyed end to end: this endpoint, the
    binding create, and the telephony ``lookup_attached_mailbox`` all agree on
    ``attach_ref = DID``). UCaaS-extension attach is DEFERRED to Phase 2: the
    ucaas.lua no-answer fallback keys the attached lookup by the inbound DID, not
    the extension id, and the UCaaS-DID→extension mapping isn't surfaced here —
    shipping it now would be a non-functional path. Reconcile the lua keying +
    DID mapping before re-adding a UCaaS branch.
    """
    target = customer_filter if customer_filter is not None else customer_id
    if target is None:
        raise HTTPException(status_code=400, detail="customer_id is required")

    rows = await db.fetch_all(
        """
        SELECT 'rcf'::text AS product,
               r.did AS ref,
               COALESCE(r.name, r.did) AS label,
               r.forward_to AS current_routing
          FROM rcf_numbers r
         WHERE r.customer_id = $1

        UNION ALL

        SELECT 'trunk'::text AS product,
               td.did AS ref,
               COALESCE(t.trunk_name, td.did) AS label,
               t.trunk_name AS current_routing
          FROM trunk_dids td
          JOIN sip_trunks t ON t.id = td.trunk_id
         WHERE t.customer_id = $1

        ORDER BY product, ref
        """,
        target,
    )
    return [dict(r) for r in rows]


# ===========================================================================
# Greetings
# ===========================================================================
@router.get("/mailboxes/{mailbox_id}/greetings")
async def list_greetings(
    mailbox_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    rows = await db.fetch_all(
        """
        SELECT id, mailbox_id, greeting_type, is_active, schedule_kind, schedule_json,
               (object_key IS NOT NULL) AS has_audio, created_at
        FROM voicemail_greetings WHERE mailbox_id = $1 ORDER BY created_at DESC
        """,
        mailbox_id,
    )
    return [dict(r) for r in rows]


@router.post("/mailboxes/{mailbox_id}/greetings")
async def upload_greeting(
    mailbox_id: int,
    request: Request,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Upload + encrypt a greeting (multipart ``file`` + greeting_type/schedule)."""
    mb = await _get_owned_mailbox(mailbox_id, customer_filter)
    ctype = request.headers.get("content-type", "")
    if not ctype.startswith("multipart/form-data"):
        raise HTTPException(status_code=400, detail="multipart/form-data with a file is required")
    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(status_code=400, detail="file is required")
    file_bytes = await upload.read()

    greeting_type = (form.get("greeting_type") or "unavailable")
    schedule_kind = (form.get("schedule_kind") or "always")
    schedule_json = form.get("schedule_json")
    is_active = str(form.get("is_active", "false")).lower() in ("1", "true", "yes")

    provider = vmc.get_kms_provider(mb["kek_provider"])
    if not provider.configured():
        raise HTTPException(status_code=503, detail="Voicemail encryption is not configured")

    bucket, object_key, wrapped_dek, iv, kek_key_ref, enc_algo = await _encrypt_and_store(
        mb["customer_id"], mailbox_id, mb["kek_provider"], mb.get("kek_key_ref"),
        file_bytes, "greeting",
    )

    row = await db.fetch_one(
        """
        INSERT INTO voicemail_greetings
            (mailbox_id, greeting_type, bucket, object_key, wrapped_dek, iv,
             kek_key_ref, enc_algo, is_active, schedule_kind, schedule_json)
        VALUES ($1::int, $2::text, $3::text, $4::text, $5::bytea, $6::bytea,
                $7::text, $8::text, $9::bool, $10::text, $11::jsonb)
        RETURNING id, mailbox_id, greeting_type, is_active, schedule_kind, created_at
        """,
        mailbox_id, greeting_type, bucket, object_key, wrapped_dek, iv,
        kek_key_ref, enc_algo, is_active, schedule_kind,
        schedule_json if isinstance(schedule_json, str) else (
            json.dumps(schedule_json) if schedule_json else None),
    )
    return dict(row)


@router.put("/mailboxes/{mailbox_id}/greetings/{greeting_id}")
async def update_greeting(
    mailbox_id: int,
    greeting_id: int,
    body: GreetingUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    g = await db.fetch_one(
        "SELECT id FROM voicemail_greetings WHERE id = $1 AND mailbox_id = $2",
        greeting_id, mailbox_id,
    )
    if not g:
        raise HTTPException(status_code=404, detail="Greeting not found")

    updates, values, idx = [], [], 1
    data = body.model_dump(exclude_none=True)
    if "schedule_json" in data and data["schedule_json"] is not None:
        data["schedule_json"] = json.dumps(data["schedule_json"])
    for field, value in data.items():
        cast = "::jsonb" if field == "schedule_json" else ""
        updates.append(f"{field} = ${idx}{cast}"); values.append(value); idx += 1
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    values.extend([greeting_id, mailbox_id])
    row = await db.fetch_one(
        f"UPDATE voicemail_greetings SET {', '.join(updates)} "
        f"WHERE id = ${idx} AND mailbox_id = ${idx + 1} "
        f"RETURNING id, mailbox_id, greeting_type, is_active, schedule_kind, schedule_json",
        *values,
    )
    return dict(row)


@router.delete("/mailboxes/{mailbox_id}/greetings/{greeting_id}")
async def delete_greeting(
    mailbox_id: int,
    greeting_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    result = await db.execute(
        "DELETE FROM voicemail_greetings WHERE id = $1 AND mailbox_id = $2",
        greeting_id, mailbox_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Greeting not found")
    return {"status": "deleted", "greeting_id": greeting_id}


@router.post("/greetings/{greeting_id}/playback-token")
async def greeting_playback_token(
    greeting_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    row = await db.fetch_one(
        """
        SELECT g.id, g.mailbox_id, b.customer_id AS box_customer_id
        FROM voicemail_greetings g JOIN voicemail_boxes b ON g.mailbox_id = b.id
        WHERE g.id = $1
        """,
        greeting_id,
    )
    if not row or (customer_filter is not None and row["box_customer_id"] != customer_filter):
        raise HTTPException(status_code=404, detail="Greeting not found")
    token = _mint_playback_token("greeting", greeting_id, row["mailbox_id"], user)
    return {
        "stream_url": f"/v1/voicemail/greetings/{greeting_id}/stream?t={token}",
        "expires_in": PLAYBACK_TOKEN_TTL,
    }


@router.get("/greetings/{greeting_id}/stream")
async def greeting_stream(
    greeting_id: int,
    request: Request,
    t: str = Query(...),
    download: int = 0,
):
    """Decrypt-stream a greeting (JWT-exempt; query-token carve-out)."""
    claims = _verify_playback_token(t, "greeting", greeting_id)
    row = await db.fetch_one(
        """
        SELECT g.*, b.kek_provider AS box_kek_provider, b.customer_id AS box_customer_id
        FROM voicemail_greetings g JOIN voicemail_boxes b ON g.mailbox_id = b.id
        WHERE g.id = $1
        """,
        greeting_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Greeting not found")
    row = dict(row)
    if int(claims.get("mailbox_id", -1)) != int(row["mailbox_id"]):
        raise HTTPException(status_code=401, detail="Playback token mailbox mismatch")
    if row.get("wrapped_dek") is None:
        return _serve_legacy(row)

    await _audit("greeting_play", mailbox_id=row["mailbox_id"],
                 customer_id=row["box_customer_id"], source="ui", request=request,
                 detail={"greeting_id": greeting_id})
    try:
        plaintext = await _decrypt_object(
            row["bucket"], row["object_key"], row["wrapped_dek"], row["iv"],
            row["box_kek_provider"], row["kek_key_ref"],
        )
    except storage.StorageError:
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    except Exception:
        logger.exception("Greeting stream: decrypt failed for greeting %s", greeting_id)
        raise HTTPException(status_code=500, detail="Could not decrypt greeting")
    dl_name = f"greeting_{greeting_id}.wav" if download else None
    return _audio_response(plaintext, request.headers.get("range"), dl_name)


@router.post("/greetings/ingest")
async def ingest_greeting(request: Request):
    """FS greeting upload (ingest-secret). Encrypts like a message. Phase 1
    minimal: resolves the mailbox by ``to_did`` (dedicated) and stores an active
    greeting. Always 200."""
    if not ingest_secret_ok(request):
        return ingest_auth_error()
    try:
        ctype = request.headers.get("content-type", "")
        if not ctype.startswith("multipart/form-data"):
            return {"status": "error", "detail": "multipart required"}
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            return {"status": "error", "detail": "no file"}
        file_bytes = await upload.read()
        mailbox = await _resolve_mailbox_for_ingest({"to_did": form.get("to_did")})
        if not mailbox:
            return {"status": "error", "detail": "no mailbox for this destination"}
        provider = vmc.get_kms_provider(mailbox["kek_provider"])
        if not provider.configured():
            return {"status": "error", "detail": "encryption not configured"}
        bucket, object_key, wrapped_dek, iv, kek_key_ref, enc_algo = await _encrypt_and_store(
            mailbox["customer_id"], mailbox["id"], mailbox["kek_provider"],
            mailbox.get("kek_key_ref"), file_bytes, "greeting",
        )
        greeting_type = form.get("greeting_type") or "unavailable"
        row = await db.fetch_one(
            """
            INSERT INTO voicemail_greetings
                (mailbox_id, greeting_type, bucket, object_key, wrapped_dek, iv,
                 kek_key_ref, enc_algo, is_active, schedule_kind)
            VALUES ($1::int, $2::text, $3::text, $4::text, $5::bytea, $6::bytea,
                    $7::text, $8::text, true, 'always')
            RETURNING id
            """,
            mailbox["id"], greeting_type, bucket, object_key, wrapped_dek, iv,
            kek_key_ref, enc_algo,
        )
        return {"status": "ok", "greeting_id": row["id"], "mailbox_id": mailbox["id"]}
    except Exception:
        logger.exception("Greeting ingest: unexpected error")
        return {"status": "error", "detail": "internal processing error"}


# ===========================================================================
# Settings + PIN
# ===========================================================================
@router.get("/mailboxes/{mailbox_id}/settings")
async def get_settings(
    mailbox_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    row = await db.fetch_one("SELECT * FROM voicemail_settings WHERE mailbox_id = $1", mailbox_id)
    if not row:
        # Return defaults so the UI has a stable shape before first save.
        return {
            "mailbox_id": mailbox_id, "notify_email": False, "notify_email_address": None,
            "attach_audio_to_email": False, "notify_sms": False, "notify_sms_number": None,
            "transcription_enabled": False, "transcription_language": "en",
            "greeting_mode": "standard", "updated_at": None,
        }
    return dict(row)


@router.put("/mailboxes/{mailbox_id}/settings")
async def update_settings(
    mailbox_id: int,
    body: SettingsUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    await _get_owned_mailbox(mailbox_id, customer_filter)
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    cols = list(data.keys())
    insert_cols = ["mailbox_id"] + cols
    placeholders = [f"${i + 1}" for i in range(len(insert_cols))]
    set_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    values = [mailbox_id] + [data[c] for c in cols]
    row = await db.fetch_one(
        f"""
        INSERT INTO voicemail_settings ({', '.join(insert_cols)})
        VALUES ({', '.join(placeholders)})
        ON CONFLICT (mailbox_id) DO UPDATE SET {set_clause}, updated_at = NOW()
        RETURNING *
        """,
        *values,
    )
    return dict(row)


@router.put("/mailboxes/{mailbox_id}/pin")
async def set_pin(
    mailbox_id: int,
    body: PinSet,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Set/replace the mailbox PIN (bcrypt). The PIN is never logged."""
    await _get_owned_mailbox(mailbox_id, customer_filter)
    await db.execute(
        "UPDATE voicemail_boxes SET pin_hash = $1, updated_at = NOW() WHERE id = $2",
        hash_password(body.pin), mailbox_id,
    )
    return {"status": "ok", "mailbox_id": mailbox_id, "has_pin": True}


# ===========================================================================
# LEGACY extension-bound endpoints (kept working; declared LAST so their root
# ``/{voicemail_id}`` param route never shadows the literal product routes
# above). These serve the pre-product UCaaS voicemail UI over plaintext rows.
# ===========================================================================
async def _get_user_extension_id(user: dict) -> int:
    user_id = int(user["sub"])
    row = await db.fetch_one(
        "SELECT id FROM extensions WHERE user_id = $1 AND status = 'active'", user_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="No active extension assigned to your account")
    return row["id"]


async def _verify_voicemail_access(voicemail_id: int, extension_id: int) -> dict:
    row = await db.fetch_one(
        """SELECT id, extension_id, mailbox_id, caller_id, caller_name, duration_ms,
                  storage_path, object_key, bucket, wrapped_dek, is_read, transcription,
                  created_at
           FROM voicemails WHERE id = $1 AND extension_id = $2""",
        voicemail_id, extension_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Voicemail not found")
    return dict(row)


@router.get("/count")
async def voicemail_count(user: dict = Depends(get_current_user)):
    """Legacy unread badge for the current user's extension."""
    extension_id = await _get_user_extension_id(user)
    row = await db.fetch_one(
        """SELECT COUNT(*) FILTER (WHERE is_read = false) AS unread, COUNT(*) AS total
           FROM voicemails WHERE extension_id = $1 AND deleted_at IS NULL""",
        extension_id,
    )
    return dict(row)


@router.get("")
async def list_voicemails(
    is_read: Optional[bool] = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    user: dict = Depends(get_current_user),
):
    """Legacy list for the current user's extension, newest first."""
    extension_id = await _get_user_extension_id(user)
    query = """
        SELECT id, extension_id, mailbox_id, caller_id, caller_name, duration_ms,
               storage_path, is_read, transcription, created_at,
               (wrapped_dek IS NOT NULL) AS encrypted
        FROM voicemails WHERE extension_id = $1 AND deleted_at IS NULL
    """
    values: list = [extension_id]
    idx = 2
    if is_read is not None:
        query += f" AND is_read = ${idx}"; values.append(is_read); idx += 1
    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])
    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.get("/{voicemail_id}")
async def get_voicemail(voicemail_id: int, user: dict = Depends(get_current_user)):
    extension_id = await _get_user_extension_id(user)
    return await _verify_voicemail_access(voicemail_id, extension_id)


@router.get("/{voicemail_id}/audio")
async def get_voicemail_audio_url(voicemail_id: int, user: dict = Depends(get_current_user)):
    """Legacy presigned-URL audio. Encrypted rows are NOT served here — they
    require the token→stream decrypt path (409 with a pointer)."""
    extension_id = await _get_user_extension_id(user)
    vm = await _verify_voicemail_access(voicemail_id, extension_id)

    if vm.get("wrapped_dek") is not None:
        raise HTTPException(
            status_code=409,
            detail="Encrypted voicemail — use POST /voicemail/messages/{id}/playback-token",
        )
    key = vm.get("object_key") or vm.get("storage_path")
    if not key:
        raise HTTPException(status_code=404, detail="No audio for this voicemail")
    if str(key).startswith("/"):
        raise HTTPException(status_code=409, detail="Voicemail audio is not in object storage")
    try:
        url = storage.presigned_get_url(
            vm.get("bucket") or storage.BUCKET_VOICEMAIL, key, ttl=VOICEMAIL_URL_TTL
        )
    except storage.StorageError:
        logger.exception("Failed to presign legacy voicemail %s", voicemail_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    return {"url": url, "expires_in": VOICEMAIL_URL_TTL}


@router.put("/{voicemail_id}/read")
async def mark_voicemail_read(voicemail_id: int, user: dict = Depends(get_current_user)):
    extension_id = await _get_user_extension_id(user)
    await _verify_voicemail_access(voicemail_id, extension_id)
    await db.execute("UPDATE voicemails SET is_read = true WHERE id = $1", voicemail_id)
    return {"status": "read", "voicemail_id": voicemail_id}


@router.delete("/{voicemail_id}")
async def delete_voicemail(voicemail_id: int, user: dict = Depends(get_current_user)):
    extension_id = await _get_user_extension_id(user)
    await _verify_voicemail_access(voicemail_id, extension_id)
    result = await db.execute(
        "DELETE FROM voicemails WHERE id = $1 AND extension_id = $2", voicemail_id, extension_id
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Voicemail not found")
    return {"status": "deleted", "voicemail_id": voicemail_id}
