"""Standalone call-recording endpoints (Phase 6 — media plane) with
envelope-encryption-at-rest (compliance wedge).

FreeSWITCH writes call recordings to the shared media spool
(``/media/spool/recordings/customer_<id>/<uuid>.wav``) and then notifies the API
via an unauthenticated (ingest-secret) endpoint — the same resilient, always-200
pattern as CDR and voicemail ingest. The API ENVELOPE-ENCRYPTS the audio
(per-object AES-256-GCM DEK, KMS-wrapped KEK — see ``services/envelope_crypto``),
uploads the CIPHERTEXT to the ``voip-recordings`` bucket under a tenant-scoped
key, and persists a ``recordings`` row with the wrapped DEK + IV.

Playback mirrors the encrypted-voicemail model: a short-lived, tenant-scoped
playback token → a ``/stream`` endpoint that KMS-unwraps the DEK, AES-GCM
decrypts in memory, and serves the plaintext WAV with HTTP Range/206. Plaintext
never persists.

Back-compat / mixed state: encryption is the default but degrades gracefully.
Recordings ingested before this change (or when explicitly running plaintext) are
stored PLAINTEXT (``encryption_status='plaintext'``, ``wrapped_dek IS NULL``) and
keep being served by the original presigned-URL ``/audio`` path — nothing
re-encrypts or breaks already-stored recordings. ``RECORDINGS_ENCRYPTION`` selects
the mode: ``on`` (default — encrypt when a KEK is configured; plaintext fallback
is allowed in dev but NOT in production, where ``on`` behaves like ``require``),
``require`` (the intended PRODUCTION posture — encrypt or store metadata-only;
NEVER plaintext), ``off`` (always plaintext). MEDIUM-9: production therefore never
SILENTLY persists unencrypted call audio when a KEK is missing or a seal fails.

Tenant isolation everywhere: ``get_customer_filter`` + ``_verify_recording_access``
with 404-no-leak; a caller only ever sees/decrypts its own customer's recordings,
admins see all. Crypto-erase (retention / right-to-erasure) destroys the wrapped
DEK + ciphertext object so the recording is mathematically unrecoverable
(NIST SP 800-88), and writes a durable admin_audit_log row.
"""
import os
import uuid
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request, Query
from fastapi.responses import Response
from jose import jwt, JWTError
from pydantic import BaseModel

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter
from auth.security import JWT_SECRET, JWT_ALGORITHM
from auth.ingest import ingest_secret_ok, ingest_auth_error
from services import storage
from services import envelope_crypto as ec

logger = logging.getLogger(__name__)

router = APIRouter()

# Default lifetime for presigned recording-audio URLs (legacy plaintext rows).
RECORDING_URL_TTL = int(os.getenv("RECORDING_URL_TTL", "3600"))

# Scoped decrypt-stream playback-token lifetime (seconds). Short by design.
RECORDING_PLAYBACK_TTL = int(os.getenv("RECORDING_PLAYBACK_TTL", "120"))

# Encryption mode (MEDIUM-9): 'on' (encrypt when a KEK is configured — default),
# 'require' (encrypt or store metadata-only; NEVER write plaintext — the intended
# PRODUCTION posture), 'off' (never encrypt — legacy/explicit opt-out).
RECORDINGS_ENCRYPTION = os.getenv("RECORDINGS_ENCRYPTION", "on").lower()


def _plaintext_fallback_allowed() -> bool:
    """Whether an unencryptable recording may be persisted as PLAINTEXT (MEDIUM-9).

    * ``off``     — explicit opt-out → plaintext allowed.
    * ``require`` — encrypt-or-nothing → plaintext NEVER allowed.
    * ``on``      — default: plaintext allowed ONLY outside production. In
      production, ``on`` behaves like ``require`` (encrypt-or-metadata-only) so we
      never SILENTLY persist unencrypted call audio when a KEK is merely missing
      or a seal transiently fails. (The compose default stays the infra lane; this
      just makes the code path safe by default in prod.)
    """
    if RECORDINGS_ENCRYPTION == "off":
        return True
    if RECORDINGS_ENCRYPTION == "require":
        return False
    from config_guard import is_production
    return not is_production()

