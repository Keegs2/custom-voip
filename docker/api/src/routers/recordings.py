"""Standalone call-recording endpoints (Phase 6 — media plane).

FreeSWITCH writes call recordings to the shared media spool
(``/media/spool/recordings/customer_<id>/<uuid>.wav``) and then notifies the API
via an unauthenticated ingest endpoint — the same resilient, always-200 pattern
as CDR and voicemail ingest. The API uploads the WAV to the ``voip-recordings``
object-storage bucket under a tenant-scoped key, persists a ``recordings`` row,
and serves the audio back to authenticated, tenant-scoped callers via short-lived
presigned URLs (no IDOR: a caller only ever sees its own customer's recordings;
admins see all).
"""
import os
import uuid
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter
from services import storage

logger = logging.getLogger(__name__)

router = APIRouter()

# Default lifetime for presigned recording-audio URLs (seconds).
RECORDING_URL_TTL = int(os.getenv("RECORDING_URL_TTL", "3600"))

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


async def _verify_recording_access(
    recording_id: int,
    customer_filter: Optional[int],
) -> dict:
    """Fetch a recording and enforce tenant scoping.

    Non-admins (``customer_filter`` is their customer_id) may only see their own
    recordings; admins (``customer_filter`` is None) see all. A cross-tenant id
    is indistinguishable from a missing one (404) to avoid leaking existence.
    """
    row = await db.fetch_one(
        """SELECT id, customer_id, call_uuid, recording_uuid, object_key, bucket,
                  duration_ms, kind, created_at
           FROM recordings WHERE id = $1""",
        recording_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="Recording not found")
    return dict(row)


# ---------------------------------------------------------------------------
# FreeSWITCH ingest (unauthenticated, like CDR / voicemail ingest)
# ---------------------------------------------------------------------------

@router.post("/ingest")
async def ingest_recording(request: Request):
    """Receive a recording notification from FreeSWITCH.

    Called over the internal Docker network after a recording is written to the
    shared spool. No authentication (JWT-exempt in middleware). Always returns a
    200 JSON body — errors are handled internally and logged — so FreeSWITCH's
    ``mod_*`` HTTP poster never retry-storms.
    """
    try:
        body = await request.json()
    except Exception as e:
        logger.warning("Recording ingest: failed to parse body: %s", e)
        return {"status": "error", "detail": "invalid JSON"}

    try:
        recording_uuid = body.get("recording_uuid")
        customer_id = body.get("customer_id")
        spool_path = body.get("spool_path")
        call_uuid = body.get("call_uuid")
        duration_ms = body.get("duration_ms")
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

        # Upload the WAV from the shared spool to the voip-recordings bucket under
        # a tenant-scoped key. object_key/bucket stay NULL on failure so the row
        # still records the call's existence (the deposit is never lost).
        object_key = None
        bucket = None
        safe_path = _safe_spool_path(spool_path)
        if safe_path and os.path.isfile(safe_path):
            try:
                basename = os.path.basename(safe_path)
                object_key = storage.tenant_key(
                    customer_id, "recordings", f"{uuid.uuid4().hex}_{basename}",
                )
                ext = os.path.splitext(basename)[1].lower()
                content_type = "audio/wav" if ext in (".wav", "") else "application/octet-stream"
                storage.put_file(
                    storage.BUCKET_RECORDINGS, object_key, safe_path, content_type
                )
                bucket = storage.BUCKET_RECORDINGS
                # Best-effort: drop the spool copy after a successful upload.
                try:
                    os.remove(safe_path)
                except OSError:
                    pass
            except Exception:
                logger.exception(
                    "Recording ingest: object-storage upload failed for %s; "
                    "persisting row without object_key", safe_path,
                )
                object_key = None
                bucket = None
        else:
            logger.warning(
                "Recording ingest: spool file missing/unsafe for recording_uuid=%s "
                "(spool_path=%s)", recording_uuid, spool_path,
            )

        row = await db.fetch_one(
            """INSERT INTO recordings
                   (customer_id, call_uuid, recording_uuid, object_key, bucket,
                    duration_ms, kind)
               VALUES ($1::int, $2::text, $3::text, $4::text, $5::text,
                       $6::int, $7::text)
               RETURNING id""",
            customer_id,
            call_uuid,
            str(recording_uuid),
            object_key,
            bucket,
            duration_ms,
            kind,
        )

        logger.info(
            "Recording ingest: stored id=%s uuid=%s customer=%s kind=%s key=%s",
            row["id"], recording_uuid, customer_id, kind, object_key,
        )
        return {"status": "ok", "recording_id": row["id"], "object_key": object_key}

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
    query = """
        SELECT id, customer_id, call_uuid, recording_uuid, object_key, bucket,
               duration_ms, kind, created_at
        FROM recordings
        WHERE 1=1
    """
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
    return [dict(r) for r in rows]


@router.get("/{recording_id}")
async def get_recording(
    recording_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Get a single recording's metadata (tenant-scoped)."""
    return await _verify_recording_access(recording_id, customer_filter)


@router.get("/{recording_id}/audio")
async def get_recording_audio(
    recording_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
):
    """Redirect (307) to a short-lived presigned URL for the recording audio.

    The object lives privately in the voip-recordings bucket under a tenant-scoped
    key — the browser never sees storage credentials.
    """
    rec = await _verify_recording_access(recording_id, customer_filter)

    key = rec.get("object_key")
    if not key:
        raise HTTPException(status_code=404, detail="No audio for this recording")

    # Legacy/local-path rows (should not occur post-object-storage) cannot presign.
    if key.startswith("/"):
        raise HTTPException(
            status_code=409, detail="Recording audio is not in object storage"
        )

    bucket = rec.get("bucket") or storage.BUCKET_RECORDINGS
    try:
        url = storage.presigned_get_url(bucket, key, ttl=RECORDING_URL_TTL)
    except storage.StorageError:
        logger.exception("Failed to presign recording %s", recording_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")

    return RedirectResponse(url=url, status_code=307)
