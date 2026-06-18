"""Voicemail management endpoints for UCaaS.

Provides voicemail listing, read/unread tracking, deletion, and an
unauthenticated ingest endpoint for FreeSWITCH to deposit new messages.
"""
import os
import uuid
import logging
from fastapi import APIRouter, HTTPException, Depends, Request, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter
from services import storage

logger = logging.getLogger(__name__)

router = APIRouter()

# Default lifetime for presigned voicemail-audio URLs (seconds).
VOICEMAIL_URL_TTL = int(os.getenv("VOICEMAIL_URL_TTL", "3600"))


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class VoicemailIngest(BaseModel):
    """Payload sent by FreeSWITCH when depositing a voicemail."""
    extension: str
    customer_id: int
    caller_id: Optional[str] = None
    caller_name: Optional[str] = None
    duration_ms: Optional[int] = None
    storage_path: Optional[str] = None
    transcription: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_user_extension_id(user: dict) -> int:
    """Resolve the current user's extension id.

    A user is associated with exactly one extension via extensions.user_id.
    Raises 404 if the user has no extension assigned.
    """
    user_id = int(user["sub"])
    row = await db.fetch_one(
        "SELECT id FROM extensions WHERE user_id = $1 AND status = 'active'",
        user_id,
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No active extension assigned to your account",
        )
    return row["id"]