# Shared spool root the API container mounts (media_spool volume). FS-supplied
# paths are confined to this root so an unauthenticated ingest can never make us
# read arbitrary files.
SPOOL_ROOT = os.getenv("MEDIA_SPOOL_ROOT", "/media/spool")

# Recognised recording kinds (others are normalised to 'call').
VALID_KINDS = {"programmable", "call", "conference"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RecordingIngest(BaseModel):
    """Payload FreeSWITCH POSTs after a recording finishes."""
    recording_uuid: str
    customer_id: int
    spool_path: str
    call_uuid: Optional[str] = None
    duration_ms: Optional[int] = None
    kind: Optional[str] = "call"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _recording_scope(customer_id: int) -> str:
    """Stable KEK scope for a customer's call recordings (one KEK per customer)."""
    return f"recordings:customer:{int(customer_id)}"


def _safe_spool_path(spool_path: Optional[str]) -> Optional[str]:
    """Resolve and confine an FS-supplied spool path to ``SPOOL_ROOT``.

    The ingest endpoint is unauthenticated, so we never trust the path blindly:
    the resolved real path MUST live under the shared spool root, otherwise it is
    refused (defends against ``../`` traversal and absolute paths to other files
    in the container). Returns the safe absolute path, or None if rejected.
    """
    if not spool_path:
        return None
    root = os.path.realpath(SPOOL_ROOT)
    real = os.path.realpath(spool_path)
    if real == root or real.startswith(root + os.sep):
        return real
    logger.warning("Recording ingest: rejected out-of-spool path %s", spool_path)
    return None


async def _load_recording(recording_id: int) -> Optional[dict]:
    """Load a recording row as a dict (SELECT * so it works whether or not the
    envelope-encryption migration has been applied — new columns simply read back
    as absent/None on an un-migrated DB, i.e. treated as plaintext)."""
    row = await db.fetch_one("SELECT * FROM recordings WHERE id = $1", recording_id)
    return dict(row) if row else None


async def _verify_recording_access(
    recording_id: int,
    customer_filter: Optional[int],
) -> dict:
    """Fetch a recording and enforce tenant scoping.

    Non-admins (``customer_filter`` is their customer_id) may only see their own
    recordings; admins (``customer_filter`` is None) see all. A cross-tenant id
    is indistinguishable from a missing one (404) to avoid leaking existence.
    """
    row = await _load_recording(recording_id)
    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="Recording not found")
    return row


def _is_encrypted(rec: dict) -> bool:
    """A recording is encrypted iff it carries a wrapped DEK."""
    return rec.get("wrapped_dek") is not None


def _public_recording(rec: dict) -> dict:
    """Serialize a recording for API responses (never leak key material)."""
    return {
        "id": rec["id"],
        "customer_id": rec["customer_id"],
        "call_uuid": rec.get("call_uuid"),
        "recording_uuid": rec.get("recording_uuid"),
        "object_key": rec.get("object_key"),
        "bucket": rec.get("bucket"),
        "duration_ms": rec.get("duration_ms"),
        "kind": rec.get("kind"),
        "encrypted": _is_encrypted(rec),
        "encryption_status": rec.get("encryption_status")
            or ("encrypted" if _is_encrypted(rec) else "plaintext"),
        "created_at": rec.get("created_at"),
    }


def _audit_media(action: str, *, recording_id: int, customer_id: int, actor, source: str):
    """Structured decrypt/erase audit line for a recording (SIEM-greppable).

    Recordings have no dedicated access-log table (voicemail has
    voicemail_access_log); a unified media_access_log is the documented next step.
    Crypto-erase ALSO persists to admin_audit_log (see the erase endpoint)."""
    try:
        actor_id = actor.get("sub") if isinstance(actor, dict) else actor
        logger.info(
            "MEDIA_ACCESS action=%s recording=%s customer=%s actor=%s source=%s",
            action, recording_id, customer_id, actor_id, source,
        )
    except Exception:  # noqa: BLE001 — auditing must never break the request
        logger.debug("recording media audit emit failed", exc_info=True)


