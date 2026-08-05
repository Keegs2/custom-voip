"""STIR/SHAKEN attestation summary endpoints (admin only).

Aggregate visibility over the `call_attestations` companion table
(see docker/postgres/init/32_call_attestations.sql). Per-call reads live on
the CDRs router (GET /v1/cdrs/{call_id}/attestation, tenant-scoped); this
router is the admin roll-up for the UI summary panel.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from auth.dependencies import require_admin
from db import database as db

router = APIRouter()


@router.get("/attestation-summary")
async def attestation_summary(
    customer_id: Optional[int] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    admin: dict = Depends(require_admin),
):
    """STIR/SHAKEN attestation roll-up (admin only).

    Returns GROUP BY counts over the `call_attestations` table for the given
    window (default: last 7 days), optionally scoped to one customer:
      - by_signed_attestation: what WE emitted (A / B / C / div)
      - by_inbound_attest:     the caller's attestation from the origin carrier
      - by_inbound_verstat:    inbound caller verification result
      - by_verstat_source:     'self' (our crypto) vs 'carrier' (their PAI)

    Each breakdown is a list of {value, count} objects (value=null groups the
    rows where that dimension was not present). Also returns `total` (rows in
    window) and the effective window echoed back.

    Filtering is by created_at (ingest time). Backed by the
    (customer_id, created_at) index for an efficient range scan.
    """
    if not start_date:
        start_date = datetime.now(timezone.utc) - timedelta(days=7)
    if not end_date:
        end_date = datetime.now(timezone.utc)

    # Shared WHERE clause: created_at=$1..$2, optional customer_id=$3.
    where = "WHERE created_at >= $1 AND created_at <= $2"
    values: list = [start_date, end_date]
    if customer_id is not None:
        where += " AND customer_id = $3"
        values.append(customer_id)

    async def _grouped(column: str) -> list[dict]:
        """Return [{value, count}] grouped by one attestation dimension."""
        rows = await db.fetch_all(
            f"""
            SELECT {column} AS value, COUNT(*) AS count
            FROM call_attestations
            {where}
            GROUP BY {column}
            ORDER BY count DESC
            """,
            *values,
        )
        return [{"value": r["value"], "count": r["count"]} for r in rows]

    total_row = await db.fetch_one(
        f"SELECT COUNT(*) AS total FROM call_attestations {where}",
        *values,
    )

    return {
        "total": (total_row["total"] if total_row else 0),
        "customer_id": customer_id,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "by_signed_attestation": await _grouped("signed_attestation"),
        "by_inbound_attest": await _grouped("inbound_attest"),
        "by_inbound_verstat": await _grouped("inbound_verstat"),
        "by_verstat_source": await _grouped("verstat_source"),
    }
