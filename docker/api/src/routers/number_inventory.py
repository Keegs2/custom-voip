"""DID inventory and lifecycle management endpoints.

Provides a complete DID management system backed by the did_inventory table:
  - Admin: full inventory, stats, Bandwidth sync, assign/unassign
  - Customer: browse available numbers, view own numbers, request a number

Cross-references Bandwidth TN inventory with internal product tables
(rcf_numbers, api_dids, trunk_dids) and manages the full DID lifecycle.
"""
import re
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

from db import database as db
from db import redis_client as cache
from auth.dependencies import require_admin, get_current_user, get_customer_filter
from services.bandwidth_client import get_all_tns, _credentials_configured

logger = logging.getLogger(__name__)

router = APIRouter()

# E.164 pattern: + followed by 1-15 digits
E164_PATTERN = re.compile(r"^\+[1-9]\d{1,14}$")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AssignRequest(BaseModel):
    customer_id: int
    product_type: str
    notes: Optional[str] = None

    @field_validator("product_type")
    @classmethod
    def validate_product_type(cls, v: str) -> str:
        allowed = ("rcf", "trunk", "api", "ucaas")
        if v not in allowed:
            raise ValueError(f"product_type must be one of {allowed}")
        return v


class UnassignRequest(BaseModel):
    notes: Optional[str] = None