async def _admin_audit(action: str, *, actor: dict, target_id, detail: Optional[dict] = None,
                       ip: Optional[str] = None) -> None:
    """Best-effort durable admin audit row for a destructive recording action.
    Never raises into the request (SOC 2 audit trail; see routers/customers.py)."""
    try:
        import json
        await db.execute(
            """
            INSERT INTO admin_audit_log
                (actor_user_id, actor_email, action, target_type, target_id, detail, ip_address)
            VALUES ($1::int, $2::text, $3::text, 'recording', $4::text, $5::jsonb, $6::text)
            """,
            int(actor["sub"]) if actor.get("sub") is not None else None,
            actor.get("email"), action, str(target_id),
            json.dumps(detail) if detail else None, ip,
        )
    except Exception:
        logger.debug("recording admin audit persist failed", exc_info=True)


# --- scoped playback tokens (mirror the voicemail vm_play model) ------------
def _mint_playback_token(recording_id: int, user: dict) -> str:
    """Mint a short-lived scoped HS256 token for one recording's decrypt-stream."""
    now = datetime.now(timezone.utc)
    claims = {
        "typ": "rec_play",
        "id": recording_id,
        "sub": str(user.get("sub")),
        "customer_id": user.get("customer_id"),
        "role": user.get("role"),
        "iat": now,
        "exp": now + timedelta(seconds=RECORDING_PLAYBACK_TTL),
    }
    return jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _verify_playback_token(token: str, recording_id: int) -> dict:
    """Validate a rec_play token for ``recording_id``. Raises 401 on any fault."""
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired playback token")
    if claims.get("typ") != "rec_play":
        raise HTTPException(status_code=401, detail="Invalid playback token type")
    if int(claims.get("id", -1)) != int(recording_id):
        raise HTTPException(status_code=401, detail="Playback token does not match resource")
    return claims


