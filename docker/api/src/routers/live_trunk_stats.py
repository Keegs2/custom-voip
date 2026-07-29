"""Live customer-SIP-trunk stats — ingest + query (Prometheus escape hatch).

The metrics plane keeps a hard cardinality contract: customer identifiers never
become Prometheus labels. Carrier trunks (a closed enum) are safe as labels;
CUSTOMER SIP trunks are hundreds -> thousands, so their per-trunk LIVE detail
lives in Postgres instead of exploding VictoriaMetrics active-series. A per-SBC
feeder (the carrier-monitor sidecar) derives per-customer-trunk active_channels,
cps, and registration from kamcmd and POSTs it here. We UPSERT one row per
(customer_id, trunk_id, reporting SBC) into `live_trunk_stats` on the East
primary. Grafana/CRAG read the aggregated `live_trunk_health` view to drill into
a customer's live trunk load without any per-trunk metric series.

Endpoints:
  * POST /v1/live-trunk-stats/report  — feeder ingest. Shared-bearer auth
    (LIVE_TRUNK_STATS_TOKEN). Resilient like the CDR ingest: validates input,
    swallows transient DB errors, and returns 200 {"ok": true} so a hiccup never
    makes the feeders hot-loop. 400 only for a genuinely malformed body, 401 for
    a missing/wrong token.
  * GET  /v1/live-trunk-stats          — admin-only read of the health view (CRAG/debug).
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

# Max trunks accepted in a single report. A single SBC can carry a large customer
# fleet, so this is set generously — it bounds a malformed or hostile payload
# without ever rejecting a real report from a busy SBC.
MAX_TRUNKS = 5000


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

    Returns False when LIVE_TRUNK_STATS_TOKEN is unset/empty (fail CLOSED — an
    unconfigured token must not silently accept every feeder) or when the header
    is missing/malformed. hmac.compare_digest avoids leaking the token via timing.
    """
    expected = os.getenv("LIVE_TRUNK_STATS_TOKEN", "")
    if not expected:
        logger.error(
            "live-trunk-stats report: LIVE_TRUNK_STATS_TOKEN is not set — rejecting "
            "(configure it to match the SBC feeders)"
        )
        return False
    if not authorization:
        return False
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return False
    return hmac.compare_digest(token, expected)


def _coerce_int(value):
    """Best-effort int coercion; None on failure (never raises)."""
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def _coerce_float(value):
    """Best-effort float coercion; None on failure (never raises)."""
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


async def _upsert_trunk(sbc_id: str, trunk: dict) -> bool:
    """UPSERT one customer-trunk row for one reporting SBC. Returns True on success.

    `active_channels` / `cps_1m` / `asr_5m` / `registered` / `trunk_name` and
    `updated_at` are refreshed on every report for this (customer_id, trunk_id,
    sbc_id) triple.

    Every parameter carries an explicit ::type cast — required for
    asyncpg + PgBouncer transaction pooling (no prepared-statement type inference).
    """
    customer_id = _coerce_int(trunk.get("customer_id"))
    trunk_id = _coerce_int(trunk.get("trunk_id"))
    if trunk_id is None:
        logger.warning(
            "live-trunk-stats report: skipping trunk with missing/invalid "
            "trunk_id from sbc_id=%s: %r", sbc_id, trunk,
        )
        return False

    # customer_id may arrive as 0 (sentinel) or None from a poller that only knows
    # the trunk_id — e.g. the SBC feeder reads the `trunk_cps` htable, which is
    # keyed by trunk id with no owning-customer context. Resolve the owner from
    # sip_trunks (id -> customer_id, one indexed lookup). If it can't be resolved,
    # skip the row rather than persist a bogus customer_id=0 (which is part of the
    # (customer_id, trunk_id, sbc_id) primary key).
    if not customer_id:
        owner = await db.fetch_one(
            "SELECT customer_id FROM sip_trunks WHERE id = $1::int", trunk_id
        )
        customer_id = owner["customer_id"] if owner else None
        if customer_id is None:
            logger.warning(
                "live-trunk-stats report: could not resolve customer_id for "
                "trunk_id=%s from sbc_id=%s; skipping", trunk_id, sbc_id,
            )
            return False

    trunk_name = trunk.get("trunk_name")
    # active_channels / cps_1m are NOT NULL DEFAULT 0 in the table — default a
    # missing/unparseable value to 0 rather than dropping the whole row.
    active_channels = _coerce_int(trunk.get("active_channels"))
    if active_channels is None:
        active_channels = 0
    cps_1m = _coerce_float(trunk.get("cps_1m"))
    if cps_1m is None:
        cps_1m = 0.0
    asr_5m = _coerce_float(trunk.get("asr_5m"))  # nullable — unknown stays NULL

    # registered is a nullable tri-state (True/False/unknown); only coerce a real
    # bool, leave None (unknown) untouched so it maps to SQL NULL.
    registered_raw = trunk.get("registered")
    registered = bool(registered_raw) if registered_raw is not None else None

    # Normalize optional text field to str|None so the ::text cast is clean.
    trunk_name = str(trunk_name) if trunk_name is not None else None

    await db.execute(
        """
        INSERT INTO live_trunk_stats
            (customer_id, trunk_id, sbc_id, trunk_name, active_channels,
             cps_1m, asr_5m, registered, updated_at)
        VALUES
            ($1::int, $2::int, $3::text, $4::text, $5::int,
             $6::numeric, $7::numeric, $8::bool, now())
        ON CONFLICT (customer_id, trunk_id, sbc_id) DO UPDATE SET
            trunk_name      = EXCLUDED.trunk_name,
            active_channels = EXCLUDED.active_channels,
            cps_1m          = EXCLUDED.cps_1m,
            asr_5m          = EXCLUDED.asr_5m,
            registered      = EXCLUDED.registered,
            updated_at      = now()
        """,
        customer_id,      # $1 customer_id
        trunk_id,         # $2 trunk_id
        str(sbc_id),      # $3 sbc_id
        trunk_name,       # $4 trunk_name (str | None)
        active_channels,  # $5 active_channels (int)
        cps_1m,           # $6 cps_1m (float)
        asr_5m,           # $7 asr_5m (float | None)
        registered,       # $8 registered (bool | None)
    )
    return True