class NumberRequest(BaseModel):
    product_type: str
    notes: Optional[str] = None

    @field_validator("product_type")
    @classmethod
    def validate_product_type(cls, v: str) -> str:
        allowed = ("rcf", "trunk", "api")
        if v not in allowed:
            raise ValueError(f"product_type must be one of {allowed}")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_did(did: str) -> str:
    """Ensure a DID is in E.164 format (+1NPANXXXXXX).

    Accepts: +16174544217, 16174544217, 6174544217
    Returns: +16174544217
    """
    digits = did.strip().lstrip("+")
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if did.startswith("+"):
        return did
    return f"+{digits}"


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@router.get("/inventory")
async def get_inventory(
    admin: dict = Depends(require_admin),
    status: Optional[str] = Query(None, description="Filter by status"),
    customer_id: Optional[int] = Query(None, description="Filter by customer"),
    product_type: Optional[str] = Query(None, description="Filter by product type"),
    search: Optional[str] = Query(None, description="DID substring search"),
    state: Optional[str] = Query(None, description="Filter by state"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Return the full DID inventory with filters and pagination. Admin only."""
    query = """
        SELECT d.*,
               c.name AS customer_name,
               u.name AS assigned_by_name,
               COUNT(*) OVER() AS total_count
          FROM did_inventory d
          LEFT JOIN customers c ON d.customer_id = c.id
          LEFT JOIN users u ON d.assigned_by = u.id
         WHERE 1=1
    """
    values = []
    idx = 1

    if status is not None:
        query += f" AND d.status = ${idx}"
        values.append(status)
        idx += 1

    if customer_id is not None:
        query += f" AND d.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if product_type is not None:
        query += f" AND d.product_type = ${idx}"
        values.append(product_type)
        idx += 1

    if search is not None:
        query += f" AND d.did LIKE ${idx}"
        values.append(f"%{search}%")
        idx += 1

    if state is not None:
        query += f" AND d.state = ${idx}"
        values.append(state)
        idx += 1

    query += f" ORDER BY d.did LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0

    items = []
    for r in rows:
        item = dict(r)
        item.pop("total_count", None)
        items.append(item)

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
async def get_stats(admin: dict = Depends(require_admin)):
    """Summary statistics for the DID inventory. Admin only."""
    # Status breakdown
    status_rows = await db.fetch_all(
        "SELECT status, COUNT(*) AS cnt FROM did_inventory GROUP BY status"
    )
    by_status = {r["status"]: r["cnt"] for r in status_rows}

    # Product breakdown (only assigned DIDs)
    product_rows = await db.fetch_all(
        "SELECT product_type, COUNT(*) AS cnt FROM did_inventory "
        "WHERE product_type IS NOT NULL GROUP BY product_type"
    )
    by_product = {r["product_type"]: r["cnt"] for r in product_rows}

    # State breakdown (top 10)
    state_rows = await db.fetch_all(
        "SELECT state, COUNT(*) AS cnt FROM did_inventory "
        "WHERE state IS NOT NULL AND state != '' "
        "GROUP BY state ORDER BY cnt DESC LIMIT 10"
    )
    by_state = {r["state"]: r["cnt"] for r in state_rows}

    total = sum(by_status.values())
    available = by_status.get("available", 0)
    assigned = by_status.get("assigned", 0)
    reserved = by_status.get("reserved", 0)

    return {
        "total": total,
        "available": available,
        "assigned": assigned,
        "reserved": reserved,
        "by_status": by_status,
        "by_product": by_product,
        "by_state": by_state,
    }


@router.post("/sync")
async def sync_from_bandwidth(admin: dict = Depends(require_admin)):
    """Sync the Bandwidth TN inventory into did_inventory. Admin only.

    - New TNs from Bandwidth are inserted with status='available'
    - Existing TNs have their metadata (city/state/lata/rate_center) updated
    - TNs in our DB but no longer in Bandwidth are flagged (returned as 'removed')
    - Idempotent: safe to run multiple times
    """
    if not _credentials_configured():
        raise HTTPException(
            status_code=503,
            detail="Bandwidth API credentials not configured. "
                   "Set BANDWIDTH_API_CLIENT_ID and BANDWIDTH_API_CLIENT_SECRET.",
        )

    try:
        tns = await get_all_tns()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if not tns:
        return {"synced": 0, "inserted": 0, "updated": 0, "removed": []}

    # Build a set of E.164 DIDs from Bandwidth for comparison
    bw_dids: set[str] = set()
    bw_map: dict[str, dict] = {}
    for tn in tns:
        e164 = tn.get("fullNumber", "")
        if e164:
            bw_dids.add(e164)
            bw_map[e164] = tn

    # Get all DIDs currently in our inventory
    existing_rows = await db.fetch_all("SELECT did FROM did_inventory")
    existing_dids = {r["did"] for r in existing_rows}

    # New DIDs: in Bandwidth but not in our DB
    new_dids = bw_dids - existing_dids
    # Possibly removed: in our DB but not in Bandwidth
    removed_dids = existing_dids - bw_dids

    pool = await db.get_pool()
    inserted = 0
    updated = 0

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Insert new DIDs
            if new_dids:
                insert_args = []
                for did in new_dids:
                    tn = bw_map[did]
                    insert_args.append((
                        did,
                        tn.get("city", "") or None,
                        tn.get("state", "") or None,
                        tn.get("lata", "") or None,
                        tn.get("rateCenter", "") or None,
                    ))
                await conn.executemany(
                    """
                    INSERT INTO did_inventory (did, city, state, lata, rate_center, status)
                    VALUES ($1, $2, $3, $4, $5, 'available')
                    ON CONFLICT (did) DO NOTHING
                    """,
                    insert_args,
                )
                inserted = len(new_dids)

            # Update metadata for existing DIDs that are still in Bandwidth
            update_dids = existing_dids & bw_dids
            if update_dids:
                update_args = []
                for did in update_dids:
                    tn = bw_map[did]
                    update_args.append((
                        tn.get("city", "") or None,
                        tn.get("state", "") or None,
                        tn.get("lata", "") or None,
                        tn.get("rateCenter", "") or None,
                        did,
                    ))
                await conn.executemany(
                    """
                    UPDATE did_inventory
                       SET city = $1, state = $2, lata = $3, rate_center = $4,
                           updated_at = NOW()
                     WHERE did = $5
                    """,
                    update_args,
                )
                updated = len(update_dids)

    # Return removed DIDs as a warning (don't auto-delete; admin reviews)
    removed_list = sorted(removed_dids) if removed_dids else []

    logger.info(
        "Bandwidth sync complete: %d total, %d inserted, %d updated, %d removed from Bandwidth",
        len(bw_dids), inserted, updated, len(removed_list),
    )

    return {
        "synced": len(bw_dids),
        "inserted": inserted,
        "updated": updated,
        "removed": removed_list,
    }


@router.post("/{did}/assign")
async def assign_did(
    did: str,
    body: AssignRequest,
    admin: dict = Depends(require_admin),
):
    """Assign a DID to a customer for a specific product. Admin only.

    For RCF: also creates the rcf_numbers record.
    Changes status from 'available' (or 'reserved') to 'assigned'.
    """
    e164 = _normalize_did(did)
    admin_user_id = int(admin["sub"])

    # Verify customer exists and is active
    customer = await db.fetch_one(
        "SELECT id, name, status FROM customers WHERE id = $1",
        body.customer_id,
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    # Verify DID exists in inventory and is assignable
    inv = await db.fetch_one(
        "SELECT id, status, customer_id FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv:
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] == "assigned":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} is already assigned to customer_id={inv['customer_id']}",
        )
    if inv["status"] not in ("available", "reserved"):
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} has status '{inv['status']}' and cannot be assigned",
        )

    pool = await db.get_pool()
    product_ref_id = None

    async with pool.acquire() as conn:
        async with conn.transaction():
            # For RCF: create the rcf_numbers record
            if body.product_type == "rcf":
                try:
                    rcf_row = await conn.fetchrow(
                        """
                        INSERT INTO rcf_numbers (customer_id, did, name, forward_to, pass_caller_id, enabled, ring_timeout)
                        VALUES ($1, $2, $3, '', true, true, 30)
                        RETURNING id
                        """,
                        body.customer_id, e164, f"DID {e164}",
                    )
                    product_ref_id = rcf_row["id"]
                except Exception as e:
                    if "unique" in str(e).lower():
                        raise HTTPException(
                            status_code=409,
                            detail=f"DID {e164} already exists in rcf_numbers",
                        )
                    raise

            # Update did_inventory
            await conn.execute(
                """
                UPDATE did_inventory
                   SET customer_id = $1,
                       product_type = $2,
                       product_ref_id = $3,
                       status = 'assigned',
                       assigned_at = $4,
                       assigned_by = $5,
                       notes = $6,
                       updated_at = $4
                 WHERE did = $7
                """,
                body.customer_id,
                body.product_type,
                product_ref_id,
                datetime.now(timezone.utc),
                admin_user_id,
                body.notes,
                e164,
            )

    # Invalidate relevant caches
    await cache.cache_delete("bandwidth:tns")

    logger.info(
        "DID assigned: did=%s, customer=%s (%d), product=%s, by_user=%d",
        e164, customer["name"], body.customer_id, body.product_type, admin_user_id,
    )

    return {
        "status": "assigned",
        "did": e164,
        "customer_id": body.customer_id,
        "customer_name": customer["name"],
        "product_type": body.product_type,
        "product_ref_id": product_ref_id,
    }


@router.post("/{did}/unassign")
async def unassign_did(
    did: str,
    body: UnassignRequest = UnassignRequest(),
    admin: dict = Depends(require_admin),
):
    """Unassign a DID from a customer. Admin only.

    Removes the product record (rcf_numbers, etc.) and sets status back to 'available'.
    """
    e164 = _normalize_did(did)
    admin_user_id = int(admin["sub"])

    # Verify DID is currently assigned
    inv = await db.fetch_one(
        "SELECT id, status, customer_id, product_type, product_ref_id FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv:
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] not in ("assigned", "reserved"):
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} has status '{inv['status']}' and is not currently assigned",
        )

    pool = await db.get_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Remove the product record based on product_type
            product_type = inv["product_type"]
            if product_type == "rcf":
                await conn.execute("DELETE FROM rcf_numbers WHERE did = $1", e164)
            elif product_type == "api":
                await conn.execute("DELETE FROM api_dids WHERE did = $1", e164)
            elif product_type == "trunk":
                await conn.execute("DELETE FROM trunk_dids WHERE did = $1", e164)

            # Reset did_inventory
            now = datetime.now(timezone.utc)
            await conn.execute(
                """
                UPDATE did_inventory
                   SET customer_id = NULL,
                       product_type = NULL,
                       product_ref_id = NULL,
                       status = 'available',
                       assigned_at = NULL,
                       assigned_by = NULL,
                       notes = $1,
                       updated_at = $2
                 WHERE did = $3
                """,
                body.notes,
                now,
                e164,
            )

    # Invalidate caches
    if inv["product_type"] == "rcf":
        await cache.invalidate_rcf_cache(e164)
    await cache.cache_delete("bandwidth:tns")

    logger.info(
        "DID unassigned: did=%s, was_customer=%s, was_product=%s, by_user=%d",
        e164, inv["customer_id"], inv["product_type"], admin_user_id,
    )

    return {
        "status": "unassigned",
        "did": e164,
        "previous_customer_id": inv["customer_id"],
        "previous_product_type": inv["product_type"],
    }


# ---------------------------------------------------------------------------
# Customer-facing endpoints
# ---------------------------------------------------------------------------

@router.get("/available")
async def get_available(
    user: dict = Depends(get_current_user),
    state: Optional[str] = Query(None, description="Filter by state"),
    city: Optional[str] = Query(None, description="Filter by city"),
    area_code: Optional[str] = Query(None, description="Filter by area code (3 digits)"),
    search: Optional[str] = Query(None, description="DID substring search"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Browse available DIDs. Accessible by any authenticated user."""
    query = """
        SELECT did, city, state, rate_center,
               COUNT(*) OVER() AS total_count
          FROM did_inventory
         WHERE status = 'available'
    """
    values = []
    idx = 1

    if state is not None:
        query += f" AND state = ${idx}"
        values.append(state)
        idx += 1

    if city is not None:
        query += f" AND city ILIKE ${idx}"
        values.append(f"%{city}%")
        idx += 1

    if area_code is not None:
        # Area code is the 3 digits after +1 in E.164
        query += f" AND did LIKE ${idx}"
        values.append(f"+1{area_code}%")
        idx += 1

    if search is not None:
        query += f" AND did LIKE ${idx}"
        values.append(f"%{search}%")
        idx += 1

    query += f" ORDER BY did LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0

    items = []
    for r in rows:
        items.append({
            "did": r["did"],
            "city": r["city"],
            "state": r["state"],
            "rate_center": r["rate_center"],
        })

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/my")
async def get_my_numbers(
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get all DIDs assigned to the current user's customer. Any authenticated user."""
    customer_id = customer_filter
    if customer_id is None:
        # Admin: require explicit customer_id? No -- show all assigned.
        # But for non-admin, customer_filter returns their customer_id.
        # For admin, show all assigned DIDs (they can filter via /inventory).
        rows = await db.fetch_all(
            """
            SELECT d.did, d.product_type, d.status, d.city, d.state,
                   d.assigned_at, d.notes, d.customer_id,
                   c.name AS customer_name
              FROM did_inventory d
              LEFT JOIN customers c ON d.customer_id = c.id
             WHERE d.status IN ('assigned', 'reserved')
             ORDER BY d.did
             LIMIT 500
            """
        )
    else:
        rows = await db.fetch_all(
            """
            SELECT d.did, d.product_type, d.status, d.city, d.state,
                   d.assigned_at, d.notes, d.customer_id,
                   c.name AS customer_name
              FROM did_inventory d
              LEFT JOIN customers c ON d.customer_id = c.id
             WHERE d.customer_id = $1
               AND d.status IN ('assigned', 'reserved')
             ORDER BY d.did
            """,
            customer_id,
        )

    return [dict(r) for r in rows]


@router.post("/{did}/request")
async def request_number(
    did: str,
    body: NumberRequest,
    user: dict = Depends(get_current_user),
):
    """Customer requests a number. Changes status to 'reserved'.

    Admin reviews and approves (via /assign) or the system auto-approves.
    """
    e164 = _normalize_did(did)
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    if customer_id is None and user.get("role") != "admin":
        raise HTTPException(
            status_code=400,
            detail="User is not associated with a customer account",
        )

    # Verify the DID is available
    inv = await db.fetch_one(
        "SELECT id, status FROM did_inventory WHERE did = $1",
        e164,
    )
    if not inv:
        raise HTTPException(status_code=404, detail=f"DID {e164} not found in inventory")
    if inv["status"] != "available":
        raise HTTPException(
            status_code=409,
            detail=f"DID {e164} is not available (current status: {inv['status']})",
        )

    # Reserve the DID for this customer
    now = datetime.now(timezone.utc)
    await db.execute(
        """
        UPDATE did_inventory
           SET customer_id = $1,
               product_type = $2,
               status = 'reserved',
               assigned_at = $3,
               assigned_by = $4,
               notes = $5,
               updated_at = $3
         WHERE did = $6 AND status = 'available'
        """,
        customer_id,
        body.product_type,
        now,
        user_id,
        body.notes or f"Requested by user {user.get('email', user_id)}",
        e164,
    )

    logger.info(
        "DID requested: did=%s, customer_id=%s, product=%s, user=%d",
        e164, customer_id, body.product_type, user_id,
    )

    return {
        "status": "reserved",
        "did": e164,
        "customer_id": customer_id,
        "product_type": body.product_type,
        "message": "Number reserved. An administrator will review and complete the assignment.",
    }
