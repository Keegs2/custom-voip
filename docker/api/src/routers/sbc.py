"""SBC stats and monitoring endpoints (admin only)."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from auth.dependencies import require_admin
from db import database as db

router = APIRouter()


@router.get("/stats")
async def sbc_stats(
    minutes: int = Query(default=5, ge=1, le=1440),
    admin: dict = Depends(require_admin),
):
    """Return per-SBC call distribution over the last N minutes.

    Used for monitoring SBC failover and load balancing health.
    """
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=minutes)
    one_minute_ago = now - timedelta(minutes=1)

    rows = await db.fetch_all(
        """
        SELECT sbc_id,
               COUNT(*) as total_calls,
               COUNT(*) FILTER (WHERE start_time >= $2) as calls_last_minute,
               COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
               AVG(duration_ms) FILTER (WHERE answer_time IS NOT NULL) as avg_duration_ms
        FROM cdrs
        WHERE start_time >= $1 AND sbc_id IS NOT NULL
        GROUP BY sbc_id
        ORDER BY total_calls DESC
        """,
        window_start,
        one_minute_ago,
    )

    total_calls = sum(r["total_calls"] for r in rows)

    sbcs = []
    for r in rows:
        avg_dur = r["avg_duration_ms"]
        sbcs.append({
            "sbc_id": r["sbc_id"],
            "calls_total": r["total_calls"],
            "calls_last_minute": r["calls_last_minute"],
            "answered_calls": r["answered_calls"],
            "avg_duration_ms": round(float(avg_dur), 1) if avg_dur is not None else None,
            "percentage": round((r["total_calls"] / total_calls) * 100, 1) if total_calls > 0 else 0.0,
        })

    return {
        "window_minutes": minutes,
        "total_calls": total_calls,
        "sbcs": sbcs,
        "timestamp": now.isoformat(),
    }