async def _verify_voicemail_access(
    voicemail_id: int,
    extension_id: int,
) -> dict:
    """Verify a voicemail belongs to the user's extension. Returns the row."""
    row = await db.fetch_one(
        """SELECT id, extension_id, caller_id, caller_name, duration_ms,
                  storage_path, is_read, transcription, created_at
           FROM voicemails WHERE id = $1 AND extension_id = $2""",
        voicemail_id,
        extension_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Voicemail not found")
    return dict(row)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/count")
async def voicemail_count(user: dict = Depends(get_current_user)):
    """Get unread voicemail count for the current user's extension (badge)."""
    extension_id = await _get_user_extension_id(user)
    row = await db.fetch_one(
        """SELECT
               COUNT(*) FILTER (WHERE is_read = false) AS unread,
               COUNT(*) AS total
           FROM voicemails WHERE extension_id = $1""",
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
    """List voicemails for the current user's extension, newest first."""
    extension_id = await _get_user_extension_id(user)

    query = """
        SELECT id, extension_id, caller_id, caller_name, duration_ms,
               storage_path, is_read, transcription, created_at
        FROM voicemails
        WHERE extension_id = $1
    """
    values: list = [extension_id]
    idx = 2

    if is_read is not None:
        query += f" AND is_read = ${idx}"
        values.append(is_read)
        idx += 1

    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.get("/{voicemail_id}")
async def get_voicemail(
    voicemail_id: int,
    user: dict = Depends(get_current_user),
):
    """Get a single voicemail's details."""
    extension_id = await _get_user_extension_id(user)
    return await _verify_voicemail_access(voicemail_id, extension_id)


@router.get("/{voicemail_id}/audio")
async def get_voicemail_audio_url(
    voicemail_id: int,
    user: dict = Depends(get_current_user),
):
    """Return a short-lived presigned URL to stream/download the voicemail audio.

    The audio lives in the voip-voicemail bucket under a tenant-scoped key
    (stored in voicemails.storage_path). A presigned GET keeps the object
    private — the browser never sees storage credentials.
    """
    extension_id = await _get_user_extension_id(user)
    vm = await _verify_voicemail_access(voicemail_id, extension_id)

    key = vm.get("storage_path")
    if not key:
        raise HTTPException(status_code=404, detail="No audio for this voicemail")

    # Legacy/local-path rows (pre-object-storage) cannot be presigned.
    if key.startswith("/"):
        raise HTTPException(
            status_code=409,
            detail="Voicemail audio is not in object storage",
        )

    try:
        url = storage.presigned_get_url(
            storage.BUCKET_VOICEMAIL, key, ttl=VOICEMAIL_URL_TTL
        )
    except storage.StorageError:
        logger.exception("Failed to presign voicemail %s", voicemail_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")

    return {"url": url, "expires_in": VOICEMAIL_URL_TTL}


@router.put("/{voicemail_id}/read")
async def mark_voicemail_read(
    voicemail_id: int,
    user: dict = Depends(get_current_user),
):
    """Mark a voicemail as read."""
    extension_id = await _get_user_extension_id(user)
    # Verify ownership first
    await _verify_voicemail_access(voicemail_id, extension_id)

    await db.execute(
        "UPDATE voicemails SET is_read = true WHERE id = $1",
        voicemail_id,
    )
    return {"status": "read", "voicemail_id": voicemail_id}


@router.delete("/{voicemail_id}")
async def delete_voicemail(
    voicemail_id: int,
    user: dict = Depends(get_current_user),
):
    """Delete a voicemail message."""
    extension_id = await _get_user_extension_id(user)
    # Verify ownership first
    await _verify_voicemail_access(voicemail_id, extension_id)

    result = await db.execute(
        "DELETE FROM voicemails WHERE id = $1 AND extension_id = $2",
        voicemail_id,
        extension_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Voicemail not found")
    return {"status": "deleted", "voicemail_id": voicemail_id}


# ---------------------------------------------------------------------------
# FreeSWITCH ingest (unauthenticated, like CDR ingest)
# ---------------------------------------------------------------------------

@router.post("/ingest")
async def ingest_voicemail(request: Request):
    """Receive a voicemail notification from FreeSWITCH.

    This endpoint is called by FreeSWITCH over the internal Docker network
    after a voicemail is deposited. No authentication is required.

    Always returns 200 to prevent FreeSWITCH retries.
    """
    try:
        body = await request.json()
    except Exception as e:
        logger.warning("Voicemail ingest: failed to parse body: %s", e)
        return {"status": "error", "detail": "invalid JSON"}

    try:
        extension_number = body.get("extension")
        customer_id = body.get("customer_id")

        if not extension_number or not customer_id:
            logger.warning(
                "Voicemail ingest: missing extension or customer_id"
            )
            return {"status": "error", "detail": "missing extension or customer_id"}

        # Resolve extension_id from extension number + customer
        ext_row = await db.fetch_one(
            """SELECT id FROM extensions
               WHERE extension = $1 AND customer_id = $2 AND voicemail_enabled = true""",
            str(extension_number),
            int(customer_id),
        )
        if not ext_row:
            logger.warning(
                "Voicemail ingest: extension %s not found or voicemail disabled "
                "for customer %s",
                extension_number,
                customer_id,
            )
            return {"status": "error", "detail": "extension not found or voicemail disabled"}

        extension_id = ext_row["id"]

        # FreeSWITCH writes the recording to the shared spool volume
        # (/media/spool/...). Upload it to the voip-voicemail bucket under a
        # tenant-scoped key so any media node can serve it via presigned URL.
        # storage_path persisted is the OBJECT KEY (not the local path).
        local_path = body.get("storage_path")
        object_key = None
        if local_path and os.path.isfile(local_path):
            try:
                basename = os.path.basename(local_path)
                object_key = storage.tenant_key(
                    int(customer_id),
                    "voicemail",
                    f"ext_{extension_id}",
                    f"{uuid.uuid4().hex}_{basename}",
                )
                ext = os.path.splitext(basename)[1].lower()
                content_type = "audio/wav" if ext in (".wav", "") else "application/octet-stream"
                storage.put_file(
                    storage.BUCKET_VOICEMAIL, object_key, local_path, content_type
                )
                # Best-effort: remove the spool copy after a successful upload.
                try:
                    os.remove(local_path)
                except OSError:
                    pass
            except Exception:
                logger.exception(
                    "Voicemail ingest: object-storage upload failed for %s; "
                    "persisting local path as fallback", local_path,
                )
                object_key = None

        # Store the object key when uploaded; otherwise fall back to whatever
        # path FS provided so the deposit is never lost.
        stored_path = object_key or local_path

        row = await db.fetch_one(
            """INSERT INTO voicemails
                   (extension_id, caller_id, caller_name, duration_ms,
                    storage_path, transcription)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id""",
            extension_id,
            body.get("caller_id"),
            body.get("caller_name"),
            body.get("duration_ms"),
            stored_path,
            body.get("transcription"),
        )

        logger.info(
            "Voicemail ingest: deposited id=%s for extension %s (customer %s)",
            row["id"],
            extension_number,
            customer_id,
        )
        return {"status": "ok", "voicemail_id": row["id"]}

    except Exception:
        logger.exception("Voicemail ingest: unexpected error")
        # Always return 200 so FreeSWITCH does not retry
        return {"status": "error", "detail": "internal processing error"}
