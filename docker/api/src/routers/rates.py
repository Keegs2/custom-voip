"""Rate table and rate entry management endpoints (admin only)."""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

from auth.dependencies import require_admin
from db import database as db

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RateCreate(BaseModel):
    prefix: str
    description: Optional[str] = None
    rate_per_min: float
    cost_per_min: float
    connection_fee: float = 0.0
    increment: int = 6
    rate_table_id: Optional[int] = None

    @field_validator("prefix")
    @classmethod
    def validate_prefix(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("prefix must not be empty")
        return v

    @field_validator("rate_per_min", "cost_per_min")
    @classmethod
    def validate_rate(cls, v: float) -> float:
        if v < 0:
            raise ValueError("rate values must be non-negative")
        return v


class RateUpdate(BaseModel):
    description: Optional[str] = None
    rate_per_min: Optional[float] = None
    cost_per_min: Optional[float] = None
    connection_fee: Optional[float] = None
    increment: Optional[int] = None

    @field_validator("rate_per_min", "cost_per_min")
    @classmethod
    def validate_rate(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v < 0:
            raise ValueError("rate values must be non-negative")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rate_row(row) -> dict:
    """Convert a rates DB row to the frontend-expected shape with margins."""
    d = dict(row)
    rate = float(d.get("rate_per_min") or 0)
    cost = float(d.get("cost_per_min") or 0)
    margin = rate - cost
    d["margin_per_min"] = round(margin, 6)
    d["margin_pct"] = round((margin / rate) * 100, 2) if rate > 0 else None
    return d


async def _get_default_rate_table_id() -> int:
    """Return the default rate table id, or the first one available."""
    row = await db.fetch_one(
        "SELECT id FROM rate_tables WHERE is_default = true LIMIT 1"
    )
    if row:
        return row["id"]
    row = await db.fetch_one("SELECT id FROM rate_tables ORDER BY id LIMIT 1")
    if row:
        return row["id"]
    raise HTTPException(
        status_code=400,
        detail="No rate tables exist. Create a rate table first.",
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/margins")
async def get_margins(admin: dict = Depends(require_admin)):
    """Margin analysis across all rates.

    Returns aggregate statistics and lists of rates with negative, low (<10%),
    and best margins.
    """
    rows = await db.fetch_all(
        """
        SELECT id, prefix, description, rate_per_min, cost_per_min,
               connection_fee, increment
        FROM rates
        ORDER BY prefix
        """
    )

    if not rows:
        return {
            "total_rates": 0,
            "avg_margin_pct": 0,
            "min_margin_pct": 0,
            "max_margin_pct": 0,
            "negative_margin_count": 0,
            "negative_margins": [],
            "low_margins": [],
            "best_margins": [],
        }

    margins = []
    for r in rows:
        rate = float(r["rate_per_min"] or 0)
        cost = float(r["cost_per_min"] or 0)
        margin = rate - cost
        pct = round((margin / rate) * 100, 2) if rate > 0 else 0
        margins.append({
            "prefix": r["prefix"],
            "description": r["description"],
            "rate_per_min": float(rate),
            "cost_per_min": float(cost),
            "margin_per_min": round(margin, 6),
            "margin_pct": pct,
        })

    pcts = [m["margin_pct"] for m in margins]
    negative = [m for m in margins if m["margin_per_min"] < 0]
    low = [m for m in margins if 0 <= (m["margin_pct"] or 0) < 10]
    best = sorted(margins, key=lambda m: m["margin_pct"] or 0, reverse=True)[:20]

    return {
        "total_rates": len(margins),
        "avg_margin_pct": round(sum(pcts) / len(pcts), 2) if pcts else 0,
        "min_margin_pct": round(min(pcts), 2) if pcts else 0,
        "max_margin_pct": round(max(pcts), 2) if pcts else 0,
        "negative_margin_count": len(negative),
        "negative_margins": negative[:50],
        "low_margins": low[:50],
        "best_margins": best,
    }


@router.get("/lookup")
async def lookup_rate(
    destination: str = Query(..., description="Phone number or prefix to look up"),
    rate_table_id: Optional[int] = Query(None, description="Rate table ID (uses default if omitted)"),
    admin: dict = Depends(require_admin),
):
    """Longest-prefix-match rate lookup using the get_rate() PostgreSQL function."""
    if rate_table_id is None:
        rate_table_id = await _get_default_rate_table_id()

    # Strip any non-digit characters except leading +
    clean = destination.lstrip("+")

    row = await db.fetch_one(
        "SELECT * FROM get_rate($1, $2)",
        rate_table_id,
        clean,
    )
    if not row:
        return None

    d = dict(row)
    rate = float(d.get("rate_per_min") or 0)
    cost = float(d.get("cost_per_min") or 0)
    margin = rate - cost
    d["margin_per_min"] = round(margin, 6)
    d["margin_pct"] = round((margin / rate) * 100, 2) if rate > 0 else None
    return d


@router.get("/{rate_id}")
async def get_rate(rate_id: int, admin: dict = Depends(require_admin)):
    """Get a single rate entry by ID."""
    row = await db.fetch_one(
        """
        SELECT id, rate_table_id, prefix, description, rate_per_min, cost_per_min,
               connection_fee, min_duration, increment, effective_date
        FROM rates
        WHERE id = $1
        """,
        rate_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Rate not found")
    return _rate_row(row)


@router.get("")
async def list_rates(
    rate_table_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None, description="Prefix or description search"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    admin: dict = Depends(require_admin),
):
    """List rates with optional filters and pagination."""
    query = """
        SELECT id, rate_table_id, prefix, description, rate_per_min, cost_per_min,
               connection_fee, min_duration, increment, effective_date,
               COUNT(*) OVER() AS _total
        FROM rates
        WHERE 1=1
    """
    values = []
    idx = 1

    if rate_table_id is not None:
        query += f" AND rate_table_id = ${idx}"
        values.append(rate_table_id)
        idx += 1

    if search:
        query += f" AND (prefix LIKE ${idx} OR description ILIKE ${idx + 1})"
        values.append(search + "%")
        values.append("%" + search + "%")
        idx += 2

    query += f" ORDER BY prefix LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)

    total = rows[0]["_total"] if rows else 0
    items = [_rate_row(r) for r in rows]

    # Compute summary for the current dataset
    pcts = [i["margin_pct"] for i in items if i["margin_pct"] is not None]
    neg_count = sum(1 for i in items if i["margin_per_min"] < 0)

    return {
        "rates": items,
        "items": items,
        "count": len(items),
        "total": total,
        "limit": limit,
        "offset": offset,
        "summary": {
            "avg_margin_pct": round(sum(pcts) / len(pcts), 2) if pcts else 0,
            "min_margin_pct": round(min(pcts), 2) if pcts else 0,
            "negative_margin_count": neg_count,
        },
    }


@router.post("")
async def create_rate(body: RateCreate, admin: dict = Depends(require_admin)):
    """Create a new rate entry."""
    rate_table_id = body.rate_table_id
    if rate_table_id is None:
        rate_table_id = await _get_default_rate_table_id()

    try:
        row = await db.fetch_one(
            """
            INSERT INTO rates (rate_table_id, prefix, description, rate_per_min,
                               cost_per_min, connection_fee, increment)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, rate_table_id, prefix, description, rate_per_min,
                      cost_per_min, connection_fee, min_duration, increment, effective_date
            """,
            rate_table_id, body.prefix, body.description,
            body.rate_per_min, body.cost_per_min,
            body.connection_fee, body.increment,
        )
        return _rate_row(row)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"Rate with prefix '{body.prefix}' already exists in this rate table",
            )
        raise


@router.patch("/{rate_id}")
async def update_rate(rate_id: int, body: RateUpdate, admin: dict = Depends(require_admin)):
    """Update a rate entry."""
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates = []
    values = []
    idx = 1
    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    values.append(rate_id)
    query = f"""
        UPDATE rates
        SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, rate_table_id, prefix, description, rate_per_min,
                  cost_per_min, connection_fee, min_duration, increment, effective_date
    """

    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="Rate not found")
    return _rate_row(row)


@router.delete("/{rate_id}")
async def delete_rate(rate_id: int, admin: dict = Depends(require_admin)):
    """Delete a rate entry."""
    result = await db.execute("DELETE FROM rates WHERE id = $1", rate_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Rate not found")
    return {"status": "deleted", "id": rate_id}
