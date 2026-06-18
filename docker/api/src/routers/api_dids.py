"""API DID management endpoints.

Multi-tenant: every read/write is scoped to the caller's customer_id. Admins
(customer_filter=None) may operate across customers and may target an explicit
customer via the create payload / list filter.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from db import database as db
from auth.dependencies import get_current_user, get_customer_filter

router = APIRouter()


class APIDIDCreate(BaseModel):
    customer_id: int
    did: str
    voice_url: str
    status_callback: Optional[str] = None


class APIDIDUpdate(BaseModel):
    voice_url: Optional[str] = None
    status_callback: Optional[str] = None
    enabled: Optional[bool] = None


async def _get_owned_did(did: str, customer_filter: int | None) -> dict:
    """Fetch an API DID enforcing tenant isolation. 404 if it does not exist OR
    belongs to another customer (do not leak existence cross-tenant)."""
    row = await db.fetch_one(
        "SELECT id, did, customer_id, voice_url, status_callback, enabled FROM api_dids WHERE did = $1",
        did,
    )
    if not row:
        raise HTTPException(status_code=404, detail="API DID not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="API DID not found")
    return dict(row)


@router.get("")
async def list_api_dids(
    customer_id: Optional[int] = None,
    enabled: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List API DIDs. Non-admins are scoped to their own customer."""
    query = """
        SELECT a.id, a.did, a.customer_id, a.voice_url, a.status_callback,
               a.enabled, a.created_at, c.name as customer_name
        FROM api_dids a
        JOIN customers c ON a.customer_id = c.id
        WHERE 1=1
    """
    values = []
    idx = 1

    # Enforce tenant scoping for non-admins; admins may filter by customer_id.
    if customer_filter is not None:
        query += f" AND a.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    elif customer_id is not None:
        query += f" AND a.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if enabled is not None:
        query += f" AND a.enabled = ${idx}"
        values.append(enabled)
        idx += 1

    query += f" ORDER BY a.created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)
    return [dict(r) for r in results]


@router.post("")
async def create_api_did(
    api_did: APIDIDCreate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create a new API DID. Non-admins may only create within their own
    customer; the payload's customer_id is forced to the caller's."""
    customer_id = api_did.customer_id
    if customer_filter is not None:
        # Non-admin: ignore any attempt to target another customer.
        customer_id = customer_filter

    # Verify customer exists and is active
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        customer_id,
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    try:
        result = await db.fetch_one(
            """
            INSERT INTO api_dids (customer_id, did, voice_url, status_callback)
            VALUES ($1, $2, $3, $4)
            RETURNING id, did, customer_id, voice_url, status_callback, enabled, created_at
            """,
            customer_id, api_did.did, api_did.voice_url, api_did.status_callback
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="DID already exists")
        raise


@router.get("/{did}")
async def get_api_did(
    did: str,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get API DID by DID number (tenant-scoped)."""
    # Ownership gate first (404 cross-tenant), then enrich.
    await _get_owned_did(did, customer_filter)
    result = await db.fetch_one(
        """
        SELECT a.*, c.name as customer_name, c.traffic_grade
        FROM api_dids a
        JOIN customers c ON a.customer_id = c.id
        WHERE a.did = $1
        """,
        did
    )
    if not result:
        raise HTTPException(status_code=404, detail="API DID not found")
    return dict(result)


@router.put("/{did}")
async def update_api_did(
    did: str,
    api_did: APIDIDUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Update API DID settings (tenant-scoped)."""
    # Ownership gate first so a non-owner gets 404, not a silent update.
    await _get_owned_did(did, customer_filter)

    updates = []
    values = []
    idx = 1

    for field, value in api_did.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    values.append(did)
    query = f"""
        UPDATE api_dids SET {', '.join(updates)}
        WHERE did = ${idx}
        RETURNING id, did, voice_url, status_callback, enabled
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="API DID not found")
    return dict(result)


@router.delete("/{did}")
async def delete_api_did(
    did: str,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Delete an API DID (tenant-scoped)."""
    await _get_owned_did(did, customer_filter)
    result = await db.execute(
        "DELETE FROM api_dids WHERE did = $1",
        did
    )

    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="API DID not found")
    return {"status": "deleted", "did": did}
