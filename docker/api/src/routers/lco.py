"""Least-Cost Outbound (LCO) admin + reporting surface.

A dedicated admin surface (rather than extending routers/rates.py, whose
`/{rate_id}` int catch-all would shadow these literal sub-paths) for:

  * rate-deck CRUD + bulk CSV import        — admin only  (/decks*)
  * per-customer carrier allow/deny policy  — admin only  (/policy*)
  * LCO decision (stamps X-LCO-Route)       — admin only  (/route)
  * transparent LCO savings report          — tenant-scoped (/savings)
  * rated-CDR billing-feed export           — tenant-scoped, streaming (/billing-export)

The call path itself does NOT go through this router: FreeSWITCH reads the
`lco_route` view / `lco_decide()` directly, and the API origination path imports
`services.lco.decide_lco_route`. `/route` here is the admin/verification handle
for the same decision.
"""
import csv
import io
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from db import database as db
from auth.dependencies import require_admin, get_current_user, get_customer_filter
from services import lco as lco_engine
from services import rate_deck

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_SAVINGS_WINDOW = timedelta(days=92)     # ~ CDR retention
_MAX_EXPORT_WINDOW = timedelta(days=31)      # one billing month per export
_VALID_JURISDICTIONS = ("interstate", "intrastate", "intl", "default")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RateDeckCreate(BaseModel):
    carrier_id: int
    prefix: str
    cost_per_min: float
    jurisdiction: str = "default"
    priority: int = 100
    description: Optional[str] = None
    effective_date: Optional[datetime] = None
    expires_at: Optional[datetime] = None

    @field_validator("prefix")
    @classmethod
    def _validate_prefix(cls, v: str) -> str:
        v = rate_deck.normalize_prefix(v)
        if not v:
            raise ValueError("prefix must contain digits")
        return v

    @field_validator("jurisdiction")
    @classmethod
    def _validate_jur(cls, v: str) -> str:
        v = (v or "default").lower()
        if v not in _VALID_JURISDICTIONS:
            raise ValueError(f"jurisdiction must be one of {_VALID_JURISDICTIONS}")
        return v

    @field_validator("cost_per_min")
    @classmethod
    def _validate_cost(cls, v: float) -> float:
        if v < 0:
            raise ValueError("cost_per_min must be non-negative")
        return v


