"""Carrier-trunk connectivity monitor — ingest + query.

A per-SBC poller (one per Kamailio SBC) reads that SBC's dispatcher OPTIONS
state and POSTs it here. We UPSERT one row per (carrier duid, reporting SBC)
into `carrier_trunk_status` on the East primary. Grafana's NOC map reads the
aggregated `carrier_trunk_health` view to color the carrier markers by REAL
reachability instead of deriving it from CDRs.

Endpoints:
  * POST /v1/carrier-status/report  — poller ingest. Shared-bearer auth
    (CARRIER_STATUS_TOKEN). Resilient like the CDR ingest: validates input,
    swallows transient DB errors, and returns 200 {"ok": true} so a hiccup
    never makes the pollers hot-loop. 400 only for a genuinely malformed body,
    401 for a missing/wrong token.
  * GET  /v1/carrier-status         — admin-only read of the health view (UI/debug).
"""
import hmac
import logging
import os

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import ORJSONResponse

from auth.dependencies import require_admin
from db import database as db

logger = logging.getLogger(__name__)

router = APIRouter()

# Max trunks accepted in a single report. The poller sends one entry per
# dispatcher destination (groups 2-5 => ~6 today); this bounds a malformed or
# hostile payload without ever rejecting a real report.
MAX_TRUNKS = 100


# ---------------------------------------------------------------------------
# Small JSON response helpers — keep the resilient ingest path from raising.
# ---------------------------------------------------------------------------
def _bad_request(detail: str) -> ORJSONResponse:
    """400 for a genuinely malformed body (not a transient/DB issue)."""
    return ORJSONResponse(status_code=400, content={"ok": False, "detail": detail})


def _unauthorized() -> ORJSONResponse:
    """401 for a missing/wrong shared bearer token."""
    return ORJSONResponse(status_code=401, content={"ok": False, "detail": "unauthorized"})


def _bearer_ok(authorization: str | None) -> bool:
    """Constant-time compare of the request bearer token against the env token.

    Returns False when CARRIER_STATUS_TOKEN is unset/empty (fail CLOSED — an
    unconfigured token must not silently accept every poller) or when the header
    is missing/malformed. hmac.compare_digest avoids leaking the token via timing.
    """
    expected = os.getenv("CARRIER_STATUS_TOKEN", "")
    if not expected:
        logger.error(
            "carrier-status report: CARRIER_STATUS_TOKEN is not set — rejecting "
            "(configure it to match the SBC pollers)"
        )
        return False
    if not authorization:
        return False
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return False
    return hmac.compare_digest(token, expected)


def _coerce_int(value):
    """Best-effort int coercion for setid; None on failure (never raises)."""
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


async def _upsert_trunk(sbc_id: str, trunk: dict) -> bool:
    """UPSERT one trunk row for one reporting SBC. Returns True on success.

    `last_change` is bumped ONLY when is_up actually flips relative to the stored
    row (CASE compares the existing carrier_trunk_status.is_up to EXCLUDED.is_up);
    `updated_at`, flags, name, ip, setid are refreshed on every report.

    Every parameter carries an explicit ::type cast — required for
    asyncpg + PgBouncer transaction pooling (no prepared-statement type inference).
    """
    duid = trunk.get("duid")
    if not duid or not isinstance(duid, str):
        logger.warning(
            "carrier-status report: skipping trunk with missing/invalid duid "
            "from sbc_id=%s: %r", sbc_id, trunk,
        )
        return False

    name = trunk.get("name")
    ip = trunk.get("ip")
    setid = _coerce_int(trunk.get("setid"))
    is_up = bool(trunk.get("is_up", False))
    flags = trunk.get("flags")

    # Normalize optional text fields to str|None so the ::text casts are clean.
    name = str(name) if name is not None else None
    ip = str(ip) if ip is not None else None
    flags = str(flags) if flags is not None else None

    await db.execute(
        """
        INSERT INTO carrier_trunk_status
            (duid, sbc_id, name, ip, setid, is_up, flags, last_change, updated_at)
        VALUES
            ($1::text, $2::text, $3::text, $4::text, $5::int, $6::bool, $7::text,
             now(), now())
        ON CONFLICT (duid, sbc_id) DO UPDATE SET
            name        = EXCLUDED.name,
            ip          = EXCLUDED.ip,
            setid       = EXCLUDED.setid,
            flags       = EXCLUDED.flags,
            is_up       = EXCLUDED.is_up,
            -- bump last_change only on an actual up<->down flip
            last_change = CASE
                WHEN carrier_trunk_status.is_up IS DISTINCT FROM EXCLUDED.is_up
                THEN now()
                ELSE carrier_trunk_status.last_change
            END,
            updated_at  = now()
        """,
        str(duid),    # $1 duid
        str(sbc_id),  # $2 sbc_id
        name,         # $3 name (str | None)
        ip,           # $4 ip (str | None)
        setid,        # $5 setid (int | None)
        is_up,        # $6 is_up (bool)
        flags,        # $7 flags (str | None)
    )
    return True


