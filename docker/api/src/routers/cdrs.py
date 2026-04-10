"""CDR (Call Detail Record) query and ingestion endpoints."""
from fastapi import APIRouter, HTTPException, Query, Request
from typing import Optional
from datetime import datetime, timedelta, timezone
from db import database as db
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# CDR Ingestion from FreeSWITCH mod_json_cdr
# ---------------------------------------------------------------------------

def _safe_int(value, default=None):
    """Convert a string value to int, returning default on failure."""
    if value is None:
        return default
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def _epoch_to_timestamp(epoch_str):
    """Convert a Unix epoch string to a timezone-aware datetime.

    Returns None if the epoch is 0, empty, or unparseable (e.g. unanswered
    calls report answer_epoch as "0").
    """
    if not epoch_str:
        return None
    try:
        epoch = int(epoch_str)
        if epoch == 0:
            return None
        return datetime.fromtimestamp(epoch, tz=timezone.utc)
    except (ValueError, TypeError):
        return None


@router.post("/ingest")
async def ingest_cdr(request: Request):
    """Receive a raw JSON CDR from FreeSWITCH mod_json_cdr and insert it.

    This endpoint is called directly by FreeSWITCH after each call ends.
    It must always return 200 -- returning an error causes FS to retry and
    can flood the endpoint with duplicate data.

    No authentication is required; FreeSWITCH calls this over the internal
    Docker network.
    """
    try:
        body = await request.json()
    except Exception:
        logger.warning("CDR ingest: failed to parse JSON body")
        return {"status": "error", "detail": "invalid JSON"}

    try:
        variables = body.get("variables", {})
        if not variables:
            logger.warning("CDR ingest: missing 'variables' key in payload")
            return {"status": "error", "detail": "missing variables"}

        # ---- Extract and validate required fields -------------------------
        call_uuid = variables.get("uuid")
        if not call_uuid:
            logger.warning("CDR ingest: missing uuid in variables")
            return {"status": "error", "detail": "missing uuid"}

        direction = variables.get("direction", "inbound")
        product_type = variables.get("product_type", "trunk")
        destination = variables.get("destination_number")
        if not destination:
            logger.warning("CDR ingest: missing destination_number for uuid=%s", call_uuid)
            return {"status": "error", "detail": "missing destination"}

        start_time = _epoch_to_timestamp(variables.get("start_epoch"))
        end_time = _epoch_to_timestamp(variables.get("end_epoch"))
        if not start_time or not end_time:
            logger.warning(
                "CDR ingest: invalid start/end epoch for uuid=%s "
                "(start_epoch=%s, end_epoch=%s)",
                call_uuid,
                variables.get("start_epoch"),
                variables.get("end_epoch"),
            )
            return {"status": "error", "detail": "invalid timestamps"}

        # customer_id is NOT NULL in the schema; default to 0 for unmatched
        customer_id = _safe_int(variables.get("customer_id"), default=0)

        # ---- Optional fields ----------------------------------------------
        trunk_id = _safe_int(variables.get("trunk_id"))
        caller_id = variables.get("caller_id_number")
        answer_time = _epoch_to_timestamp(variables.get("answer_epoch"))

        duration_sec = _safe_int(variables.get("duration"), default=0)
        duration_ms = duration_sec * 1000

        billsec = _safe_int(variables.get("billsec"), default=0)
        billable_ms = billsec * 1000

        hangup_cause = variables.get("hangup_cause")
        sip_code = _safe_int(variables.get("sip_term_status"))
        carrier_used = variables.get("carrier_used")
        traffic_grade = variables.get("traffic_grade")
        freeswitch_node = variables.get("FreeSWITCH-Hostname")

        # Extract a destination prefix (up to first 6 digits after +) for
        # rate-lookup caching.  e.g. "+17743260301" -> "+17743"
        destination_prefix = destination[:6] if destination else None

        # ---- Insert with duplicate guard ----------------------------------
        # The cdrs table uses a composite PK (id, start_time) for TimescaleDB
        # hypertable partitioning, so ON CONFLICT on uuid is not available.
        # Instead we use a NOT EXISTS subquery to skip duplicates.
        result = await db.execute(
            """
            INSERT INTO cdrs (
                uuid, customer_id, product_type, trunk_id, direction,
                caller_id, destination, destination_prefix,
                start_time, answer_time, end_time,
                duration_ms, billable_ms,
                hangup_cause, sip_code, carrier_used, traffic_grade,
                freeswitch_node
            )
            SELECT
                $1, $2, $3, $4, $5,
                $6, $7, $8,
                $9, $10, $11,
                $12, $13,
                $14, $15, $16, $17,
                $18
            WHERE NOT EXISTS (
                SELECT 1 FROM cdrs WHERE uuid = $1
            )
            """,
            call_uuid,
            customer_id,
            product_type,
            trunk_id,
            direction,
            caller_id,
            destination,
            destination_prefix,
            start_time,
            answer_time,
            end_time,
            duration_ms,
            billable_ms,
            hangup_cause,
            sip_code,
            carrier_used,
            traffic_grade,
            freeswitch_node,
        )

        if result and "INSERT 0 0" in result:
            logger.info("CDR ingest: duplicate skipped uuid=%s", call_uuid)
            return {"status": "duplicate", "uuid": call_uuid}

        logger.info(
            "CDR ingest: inserted uuid=%s customer=%s dest=%s duration=%ds",
            call_uuid, customer_id, destination, duration_sec,
        )
        return {"status": "ok", "uuid": call_uuid}

    except Exception:
        logger.exception("CDR ingest: unexpected error processing CDR")
        # Always return 200 so FreeSWITCH does not retry
        return {"status": "error", "detail": "internal processing error"}