class RateDeckUpdate(BaseModel):
    cost_per_min: Optional[float] = None
    priority: Optional[int] = None
    description: Optional[str] = None
    expires_at: Optional[datetime] = None
    enabled: Optional[bool] = None

    @field_validator("cost_per_min")
    @classmethod
    def _validate_cost(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v < 0:
            raise ValueError("cost_per_min must be non-negative")
        return v


class RateDeckImport(BaseModel):
    carrier_id: int
    csv: str
    effective_date: Optional[datetime] = None


class PolicyUpsert(BaseModel):
    customer_id: int
    carrier_id: int
    mode: str
    priority_override: Optional[int] = None
    notes: Optional[str] = None

    @field_validator("mode")
    @classmethod
    def _validate_mode(cls, v: str) -> str:
        v = (v or "").lower()
        if v not in ("allow", "deny"):
            raise ValueError("mode must be 'allow' or 'deny'")
        return v


# ---------------------------------------------------------------------------
# LCO decision (admin / verification) — stamps X-LCO-Route
# ---------------------------------------------------------------------------

@router.get("/route")
async def lco_route_decision(
    response: Response,
    destination: str = Query(..., description="Dialed number (E.164 or digits)"),
    customer_id: Optional[int] = Query(None, description="Apply this customer's carrier policy"),
    admin: dict = Depends(require_admin),
):
    """Return the cheapest-first carrier list for a destination and stamp the
    `X-LCO-Route` header with the chosen route. This is the same decision the
    origination path makes via services.lco.decide_lco_route."""
    routes = await lco_engine.decide_lco_route(destination, customer_id)
    header = lco_engine.lco_header_value(routes)
    if header:
        response.headers[lco_engine.LCO_HEADER] = header
    return {
        "destination": destination,
        "customer_id": customer_id,
        "x_lco_route": header,
        "routes": [
            {
                "carrier_id": r["carrier_id"],
                "x_carrier_value": r.get("x_carrier_value"),
                "pop_ip": r.get("pop_ip"),
                "cost_per_min": float(r["cost_per_min"]) if r.get("cost_per_min") is not None else None,
                "priority": r.get("priority"),
                "prefix": r.get("prefix"),
            }
            for r in routes
        ],
    }


# ---------------------------------------------------------------------------
# Rate-deck CRUD + bulk import (admin)
# ---------------------------------------------------------------------------

@router.get("/decks")
async def list_decks(
    admin: dict = Depends(require_admin),
    carrier_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None, description="prefix starts-with"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """List rate-deck entries."""
    query = """
        SELECT d.id, d.carrier_id, g.gateway_name, d.prefix, d.description,
               d.cost_per_min, d.jurisdiction, d.priority, d.effective_date,
               d.expires_at, d.enabled, d.updated_at,
               COUNT(*) OVER() AS total_count
          FROM carrier_rate_decks d
          JOIN carrier_gateways g ON g.id = d.carrier_id
         WHERE 1=1
    """
    values: list = []
    idx = 1
    if carrier_id is not None:
        query += f" AND d.carrier_id = ${idx}"; values.append(carrier_id); idx += 1
    if search:
        query += f" AND d.prefix LIKE ${idx}"; values.append(rate_deck.normalize_prefix(search) + "%"); idx += 1
    query += f" ORDER BY d.prefix, d.carrier_id LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0
    items = []
    for r in rows:
        d = dict(r)
        d.pop("total_count", None)
        items.append(d)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/decks/import")
async def import_deck(body: RateDeckImport, admin: dict = Depends(require_admin)):
    """Bulk CSV rate-deck import for one carrier. Idempotent on
    (carrier_id, prefix, jurisdiction, effective_date). Admin only."""
    carrier = await db.fetch_one(
        "SELECT id, gateway_name FROM carrier_gateways WHERE id = $1", body.carrier_id
    )
    if not carrier:
        raise HTTPException(status_code=404, detail=f"carrier_id {body.carrier_id} not found")

    records, errors = rate_deck.parse_rate_csv(body.csv)
    effective = body.effective_date or datetime.now(timezone.utc)

    processed = 0
    if records:
        pool = await db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                res = await rate_deck.bulk_upsert_rate_deck(conn, body.carrier_id, records, effective)
                processed = res["processed"]

    logger.info(
        "Rate-deck import carrier=%s processed=%d errors=%d by_user=%s",
        body.carrier_id, processed, len(errors), admin.get("sub"),
    )
    return {
        "carrier_id": body.carrier_id,
        "gateway_name": carrier["gateway_name"],
        "effective_date": effective,
        "processed": processed,
        "skipped": len(errors),
        "errors": errors[:50],
    }


@router.post("/decks")
async def create_deck(body: RateDeckCreate, admin: dict = Depends(require_admin)):
    """Create a single rate-deck entry."""
    if not await db.fetch_one("SELECT 1 FROM carrier_gateways WHERE id = $1", body.carrier_id):
        raise HTTPException(status_code=404, detail=f"carrier_id {body.carrier_id} not found")
    effective = body.effective_date or datetime.now(timezone.utc)
    try:
        row = await db.fetch_one(
            """
            INSERT INTO carrier_rate_decks
                (carrier_id, prefix, description, cost_per_min, jurisdiction,
                 priority, effective_date, expires_at)
            VALUES ($1::int, $2::varchar, $3::varchar, $4::numeric, $5::varchar,
                    $6::int, $7::timestamptz, $8::timestamptz)
            RETURNING id, carrier_id, prefix, description, cost_per_min, jurisdiction,
                      priority, effective_date, expires_at, enabled, updated_at
            """,
            body.carrier_id, body.prefix, body.description, body.cost_per_min,
            body.jurisdiction, body.priority, effective, body.expires_at,
        )
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail="A rate for this (carrier, prefix, jurisdiction, effective_date) already exists",
            )
        raise


@router.patch("/decks/{deck_id}")
async def update_deck(deck_id: int, body: RateDeckUpdate, admin: dict = Depends(require_admin)):
    """Update a rate-deck entry."""
    update_data = body.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets: list[str] = []
    values: list = []
    idx = 1
    for field, value in update_data.items():
        sets.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1
    values.append(deck_id)
    row = await db.fetch_one(
        f"UPDATE carrier_rate_decks SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${idx} RETURNING id, carrier_id, prefix, description, cost_per_min, "
        f"jurisdiction, priority, effective_date, expires_at, enabled, updated_at",
        *values,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Rate-deck entry not found")
    return dict(row)


@router.delete("/decks/{deck_id}")
async def delete_deck(deck_id: int, admin: dict = Depends(require_admin)):
    """Delete a rate-deck entry."""
    result = await db.execute("DELETE FROM carrier_rate_decks WHERE id = $1", deck_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Rate-deck entry not found")
    return {"status": "deleted", "id": deck_id}


# ---------------------------------------------------------------------------
# Per-customer carrier policy (admin)
# ---------------------------------------------------------------------------

@router.get("/policy")
async def list_policy(
    admin: dict = Depends(require_admin),
    customer_id: Optional[int] = Query(None),
):
    """List per-customer carrier allow/deny policy rows."""
    query = """
        SELECT p.id, p.customer_id, p.carrier_id, g.gateway_name, p.mode,
               p.priority_override, p.notes, p.updated_at
          FROM customer_carrier_policy p
          JOIN carrier_gateways g ON g.id = p.carrier_id
         WHERE 1=1
    """
    values: list = []
    idx = 1
    if customer_id is not None:
        query += f" AND p.customer_id = ${idx}"; values.append(customer_id); idx += 1
    query += " ORDER BY p.customer_id, p.carrier_id"
    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.put("/policy")
async def upsert_policy(body: PolicyUpsert, admin: dict = Depends(require_admin)):
    """Create/update a per-customer carrier policy row (allow/deny + override)."""
    if not await db.fetch_one("SELECT 1 FROM customers WHERE id = $1", body.customer_id):
        raise HTTPException(status_code=404, detail="customer_id not found")
    if not await db.fetch_one("SELECT 1 FROM carrier_gateways WHERE id = $1", body.carrier_id):
        raise HTTPException(status_code=404, detail="carrier_id not found")
    row = await db.fetch_one(
        """
        INSERT INTO customer_carrier_policy
            (customer_id, carrier_id, mode, priority_override, notes)
        VALUES ($1::int, $2::int, $3::varchar, $4::int, $5::text)
        ON CONFLICT (customer_id, carrier_id) DO UPDATE
           SET mode = EXCLUDED.mode,
               priority_override = EXCLUDED.priority_override,
               notes = EXCLUDED.notes, updated_at = NOW()
        RETURNING id, customer_id, carrier_id, mode, priority_override, notes, updated_at
        """,
        body.customer_id, body.carrier_id, body.mode, body.priority_override, body.notes,
    )
    return dict(row)


@router.delete("/policy/{policy_id}")
async def delete_policy(policy_id: int, admin: dict = Depends(require_admin)):
    """Delete a per-customer carrier policy row."""
    result = await db.execute("DELETE FROM customer_carrier_policy WHERE id = $1", policy_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Policy row not found")
    return {"status": "deleted", "id": policy_id}


# ---------------------------------------------------------------------------
# Transparent LCO savings report (tenant-scoped)
# ---------------------------------------------------------------------------

@router.get("/savings")
async def lco_savings(
    start: datetime = Query(..., description="Window start (ISO 8601)"),
    end: datetime = Query(..., description="Window end (ISO 8601)"),
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
    customer_id: Optional[int] = Query(None, description="Admin-only cross-tenant filter"),
    limit: int = Query(25, ge=1, le=200, description="Top-N prefixes in the breakdown"),
):
    """Transparent LCO savings for a period: for each destination prefix, compare
    what we actually paid (LCO-chosen carrier, `cdrs.carrier_cost`) against a
    baseline = the most expensive carrier's longest-match rate for that prefix.
    savings = baseline_cost − actual_cost. Tenant-scoped + time-bounded (one
    aggregate over the CDR hypertable, then a bounded per-prefix baseline lookup).
    """
    scope = customer_filter if customer_filter is not None else customer_id
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be after start")
    if (end - start) > _MAX_SAVINGS_WINDOW:
        raise HTTPException(status_code=400, detail="window too large (max 92 days)")

    rows = await db.fetch_all(
        """
        WITH agg AS (
            SELECT destination_prefix AS prefix,
                   SUM(billable_ms)  AS billable_ms,
                   SUM(carrier_cost) AS actual_cost,
                   COUNT(*)          AS calls
              FROM cdrs
             WHERE start_time >= $1 AND start_time < $2
               AND direction = 'outbound'
               AND rated_at IS NOT NULL
               AND destination_prefix IS NOT NULL AND destination_prefix <> ''
               AND ($3::int IS NULL OR customer_id = $3)
             GROUP BY destination_prefix
        )
        SELECT a.prefix, a.billable_ms, a.actual_cost, a.calls, b.baseline_rate,
               (a.billable_ms / 60000.0) * COALESCE(b.baseline_rate, 0) AS baseline_cost
          FROM agg a
          LEFT JOIN LATERAL (
              SELECT MAX(lm.cost_per_min) AS baseline_rate
                FROM (
                    SELECT DISTINCT ON (rd.carrier_id) rd.carrier_id, rd.cost_per_min
                      FROM carrier_rate_decks rd
                      JOIN carrier_gateways cg ON cg.id = rd.carrier_id
                     WHERE rd.enabled AND cg.enabled
                       AND a.prefix LIKE rd.prefix || '%'
                     ORDER BY rd.carrier_id, LENGTH(rd.prefix) DESC
                ) lm
          ) b ON true
         ORDER BY baseline_cost - a.actual_cost DESC
        """,
        start, end, scope,
    )

    total_actual = 0.0
    total_baseline = 0.0
    total_calls = 0
    breakdown = []
    for r in rows:
        actual = float(r["actual_cost"] or 0)
        baseline = float(r["baseline_cost"] or 0)
        total_actual += actual
        total_baseline += baseline
        total_calls += int(r["calls"] or 0)
        if len(breakdown) < limit:
            breakdown.append({
                "prefix": r["prefix"],
                "calls": int(r["calls"] or 0),
                "billable_min": round(float(r["billable_ms"] or 0) / 60000.0, 4),
                "baseline_rate": float(r["baseline_rate"]) if r["baseline_rate"] is not None else None,
                "actual_cost": round(actual, 6),
                "baseline_cost": round(baseline, 6),
                "savings": round(baseline - actual, 6),
            })

    savings = total_baseline - total_actual
    return {
        "start": start,
        "end": end,
        "customer_id": scope,
        "total_calls": total_calls,
        "actual_cost": round(total_actual, 6),
        "baseline_cost": round(total_baseline, 6),
        "savings": round(savings, 6),
        "savings_pct": round((savings / total_baseline) * 100, 2) if total_baseline > 0 else 0.0,
        "prefixes": breakdown,
        "note": "baseline = most expensive carrier's longest-match rate per prefix; "
                "actual = LCO-chosen carrier cost (cdrs.carrier_cost).",
    }


# ---------------------------------------------------------------------------
# Rated-CDR billing-feed export (tenant-scoped, streaming)
# ---------------------------------------------------------------------------

_BILLING_COLUMNS = [
    "uuid", "start_time", "answer_time", "end_time", "customer_id", "direction",
    "caller_id", "destination", "destination_prefix", "billable_ms",
    "rate_per_min", "total_cost", "carrier_cost", "margin", "carrier_used",
    "hangup_cause", "sip_code",
]


def _csv_row(values) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerow(values)
    return buf.getvalue()


@router.get("/billing-export")
async def billing_export(
    start: datetime = Query(..., description="Window start (ISO 8601)"),
    end: datetime = Query(..., description="Window end (ISO 8601)"),
    fmt: str = Query("csv", pattern="^(csv|jsonl)$", description="csv or jsonl"),
    user: dict = Depends(get_current_user),
    customer_filter: Optional[int] = Depends(get_customer_filter),
    customer_id: Optional[int] = Query(None, description="Admin-only cross-tenant filter"),
):
    """Stream a rated-CDR billing feed (the wholesale billing-feed contract).
    Tenant-scoped + time-bounded (max 31 days). Streams via a server-side cursor
    so a large export stays memory-bounded. Scheduling (cron/systemd hitting this
    endpoint) is infra's lane; this provides the query + export shape.
    """
    scope = customer_filter if customer_filter is not None else customer_id
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be after start")
    if (end - start) > _MAX_EXPORT_WINDOW:
        raise HTTPException(status_code=400, detail="window too large (max 31 days)")

    query = f"""
        SELECT {", ".join(_BILLING_COLUMNS)}
          FROM cdrs
         WHERE start_time >= $1 AND start_time < $2
           AND rated_at IS NOT NULL
           AND ($3::int IS NULL OR customer_id = $3)
         ORDER BY start_time
    """

    async def generate():
        pool = await db.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                if fmt == "csv":
                    yield _csv_row(_BILLING_COLUMNS)
                async for record in conn.cursor(query, start, end, scope, prefetch=1000):
                    if fmt == "csv":
                        yield _csv_row([record[c] for c in _BILLING_COLUMNS])
                    else:
                        row = {c: record[c] for c in _BILLING_COLUMNS}
                        yield json.dumps(row, default=str) + "\n"

    media = "text/csv" if fmt == "csv" else "application/x-ndjson"
    ext = "csv" if fmt == "csv" else "jsonl"
    filename = f"billing_{start.date()}_{end.date()}.{ext}"
    return StreamingResponse(
        generate(),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