@router.post("/report")
async def report_carrier_status(
    request: Request,
    authorization: str | None = Header(default=None),
):
    """Ingest one SBC's dispatcher trunk-status snapshot.

    Body (FIXED CONTRACT):
        {
          "sbc_id": "east-sbc-1",
          "probed_at": "2026-07-27T15:00:00Z",
          "trunks": [
            {"duid":"bw-dallas-primary","name":"Bandwidth Dallas",
             "ip":"67.231.2.12","setid":2,"is_up":true,"flags":"AP"},
            ...
          ]
        }

    Auth: shared bearer token vs env CARRIER_STATUS_TOKEN (constant-time).
    Resilience: like CDR ingest, transient DB failures are swallowed and we
    return 200 {"ok": true} so the poller never hot-loops. 400 only for a
    genuinely malformed body; 401 for a missing/wrong token.
    """
    # --- Auth (before touching the body) ---
    if not _bearer_ok(authorization):
        return _unauthorized()

    # --- Parse body ---
    try:
        body = await request.json()
    except Exception as e:
        logger.warning("carrier-status report: failed to parse JSON body: %s", e)
        return _bad_request("invalid JSON")

    if not isinstance(body, dict):
        return _bad_request("expected a JSON object")

    sbc_id = body.get("sbc_id")
    if not sbc_id or not isinstance(sbc_id, str):
        return _bad_request("missing or invalid sbc_id")

    trunks = body.get("trunks")
    if not isinstance(trunks, list):
        return _bad_request("missing or invalid trunks array")

    if len(trunks) > MAX_TRUNKS:
        # Malformed/hostile — reject rather than write thousands of rows.
        logger.warning(
            "carrier-status report: sbc_id=%s sent %d trunks (max %d) — rejecting",
            sbc_id, len(trunks), MAX_TRUNKS,
        )
        return _bad_request(f"too many trunks: {len(trunks)} (max {MAX_TRUNKS})")

    # --- UPSERT each trunk independently. A single bad/failed row must not drop
    #     the rest, and any DB error is contained so we still return 200. ---
    updated = 0
    errors = 0
    for trunk in trunks:
        if not isinstance(trunk, dict):
            logger.warning(
                "carrier-status report: sbc_id=%s trunk entry not an object: %r",
                sbc_id, trunk,
            )
            errors += 1
            continue
        try:
            if await _upsert_trunk(sbc_id, trunk):
                updated += 1
            else:
                errors += 1
        except Exception:
            errors += 1
            logger.exception(
                "carrier-status report: DB error upserting trunk duid=%s sbc_id=%s",
                trunk.get("duid"), sbc_id,
            )

    logger.info(
        "carrier-status report: sbc_id=%s updated=%d errors=%d (of %d trunks)",
        sbc_id, updated, errors, len(trunks),
    )
    return {"ok": True, "updated": updated, "errors": errors}


@router.get("")
async def get_carrier_status(admin: dict = Depends(require_admin)):
    """Return aggregated carrier-trunk health (admin-only; UI/debug).

    Reads the `carrier_trunk_health` view: one row per carrier duid with
    up_sbcs/total_sbcs, the usable is_up (up on >=1 SBC), staleness, and a
    collapsed status ('up' | 'down' | 'stale').
    """
    rows = await db.fetch_all(
        """
        SELECT duid, name, ip, setid,
               up_sbcs, total_sbcs, is_up,
               last_updated, stale, status
        FROM carrier_trunk_health
        ORDER BY setid NULLS LAST, duid
        """
    )
    return {"trunks": [dict(r) for r in rows], "count": len(rows)}