# --- Range / 206 (small in-memory buffers; mirrors voicemail _audio_response) --
def _compute_range(size: int, range_header: Optional[str]):
    """Parse a single-range ``Range`` header against ``size``.

    Returns ``(start, end)`` inclusive, ``None`` to serve the whole body, or the
    sentinel ``"unsatisfiable"`` for a valid out-of-bounds range (→ HTTP 416).
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
    """Serve a decrypted WAV buffer with Range/206 + no-store."""
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
    chunk = data[start:end + 1]
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(len(chunk))
    return Response(content=chunk, status_code=206, media_type="audio/wav", headers=headers)


# --- ingest storage helpers -------------------------------------------------
async def _store_plaintext(customer_id: int, basename: str, payload: bytes,
                           content_type: str) -> tuple[str, str]:
    """Upload plaintext bytes to the recordings bucket (legacy behavior)."""
    object_key = storage.tenant_key(customer_id, "recordings", f"{uuid.uuid4().hex}_{basename}")
    await asyncio.to_thread(storage.put_file, storage.BUCKET_RECORDINGS, object_key, payload, content_type)
    return object_key, storage.BUCKET_RECORDINGS


async def _store_encrypted(customer_id: int, basename: str, payload: bytes):
    """Envelope-encrypt ``payload`` and upload the ciphertext. Returns
    ``(object_key, bucket, Envelope)``."""
    kek_provider, kek_key_ref = await ec.resolve_or_create_kek(
        _recording_scope(customer_id), customer_id
    )
    env = await ec.seal(payload, kek_provider=kek_provider, kek_key_ref=kek_key_ref)
    object_key = storage.tenant_key(customer_id, "recordings", f"{uuid.uuid4().hex}_{basename}.enc")
    await asyncio.to_thread(
        storage.put_file, storage.BUCKET_RECORDINGS, object_key, env.ciphertext,
        "application/octet-stream",
    )
    return object_key, storage.BUCKET_RECORDINGS, env


# ---------------------------------------------------------------------------
# FreeSWITCH ingest (unauthenticated, ingest-secret; like CDR / voicemail ingest)
# ---------------------------------------------------------------------------

@router.post("/ingest")
async def ingest_recording(request: Request):
    """Receive + encrypt-at-rest a recording from FreeSWITCH.

    SEC-2: requires the shared ``X-Ingest-Secret`` header (constant-time compared
    to env ``INGEST_SHARED_SECRET``); an unset secret allows in dev with a loud
    warning.

    PROD-2 (cross-VM media): production FreeSWITCH POSTs the audio FILE itself via
    ``multipart/form-data`` (field ``file``); LOCAL fallback reads ``spool_path``
    from the shared ``/media/spool`` volume. Either way the audio is
    ENVELOPE-ENCRYPTED (default) and the CIPHERTEXT uploaded to object storage.

    Always returns 200 on processing errors — handled internally and logged — so
    FreeSWITCH's HTTP poster never retry-storms (rule #11).
    """
    if not ingest_secret_ok(request):
        return ingest_auth_error()

    # Parse metadata + optional uploaded audio from EITHER multipart or JSON.
    file_bytes: Optional[bytes] = None
    file_name: Optional[str] = None
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/form-data"):
            form = await request.form()
            body = {
                "recording_uuid": form.get("recording_uuid"),
                "customer_id": form.get("customer_id"),
                "spool_path": form.get("spool_path"),
                "call_uuid": form.get("call_uuid"),
                "duration_ms": form.get("duration_ms"),
                "kind": form.get("kind"),
            }
            upload = form.get("file")
            if upload is not None and hasattr(upload, "read"):
                file_bytes = await upload.read()
                file_name = getattr(upload, "filename", None) or "recording.wav"
        else:
            body = await request.json()
    except Exception as e:
        logger.warning("Recording ingest: failed to parse body: %s", e)
        return {"status": "error", "detail": "invalid body"}

    try:
        recording_uuid = body.get("recording_uuid")
        customer_id = body.get("customer_id")
        spool_path = body.get("spool_path")
        call_uuid = body.get("call_uuid")
        duration_ms = body.get("duration_ms")
        if duration_ms is not None:
            try:
                duration_ms = int(duration_ms)
            except (TypeError, ValueError):
                duration_ms = None
        kind = (body.get("kind") or "call").lower()

        if not recording_uuid or customer_id is None:
            logger.warning("Recording ingest: missing recording_uuid or customer_id")
            return {"status": "error", "detail": "missing recording_uuid or customer_id"}

        customer_id = int(customer_id)
        if kind not in VALID_KINDS:
            kind = "call"

        # Idempotency: FS may re-notify. If we already have this recording, ack.
        existing = await db.fetch_one(
            "SELECT id, object_key FROM recordings WHERE recording_uuid = $1",
            str(recording_uuid),
        )
        if existing:
            logger.info(
                "Recording ingest: duplicate recording_uuid=%s (id=%s)",
                recording_uuid, existing["id"],
            )
            return {
                "status": "ok",
                "recording_id": existing["id"],
                "object_key": existing["object_key"],
                "duplicate": True,
            }

        # Obtain the raw audio bytes from EITHER the multipart file (cross-VM
        # prod) or the shared spool path (single-host dev).
        payload: Optional[bytes] = None
        source_name = "recording.wav"
        spool_to_remove: Optional[str] = None
        if file_bytes is not None:
            payload = file_bytes
            source_name = file_name or "recording.wav"
        else:
            safe_path = _safe_spool_path(spool_path)
            if safe_path and os.path.isfile(safe_path):
                try:
                    with open(safe_path, "rb") as f:
                        payload = f.read()
                    source_name = os.path.basename(safe_path)
                    spool_to_remove = safe_path
                except Exception:
                    logger.exception("Recording ingest: could not read spool file %s", safe_path)
                    payload = None
            else:
                logger.warning(
                    "Recording ingest: no multipart file and spool file "
                    "missing/unsafe for recording_uuid=%s (spool_path=%s)",
                    recording_uuid, spool_path,
                )

        # Store (encrypted by default). object_key/bucket stay NULL on failure so
        # the row still records the call's existence (deposit is never lost).
        object_key = None
        bucket = None
        wrapped_dek = iv = kek_key_ref = kek_provider = enc_algo = None
        encryption_status = "plaintext"

        if payload is not None:
            basename = os.path.basename(source_name or "recording.wav")
            ext = os.path.splitext(basename)[1].lower()
            content_type = "audio/wav" if ext in (".wav", "") else "application/octet-stream"
            want_encrypt = RECORDINGS_ENCRYPTION in ("on", "require")
            provider_ok = ec.encryption_configured()
            # MEDIUM-9: is plaintext a permitted fallback at all? (No in 'require',
            # and no in production 'on'.)
            plaintext_ok = _plaintext_fallback_allowed()

            if want_encrypt and provider_ok:
                try:
                    object_key, bucket, env = await _store_encrypted(customer_id, basename, payload)
                    wrapped_dek, iv, enc_algo = env.wrapped_dek, env.iv, env.enc_algo
                    kek_provider, kek_key_ref = env.kek_provider, env.kek_key_ref
                    encryption_status = "encrypted"
                except Exception:
                    logger.exception(
                        "Recording ingest: envelope encryption failed for uuid=%s", recording_uuid
                    )
                    object_key = bucket = None
                    wrapped_dek = iv = kek_key_ref = kek_provider = enc_algo = None
                    if plaintext_ok:
                        try:
                            object_key, bucket = await _store_plaintext(
                                customer_id, basename, payload, content_type
                            )
                            encryption_status = "plaintext"
                        except Exception:
                            logger.exception(
                                "Recording ingest: plaintext fallback upload failed for uuid=%s",
                                recording_uuid,
                            )
                    else:
                        # Confidentiality > durability: never write plaintext.
                        logger.error(
                            "Recording ingest: encryption expected (mode=%s) but the seal "
                            "failed and plaintext is not permitted — storing metadata only "
                            "(no plaintext) for uuid=%s", RECORDINGS_ENCRYPTION, recording_uuid,
                        )
                        encryption_status = "pending"
            elif want_encrypt and not provider_ok and not plaintext_ok:
                # Encryption expected but no KEK, and plaintext not permitted
                # ('require', or production 'on') — persist metadata only.
                logger.error(
                    "Recording ingest: encryption expected (mode=%s) but no KEK is "
                    "configured and plaintext is not permitted; storing metadata only "
                    "(no plaintext) for uuid=%s", RECORDINGS_ENCRYPTION, recording_uuid,
                )
                encryption_status = "pending"
            else:
                # Plaintext path: mode 'off', or 'on' with no KEK outside production.
                try:
                    object_key, bucket = await _store_plaintext(
                        customer_id, basename, payload, content_type
                    )
                    encryption_status = "plaintext"
                except Exception:
                    logger.exception(
                        "Recording ingest: object-storage upload failed for uuid=%s; "
                        "persisting row without object_key", recording_uuid,
                    )

            # Best-effort: drop the spool copy after a successful upload.
            if spool_to_remove and object_key:
                try:
                    os.remove(spool_to_remove)
                except OSError:
                    pass

        # Persist the row. Only reference the envelope columns when we actually
        # encrypted — the legacy INSERT keeps working on databases where the
        # envelope-encryption migration has not (yet) been applied.
        if encryption_status == "encrypted":
            row = await db.fetch_one(
                """INSERT INTO recordings
                       (customer_id, call_uuid, recording_uuid, object_key, bucket,
                        duration_ms, kind, wrapped_dek, iv, kek_provider, kek_key_ref,
                        enc_algo, encryption_status)
                   VALUES ($1::int, $2::text, $3::text, $4::text, $5::text,
                           $6::int, $7::text, $8::bytea, $9::bytea, $10::text,
                           $11::text, $12::text, $13::text)
                   RETURNING id""",
                customer_id, call_uuid, str(recording_uuid), object_key, bucket,
                duration_ms, kind, wrapped_dek, iv, kek_provider, kek_key_ref,
                enc_algo, encryption_status,
            )
        else:
            row = await db.fetch_one(
                """INSERT INTO recordings
                       (customer_id, call_uuid, recording_uuid, object_key, bucket,
                        duration_ms, kind)
                   VALUES ($1::int, $2::text, $3::text, $4::text, $5::text,
                           $6::int, $7::text)
                   RETURNING id""",
                customer_id, call_uuid, str(recording_uuid), object_key, bucket,
                duration_ms, kind,
            )

        logger.info(
            "Recording ingest: stored id=%s uuid=%s customer=%s kind=%s enc=%s key=%s",
            row["id"], recording_uuid, customer_id, kind, encryption_status, object_key,
        )
        return {
            "status": "ok",
            "recording_id": row["id"],
            "object_key": object_key,
            "encryption_status": encryption_status,
        }

    except Exception:
        logger.exception("Recording ingest: unexpected error")
        # Always return 200 so FreeSWITCH does not retry.
        return {"status": "error", "detail": "internal processing error"}


# ---------------------------------------------------------------------------
# Tenant-scoped read API
# ---------------------------------------------------------------------------

@router.get("")
async def list_recordings(
    call_uuid: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """List recordings, newest first. Scoped to the caller's customer; admins
    (customer_filter=None) see all. Optional ``call_uuid`` / ``kind`` filters."""
    query = "SELECT * FROM recordings WHERE 1=1"
    values: list = []
    idx = 1

    if customer_filter is not None:
        query += f" AND customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    if call_uuid:
        query += f" AND call_uuid = ${idx}"
        values.append(call_uuid)
        idx += 1
    if kind:
        query += f" AND kind = ${idx}"
        values.append(kind)
        idx += 1

    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    return [_public_recording(dict(r)) for r in rows]


@router.get("/{recording_id}")
async def get_recording(
    recording_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Get a single recording's metadata (tenant-scoped)."""
    return _public_recording(await _verify_recording_access(recording_id, customer_filter))


