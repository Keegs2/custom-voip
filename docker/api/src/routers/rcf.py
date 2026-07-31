"""RCF (Remote Call Forwarding) endpoints."""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional
from db import database as db
from db import redis_client as cache
from utils import phone

router = APIRouter()
logger = logging.getLogger(__name__)

# Number normalization is centralized in utils.phone — the single source of truth
# shared (by identical algorithm) with the FreeSWITCH Lua and React TS layers.
# DID fields must be canonical +E.164; forward/failover fields may also be a 3-6
# digit local PBX extension. See utils/phone.py for the canonical rule + vectors.
validate_e164 = phone.normalize_e164
validate_forward_destination = phone.normalize_forward_destination


class RCFCreate(BaseModel):
    customer_id: int
    did: str
    name: Optional[str] = None
    forward_to: str
    pass_caller_id: bool = True
    ring_timeout: int = 30
    failover_to: Optional[str] = None
    max_channels: int = 0

    @field_validator('did')
    @classmethod
    def validate_did(cls, v: str) -> str:
        """DID must be E.164 format (this is the inbound number)."""
        return validate_e164(v)

    @field_validator('forward_to')
    @classmethod
    def validate_forward_to_number(cls, v: str) -> str:
        """Forward destination can be E.164 or local extension."""
        return validate_forward_destination(v)

    @field_validator('failover_to')
    @classmethod
    def validate_failover(cls, v: Optional[str]) -> Optional[str]:
        """Failover destination can be E.164 or local extension."""
        if v is not None:
            return validate_forward_destination(v)
        return v

    @field_validator('ring_timeout')
    @classmethod
    def validate_ring_timeout(cls, v: int) -> int:
        if v < 5 or v > 120:
            raise ValueError("ring_timeout must be between 5 and 120 seconds")
        return v

    @field_validator('max_channels')
    @classmethod
    def validate_max_channels(cls, v: int) -> int:
        """0 = unlimited, 1-100 = enforced concurrent call limit per DID."""
        if v < 0 or v > 100:
            raise ValueError("max_channels must be between 0 (unlimited) and 100")
        return v


class RCFUpdate(BaseModel):
    name: Optional[str] = None
    forward_to: Optional[str] = None
    pass_caller_id: Optional[bool] = None
    ring_timeout: Optional[int] = None
    failover_to: Optional[str] = None
    enabled: Optional[bool] = None
    max_channels: Optional[int] = None

    @field_validator('forward_to')
    @classmethod
    def validate_forward_to(cls, v: Optional[str]) -> Optional[str]:
        """Forward destination can be E.164 or local extension."""
        if v is not None:
            return validate_forward_destination(v)
        return v

    @field_validator('failover_to')
    @classmethod
    def validate_failover(cls, v: Optional[str]) -> Optional[str]:
        """Failover destination can be E.164 or local extension."""
        if v is not None:
            return validate_forward_destination(v)
        return v

    @field_validator('ring_timeout')
    @classmethod
    def validate_ring_timeout(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 5 or v > 120):
            raise ValueError("ring_timeout must be between 5 and 120 seconds")
        return v

    @field_validator('max_channels')
    @classmethod
    def validate_max_channels(cls, v: Optional[int]) -> Optional[int]:
        """0 = unlimited, 1-100 = enforced concurrent call limit per DID."""
        if v is not None and (v < 0 or v > 100):
            raise ValueError("max_channels must be between 0 (unlimited) and 100")
        return v


class RCFResponse(BaseModel):
    """Response model for RCF operations."""
    id: int
    did: str
    name: Optional[str] = None
    forward_to: str
    pass_caller_id: bool
    enabled: bool
    ring_timeout: Optional[int] = None
    failover_to: Optional[str] = None
    max_channels: int = 0
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None


@router.post("")
async def create_rcf(rcf: RCFCreate):
    """Create a new RCF number."""
    # Verify customer exists and is active
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        rcf.customer_id
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    try:
        result = await db.fetch_one(
            """
            INSERT INTO rcf_numbers (customer_id, did, name, forward_to, pass_caller_id, ring_timeout, failover_to, max_channels)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, did, name, forward_to, pass_caller_id, enabled, ring_timeout, failover_to, max_channels, created_at
            """,
            rcf.customer_id, rcf.did, rcf.name, rcf.forward_to, rcf.pass_caller_id,
            rcf.ring_timeout, rcf.failover_to, rcf.max_channels
        )
        return dict(result)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="DID already exists")
        raise


