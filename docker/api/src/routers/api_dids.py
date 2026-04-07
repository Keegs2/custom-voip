"""API DID management endpoints."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import database as db

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


@router.get("")
async def list_api_dids(
    customer_id: Optional[int] = None,
    enabled: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0
):
    """List all API DIDs with optional filters."""
    query = """
        SELECT a.id, a.did, a.customer_id, a.voice_url, a.status_callback,
               a.enabled, a.created_at, c.name as customer_name
        FROM api_dids a
        JOIN customers c ON a.customer_id = c.id
        WHERE 1=1
    """
    values = []
    idx = 1

    if customer_id is not None:
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
async def create_api_did(api_did: APIDIDCreate):
    """Create a new API DID."""
    # Verify customer exists
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        api_did.customer_id
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
            api_did.customer_id, api_did.did, api_did.voice_url, api_did.status_callback
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="DID already exists")
        raise


@router.get("/{did}")
async def get_api_did(did: str):
    """Get API DID by DID number."""
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
async def update_api_did(did: str, api_did: APIDIDUpdate):
    """Update API DID settings."""
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
async def delete_api_did(did: str):
    """Delete an API DID."""
    result = await db.execute(
        "DELETE FROM api_dids WHERE did = $1",
        did
    )

    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="API DID not found")
    return {"status": "deleted", "did": did}
