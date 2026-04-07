"""Rate table and rate management endpoints with margin analysis."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from db import database as db

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------------

class RateTableCreate(BaseModel):
    name: str
    description: Optional[str] = None
    is_default: bool = False


class RateCreate(BaseModel):
    rate_table_id: int
    prefix: str
    description: Optional[str] = None
    rate_per_min: float
    cost_per_min: float
    connection_fee: float = 0
    increment: int = 6


class RateUpdate(BaseModel):
    rate_per_min: Optional[float] = None
    cost_per_min: Optional[float] = None
    connection_fee: Optional[float] = None
    increment: Optional[int] = None
    description: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def compute_margin(rate_per_min: float, cost_per_min: float) -> dict:
    """Return margin_per_min and margin_pct for a single rate."""
    margin_per_min = (rate_per_min or 0) - (cost_per_min or 0)
    if rate_per_min and rate_per_min > 0:
        margin_pct = round(margin_per_min / rate_per_min * 100, 2)
    else:
        margin_pct = 0.0
    return {"margin_per_min": round(margin_per_min, 6), "margin_pct": margin_pct}


def enrich_rate(row) -> dict:
    """Convert a DB row to a dict with computed margin fields."""
    r = dict(row)
    m = compute_margin(r.get("rate_per_min", 0), r.get("cost_per_min", 0))
    r["margin_per_min"] = m["margin_per_min"]
    r["margin_pct"] = m["margin_pct"]
    return r


# ---------------------------------------------------------------------------
# Rate Tables
# ---------------------------------------------------------------------------

@router.get("/tables")
async def list_rate_tables():
    """List all rate tables."""
    results = await db.fetch_all(
        "SELECT id, name, description, is_default, created_at FROM rate_tables ORDER BY id"
    )
    return {"rate_tables": [dict(r) for r in results]}


@router.post("/tables", status_code=201)
async def create_rate_table(body: RateTableCreate):
    """Create a new rate table."""
    result = await db.fetch_one(
        """
        INSERT INTO rate_tables (name, description, is_default)
        VALUES ($1, $2, $3)
        RETURNING id, name, description, is_default, created_at
        """,
        body.name, body.description, body.is_default
    )
    return dict(result)


@router.get("/tables/{table_id}")
async def get_rate_table(table_id: int):
    """Get a rate table with summary statistics."""
    table = await db.fetch_one(
        "SELECT id, name, description, is_default, created_at FROM rate_tables WHERE id = $1",
        table_id
    )
    if not table:
        raise HTTPException(status_code=404, detail="Rate table not found")

    stats = await db.fetch_one(
        """
        SELECT
            COUNT(*)::int AS total_rates,
            COALESCE(AVG(
                CASE WHEN rate_per_min > 0
                     THEN (rate_per_min - cost_per_min) / rate_per_min * 100
                     ELSE 0
                END
            ), 0) AS avg_margin_pct
        FROM rates
        WHERE rate_table_id = $1
        """,
        table_id
    )

    result = dict(table)
    result["total_rates"] = stats["total_rates"]
    result["avg_margin_pct"] = round(float(stats["avg_margin_pct"]), 2)
    return result


# ---------------------------------------------------------------------------
# Rates CRUD
# ---------------------------------------------------------------------------

@router.get("")
async def list_rates(
    rate_table_id: int = Query(default=1),
    prefix: Optional[str] = None,
    limit: int = Query(default=100, le=1000),
    offset: int = 0
):
    """List rates with filters and computed margin fields."""
    query = """
        SELECT id, rate_table_id, prefix, description, rate_per_min,
               cost_per_min, connection_fee, min_duration, increment, effective_date
        FROM rates
        WHERE rate_table_id = $1
    """
    values: list = [rate_table_id]
    idx = 2

    if prefix:
        query += f" AND prefix LIKE ${idx}"
        values.append(f"{prefix}%")
        idx += 1

    query += f" ORDER BY prefix LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)
    rates = [enrich_rate(r) for r in results]

    # Compute summary across the full matching set (not just the page)
    summary_query = """
        SELECT
            COALESCE(AVG(
                CASE WHEN rate_per_min > 0
                     THEN (rate_per_min - cost_per_min) / rate_per_min * 100
                     ELSE 0
                END
            ), 0) AS avg_margin_pct,
            COALESCE(MIN(
                CASE WHEN rate_per_min > 0
                     THEN (rate_per_min - cost_per_min) / rate_per_min * 100
                     ELSE 0
                END
            ), 0) AS min_margin_pct,
            COUNT(*) FILTER (WHERE cost_per_min >= rate_per_min AND rate_per_min > 0)::int
                AS negative_margin_count
        FROM rates
        WHERE rate_table_id = $1
    """
    summary_values: list = [rate_table_id]
    sidx = 2

    if prefix:
        summary_query += f" AND prefix LIKE ${sidx}"
        summary_values.append(f"{prefix}%")

    summary = await db.fetch_one(summary_query, *summary_values)

    return {
        "rates": rates,
        "count": len(rates),
        "summary": {
            "avg_margin_pct": round(float(summary["avg_margin_pct"]), 2),
            "min_margin_pct": round(float(summary["min_margin_pct"]), 2),
            "negative_margin_count": summary["negative_margin_count"],
        }
    }


@router.post("", status_code=201)
async def create_rate(body: RateCreate):
    """Create a new rate."""
    # Verify the rate table exists
    table = await db.fetch_one(
        "SELECT id FROM rate_tables WHERE id = $1",
        body.rate_table_id
    )
    if not table:
        raise HTTPException(status_code=404, detail="Rate table not found")

    result = await db.fetch_one(
        """
        INSERT INTO rates (rate_table_id, prefix, description, rate_per_min,
                           cost_per_min, connection_fee, increment)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, rate_table_id, prefix, description, rate_per_min,
                  cost_per_min, connection_fee, min_duration, increment, effective_date
        """,
        body.rate_table_id, body.prefix, body.description,
        body.rate_per_min, body.cost_per_min, body.connection_fee, body.increment
    )
    return enrich_rate(result)


@router.put("/{rate_id}")
async def update_rate(rate_id: int, body: RateUpdate):
    """Update an existing rate."""
    existing = await db.fetch_one("SELECT id FROM rates WHERE id = $1", rate_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Rate not found")

    updates = []
    values: list = []
    idx = 1

    if body.rate_per_min is not None:
        updates.append(f"rate_per_min = ${idx}")
        values.append(body.rate_per_min)
        idx += 1

    if body.cost_per_min is not None:
        updates.append(f"cost_per_min = ${idx}")
        values.append(body.cost_per_min)
        idx += 1

    if body.connection_fee is not None:
        updates.append(f"connection_fee = ${idx}")
        values.append(body.connection_fee)
        idx += 1

    if body.increment is not None:
        updates.append(f"increment = ${idx}")
        values.append(body.increment)
        idx += 1

    if body.description is not None:
        updates.append(f"description = ${idx}")
        values.append(body.description)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(rate_id)
    query = f"""
        UPDATE rates SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, rate_table_id, prefix, description, rate_per_min,
                  cost_per_min, connection_fee, min_duration, increment, effective_date
    """
    result = await db.fetch_one(query, *values)
    return enrich_rate(result)


@router.delete("/{rate_id}")
async def delete_rate(rate_id: int):
    """Delete a rate."""
    existing = await db.fetch_one("SELECT id FROM rates WHERE id = $1", rate_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Rate not found")

    await db.execute("DELETE FROM rates WHERE id = $1", rate_id)
    return {"detail": "Rate deleted", "id": rate_id}


# ---------------------------------------------------------------------------
# Margin Analysis
# ---------------------------------------------------------------------------

@router.get("/margins")
async def margin_overview(rate_table_id: int = Query(default=1)):
    """Margin overview for a rate table.

    Returns aggregate stats plus lists of negative-margin, low-margin, and
    best-margin rates.
    """
    # Aggregate statistics
    agg = await db.fetch_one(
        """
        SELECT
            COUNT(*)::int AS total_rates,
            COALESCE(AVG(rate_per_min), 0) AS avg_sell_rate,
            COALESCE(AVG(cost_per_min), 0) AS avg_cost_rate,
            COALESCE(AVG(
                CASE WHEN rate_per_min > 0
                     THEN (rate_per_min - cost_per_min) / rate_per_min * 100
                     ELSE 0
                END
            ), 0) AS avg_margin_pct
        FROM rates
        WHERE rate_table_id = $1
        """,
        rate_table_id
    )

    # Negative margins: cost >= sell
    negative_rows = await db.fetch_all(
        """
        SELECT prefix, description,
               CASE WHEN rate_per_min > 0
                    THEN ROUND(((rate_per_min - cost_per_min) / rate_per_min * 100)::numeric, 2)
                    ELSE 0
               END AS margin_pct
        FROM rates
        WHERE rate_table_id = $1 AND cost_per_min >= rate_per_min
        ORDER BY margin_pct ASC
        """,
        rate_table_id
    )

    # Low margins: margin < 30% but not negative
    low_rows = await db.fetch_all(
        """
        SELECT prefix, description,
               ROUND(((rate_per_min - cost_per_min) / rate_per_min * 100)::numeric, 2) AS margin_pct
        FROM rates
        WHERE rate_table_id = $1
          AND rate_per_min > 0
          AND cost_per_min < rate_per_min
          AND (rate_per_min - cost_per_min) / rate_per_min * 100 < 30
        ORDER BY margin_pct ASC
        """,
        rate_table_id
    )

    # Best margins: top 5 by margin %
    best_rows = await db.fetch_all(
        """
        SELECT prefix, description,
               ROUND(((rate_per_min - cost_per_min) / rate_per_min * 100)::numeric, 2) AS margin_pct
        FROM rates
        WHERE rate_table_id = $1 AND rate_per_min > 0
        ORDER BY margin_pct DESC
        LIMIT 5
        """,
        rate_table_id
    )

    return {
        "total_rates": agg["total_rates"],
        "avg_sell_rate": round(float(agg["avg_sell_rate"]), 4),
        "avg_cost_rate": round(float(agg["avg_cost_rate"]), 4),
        "avg_margin_pct": round(float(agg["avg_margin_pct"]), 2),
        "negative_margins": [dict(r) for r in negative_rows],
        "low_margins": [dict(r) for r in low_rows],
        "best_margins": [dict(r) for r in best_rows],
    }