@router.get("/{recording_id}/audio")
async def get_recording_audio(
    recording_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Presigned-URL audio for a PLAINTEXT recording (legacy / encryption-off).

    Encrypted recordings are NOT served here (the object is ciphertext); they use
    the token→stream decrypt path — this returns 409 with a pointer, mirroring the
    encrypted-voicemail ``/audio`` contract.
    """
    rec = await _verify_recording_access(recording_id, customer_filter)

    if _is_encrypted(rec):
        raise HTTPException(
            status_code=409,
            detail="Encrypted recording — use POST /recordings/{id}/playback-token then /stream",
        )

    key = rec.get("object_key")
    if not key:
        raise HTTPException(status_code=404, detail="No audio for this recording")
    # Legacy/local-path rows (should not occur post-object-storage) cannot presign.
    if str(key).startswith("/"):
        raise HTTPException(status_code=409, detail="Recording audio is not in object storage")

    bucket = rec.get("bucket") or storage.BUCKET_RECORDINGS
    try:
        url = storage.presigned_get_url(bucket, key, ttl=RECORDING_URL_TTL)
    except storage.StorageError:
        logger.exception("Failed to presign recording %s", recording_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")

    _audit_media("play_presigned", recording_id=recording_id,
                 customer_id=rec["customer_id"], actor=user, source="ui")
    return {"url": url, "expires_in": RECORDING_URL_TTL}


@router.post("/{recording_id}/playback-token")
async def recording_playback_token(
    recording_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Mint a short-lived scoped stream token for an owned recording (encrypted
    playback). Mirrors the voicemail message playback-token model."""
    await _verify_recording_access(recording_id, customer_filter)
    token = _mint_playback_token(recording_id, user)
    return {
        "stream_url": f"/v1/recordings/{recording_id}/stream?t={token}",
        "expires_in": RECORDING_PLAYBACK_TTL,
    }


@router.get("/{recording_id}/stream")
async def stream_recording(
    recording_id: int,
    request: Request,
    t: Optional[str] = Query(default=None),
    download: int = 0,
):
    """Decrypt-stream playback of an ENCRYPTED recording.

    Two accepted auth modes:
      1. A scoped ``?t=`` playback token (for a bare ``<audio src>`` / ``<a
         download>``; requires the media-stream middleware carve-out — see the
         handoff notes). The token itself is the capability (minted only after an
         authorized playback-token request), re-validated against ``recording_id``
         and the row's customer here (defense in depth).
      2. A normal Bearer JWT (works today; the frontend fetch()es the stream and
         plays it from a Blob). Tenant-scoped via ``get_customer_filter``.

    Decrypts in memory and serves the plaintext WAV with Range/206 + no-store.
    """
    if t:
        claims = _verify_playback_token(t, recording_id)
        rec = await _load_recording(recording_id)
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        tok_customer = claims.get("customer_id")
        if tok_customer is not None and rec["customer_id"] != tok_customer:
            raise HTTPException(status_code=401, detail="Playback token customer mismatch")
        actor = {"sub": claims.get("sub"), "email": None}
    else:
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        customer_filter = None if user.get("role") == "admin" else user.get("customer_id")
        rec = await _verify_recording_access(recording_id, customer_filter)
        actor = user

    if not _is_encrypted(rec):
        raise HTTPException(status_code=409, detail="Recording is not encrypted — use GET /audio")

    key = rec.get("object_key")
    if not key:
        raise HTTPException(status_code=404, detail="No audio for this recording")

    _audit_media("download" if download else "play", recording_id=recording_id,
                 customer_id=rec["customer_id"], actor=actor, source="ui")

    try:
        ciphertext = await asyncio.to_thread(
            storage.get_bytes, rec.get("bucket") or storage.BUCKET_RECORDINGS, key
        )
        plaintext = await ec.open_envelope(
            ciphertext, bytes(rec["iv"]), bytes(rec["wrapped_dek"]),
            kek_provider=rec.get("kek_provider") or "local", kek_key_ref=rec["kek_key_ref"],
        )
    except storage.StorageError:
        logger.exception("Recording stream: storage error for %s", recording_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    except Exception:
        logger.exception("Recording stream: decrypt failed for %s", recording_id)
        raise HTTPException(status_code=500, detail="Could not decrypt recording")

    dl_name = f"recording_{recording_id}.wav" if download else None
    return _audio_response(plaintext, request.headers.get("range"), dl_name)


@router.delete("/{recording_id}")
async def crypto_erase_recording(
    recording_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Crypto-erase a recording (retention / right-to-erasure).

    Destroys the ciphertext object AND the wrapped DEK so the recording is
    mathematically unrecoverable (NIST SP 800-88 cryptographic erase); the row is
    kept as a tombstone (``encryption_status='crypto_erased'``, object_key NULL).
    Tenant-scoped (owner or admin, 404-no-leak) and written to admin_audit_log.
    """
    rec = await _verify_recording_access(recording_id, customer_filter)

    # 1) Delete the object (ciphertext for encrypted rows; plaintext for legacy).
    bucket, key = rec.get("bucket"), rec.get("object_key")
    if bucket and key and not str(key).startswith("/"):
        try:
            await asyncio.to_thread(storage.delete, bucket, key)
        except Exception:
            logger.warning("crypto_erase: object delete failed for recording %s",
                           recording_id, exc_info=True)

    # 2) Destroy the wrapped DEK + object pointer. Always-present columns first;
    #    envelope columns best-effort so this also works on an un-migrated DB.
    await db.execute(
        "UPDATE recordings SET object_key = NULL, bucket = NULL WHERE id = $1",
        recording_id,
    )
    try:
        await db.execute(
            "UPDATE recordings SET wrapped_dek = NULL, iv = NULL, kek_key_ref = NULL, "
            "encryption_status = 'crypto_erased' WHERE id = $1",
            recording_id,
        )
    except Exception:
        logger.debug("crypto_erase: envelope columns absent (un-migrated DB) for %s",
                     recording_id, exc_info=True)

    ip = request.client.host if request.client else None
    await _admin_audit("recording_crypto_erase", actor=user, target_id=recording_id,
                       detail={"was_encrypted": _is_encrypted(rec), "kind": rec.get("kind")},
                       ip=ip)
    _audit_media("crypto_erase", recording_id=recording_id,
                 customer_id=rec["customer_id"], actor=user, source="ui")
    return {"status": "crypto_erased", "recording_id": recording_id}