@router.post("/report")
async def report_live_trunk_stats(
    request: Request,
    authorization: str | None = Header(default=None),
):
    """Ingest one SBC's live customer-trunk snapshot.

    Body (FIXED CONTRACT):
        {
          "sbc_id": "east-sbc-1",
          "trunks": [
            {"customer_id": 42, "trunk_id": 7, "trunk_name": "Acme Main",
             "active_channels": 12, "cps_1m": 3.5, "asr_5m": 61.2,
             "registered": true},
            ...
          ]
        }

    Auth: shared bearer token vs env LIVE_TRUNK_STATS_TOKEN (constant-time).
    Resilience: like CDR ingest, transient DB failures are swallowed and we
    return 200 {"ok": true} so the feeder never hot-loops. 400 only for a
    genuinely malformed body; 401 for a missing/wrong token.
    """
    # --- Auth (before touching the body) ---
    if not _bearer_ok(authorization):
        return _unauthorized()

    # --- Parse body ---
    try:
        body = await request.json()
    except Exception as e:
        logger.warning("live-trunk-stats report: failed to parse JSON body: %s", e)
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
            "live-trunk-stats report: sbc_id=%s sent %d trunks (max %d) — rejecting",
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
                "live-trunk-stats report: sbc_id=%s trunk entry not an object: %r",
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
                "live-trunk-stats report: DB error upserting trunk "
                "customer_id=%s trunk_id=%s sbc_id=%s",
                trunk.get("customer_id"), trunk.get("trunk_id"), sbc_id,
            )

    logger.info(
        "live-trunk-stats report: sbc_id=%s updated=%d errors=%d (of %d trunks)",
        sbc_id, updated, errors, len(trunks),
    )
    return {"ok": True, "updated": updated, "errors": errors}


@router.get("")
async def get_live_trunk_stats(admin: dict = Depends(require_admin)):
    """Return aggregated live customer-trunk health (admin-only; CRAG/debug).

    Reads the `live_trunk_health` view: one row per (customer_id, trunk_id) with
    channels/CPS SUMmed across SBCs, best asr_5m, registered_any, staleness.
    Ordered by active_channels DESC so the busiest trunks surface first.
    """
    rows = await db.fetch_all(
        """
        SELECT customer_id, trunk_id, trunk_name,
               active_channels, cps_1m, asr_5m,
               registered_any, last_updated, stale
        FROM live_trunk_health
        ORDER BY active_channels DESC NULLS LAST, customer_id, trunk_id
        """
    )
    return {"trunks": [dict(r) for r in rows], "count": len(rows)}