@router.get("")
async def query_cdrs(
    customer_id: Optional[int] = None,
    trunk_id: Optional[int] = None,
    product_type: Optional[str] = None,
    direction: Optional[str] = None,
    destination: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    rated_only: bool = False,
    limit: int = Query(default=100, le=1000),
    offset: int = 0
):
    """Query CDRs with filters."""
    # Default to last 24 hours if no date range
    if not start_date:
        start_date = datetime.utcnow() - timedelta(hours=24)
    if not end_date:
        end_date = datetime.utcnow()

    query = """
        SELECT uuid, customer_id, product_type, trunk_id, direction,
               caller_id, destination, start_time, answer_time, end_time,
               duration_ms, billable_ms, rate_per_min, total_cost,
               hangup_cause, carrier_used, traffic_grade, rated_at
        FROM cdrs
        WHERE start_time >= $1 AND start_time <= $2
    """
    values = [start_date, end_date]
    idx = 3

    if customer_id:
        query += f" AND customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if trunk_id:
        query += f" AND trunk_id = ${idx}"
        values.append(trunk_id)
        idx += 1

    if product_type:
        query += f" AND product_type = ${idx}"
        values.append(product_type)
        idx += 1

    if direction:
        query += f" AND direction = ${idx}"
        values.append(direction)
        idx += 1

    if destination:
        query += f" AND destination LIKE ${idx}"
        values.append(f"{destination}%")
        idx += 1

    if rated_only:
        query += " AND rated_at IS NOT NULL"

    query += f" ORDER BY start_time DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)

    # Convert to dicts and format times
    cdrs = []
    for r in results:
        cdr = dict(r)
        cdr["duration_seconds"] = (cdr.pop("duration_ms") or 0) / 1000
        cdr["billable_seconds"] = (cdr.pop("billable_ms") or 0) / 1000
        cdrs.append(cdr)

    return {"cdrs": cdrs, "count": len(cdrs), "offset": offset, "limit": limit}


@router.get("/summary")
async def cdr_summary(
    customer_id: int,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    group_by: str = "day"  # day, hour, destination
):
    """Get CDR summary statistics."""
    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=7)
    if not end_date:
        end_date = datetime.utcnow()

    if group_by == "day":
        query = """
            SELECT
                DATE(start_time) as date,
                product_type,
                direction,
                COUNT(*) as total_calls,
                COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
                SUM(duration_ms) / 1000 as total_duration_sec,
                SUM(total_cost) as total_cost
            FROM cdrs
            WHERE customer_id = $1 AND start_time >= $2 AND start_time <= $3
            GROUP BY DATE(start_time), product_type, direction
            ORDER BY date DESC
        """
    elif group_by == "destination":
        query = """
            SELECT
                SUBSTRING(destination, 1, 4) as prefix,
                COUNT(*) as total_calls,
                COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
                SUM(duration_ms) / 1000 as total_duration_sec,
                SUM(total_cost) as total_cost,
                AVG(duration_ms) FILTER (WHERE answer_time IS NOT NULL) / 1000 as avg_duration_sec
            FROM cdrs
            WHERE customer_id = $1 AND start_time >= $2 AND start_time <= $3
            GROUP BY prefix
            ORDER BY total_calls DESC
            LIMIT 50
        """
    else:  # hour
        query = """
            SELECT
                DATE_TRUNC('hour', start_time) as hour,
                COUNT(*) as total_calls,
                COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
                SUM(total_cost) as total_cost
            FROM cdrs
            WHERE customer_id = $1 AND start_time >= $2 AND start_time <= $3
            GROUP BY hour
            ORDER BY hour DESC
            LIMIT 168
        """

    results = await db.fetch_all(query, customer_id, start_date, end_date)
    return {"summary": [dict(r) for r in results], "group_by": group_by}


@router.get("/{cdr_uuid}")
async def get_cdr(cdr_uuid: str):
    """Get a single CDR by UUID."""
    result = await db.fetch_one(
        """
        SELECT uuid, customer_id, product_type, trunk_id, direction,
               caller_id, destination, start_time, answer_time, end_time,
               duration_ms, billable_ms, rate_per_min, total_cost,
               hangup_cause, sip_code, carrier_used, traffic_grade,
               fraud_score, fraud_flags, rated_at
        FROM cdrs WHERE uuid = $1
        """,
        cdr_uuid
    )
    if not result:
        raise HTTPException(status_code=404, detail="CDR not found")

    cdr = dict(result)
    cdr["duration_seconds"] = (cdr.pop("duration_ms") or 0) / 1000
    cdr["billable_seconds"] = (cdr.pop("billable_ms") or 0) / 1000
    return cdr


@router.post("/{cdr_uuid}/rate")
async def rate_cdr(cdr_uuid: str):
    """Manually trigger rating for a CDR."""
    # Call the PostgreSQL rating function
    result = await db.fetch_one("SELECT rate_cdr($1) as cost", cdr_uuid)

    if result["cost"] is None:
        raise HTTPException(status_code=404, detail="CDR not found or already rated")

    return {"cdr_uuid": cdr_uuid, "cost": float(result["cost"]), "status": "rated"}
