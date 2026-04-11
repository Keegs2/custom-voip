"""Presence status endpoints for UCaaS.

Tracks real-time user availability (available, busy, away, dnd, offline).
Presence changes are also published to Redis pub/sub so that connected
WebSocket clients receive instant updates.
"""
import logging
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime, timezone

from db import database as db
from db import redis_client
from auth.dependencies import get_current_user, get_customer_filter

logger = logging.getLogger(__name__)

router = APIRouter()

VALID_STATUSES = {"available", "busy", "away", "dnd", "offline"}
PRESENCE_CHANNEL = "presence:updates"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PresenceUpdate(BaseModel):
    status: str
    status_message: Optional[str] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in VALID_STATUSES:
            raise ValueError(
                f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}"
            )
        return v

    @field_validator("status_message")
    @classmethod
    def validate_message(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) > 200:
            raise ValueError("Status message must be 200 characters or fewer")
        return v


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_presence(
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get presence statuses for all users within scope.

    Admins see every user. Non-admins see only users in their customer.
    """
    query = """
        SELECT u.id AS user_id, u.name, u.email,
               COALESCE(p.status, 'offline') AS status,
               p.status_message,
               p.updated_at
        FROM users u
        LEFT JOIN presence_status p ON u.id = p.user_id
        WHERE u.status = 'active'
    """
    values: list = []
    idx = 1

    if customer_filter is not None:
        query += f" AND u.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1

    query += " ORDER BY u.name ASC"

    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.get("/{user_id}")
async def get_presence(
    user_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get a specific user's presence status."""
    query = """
        SELECT u.id AS user_id, u.name, u.email,
               COALESCE(p.status, 'offline') AS status,
               p.status_message,
               p.updated_at
        FROM users u
        LEFT JOIN presence_status p ON u.id = p.user_id
        WHERE u.id = $1 AND u.status = 'active'
    """
    values: list = [user_id]
    idx = 2

    if customer_filter is not None:
        query += f" AND u.customer_id = ${idx}"
        values.append(customer_filter)

    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)


@router.put("")
async def update_presence(
    body: PresenceUpdate,
    user: dict = Depends(get_current_user),
):
    """Update the calling user's own presence status.

    Uses UPSERT so the row is created on first update.
    Also publishes the change to Redis pub/sub for WebSocket fanout.
    """
    user_id = int(user["sub"])
    now = datetime.now(timezone.utc)

    row = await db.fetch_one(
        """INSERT INTO presence_status (user_id, status, status_message, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id)
           DO UPDATE SET status = EXCLUDED.status,
                         status_message = EXCLUDED.status_message,
                         updated_at = EXCLUDED.updated_at
           RETURNING user_id, status, status_message, updated_at""",
        user_id,
        body.status,
        body.status_message,
        now,
    )

    # Publish to Redis for WebSocket fanout
    try:
        rc = await redis_client.get_client()
        import orjson
        payload = orjson.dumps({
            "user_id": user_id,
            "status": body.status,
            "status_message": body.status_message,
            "updated_at": now.isoformat(),
            "customer_id": user.get("customer_id"),
        }).decode()
        await rc.publish(PRESENCE_CHANNEL, payload)
    except Exception:
        # Presence updates are best-effort via pub/sub; DB is source of truth
        logger.warning("Failed to publish presence update to Redis", exc_info=True)

    return dict(row)
