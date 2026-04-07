"""CDR (Call Detail Record) query endpoints."""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime, timedelta
from db import database as db

router = APIRouter()


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