@router.get("/{did}")
async def get_rcf(did: str):
    """Get RCF config by DID."""
    result = await db.fetch_one(
        """
        SELECT r.*, c.name as customer_name, c.traffic_grade
        FROM rcf_numbers r
        JOIN customers c ON r.customer_id = c.id
        WHERE r.did = $1
        """,
        did
    )
    if not result:
        raise HTTPException(status_code=404, detail="RCF number not found")
    return dict(result)


@router.put("/{identifier}")
async def update_rcf(identifier: str, rcf: RCFUpdate) -> RCFResponse:
    """Update RCF settings by ID (numeric) or DID (E.164 string)."""
    updates = []
    values = []
    idx = 1

    update_data = rcf.model_dump(exclude_none=True)

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    if identifier.isdigit():
        values.append(int(identifier))
        where_clause = f"id = ${idx}"
    else:
        values.append(identifier)
        where_clause = f"did = ${idx}"

    query = f"""
        UPDATE rcf_numbers SET {', '.join(updates)}
        WHERE {where_clause}
        RETURNING id, did, name, forward_to, pass_caller_id, enabled, ring_timeout, failover_to, max_channels, customer_id
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="RCF number not found")

    # Invalidate Redis cache so FreeSWITCH picks up the new forward_to on the next call
    await cache.invalidate_rcf_cache(result["did"])
    logger.info(f"RCF updated: did={result['did']}, fields={list(update_data.keys())}, cache invalidated")

    # Fetch customer name for complete response
    customer = await db.fetch_one(
        "SELECT name FROM customers WHERE id = $1",
        result["customer_id"]
    )

    return RCFResponse(
        id=result["id"],
        did=result["did"],
        name=result["name"],
        forward_to=result["forward_to"],
        pass_caller_id=result["pass_caller_id"],
        enabled=result["enabled"],
        ring_timeout=result["ring_timeout"],
        failover_to=result["failover_to"],
        max_channels=result["max_channels"],
        customer_id=result["customer_id"],
        customer_name=customer["name"] if customer else None
    )


@router.patch("/{identifier}")
async def patch_rcf(identifier: str, rcf: RCFUpdate) -> RCFResponse:
    """Partial update for RCF settings (alias for PUT)."""
    return await update_rcf(identifier, rcf)


@router.delete("/{identifier}")
async def delete_rcf(identifier: str):
    """Delete an RCF number by ID (numeric) or DID (E.164 string)."""
    if identifier.isdigit():
        # Lookup DID first for cache invalidation, then delete by ID
        row = await db.fetch_one(
            "SELECT did FROM rcf_numbers WHERE id = $1", int(identifier)
        )
        if not row:
            raise HTTPException(status_code=404, detail="RCF number not found")
        did = row["did"]
        await db.execute("DELETE FROM rcf_numbers WHERE id = $1", int(identifier))
    else:
        did = identifier
        result = await db.execute("DELETE FROM rcf_numbers WHERE did = $1", did)
        if result == "DELETE 0":
            raise HTTPException(status_code=404, detail="RCF number not found")

    await cache.invalidate_rcf_cache(did)
    return {"status": "deleted", "did": did}


@router.get("")
async def list_rcf(customer_id: Optional[int] = None, enabled: Optional[bool] = None):
    """List RCF numbers with optional filters."""
    query = """
        SELECT r.id, r.did, r.name, r.forward_to, r.pass_caller_id, r.enabled,
               r.ring_timeout, r.failover_to, r.max_channels, r.customer_id,
               c.name as customer_name
        FROM rcf_numbers r
        JOIN customers c ON r.customer_id = c.id
        WHERE 1=1
    """
    values = []
    idx = 1

    if customer_id is not None:
        query += f" AND r.customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if enabled is not None:
        query += f" AND r.enabled = ${idx}"
        values.append(enabled)
        idx += 1

    query += " ORDER BY r.created_at DESC LIMIT 100"

    results = await db.fetch_all(query, *values)
    return [dict(r) for r in results]
